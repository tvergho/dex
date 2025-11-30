# CLAUDE.md - Dex Project Guide

## Project Overview

Dex is a local search engine for coding agent conversations. It indexes conversations from various AI coding tools (Cursor, Claude Code, Codex, OpenCode) into a local LanceDB database with full-text search.

## Tech Stack

- **Runtime**: Bun (preferred) or Node.js with tsx
- **Language**: TypeScript (strict mode)
- **Database**: LanceDB (embedded vector/FTS database)
- **UI**: Ink (React for CLI) + fullscreen-ink for terminal UI
- **Schema Validation**: Zod

## Project Structure

```
src/
├── adapters/           # Source-specific data extraction
│   ├── cursor/         # Cursor IDE adapter
│   ├── claude-code/    # Claude Code CLI adapter
│   ├── codex/          # Codex CLI adapter
│   ├── opencode/       # OpenCode CLI adapter
│   ├── types.ts        # Adapter interface definitions
│   └── index.ts        # Adapter registry
├── cli/
│   ├── commands/       # CLI command implementations
│   │   ├── unified.tsx # Home screen with tabs (default `dex` command)
│   │   ├── search.tsx  # Direct search with 4-level navigation
│   │   ├── list.tsx    # List conversations (non-TTY fallback)
│   │   ├── show.tsx    # Show single conversation
│   │   ├── sync.tsx    # Sync data from sources
│   │   ├── status.tsx  # Embedding progress status
│   │   ├── stats.tsx   # Analytics dashboard
│   │   ├── export.ts   # Export as markdown files
│   │   ├── backup.ts   # Full database backup (JSON)
│   │   ├── import.ts   # Import from backup
│   │   └── embed.ts    # Background embedding worker
│   ├── components/     # Reusable UI components
│   │   ├── ConversationView.tsx
│   │   ├── MessageDetailView.tsx
│   │   ├── MatchesView.tsx
│   │   ├── ResultRow.tsx
│   │   ├── HighlightedText.tsx
│   │   ├── ActivityHeatmap.tsx
│   │   ├── ExportActionMenu.tsx
│   │   └── StatusToast.tsx
│   └── hooks/          # Reusable React hooks
│       ├── useNavigation.ts  # 4-level drill-down state machine
│       └── useExport.ts      # Export modal state
├── db/
│   ├── index.ts        # LanceDB connection & table setup
│   ├── repository.ts   # Data access layer
│   └── analytics.ts    # Stats/analytics queries
├── schema/
│   └── index.ts        # Zod schemas for all entities
├── utils/
│   ├── config.ts       # Configuration paths
│   ├── format.ts       # Shared formatting utilities
│   ├── export.ts       # Export utilities (markdown generation)
│   └── platform.ts     # OS detection
├── embeddings/         # Vector embedding generation
│   ├── index.ts        # Embedding orchestration
│   └── llama-server.ts # llama-server integration
└── index.ts            # CLI entry point (Commander.js)
```

## Key Commands

```bash
bun run dev sync                    # Index conversations from all sources
bun run dev search "query"          # Search conversations by content
bun run dev search --file auth.ts   # Search by file path
bun run dev search "bug" --file auth.ts  # Combined content + file search
bun run dev list                    # List all conversations
bun run dev show <id>               # Show a specific conversation
bun run dev status                  # Check embedding progress
bun run dev stats                   # View usage analytics dashboard
bun run dev export                  # Export conversations as markdown
bun run dev backup                  # Full database backup (JSON)
bun run dev import <file>           # Import from backup
bun run typecheck                   # Run TypeScript type checking
bun run lint                        # Run ESLint
bun run lint:fix                    # Auto-fix lint issues
```

## Architecture Patterns

### Adapter Pattern
Each source (Cursor, Claude Code, etc.) implements `SourceAdapter`:
- `detect()` - Check if source is available on this machine
- `discover()` - Find all workspaces/instances
- `extract()` - Pull raw conversation data
- `normalize()` - Convert to unified schema

### Database Schema
- **conversations** - Top-level conversation metadata (title, source, timestamps, project context, token usage)
- **messages** - Individual messages with FTS index on content and vector embeddings
- **tool_calls** - Tool invocations (file edits, commands)
- **conversation_files** - Files associated with conversations (role: context/edited/mentioned)
- **message_files** - Files associated with specific messages
- **file_edits** - Individual file edit records with lines added/removed
- **sync_state** - Incremental sync tracking

### UI Navigation (Search)
Four-level navigation pattern:
1. **List view** - Search results with j/k navigation, Enter to expand
2. **Matches view** - All matches in a conversation, Enter to view full conversation
3. **Conversation view** - Full conversation with highlighted message, Enter for full message
4. **Message view** - Single message with full content, j/k to scroll, n/p for next/prev

## TUI Architecture

### Command Entry Points

The CLI has 5 main interactive commands, each implemented as a separate file in `src/cli/commands/`:

| Command | File | Description |
|---------|------|-------------|
| `dex` (default) | `unified.tsx` | Home screen with tabs: Search, Recent, Stats |
| `dex search <query>` | `search.tsx` | Direct search with 4-level drill-down |
| `dex list` | `list.tsx` | Simple conversation list (non-TTY fallback) |
| `dex show <id>` | `show.tsx` | Single conversation viewer |
| `dex stats` | `stats.tsx` | Analytics dashboard with tabs |

### unified.tsx vs search.tsx

**Key distinction:** These are the two main interactive views with significant overlap.

- **`unified.tsx`** (~970 LOC) - The default home screen when running `dex` with no arguments
  - Tab-based navigation: Search | Recent | Stats
  - Has its own search input in the Search tab
  - Contains a full implementation of 4-level navigation (list → matches → conversation → message)
  - Manages tab state, search state, AND navigation state

- **`search.tsx`** (~900 LOC) - Direct search when running `dex search "query"`
  - No tabs, goes straight to search results
  - Same 4-level navigation as unified.tsx
  - Simpler state (no tab management)

**Why both exist:** `unified.tsx` provides a discoverable home screen for new users, while `search.tsx` provides fast direct access for power users who know what they're searching for.

### View State Machines

Both `unified.tsx` and `search.tsx` use a `ViewMode` enum to track navigation depth:

```
unified.tsx ViewMode:
  'home' → 'search' → 'list' → 'matches' → 'conversation' → 'message'
           (tabs)     (search results)

search.tsx ViewMode:
  'list' → 'matches' → 'conversation' → 'message'
  (starts here after search)
```

Navigation flow:
- `Enter` - Drill down to next level
- `Esc` / `q` - Go back one level
- `j/k` - Navigate within current level
- `e` - Open export menu (available at all levels)

### Shared Components

Components in `src/cli/components/` are reused across commands:

| Component | Used By | Purpose |
|-----------|---------|---------|
| `ConversationView` | unified, search, show | Display full conversation with messages |
| `MessageDetailView` | unified, search, show | Single message with markdown rendering |
| `MatchesView` | unified, search | Search matches within a conversation |
| `ResultRow` | unified, search, list | Conversation list item |
| `HighlightedText` | unified, search | Search term highlighting |
| `ActivityHeatmap` | unified, stats | Git-style contribution heatmap |
| `ExportActionMenu` | unified, search, list, show, stats | Export modal overlay |
| `StatusToast` | unified, search, list, show, stats | Temporary success/error messages |

### Hooks

Hooks in `src/cli/hooks/` extract reusable logic:

| Hook | Purpose |
|------|---------|
| `useNavigation` | 4-level drill-down state machine (list → matches → conversation → message) |
| `useExport` | Export modal state, keyboard handling, file/clipboard actions |

The `useNavigation` hook provides:
- View mode state machine with transitions
- Scroll offset management for each view level
- Combined message merging and index mapping
- Match navigation helpers (finding distinct matches)
- Unified keyboard handler (`handleNavigationInput`)
- File and message loading when expanding conversations

## Coding Conventions

### TypeScript
- Use strict null checks - always handle `undefined`/`null` cases
- Prefer `const` assertions and explicit types for better inference
- Use Zod schemas as source of truth, derive types with `z.infer<>`

### Database
- Use deterministic IDs (SHA256 hash) to prevent duplicates on re-sync
- Always delete existing data before re-inserting (clean sync approach)
- Rebuild FTS index after bulk data insertion with `replace: true`

### React/Ink Components
- Use `fullscreen-ink` for proper terminal UI (prevents scroll issues)
- Handle both TTY (interactive) and non-TTY (piped) modes
- Keep state minimal - derive computed values with `useMemo`

### Error Handling
- Parse JSON safely with try/catch and null checks
- Skip invalid data rather than throwing during sync
- Show user-friendly errors in UI, log details for debugging

## LanceDB Specifics

- FTS index must be created/rebuilt AFTER data is inserted
- Use `replace: true` when recreating indexes
- Column names use snake_case (e.g., `conversation_id`, `message_index`) for SQL compatibility
- No `dropIndex` method - use `createIndex` with `replace: true`

### Schema Changes (Adding New Columns)

LanceDB schema is defined by the first row inserted. To add new columns:

1. **Update `src/schema/index.ts`** - Add fields to the Zod schema
2. **Update adapter parsers** - Extract new data from source (e.g., `parser.ts`)
3. **Update adapter normalizers** - Map extracted data to schema (e.g., `index.ts`)
4. **Update `src/db/index.ts`** - Add columns to table creation placeholder rows in `ensureTables()` and any `recreate*Table()` functions
5. **Update `src/db/repository.ts`** - Add columns to insert/upsert row objects AND to the return mappings in find/list functions
6. **Delete database and re-sync** - `rm -rf ~/.dex/lancedb && bun run dev sync --force`

**Critical**: Simply opening an existing table won't add new columns. The table must be recreated with the new schema for columns to exist.

## Export & Backup

### Export Command (`dex export`)

Exports conversations as human-readable markdown files organized by source and project:

```bash
dex export                          # Export all conversations to ./dex-export
dex export -o ~/my-exports          # Custom output directory
dex export --source cursor          # Filter by source
dex export --project myapp          # Filter by project path (substring match)
dex export --from 2025-01-01 --to 2025-01-31  # Date range
dex export --id <conversation-id>   # Export single conversation
```

**Output structure:**
```
output/
└── <source>/
    └── <project-name>/
        └── YYYY-MM-DD_conversation-title.md
```

**Markdown format includes:**
- Conversation metadata (source, project, model, mode, timestamps)
- Token usage and lines changed statistics
- Associated files list
- Full message content with role labels

### Backup Command (`dex backup`)

Exports the full database as JSON for migration between machines:

```bash
dex backup                          # Creates dex-backup-TIMESTAMP.json
dex backup -o my-backup.json        # Custom filename
dex backup --source claude-code     # Filter by source
```

### Import Command (`dex import`)

Imports conversations from a backup archive:

```bash
dex import backup.json              # Import all conversations
dex import backup.json --dry-run    # Preview what would be imported
dex import backup.json --force      # Overwrite existing conversations
```

## File Search

The `--file` flag enables searching by file path across all file tables:

```bash
dex search --file auth.ts              # Find conversations involving auth.ts
dex search --file src/components       # Find conversations in components/
dex search "fix bug" --file auth.ts    # Combined: content + file filter
```

**How it works:**
- Searches `file_edits`, `conversation_files`, and `message_files` tables
- Case-insensitive substring matching on file paths
- Results ranked by file role: edited (1.0) > context (0.5) > mentioned (0.3)
- Combined search filters content results to only conversations with matching files

**Implementation:** `searchByFilePath()` and `getFileMatchesForConversations()` in `src/db/repository.ts`

## Embeddings

Background embedding generation for semantic search:
- Uses `Qwen3-Embedding-0.6B` (1024 dimensions) via llama-server
- Spawned automatically after sync completes
- Progress tracked in `~/.dex/embedding-progress.json`
- Model stored in `~/.dex/models/`
- Check status with `dex status`

## Data Extraction

### Cursor
Stores conversations in SQLite:
- macOS: `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`
- Key format: `composerData:{composerId}`
- Fields: `conversation`/`conversationMap`, `context.fileSelections`, `forceMode`, `relevantFiles`

### Claude Code
Stores conversations in JSONL files:
- All platforms: `~/.claude/projects/{sanitized-path}/*.jsonl`
- Entry types: `user`, `assistant`, `summary`, `file-history-snapshot`
- Fields: `message.content`, `message.usage` (tokens), `toolUseResult`

### Codex CLI
Stores conversations in JSONL files:
- All platforms: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`
- Entry types: `session_meta`, `response_item`, `event_msg`, `turn_context`
- Fields: `payload.content`, `payload.type` (message/function_call), token counts in `event_msg`

### OpenCode
Stores conversations in JSON files with a hierarchical structure:
- All platforms: `~/.local/share/opencode/storage/`
- Directory structure:
  - `project/{projectId}.json` - Project metadata with worktree path
  - `session/{projectId}/{sessionId}.json` - Session metadata (title, timestamps)
  - `message/{sessionId}/{messageId}.json` - Message metadata (role, tokens)
  - `part/{messageId}/{partId}.json` - Message content parts (text, tool calls)
- Fields: `worktree` (project path), `title`, `tokens` (input/output/cache), tool `state` (input/output)

## Testing

**366 tests** covering adapters, database, utilities, schema, and CLI commands.

### Running Tests

```bash
bun run test:all            # Run all tests (Bun + Node.js Cursor tests)
bun test                    # Run Bun tests only
bun run test:cursor         # Run Cursor adapter tests (Node.js)
bun test --watch            # Watch mode
bun test --coverage         # With coverage report
bun test tests/unit/        # Run only unit tests
bun test --grep "export"    # Run tests matching pattern
```

### Test Structure

```
tests/
├── fixtures/               # Test data factories
│   └── index.ts            # createConversation, createMessage, etc.
├── helpers/                # Shared test utilities
│   ├── db.ts               # TestDatabase for isolated DB tests
│   ├── temp.ts             # Temporary directory management
│   ├── cli.ts              # Console/process mocking + setupCliTest
│   ├── mocks.ts            # Adapter and embedding mocks
│   ├── assertions.ts       # Custom file assertions
│   ├── sources.ts          # Mock source data generators
│   └── time.ts             # Date utilities
├── unit/                   # Pure function tests
│   ├── utils/              # export, format, config, platform
│   ├── db/                 # repository, analytics
│   ├── schema/             # Zod schema validation
│   └── adapters/           # All 4 adapters (cursor uses Node.js)
└── integration/            # Tests with I/O
    └── commands/           # export, backup, import, list, show, sync, status
```

### Writing Tests

**Unit tests** - Test pure functions:
```typescript
import { describe, it, expect } from 'bun:test';
import { generateFilename } from '../../../src/utils/export';
import { createConversation } from '../../fixtures';

it('generates filename', () => {
  const conv = createConversation({ title: 'Test' });
  expect(generateFilename(conv)).toContain('test.md');
});
```

**Integration tests** - Test with database/filesystem:
```typescript
import { TestDatabase, TempDir, setupCliTest } from '../../helpers';
import { createConversation, createMessage } from '../../fixtures';

let db: TestDatabase;
let cli: ReturnType<typeof setupCliTest>;

beforeEach(async () => {
  db = new TestDatabase();
  cli = setupCliTest();
  await db.setup();
});

afterEach(async () => {
  cli.restore();
  await db.teardown();
});

it('lists conversations', async () => {
  await db.seed({ conversations: [createConversation()] });
  const { listCommand } = await import('../../../src/cli/commands/list');
  await listCommand({});
  expect(cli.getOutput()).toContain('Conversations');
});
```

### Cursor Adapter Tests

The Cursor adapter uses `better-sqlite3` which has compatibility issues with Bun.
Cursor tests run separately with Node.js via `bun run test:cursor`.

### Manual Testing

1. Delete old database: `rm -rf ~/.dex/lancedb`
2. Re-sync: `bun run dev sync --force`
3. Test search: `bun run dev search "your query"`
4. Run typecheck: `bun run typecheck`

## Platform Notes

### macOS
- The `timeout` command is not available by default on macOS
- Use the Bash tool's `timeout` parameter instead of the `timeout` command
- Example: Use `Bash(command: "bun ...", timeout: 10000)` instead of `timeout 10 bun ...`

## Git Commits

- Do NOT include "Claude Code" references, co-author lines, or AI attribution in commit messages
- Write clear, conventional commit messages focused on the actual changes
- Example: `feat: add project context to search results` (not `feat: add project context 🤖 Generated with Claude Code`)
