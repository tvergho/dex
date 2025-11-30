# Dex - Complete Project Documentation

**Local search engine for your AI coding conversations.**

This document contains everything needed to recreate the Dex project functionally. It includes complete source code, configuration files, architecture documentation, and setup instructions.

## Table of Contents

1. [Project Overview](#project-overview)
2. [Architecture](#architecture)
3. [Installation & Setup](#installation--setup)
4. [Complete Source Code](#complete-source-code)
5. [Configuration Files](#configuration-files)
6. [Usage Guide](#usage-guide)

---

## Project Overview

Dex is a local search engine that indexes conversations from AI coding assistants (Cursor, Claude Code, Codex) into a local LanceDB database with full-text search and semantic search capabilities.

### Key Features

- 🔍 **Full-text search** across all AI conversations
- 🖥️ **Interactive TUI** with vim-style navigation (j/k, Enter, Esc)
- 📁 **Project context** - see which files were discussed
- 🔄 **Incremental sync** - only indexes new conversations
- 🏠 **Fully local** - your data never leaves your machine
- 🧠 **Hybrid search** - combines FTS (BM25) with vector embeddings
- 📊 **Analytics dashboard** - usage stats, activity heatmaps, token tracking

### Supported Sources

| Source | Status |
|--------|--------|
| Cursor | ✅ Supported |
| Claude Code | ✅ Supported |
| Codex CLI | ✅ Supported |

### Tech Stack

- **Runtime**: Bun (preferred) or Node.js with tsx
- **Language**: TypeScript (strict mode)
- **Database**: LanceDB (embedded vector/FTS database)
- **UI**: Ink (React for CLI) + fullscreen-ink for terminal UI
- **Schema Validation**: Zod
- **Embeddings**: Qwen3-Embedding-0.6B (1024 dimensions) via llama-server/node-llama-cpp

---

## Architecture

### Project Structure

```
src/
├── adapters/           # Source-specific data extraction
│   ├── cursor/         # Cursor IDE adapter
│   ├── claude-code/   # Claude Code adapter
│   ├── codex/         # Codex CLI adapter
│   ├── types.ts       # Adapter interface definitions
│   └── index.ts       # Adapter registry
├── cli/
│   ├── commands/      # CLI command implementations
│   │   ├── search.tsx  # Search with 4-level navigation
│   │   ├── list.tsx    # List conversations
│   │   ├── show.tsx    # Show single conversation
│   │   ├── sync.tsx    # Sync data from sources
│   │   ├── status.tsx  # Embedding progress status
│   │   ├── stats.tsx   # Analytics dashboard
│   │   └── embed.ts    # Background embedding worker
│   └── components/    # Reusable UI components
│       ├── HighlightedText.tsx
│       ├── ResultRow.tsx
│       ├── MatchesView.tsx
│       ├── ConversationView.tsx
│       ├── MessageDetailView.tsx
│       ├── ActivityHeatmap.tsx  # GitHub-style activity heatmap
│       ├── HorizontalBar.tsx    # Horizontal bar charts
│       ├── MetricCard.tsx       # Metric display components
│       └── Sparkline.tsx        # Sparkline trend charts
├── db/
│   ├── index.ts       # LanceDB connection & table setup
│   ├── repository.ts  # Data access layer
│   └── analytics.ts   # Analytics query functions
├── schema/
│   └── index.ts       # Zod schemas for all entities
├── utils/
│   ├── config.ts      # Configuration paths
│   ├── format.ts      # Shared formatting utilities
│   └── platform.ts    # OS detection
├── embeddings/        # Vector embedding generation
│   ├── index.ts       # Embedding orchestration
│   └── llama-server.ts # llama-server integration
└── index.ts           # CLI entry point (Commander.js)
```

### Database Schema

- **conversations** - Top-level conversation metadata (title, source, timestamps, project context, token usage, lines generated)
- **messages** - Individual messages with FTS index on content and vector embeddings (includes token usage and lines generated)
- **tool_calls** - Tool invocations (file edits, commands)
- **conversation_files** - Files associated with conversations
- **message_files** - Files associated with specific messages
- **file_edits** - Individual line-level file edits (create/modify/delete operations with line counts)
- **sync_state** - Incremental sync tracking

### Adapter Pattern

Each source (Cursor, Claude Code, etc.) implements `SourceAdapter`:
- `detect()` - Check if source is available on this machine
- `discover()` - Find all workspaces/instances
- `extract()` - Pull raw conversation data
- `normalize()` - Convert to unified schema

### UI Navigation (Search)

Four-level navigation pattern:
1. **List view** - Search results with j/k navigation, Enter to expand
2. **Matches view** - All matches in a conversation, Enter to view full conversation
3. **Conversation view** - Full conversation with highlighted message, Enter for full message
4. **Message view** - Single message with full content, j/k to scroll, n/p for next/prev

---

## Installation & Setup

### Prerequisites

- [Bun](https://bun.sh) (recommended) or Node.js 18+ with tsx
- TypeScript 5.6+

### Installation Steps

1. **Clone or create project directory**
```bash
mkdir dex
cd dex
```

2. **Initialize package.json**
```bash
bun init
```

3. **Install dependencies** (see package.json in Configuration Files section)

4. **Create directory structure** as shown in Project Structure above

5. **Copy all source files** from Complete Source Code section below

6. **Build and run**
```bash
bun install
bun run dev sync
```

---

## Complete Source Code

### Entry Point

#### `src/index.ts`

```typescript
#!/usr/bin/env bun
import { Command } from 'commander';
import { syncCommand } from './cli/commands/sync';
import { searchCommand } from './cli/commands/search';
import { listCommand } from './cli/commands/list';
import { showCommand } from './cli/commands/show';
import { statusCommand } from './cli/commands/status';
import { statsCommand } from './cli/commands/stats';

const program = new Command()
  .name('dex')
  .description('Universal search for your coding agent conversations')
  .version('0.1.0');

program
  .command('sync')
  .description('Index conversations from all sources')
  .option('-f, --force', 'Force re-index all conversations')
  .action(syncCommand);

program
  .command('search <query...>')
  .description('Full-text search across conversations')
  .option('-l, --limit <number>', 'Maximum number of results', '20')
  .action((queryParts: string[], options) => searchCommand(queryParts.join(' '), options));

program
  .command('list')
  .description('Browse recent conversations')
  .option('-l, --limit <number>', 'Maximum number of conversations', '20')
  .option('-s, --source <source>', 'Filter by source (cursor, claude-code, codex)')
  .action(listCommand);

program
  .command('show <id>')
  .description('View a conversation')
  .action(showCommand);

program
  .command('status')
  .description('Check embedding generation progress')
  .action(statusCommand);

program
  .command('stats')
  .description('View usage analytics and statistics')
  .option('-p, --period <days>', 'Time period in days', '30')
  .option('-s, --summary', 'Print quick summary (non-interactive)')
  .action(statsCommand);

program.parse();
```

### Schema Definitions

#### `src/schema/index.ts`

```typescript
import { z } from 'zod';

// Source types for extensibility
export const SourceType = z.enum(['cursor', 'claude-code', 'codex']);
export type SourceType = z.infer<typeof SourceType>;

// Reference back to original source for deep linking
export const SourceRef = z.object({
  source: SourceType,
  workspacePath: z.string().optional(),
  originalId: z.string(),
  dbPath: z.string(),
});
export type SourceRef = z.infer<typeof SourceRef>;

// Individual message within a conversation
export const Message = z.object({
  id: z.string(),
  conversationId: z.string(),
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string(),
  timestamp: z.string().datetime().optional(),
  messageIndex: z.number(),
  // Token usage (from API response)
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  cacheCreationTokens: z.number().optional(), // Claude Code only
  cacheReadTokens: z.number().optional(), // Claude Code only
});
export type Message = z.infer<typeof Message>;

// Tool invocation (first-class for querying "what files did I edit")
export const ToolCall = z.object({
  id: z.string(),
  messageId: z.string(),
  conversationId: z.string(),
  type: z.string(),
  input: z.string(),
  output: z.string().optional(),
  filePath: z.string().optional(),
});
export type ToolCall = z.infer<typeof ToolCall>;

// Conversation (top-level entity)
export const Conversation = z.object({
  id: z.string(),
  source: SourceType,
  title: z.string(),
  subtitle: z.string().optional(),
  workspacePath: z.string().optional(),
  projectName: z.string().optional(),
  model: z.string().optional(),
  mode: z.string().optional(), // 'chat', 'edit', 'agent', etc.
  createdAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional(),
  messageCount: z.number(),
  sourceRef: SourceRef,
  // Aggregated token usage
  totalInputTokens: z.number().optional(),
  totalOutputTokens: z.number().optional(),
  totalCacheCreationTokens: z.number().optional(),
  totalCacheReadTokens: z.number().optional(),
});
export type Conversation = z.infer<typeof Conversation>;

// Files associated with a conversation
export const ConversationFile = z.object({
  id: z.string(),
  conversationId: z.string(),
  filePath: z.string(),
  role: z.enum(['context', 'edited', 'mentioned']), // how the file was involved
});
export type ConversationFile = z.infer<typeof ConversationFile>;

// Files associated with a specific message
export const MessageFile = z.object({
  id: z.string(),
  messageId: z.string(),
  conversationId: z.string(),
  filePath: z.string(),
  role: z.enum(['context', 'edited', 'mentioned']), // how the file was involved in this message
});
export type MessageFile = z.infer<typeof MessageFile>;

// Sync state for incremental updates
export const SyncState = z.object({
  source: SourceType,
  workspacePath: z.string(),
  dbPath: z.string(),
  lastSyncedAt: z.string().datetime(),
  lastMtime: z.number(),
});
export type SyncState = z.infer<typeof SyncState>;

// Search result types
export const MessageMatch = z.object({
  messageId: z.string(),
  conversationId: z.string(),
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string(),
  snippet: z.string(),
  highlightRanges: z.array(z.tuple([z.number(), z.number()])),
  score: z.number(),
  messageIndex: z.number(),
});
export type MessageMatch = z.infer<typeof MessageMatch>;

export const ConversationResult = z.object({
  conversation: Conversation,
  matches: z.array(MessageMatch),
  bestMatch: MessageMatch,
  totalMatches: z.number(),
});
export type ConversationResult = z.infer<typeof ConversationResult>;

export const SearchResponse = z.object({
  query: z.string(),
  results: z.array(ConversationResult),
  totalConversations: z.number(),
  totalMessages: z.number(),
  searchTimeMs: z.number(),
});
export type SearchResponse = z.infer<typeof SearchResponse>;
```

### Database Layer

#### `src/db/index.ts`

```typescript
import * as lancedb from '@lancedb/lancedb';
import { getLanceDBPath } from '../utils/config';
import type { Table } from '@lancedb/lancedb';
import { EMBEDDING_DIMENSIONS } from '../embeddings/index';

let db: lancedb.Connection | null = null;

// Table references
let conversationsTable: Table | null = null;
let messagesTable: Table | null = null;
let toolCallsTable: Table | null = null;
let syncStateTable: Table | null = null;
let filesTable: Table | null = null;
let messageFilesTable: Table | null = null;

export async function connect(): Promise<lancedb.Connection> {
  if (db) return db;

  const dbPath = getLanceDBPath();
  db = await lancedb.connect(dbPath);

  await ensureTables();

  return db;
}

export async function getConversationsTable(): Promise<Table> {
  if (!conversationsTable) {
    await connect();
  }
  return conversationsTable!;
}

export async function getMessagesTable(): Promise<Table> {
  if (!messagesTable) {
    await connect();
  }
  return messagesTable!;
}

export async function getToolCallsTable(): Promise<Table> {
  if (!toolCallsTable) {
    await connect();
  }
  return toolCallsTable!;
}

export async function getSyncStateTable(): Promise<Table> {
  if (!syncStateTable) {
    await connect();
  }
  return syncStateTable!;
}

export async function getFilesTable(): Promise<Table> {
  if (!filesTable) {
    await connect();
  }
  return filesTable!;
}

export async function getMessageFilesTable(): Promise<Table> {
  if (!messageFilesTable) {
    await connect();
  }
  return messageFilesTable!;
}

async function ensureTables(): Promise<void> {
  if (!db) throw new Error('Database not connected');

  const existingTables = await db.tableNames();

  // Conversations table
  // Use empty strings for nullable fields to establish schema types
  if (!existingTables.includes('conversations')) {
    conversationsTable = await db.createTable('conversations', [
      {
        id: '_placeholder_',
        source: 'cursor',
        title: '',
        subtitle: '',           // Empty string instead of null
        workspacePath: '',      // Empty string instead of null
        projectName: '',        // Empty string instead of null
        model: '',              // Empty string instead of null
        mode: '',               // Empty string instead of null
        createdAt: '',          // Empty string instead of null
        updatedAt: '',          // Empty string instead of null
        messageCount: 0,
        sourceRefJson: '{}',
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheCreationTokens: 0,
        totalCacheReadTokens: 0,
        totalLinesAdded: 0,
        totalLinesRemoved: 0,
      },
    ]);
    // Delete placeholder row
    await conversationsTable.delete("id = '_placeholder_'");
  } else {
    conversationsTable = await db.openTable('conversations');
  }

  // Messages table - primary search target with vector embeddings
  if (!existingTables.includes('messages')) {
    messagesTable = await db.createTable('messages', [
      {
        id: '_placeholder_',
        conversationId: '',
        role: 'user',
        content: '',
        timestamp: '',          // Empty string instead of null
        messageIndex: 0,
        vector: new Array(EMBEDDING_DIMENSIONS).fill(0), // Vector embeddings for hybrid search
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        totalLinesAdded: 0,
        totalLinesRemoved: 0,
      },
    ]);
    await messagesTable.delete("id = '_placeholder_'");
    // Note: FTS and vector indexes will be created/rebuilt after sync when data exists
  } else {
    messagesTable = await db.openTable('messages');
  }

  // Tool calls table
  if (!existingTables.includes('tool_calls')) {
    toolCallsTable = await db.createTable('tool_calls', [
      {
        id: '_placeholder_',
        messageId: '',
        conversationId: '',
        type: '',
        input: '',
        output: '',             // Empty string instead of null
        filePath: '',           // Empty string instead of null
      },
    ]);
    await toolCallsTable.delete("id = '_placeholder_'");
  } else {
    toolCallsTable = await db.openTable('tool_calls');
  }

  // Sync state table
  if (!existingTables.includes('sync_state')) {
    syncStateTable = await db.createTable('sync_state', [
      {
        source: 'cursor',
        workspacePath: '_placeholder_',
        dbPath: '',
        lastSyncedAt: new Date().toISOString(),
        lastMtime: 0,
      },
    ]);
    await syncStateTable.delete(`"workspacePath" = '_placeholder_'`);
  } else {
    syncStateTable = await db.openTable('sync_state');
  }

  // Conversation files table
  if (!existingTables.includes('conversation_files')) {
    filesTable = await db.createTable('conversation_files', [
      {
        id: '_placeholder_',
        conversationId: '',
        filePath: '',
        role: 'context',
      },
    ]);
    await filesTable.delete("id = '_placeholder_'");
  } else {
    filesTable = await db.openTable('conversation_files');
  }

  // Message files table (per-message file associations)
  if (!existingTables.includes('message_files')) {
    messageFilesTable = await db.createTable('message_files', [
      {
        id: '_placeholder_',
        messageId: '',
        conversationId: '',
        filePath: '',
        role: 'context',
      },
    ]);
    await messageFilesTable.delete("id = '_placeholder_'");
  } else {
    messageFilesTable = await db.openTable('message_files');
  }

  // File edits table (individual line-level edits)
  if (!existingTables.includes('file_edits')) {
    fileEditsTable = await db.createTable('file_edits', [
      {
        id: '_placeholder_',
        messageId: '',
        conversationId: '',
        filePath: '',
        editType: 'modify',
        linesAdded: 0,
        linesRemoved: 0,
        startLine: 0,  // 0 = not available
        endLine: 0,    // 0 = not available
      },
    ]);
    await fileEditsTable.delete("id = '_placeholder_'");
  } else {
    fileEditsTable = await db.openTable('file_edits');
  }
}

export async function closeConnection(): Promise<void> {
  db = null;
  conversationsTable = null;
  messagesTable = null;
  toolCallsTable = null;
  syncStateTable = null;
  filesTable = null;
  messageFilesTable = null;
  fileEditsTable = null;
}

export async function getFileEditsTable(): Promise<Table> {
  if (!fileEditsTable) {
    await connect();
  }
  return fileEditsTable!;
}

export async function rebuildFtsIndex(): Promise<void> {
  const table = await getMessagesTable();

  // LanceDB will update existing index when createIndex is called again
  // with replace: true option
  await table.createIndex('content', {
    config: lancedb.Index.fts(),
    replace: true,
  });
}

export async function rebuildVectorIndex(): Promise<void> {
  const table = await getMessagesTable();

  // Create IVF-PQ vector index for efficient similarity search
  await table.createIndex('vector', {
    config: lancedb.Index.ivfPq({
      numPartitions: 256,
      numSubVectors: 16,
    }),
    replace: true,
  });
}

export async function needsVectorMigration(): Promise<boolean> {
  const table = await getMessagesTable();

  // Check if the table has a vector column by trying to get schema
  try {
    const schema = await table.schema();
    const hasVector = schema.fields.some((f) => f.name === 'vector');
    return !hasVector;
  } catch {
    return true;
  }
}

export async function dropMessagesTable(): Promise<void> {
  if (!db) {
    await connect();
  }
  await db!.dropTable('messages');
  messagesTable = null;
}

export async function recreateMessagesTable(): Promise<void> {
  if (!db) {
    await connect();
  }

  // Drop and recreate with vector column
  const existingTables = await db!.tableNames();
  if (existingTables.includes('messages')) {
    await db!.dropTable('messages');
  }

  messagesTable = await db!.createTable('messages', [
    {
      id: '_placeholder_',
      conversationId: '',
      role: 'user',
      content: '',
      timestamp: '',
      messageIndex: 0,
      vector: new Array(EMBEDDING_DIMENSIONS).fill(0),
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    },
  ]);
  await messagesTable.delete("id = '_placeholder_'");
}
```

#### `src/db/repository.ts`

[This file is 659 lines - see the actual file content in the codebase. Key functions include:]
- `conversationRepo` - CRUD operations for conversations
- `messageRepo` - Message operations including hybrid search (FTS + vector)
- `toolCallRepo` - Tool call operations
- `syncStateRepo` - Sync state tracking
- `filesRepo` - Conversation file associations
- `messageFilesRepo` - Message file associations
- `fileEditsRepo` - File edit operations tracking (line-level edits)
- `search()` - Main search function combining FTS and vector results with RRF

#### `src/db/analytics.ts`

[This file is 805 lines - see the actual file content in the codebase. Key functions include:]
- `getOverviewStats()` - Overall statistics (conversations, messages, tokens, lines)
- `getDailyActivity()` - Daily activity breakdown
- `getStatsBySource()` - Statistics grouped by source (Cursor, Claude Code, Codex)
- `getStatsByModel()` - Statistics grouped by model
- `getTopConversationsByTokens()` - Top conversations by token usage
- `getLinesGeneratedStats()` - Lines added/removed statistics
- `getCacheStats()` - Cache efficiency metrics (Claude Code/Codex)
- `getActivityByHour()` - Hourly activity distribution
- `getActivityByDayOfWeek()` - Day-of-week activity distribution
- `getStreakInfo()` - Current and longest activity streaks
- `getProjectStats()` - Statistics grouped by project
- `getConversationsByProject()` - Get conversations for a specific project
- `getCombinedFileStats()` - Most active files (edits + mentions)
- `getEditTypeBreakdown()` - Breakdown of create/modify/delete operations
- `getFileTypeStats()` - Statistics by file extension
- `getSummaryStats()` - Quick summary for non-interactive output
- `getRecentConversations()` - Most recent conversations

### Adapter System

#### `src/adapters/types.ts`

```typescript
import type { Conversation, Message, ToolCall, SourceRef, SourceType, ConversationFile, MessageFile } from '../schema/index';

export interface SourceLocation {
  source: SourceType;
  workspacePath: string;
  dbPath: string;
  mtime: number;
}

export interface NormalizedConversation {
  conversation: Conversation;
  messages: Message[];
  toolCalls: ToolCall[];
  files?: ConversationFile[];
  messageFiles?: MessageFile[];
}

export interface SourceAdapter {
  name: SourceType;

  /** Check if this source is available on this machine */
  detect(): Promise<boolean>;

  /** Find all instances/workspaces of this source */
  discover(): Promise<SourceLocation[]>;

  /** Extract raw conversations from a source location */
  extract(location: SourceLocation): Promise<unknown[]>;

  /** Convert raw conversation to unified schema */
  normalize(raw: unknown, location: SourceLocation): NormalizedConversation;

  /** Get a URL/path to open the original conversation (if possible) */
  getDeepLink(ref: SourceRef): string | null;
}
```

#### `src/adapters/index.ts`

```typescript
import { cursorAdapter } from './cursor/index.js';
import { claudeCodeAdapter } from './claude-code/index.js';
import { codexAdapter } from './codex/index.js';
import type { SourceAdapter } from './types.js';

// Registry of all available adapters
export const adapters: SourceAdapter[] = [cursorAdapter, claudeCodeAdapter, codexAdapter];

export function getAdapter(name: string): SourceAdapter | undefined {
  return adapters.find((a) => a.name === name);
}

export * from './types';
```

#### `src/adapters/cursor/index.ts`

[See actual file - implements CursorAdapter for extracting conversations from Cursor's SQLite database]

#### `src/adapters/cursor/parser.ts`

[See actual file - extracts conversations from Cursor's state.vscdb SQLite database]

#### `src/adapters/cursor/paths.ts`

```typescript
import { existsSync, statSync } from 'fs';
import { getPlatform, expandPath } from '../../utils/platform';

export interface CursorGlobalDB {
  dbPath: string;
  mtime: number;
}

// Platform-specific Cursor global storage locations
const CURSOR_GLOBAL_PATHS = {
  darwin: '~/Library/Application Support/Cursor/User/globalStorage/state.vscdb',
  win32: '%APPDATA%/Cursor/User/globalStorage/state.vscdb',
  linux: '~/.config/Cursor/User/globalStorage/state.vscdb',
};

export function getCursorGlobalDbPath(): string {
  const platform = getPlatform();
  const path = CURSOR_GLOBAL_PATHS[platform];
  return expandPath(path);
}

export function getGlobalDatabase(): CursorGlobalDB | null {
  const dbPath = getCursorGlobalDbPath();

  if (!existsSync(dbPath)) {
    return null;
  }

  const stats = statSync(dbPath);
  return {
    dbPath,
    mtime: stats.mtimeMs,
  };
}
```

### Utilities

#### `src/utils/config.ts`

```typescript
import { homedir } from 'os';
import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';

const DEFAULT_DATA_DIR = join(homedir(), '.dex');

export function getDataDir(): string {
  const dataDir = process.env['DEX_DATA_DIR'] ?? DEFAULT_DATA_DIR;

  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  return dataDir;
}

export function getLanceDBPath(): string {
  return join(getDataDir(), 'lancedb');
}
```

#### `src/utils/platform.ts`

```typescript
import { homedir } from 'os';
import { join } from 'path';

export type Platform = 'darwin' | 'win32' | 'linux';

export function getPlatform(): Platform {
  const platform = process.platform;
  if (platform === 'darwin' || platform === 'win32' || platform === 'linux') {
    return platform;
  }
  throw new Error(`Unsupported platform: ${platform}`);
}

export function expandPath(path: string): string {
  if (path.startsWith('~/')) {
    return join(homedir(), path.slice(2));
  }
  if (path.startsWith('%APPDATA%')) {
    const appData = process.env['APPDATA'];
    if (!appData) {
      throw new Error('APPDATA environment variable not set');
    }
    return path.replace('%APPDATA%', appData);
  }
  return path;
}
```

#### `src/utils/format.ts`

[See actual file - contains formatting utilities for dates, tokens, files, and message combining logic]

### Embeddings

#### `src/embeddings/index.ts`

[See actual file - handles embedding model download, initialization, and embedding generation using node-llama-cpp]

#### `src/embeddings/llama-server.ts`

[See actual file - manages llama-server binary for faster batch embeddings]

### CLI Commands

#### `src/cli/commands/sync.tsx`

[See actual file - syncs conversations from all sources, spawns background embedding worker]

#### `src/cli/commands/search.tsx`

[See actual file - implements 4-level navigation search UI]

#### `src/cli/commands/list.tsx`

[See actual file - lists all conversations with TUI]

#### `src/cli/commands/show.tsx`

[See actual file - displays a single conversation]

#### `src/cli/commands/status.tsx`

[See actual file - shows embedding progress]

#### `src/cli/commands/stats.tsx`

[See actual file - interactive analytics dashboard with tabs for Overview, Tokens, Activity, Projects, and Files. Features include:
- Overview tab: Activity metrics, token usage, lines generated, source breakdown, recent conversations
- Tokens tab: Token breakdown by model, cache efficiency, top conversations by tokens
- Activity tab: GitHub-style activity heatmap, hourly/weekly distributions, streak tracking
- Projects tab: Statistics by project with drill-down to conversations
- Files tab: Most active files, edit type breakdown, file type statistics
- Navigation: Tab switching (1-3 or h/l), Enter to view conversations, j/k for selection
- Non-interactive mode: `--summary` flag for quick text output]

#### `src/cli/commands/embed.ts`

[See actual file - background worker for generating embeddings]

### CLI Components

#### `src/cli/components/HighlightedText.tsx`

```typescript
import React from 'react';
import { Text } from 'ink';

export interface HighlightedTextProps {
  text: string;
  query: string;
  dimColor?: boolean;
}

/**
 * Render text with highlighted search terms (yellow + bold)
 */
export function HighlightedText({
  text,
  query,
  dimColor,
}: HighlightedTextProps) {
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 0);
  if (terms.length === 0) {
    return <Text dimColor={dimColor}>{text}</Text>;
  }

  // Build regex to match any term
  const escapedTerms = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const regex = new RegExp(`(${escapedTerms.join('|')})`, 'gi');

  const parts = text.split(regex);

  return (
    <Text dimColor={dimColor} wrap="wrap">
      {parts.map((part, i) => {
        const isMatch = terms.some((t) => part.toLowerCase() === t);
        if (isMatch) {
          return <Text key={i} color="yellow" bold>{part}</Text>;
        }
        return <Text key={i}>{part}</Text>;
      })}
    </Text>
  );
}
```

#### `src/cli/components/ResultRow.tsx`

[See actual file - displays a single search result row]

#### `src/cli/components/MatchesView.tsx`

[See actual file - shows all matches within a conversation]

#### `src/cli/components/ConversationView.tsx`

[See actual file - displays full conversation with messages]

#### `src/cli/components/MessageDetailView.tsx`

[See actual file - shows full message content]

#### `src/cli/components/ActivityHeatmap.tsx`

[See actual file - GitHub-style activity heatmap component with:
- `ActivityHeatmap` - Main heatmap component showing daily activity over weeks
- `HourlyActivity` - Horizontal bar chart for hour-of-day distribution
- `WeeklyActivity` - Day-of-week activity chart
- Supports multiple metrics: conversations, messages, tokens
- iOS GitHub widget aesthetic with green color gradient]

#### `src/cli/components/HorizontalBar.tsx`

[See actual file - Horizontal bar chart components:
- `HorizontalBar` - Multi-item bar chart with labels and values
- `ProgressBar` - Single progress bar for percentages
- Compact number formatting (K/M suffixes)
- Customizable colors and characters]

#### `src/cli/components/MetricCard.tsx`

[See actual file - Metric display components:
- `MetricCard` - Single metric with label and value
- `MetricRow` - Row of evenly distributed metrics
- `formatLargeNumber()` - Format numbers with K/M/B suffixes
- `formatTokenDisplay()` - Format token counts
- `formatLinesDisplay()` - Format line counts]

#### `src/cli/components/Sparkline.tsx`

[See actual file - Sparkline trend chart component:
- Unicode block characters (▁▂▃▄▅▆▇█) for visual trend
- Trend indicator (↑/↓) with percentage change
- Resampling for different widths
- Color customization]

#### `src/cli/components/index.ts`

```typescript
export { HighlightedText, type HighlightedTextProps } from './HighlightedText';
export { ResultRow, type ResultRowProps } from './ResultRow';
export { MatchesView, type MatchesViewProps } from './MatchesView';
export { ConversationView, type ConversationViewProps } from './ConversationView';
export { MessageDetailView, type MessageDetailViewProps } from './MessageDetailView';
```

---

## Configuration Files

### `package.json`

```json
{
  "name": "dex",
  "version": "0.1.0",
  "description": "Universal search and analytics for your coding agent conversations",
  "type": "module",
  "bin": {
    "dex": "./dist/index.js"
  },
  "scripts": {
    "dev": "tsx src/index.ts",
    "dev:bun": "bun run src/index.ts",
    "build": "bun build src/index.ts --outdir dist --target bun",
    "typecheck": "tsc --noEmit",
    "lint": "eslint src/",
    "lint:fix": "eslint src/ --fix"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.52.0",
    "@lancedb/lancedb": "^0.13.0",
    "apache-arrow": "^18.0.0",
    "better-sqlite3": "^11.6.0",
    "chalk": "^5.3.0",
    "commander": "^12.1.0",
    "fullscreen-ink": "0.1.0",
    "ink": "^5.1.0",
    "node-llama-cpp": "3.14.2",
    "react": "^18.3.1",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.11",
    "@types/bun": "^1.1.13",
    "@types/react": "^18.3.12",
    "@typescript-eslint/eslint-plugin": "8.48.0",
    "@typescript-eslint/parser": "8.48.0",
    "eslint": "9.39.1",
    "eslint-plugin-react": "7.37.5",
    "eslint-plugin-react-hooks": "7.0.1",
    "tsx": "4.20.6",
    "typescript": "^5.6.3"
  }
}
```

### `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "esModuleInterop": true,
    "strict": true,
    "skipLibCheck": true,
    "declaration": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "jsx": "react-jsx",
    "types": ["bun-types"],
    "resolveJsonModule": true,
    "allowSyntheticDefaultImports": true,
    "forceConsistentCasingInFileNames": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

### `eslint.config.js`

```javascript
import eslint from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';

export default [
  {
    ignores: ['dist/**', 'node_modules/**', '*.js'],
  },
  {
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
      'react': react,
      'react-hooks': reactHooks,
    },
    settings: {
      react: {
        version: '18.3',
      },
    },
    rules: {
      // TypeScript rules
      '@typescript-eslint/no-unused-vars': ['warn', { 
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
      }],
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      
      // React rules
      'react/react-in-jsx-scope': 'off', // Not needed with new JSX transform
      'react/prop-types': 'off', // Using TypeScript for prop types
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      
      // General rules
      'no-console': 'off',
      'prefer-const': 'warn',
      'no-var': 'error',
    },
  },
];
```

### `bunfig.toml`

```toml
[install]
# Use exact versions for reproducibility
exact = true

[run]
# Enable source maps for better error traces
sourcemap = "inline"
```

---

## Usage Guide

### Basic Commands

```bash
# Index conversations from all sources
bun run dev sync

# Force re-index everything
bun run dev sync --force

# Search for something
bun run dev search "authentication middleware"

# List all conversations
bun run dev list

# View a specific conversation
bun run dev show <conversation-id>

# Check embedding progress
bun run dev status

# View analytics dashboard
bun run dev stats

# Quick stats summary (non-interactive)
bun run dev stats --summary

# Stats for last 7 days
bun run dev stats --period 7
```

### Search Navigation

The search command has 4 levels of detail:

1. **Results list** - Matching conversations with snippets
   - `j/k` or `↑/↓` - Navigate results
   - `Enter` - Expand to see matches
   - `q` - Quit

2. **Matches view** - All matches within a conversation
   - `j/k` - Navigate matches
   - `Enter` - View full conversation
   - `Esc` - Back to results

3. **Conversation view** - Full conversation with highlighted message
   - `j/k` - Navigate messages
   - `Enter` - View full message content
   - `g/G` - Jump to top/bottom
   - `Esc` - Back to matches

4. **Message view** - Complete message content
   - `j/k` - Scroll message
   - `n/p` - Next/previous message
   - `g/G` - Jump to top/bottom
   - `Esc` - Back to conversation

### Analytics Dashboard

The `stats` command provides an interactive analytics dashboard:

```bash
# Interactive dashboard (default: last 30 days)
bun run dev stats

# Quick summary output
bun run dev stats --summary

# Custom time period
bun run dev stats --period 7
```

**Dashboard Features:**
- **Overview Tab**: Activity metrics, token usage, lines generated, source breakdown, recent conversations
- **Tokens Tab**: Token breakdown by model, cache efficiency (Claude Code/Codex), top conversations
- **Activity Tab**: GitHub-style activity heatmap, hourly/weekly distributions, streak tracking
- **Projects Tab**: Statistics grouped by project with drill-down to conversations
- **Files Tab**: Most active files, edit type breakdown (create/modify/delete), file type statistics

**Navigation:**
- `1-3` or `h/l` - Switch tabs
- `j/k` or `↑/↓` - Navigate items
- `Enter` - View conversation details
- `Esc` or `b` - Go back
- `q` - Quit

### Data Storage

All data is stored locally in `~/.dex/`:

```
~/.dex/
├── lancedb/          # Main database (conversations, messages, FTS index)
├── models/           # Embedding models (downloaded on first use)
├── bin/              # llama-server binary (downloaded on first use)
└── embedding-progress.json
```

### Development

```bash
# Run in development mode
bun run dev <command>

# Type checking
bun run typecheck

# Linting
bun run lint
bun run lint:fix
```

### Testing Changes

1. Delete old database: `rm -rf ~/.dex/lancedb`
2. Re-sync: `bun run dev sync --force`
3. Test search: `bun run dev search "your query"`
4. Run typecheck: `bun run typecheck`

---

## Key Implementation Details

### Hybrid Search

Dex uses Reciprocal Rank Fusion (RRF) to combine full-text search (BM25) and vector similarity search:

1. Run FTS search on message content
2. Run vector similarity search using embeddings
3. Combine results using RRF with k=60
4. Sort by combined score

### Incremental Sync

- Tracks `lastMtime` (modification time) of source databases
- Only syncs if source database has changed since last sync
- Preserves existing embeddings when updating conversations
- Use `--force` flag to re-index everything

### Embedding Generation

- Runs in background after sync completes
- Uses llama-server for faster batch processing (falls back to node-llama-cpp)
- Progress tracked in `~/.dex/embedding-progress.json`
- Low CPU priority to minimize user impact
- Model: Qwen3-Embedding-0.6B (1024 dimensions)

### Message Combining

Consecutive assistant messages are combined into single logical messages for better readability, especially when split by tool calls.

### Analytics

The analytics system provides comprehensive insights into conversation usage:

- **Data Aggregation**: Queries aggregate data from conversations, messages, and file_edits tables
- **Period Filtering**: All queries support time period filtering (default: 30 days)
- **File Edit Tracking**: Captures line-level changes (create/modify/delete operations) from tool calls
- **Token Usage**: Includes cache tokens (cacheCreationTokens, cacheReadTokens) for Claude Code/Codex sources
- **Activity Streaks**: Calculated from conversation creation dates, tracks current and longest streaks
- **Project Grouping**: Statistics grouped by project name (extracted from workspacePath)
- **Visual Components**: Uses ActivityHeatmap (GitHub-style), Sparklines, ProgressBars, and HorizontalBars for visualization
- **Performance**: Analytics queries are optimized to scan tables once and aggregate in memory

### Platform Support

- macOS: Full support
- Linux: Full support
- Windows: Full support (with platform-specific path handling)

---

## Notes

- All adapters use deterministic IDs (SHA256 hash) to prevent duplicates on re-sync
- LanceDB FTS index must be rebuilt after bulk data insertion
- Vector index uses IVF-PQ for efficient similarity search
- Empty strings are used instead of null for nullable fields (LanceDB limitation)
- Column names with camelCase need quotes in SQL filters: `"conversationId"`
- Analytics queries aggregate data from conversations, messages, and file_edits tables
- File edit tracking captures line-level changes (create/modify/delete operations)
- Token usage includes cache tokens (cacheCreationTokens, cacheReadTokens) for Claude Code/Codex sources
- Activity streaks are calculated from conversation creation dates

---

## License

MIT

