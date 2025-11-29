# Plan: Claude Code Adapter & Search Integration

## Goals
- Add a Claude Code source adapter that detects local data, extracts conversations/messages/files/tool calls, and normalizes them to the existing schema.
- Ensure Claude Code conversations sync into LanceDB alongside Cursor, with deterministic IDs and clean re-sync behavior.
- Make Claude Code data searchable (FTS + embeddings) and navigable in the existing CLI UI.

## Open Questions / Assumptions to Resolve
- Linux/Windows path confirmation (macOS uses `~/.claude`; likely `~/.claude` on Linux and `%USERPROFILE%\\.claude` on Windows but needs verification).
- How to map file-history blobs to message/file associations (ids -> paths/versions).
- Whether there is a launchable deep link; if none, return `null`.
- Fallback timestamp/ID strategy if any entries lack session/message timestamps.

## Storage Findings (macOS, per docs + local)
- Root dir: `~/.claude`.
- Per-project conversations: `~/.claude/projects/<sanitized-project-path>/<sessionId>.jsonl` plus `agent-<id>.jsonl` sidecar files (same `sessionId`).
  - Records are newline-delimited JSON objects.
  - Typical fields: `sessionId`, `uuid`, `parentUuid`, `timestamp` (ISO), `cwd`, `gitBranch`, `slug`, `version`, `isSidechain`, `userType`.
  - Message objects include `message.role` (`user`/`assistant`), `message.content` as an array of segments (`{type:"text",text:"..."}`, `{type:"tool_use",id,name,input}`), `requestId`, and `type` (`user`/`assistant`).
  - Tool results are stored in `toolUseResult` objects with `type` (`create`, `text`, etc.), `filePath`, `content`, `structuredPatch`, `originalFile`, `stdout/stderr` for commands, etc. These give us tool calls + file edits + command outputs.
  - Some entries are `file-history-snapshot` records with `trackedFileBackups` map and `timestamp`.
  - `todos/` and `plans/` dirs contain task state (JSON), potentially linked by ids found in messages.
- File contents: `~/.claude/file-history/<sessionId>/<fileId>@vN` holds versioned file blobs referenced by tool results or snapshots.
- Global history: `~/.claude/history.jsonl` holds top-level command/messages with `display`, `pastedContents`, `timestamp`, `project`.
- Settings: `settings.json` and `settings.local.json` under `~/.claude`.

## Parsing Strategy From Findings
- Conversation boundary = `sessionId`; collect lines from both `<sessionId>.jsonl` and `agent-*.jsonl` sharing that id.
- Message ordering: use file order; maintain `parentUuid` if needed to disambiguate threads.
- Role mapping: `message.role` → `user/assistant`; treat tool_use segments as tool calls attached to that assistant message.
- Tool calls: emit `ToolCall` entries from `tool_use` segments and enrich with `toolUseResult` (inputs/outputs, filePath, stdout/stderr).
- Files: extract paths from `toolUseResult.filePath`, `toolUseResult.content` metadata, any `trackedFileBackups` paths, and from file-history references; map to conversation/message files (likely `role: edited` for creates/patches, `context` for reads, `mentioned` for others).
- Workspace/project: derive from `<sanitized-project-path>` (desanitize `-` separators) and `cwd` fields.

## Work Plan

### 1) Data Recon
- Inspect Claude Code app data directories for DBs (SQLite/LevelDB/JSON) and identify the conversation store and schema.
- Create a few sample conversations with files/tool calls to observe how they are stored.
- Document key fields: conversation id/title, created/updated timestamps, model, mode, message ordering, tool calls, file references, workspace/project metadata, and any per-message timestamps.

### 2) Adapter Design
- `detect()`: check for the presence of the Claude data store (path + readable file).
- `discover()`: enumerate available workspaces/instances (per-account or global store), returning `dbPath`, `workspacePath` (if derivable), and `mtime`.
- `extract()`: read raw conversations from the store with defensive parsing (skip bad rows/JSON); keep raw types narrow and typed.
- `normalize()`: map raw data to `Conversation`, `Message`, `ToolCall`, `ConversationFile`, and `MessageFile`.
  - Deterministic IDs: `sha256('claude-code:' + originalId).slice(0,32)`.
  - Timestamps: parse/ISO stringify; skip invalid values.
  - Roles: map Claude roles to `user`/`assistant`/`system`; handle tool/system variants.
  - Files: collect conversation-level and per-message file references; mark role as `context`/`edited`/`mentioned` based on available metadata.
  - Tool calls: capture command/file edit executions if present; store inputs/outputs where available.
  - Workspace/project: derive from stored metadata or from file paths (common prefix heuristic similar to Cursor).
- `getDeepLink()`: return a custom URL/path if discoverable; otherwise `null`.

### 3) Platform Paths & Parsing
- Add `src/adapters/claude-code/paths.ts` to encapsulate OS-specific data locations and mtime detection.
- Add `parser.ts` to read the underlying store (SQLite or JSON) and emit raw conversations with messages, files, tool calls.
- Handle multiple schema versions if present; prefer robust field checks over strict assumptions.

### 4) Adapter Wiring
- Implement `ClaudeCodeAdapter` in `src/adapters/claude-code/index.ts` using the shared `SourceAdapter` interface.
- Register the adapter in `src/adapters/index.ts` so `dex sync` picks it up automatically.
- Ensure `SourceType` already includes `claude-code` (present in schema) and reuse it.

### 5) Sync & Indexing Flow
- Verify sync deletes/reinserts Claude Code data per run (clean sync) and uses deterministic IDs to avoid duplicates.
- After insertion, rebuild FTS indexes (`replace: true`) to include the new source.
- Confirm embedding worker picks up new rows (no source-specific filter); if needed, ensure embedding queue reads all messages regardless of source.

### 6) Validation & Testing
- Add targeted unit/integration tests for parsing/normalization (sample fixtures from captured Claude Code data).
- Manual flow: delete DB, run `bun run dev sync --force`, then `bun run dev search "query"` and `bun run dev list/show` to verify Claude entries appear and navigate through the 4-level UI.
- Run `bun run typecheck` and `bun run lint` to ensure type safety and style conformity.

### 7) Documentation & DX
- Update README/CLI help to mention Claude Code support and any platform-specific notes (paths, permissions).
- Document limitations (missing deep links, missing timestamps, partial tool/file metadata) and follow-up tasks if data is not available.

## Definition of Done
- Claude Code adapter detects, extracts, normalizes, and syncs conversations/messages/files/tool calls without crashes on malformed data.
- Data is indexed (FTS + embeddings) and appears in search/list/show with correct roles/order and highlighted matches.
- Tests and lint/typecheck pass; documentation reflects the new source and known gaps.
- Cross-platform paths (to verify):
  - macOS: `~/.claude` (confirmed).
  - Linux: `~/.claude` (expected).
  - Windows: `%USERPROFILE%\\.claude` (expected; likely `C:\\Users\\<user>\\.claude`).
  - Detection should fall back to HOME/USERPROFILE and exist/read checks.
