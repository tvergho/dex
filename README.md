# Dex

**Local search engine for your AI coding conversations.**

Dex indexes conversations from AI coding assistants (Cursor, Claude Code, Codex) into a local database with full-text search. Find that conversation where you debugged that tricky auth issue, or search across all your pair programming sessions.

## Features

- 🔍 **Full-text search** across all your AI conversations
- 🖥️ **Interactive TUI** with vim-style navigation (j/k, Enter, Esc)
- 📁 **Project context** - see which files were discussed
- 🔄 **Incremental sync** - only indexes new conversations
- 🏠 **Fully local** - your data never leaves your machine

## Supported Sources

| Source | Status |
|--------|--------|
| Cursor | ✅ Supported |
| Claude Code | 🚧 Coming soon |
| Codex CLI | 🚧 Coming soon |

## Installation

### Prerequisites

- [Bun](https://bun.sh) (recommended) or Node.js 18+

### From Source

```bash
git clone https://github.com/yourusername/dex.git
cd dex
bun install
```

## Quick Start

```bash
# Index your conversations
bun run dev sync

# Search for something
bun run dev search "authentication middleware"

# List all conversations
bun run dev list

# View a specific conversation
bun run dev show <conversation-id>
```

## Usage

### Search

```bash
bun run dev search "your query"
```

Navigate the interactive TUI:
- `j/k` or `↑/↓` - Move selection
- `Enter` - Expand/drill down
- `Esc` - Go back
- `g/G` - Jump to top/bottom
- `q` - Quit

The search has 4 levels of detail:
1. **Results list** - Matching conversations with snippets
2. **Matches view** - All matches within a conversation
3. **Conversation view** - Full conversation with messages
4. **Message view** - Complete message content

### Sync

```bash
# Sync from all sources
bun run dev sync

# Force full re-sync
bun run dev sync --force
```

### List

```bash
# List recent conversations
bun run dev list

# Limit results
bun run dev list --limit 10
```

## Data Storage

All data is stored locally in `~/.dex/`:

```
~/.dex/
├── lancedb/          # Main database (conversations, messages, FTS index)
├── models/           # Embedding models (downloaded on first use)
└── embedding-progress.json
```

## Development

```bash
# Run in development mode
bun run dev <command>

# Type checking
bun run typecheck

# Linting
bun run lint
bun run lint:fix
```

## How It Works

1. **Sync** reads conversation data from source applications (e.g., Cursor's SQLite database)
2. Data is normalized into a unified schema and stored in LanceDB
3. **Search** uses LanceDB's full-text search with BM25 ranking
4. Results are presented in an interactive terminal UI built with Ink

## Privacy

Dex is fully local:
- All data stays on your machine in `~/.dex/`
- No network requests (except downloading the embedding model once)
- No telemetry or analytics

## License

MIT

