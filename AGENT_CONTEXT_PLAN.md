# Agent Context Enrichment System Plan

## Overview

Extend dex from a search engine over agent conversations into a **tool that agents can use** to enrich themselves with context from past conversations.

### Core Insight

dex is a retrieval system. The next layer is a reasoning system that uses that retrieval to:
1. Answer ad-hoc questions about past work
2. Extract structured artifacts (rules, skills, preferences)
3. Synthesize across many conversations (summaries, benchmarks)

### Use Cases

| Use Case | Scope | Context Pattern |
|----------|-------|-----------------|
| "What did I do on the auth API?" | Few conversations | Targeted search → expand relevant |
| "Summarize today's work" | Time-bounded set | Full scan of subset |
| "Extract cursor rules" | All conversations | Map-reduce across everything |
| "Build personal eval set" | All conversations | Sample + deep analysis |
| "What's my preference for error handling?" | Fuzzy/emergent | Search + aggregate patterns |

**Key observation**: The first two work with search → expand. The last three require seeing many conversations to find patterns.

---

## Tool Interface Design

Four tools with clean separation:

### 1. `dex_stats` - Discovery

```typescript
dex_stats() → {
  total_conversations: number,
  total_messages: number,
  date_range: { earliest: string, latest: string },
  sources: Record<string, number>,  // { cursor: 150, claude_code: 80, ... }
  projects: string[],               // top 20 by activity
  avg_tokens_per_conversation: number,
}
```

### 2. `dex_list` - Browse by Metadata

```typescript
dex_list({
  project?: string,           // substring match on project path
  source?: string,            // cursor | claude_code | codex | opencode
  from?: string,              // ISO date
  to?: string,                // ISO date
  limit?: number,             // default 20
  offset?: number,            // for pagination
}) → {
  conversations: [{
    id: string,
    title: string,
    project: string,
    source: string,
    date: string,
    message_count: number,
    estimated_tokens: number,
  }],
  total: number,
}
```

### 3. `dex_search` - Find by Content

```typescript
dex_search({
  query: string,              // required - FTS + semantic hybrid
  file?: string,              // filter by file path involvement
  project?: string,           // substring match
  source?: string,            // cursor | claude_code | codex | opencode
  from?: string,              // ISO date
  to?: string,                // ISO date
  limit?: number,             // default 10
}) → {
  results: [{
    id: string,
    title: string,
    project: string,
    source: string,
    date: string,
    snippet: string,          // ~300 chars around match
    message_index: number,    // which message matched (for expand)
    estimated_tokens: number,
  }],
  total: number,
}
```

### 4. `dex_get` - Retrieve Content

```typescript
dex_get({
  ids: string[],              // batch support - always array
  format: 'full' | 'stripped' | 'user_only' | 'outline',

  // Optional: expand around specific point instead of full conversation
  expand?: {
    message_index: number,    // center on this message
    before?: number,          // messages before (default 2)
    after?: number,           // messages after (default 2)
  },

  max_tokens?: number,        // auto-truncate from end if exceeded
}) → {
  conversations: [{
    id: string,
    title: string,
    project: string,
    source: string,
    messages: [{ index: number, role: string, content: string, tokens?: number }],
    files?: string[],
    total_tokens: number,
    has_more_before?: boolean,  // only with expand
    has_more_after?: boolean,   // only with expand
  }],
}
```

### Format Options

| Format | Content | Typical Tokens | Use Case |
|--------|---------|----------------|----------|
| `full` | Everything including tool outputs | 15-20K | Deep analysis, exact quotes |
| `stripped` | Tool outputs removed | 5-10K | Understanding the conversation |
| `user_only` | Just user messages | 1-3K | Quick intent scanning |
| `outline` | First line + token count per message | 500-1K | Understand shape before committing |

### Outline Format Example

```
[User] How do I implement auth? (42 tokens)
[Assistant] I'll help you implement JWT auth... (1.2k tokens)
[User] Can you add refresh tokens? (18 tokens)
[Assistant] Sure, here's the refresh token flow... (800 tokens)
```

---

## CLI Mapping

These tools map to existing CLI commands with minimal additions:

| MCP Tool | CLI Command | Exists | Needs Added |
|----------|-------------|--------|-------------|
| `dex_stats` | `dex stats` | `--summary` | `--json` |
| `dex_list` | `dex list` | `-l`, `-s` | `--json`, `--project`, `--from`, `--to`, `--offset` |
| `dex_search` | `dex search` | `-l`, `-f`, `-s`, `-m` | `--json`, `--from`, `--to`, `--project`, message_index in output |
| `dex_get` | `dex show` | single id | `--json`, `--format`, multiple IDs, `--expand` |

### New CLI Flags

```bash
# Stats
dex stats --json

# List with filters
dex list --json --project myapp --from 2025-01-01 --to 2025-01-31 --limit 50

# Search with filters
dex search "error handling" --json --project myapp --from 2025-01-01

# Show with format options
dex show <id> --json --format stripped
dex show <id> --json --format outline
dex show <id1> <id2> <id3> --json --format user_only

# Show with expand (context around specific message)
dex show <id> --json --expand 5 --before 3 --after 3
```

---

## MCP Server

Expose the tools as an MCP server that any agent can connect to.

### Entry Point

```bash
dex serve                     # Start MCP server (stdio)
dex serve --port 3000         # HTTP transport (optional)
```

### Implementation

```typescript
// src/mcp/server.ts
import { McpServer } from '@anthropic/mcp';  // or similar

const server = new McpServer({
  name: 'dex',
  version: '0.3.0',
  tools: [
    {
      name: 'dex_stats',
      description: 'Get overview statistics about indexed conversations',
      handler: handleStats,
    },
    {
      name: 'dex_list',
      description: 'Browse conversations by metadata filters (date, project, source)',
      inputSchema: listSchema,
      handler: handleList,
    },
    {
      name: 'dex_search',
      description: 'Search conversations by content with optional filters',
      inputSchema: searchSchema,
      handler: handleSearch,
    },
    {
      name: 'dex_get',
      description: 'Retrieve conversation content in various formats',
      inputSchema: getSchema,
      handler: handleGet,
    },
  ],
});
```

### Claude Code Integration

Add to `~/.claude/mcp.json`:

```json
{
  "dex": {
    "command": "dex",
    "args": ["serve"]
  }
}
```

---

## Chat Mode

Ephemeral OpenCode sessions with dex tools available.

### Entry Point

```bash
dex chat                                    # Start ephemeral chat session
dex chat "what patterns do I use for X?"   # With initial query
```

### How It Works

1. Spawn OpenCode with isolated data directory (`~/.dex/chat-sessions/{id}/`)
2. MCP tools available (dex_stats, dex_list, dex_search, dex_get)
3. Session saved for later reference but separate from main OpenCode history
4. Agent + subagents can access same tools

### Session Storage

```
~/.dex/
├── opencode/              # existing: title generation (ephemeral)
├── chat-sessions/         # new: interactive chat sessions
│   └── {timestamp}/
│       ├── messages.jsonl
│       └── metadata.json  # task summary, duration, etc.
```

Sessions are tagged and can optionally be:
- Indexed by dex later (meta-learning)
- Excluded from regular searches if desired

---

## Batch Processing with Subagents

For comprehensive tasks that need to scan many/all conversations.

### Pattern

```
User: "Extract coding rules from my conversations"

Agent (orchestrator):
1. dex_stats() → 500 conversations
2. dex_list({ limit: 500 }) → all conversation IDs
3. Decides batching strategy (e.g., 50 per subagent)
4. Spawns 10 subagents, each with:
   - Subset of conversation IDs
   - Same dex MCP tools available
   - Task: "Extract rules from these conversations, return JSON"
5. Collects structured outputs from subagents
6. Merges/dedupes results
7. Returns consolidated rules to user
```

### Key Points

- **Orchestrator is just another agent** using the same tools
- Subagents have access to same MCP tools (dex_search, dex_get, etc.)
- Each subagent processes its batch independently
- OpenCode handles subagent spawning/coordination
- Merge strategy depends on task (dedupe rules, concatenate summaries, etc.)

### Batching Heuristics

```
Target: ~80K tokens per subagent batch (leaves room for prompt + response)
Typical conversation: ~8K tokens stripped

→ ~10 conversations per batch
→ 500 conversations = 50 batches
→ Parallel execution via OpenCode subagents
```

---

## Build Order

### Phase 1: CLI JSON Output

Add `--json` flag to existing commands:

1. `dex stats --json` - structured stats output
2. `dex list --json` - with new filters (--project, --from, --to, --offset)
3. `dex search --json` - with new filters, include message_index in results
4. `dex show --json` - with --format and multiple ID support

This validates the interface before adding MCP complexity.

**Files to modify:**
- `src/cli/commands/stats.tsx` - add --json flag
- `src/cli/commands/list.tsx` - add --json and filter flags
- `src/cli/commands/search.tsx` - add --json and filter flags
- `src/cli/commands/show.tsx` - add --json, --format, --expand, multi-ID
- `src/db/repository.ts` - add any missing filter support

### Phase 2: MCP Server

Wrap CLI functionality as MCP tools:

1. Create `src/mcp/server.ts`
2. Define tool schemas matching the interface above
3. Implement handlers (can call repository directly or shell to CLI)
4. Add `dex serve` command
5. Test with Claude Code

**Files to create:**
- `src/mcp/server.ts` - MCP server implementation
- `src/mcp/schemas.ts` - Zod schemas for tool inputs
- `src/mcp/handlers.ts` - Tool handler implementations

**Files to modify:**
- `src/index.ts` - add `serve` command

### Phase 3: Chat Mode

Ephemeral sessions with MCP tools:

1. Create chat session management
2. Spawn OpenCode with isolated data dir
3. Configure MCP tools in spawned session
4. Add `dex chat` command
5. Handle session cleanup/storage

**Files to create:**
- `src/chat/session.ts` - session lifecycle management
- `src/chat/spawn.ts` - OpenCode spawning with MCP config

**Files to modify:**
- `src/index.ts` - add `chat` command

### Phase 4: Polish & Iterate

Based on real usage:
- Tune format options and token estimates
- Add any missing filters or retrieval modes
- Optimize batch processing patterns
- Consider caching extracted artifacts (rules, summaries)

---

## Token Budget Management

All tools return `estimated_tokens` to help agents self-budget:

```typescript
// Agent reasoning:
// "I have 100K context budget"
// "Search returned 10 results, ~8K tokens each stripped"
// "I can safely get 5-6 full conversations, or outlines for all 10"
```

The `max_tokens` parameter on `dex_get` provides a safety valve - auto-truncates from the end if content exceeds budget.

---

## Future Considerations (Not in Initial Scope)

- **Pre-computed summaries**: Generate on sync for faster retrieval (expensive, consider later)
- **Predefined workflows**: `dex extract-rules`, `dex summarize --period week` (add once patterns emerge)
- **Rules caching**: Store extracted rules, update incrementally on new conversations
- **Cross-source expansion**: Twitter bookmarks, ChatGPT history, etc. (architecture should support)

---

## Success Criteria

1. Agent can answer "what was my approach for X?" by searching and expanding
2. Agent can extract rules/patterns from all conversations via subagent batching
3. Sessions don't pollute main OpenCode history
4. Tools work from Claude Code, Cursor (when MCP ships), or any MCP-compatible agent
5. Performance: search < 500ms, get outline < 200ms, get full < 2s
