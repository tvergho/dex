# CLAUDE.md - Dex Project Guide

## Project Overview

Dex is a local search engine for coding agent conversations. It indexes conversations from various AI coding tools (Cursor, Claude Code, Codex) into a local LanceDB database with full-text search.

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
│   │   ├── index.ts    # Adapter implementation
│   │   ├── parser.ts   # Data extraction logic
│   │   └── paths.ts    # Platform-specific paths
│   ├── types.ts        # Adapter interface definitions
│   └── index.ts        # Adapter registry
├── cli/
│   ├── commands/       # CLI command implementations
│   │   ├── search.tsx  # Search with 4-level navigation
│   │   ├── list.tsx    # List conversations
│   │   ├── show.tsx    # Show single conversation
│   │   ├── sync.tsx    # Sync data from sources
│   │   ├── status.tsx  # Embedding progress status
│   │   └── embed.ts    # Background embedding worker
│   └── components/     # Reusable UI components
│       ├── HighlightedText.tsx
│       ├── ResultRow.tsx
│       ├── MatchesView.tsx
│       ├── ConversationView.tsx
│       └── MessageDetailView.tsx
├── db/
│   ├── index.ts        # LanceDB connection & table setup
│   └── repository.ts   # Data access layer
├── schema/
│   └── index.ts        # Zod schemas for all entities
├── utils/
│   ├── config.ts       # Configuration paths
│   ├── format.ts       # Shared formatting utilities
│   └── platform.ts     # OS detection
├── embeddings/         # Vector embedding generation
│   ├── index.ts        # Embedding orchestration
│   └── llama-server.ts # llama-server integration
└── index.ts            # CLI entry point (Commander.js)
```

## Key Commands

```bash
bun run dev sync        # Index conversations from all sources
bun run dev search "query"  # Search conversations
bun run dev list        # List all conversations
bun run dev show <id>   # Show a specific conversation
bun run dev status      # Check embedding progress
bun run typecheck       # Run TypeScript type checking
```

## Architecture Patterns

### Adapter Pattern
Each source (Cursor, Claude Code, etc.) implements `SourceAdapter`:
- `detect()` - Check if source is available on this machine
- `discover()` - Find all workspaces/instances
- `extract()` - Pull raw conversation data
- `normalize()` - Convert to unified schema

### Database Schema
- **conversations** - Top-level conversation metadata (title, source, timestamps, project context)
- **messages** - Individual messages with FTS index on content
- **tool_calls** - Tool invocations (file edits, commands)
- **conversation_files** - Files associated with conversations
- **sync_state** - Incremental sync tracking

### UI Navigation (Search)
Four-level navigation pattern:
1. **List view** - Search results with j/k navigation, Enter to expand
2. **Matches view** - All matches in a conversation, Enter to view full conversation
3. **Conversation view** - Full conversation with highlighted message, Enter for full message
4. **Message view** - Single message with full content, j/k to scroll, n/p for next/prev

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
- Column names with camelCase need quotes in SQL filters: `"conversationId"`
- No `dropIndex` method - use `createIndex` with `replace: true`

## Embeddings

Background embedding generation for semantic search:
- Uses `nomic-embed-text-v1.5` (1024 dimensions) via llama-server
- Spawned automatically after sync completes
- Progress tracked in `~/.dex/embedding-progress.json`
- Model stored in `~/.dex/models/`
- Check status with `dex status`

## Data Extraction (Cursor)

Cursor stores conversations in:
- macOS: `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`
- Key format: `composerData:{composerId}`

Key fields extracted:
- `conversation` or `conversationMap` - Message content
- `context.fileSelections` - Files in context
- `forceMode` - Mode (chat/edit/agent)
- `relevantFiles` - Files mentioned in bubbles

## Testing Changes

1. Delete old database: `rm -rf ~/.dex/lancedb`
2. Re-sync: `bun run dev sync --force`
3. Test search: `bun run dev search "your query"`
4. Run typecheck: `bun run typecheck`

## Git Commits

- Do NOT include "Claude Code" references, co-author lines, or AI attribution in commit messages
- Write clear, conventional commit messages focused on the actual changes
- Example: `feat: add project context to search results` (not `feat: add project context 🤖 Generated with Claude Code`)
