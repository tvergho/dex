import { z } from 'zod';

// Source constants - single source of truth for valid source IDs
export const Source = {
  Cursor: 'cursor',
  ClaudeCode: 'claude-code',
  Codex: 'codex',
  OpenCode: 'opencode',
} as const;

// Type for source values
export type SourceType = (typeof Source)[keyof typeof Source];

// All valid source values as array
export const ALL_SOURCES: readonly SourceType[] = Object.values(Source);

// Zod schema for validation (uses tuple type for z.enum)
export const SourceTypeSchema = z.enum([
  Source.Cursor,
  Source.ClaudeCode,
  Source.Codex,
  Source.OpenCode,
]);

// Source display information
export interface SourceInfo {
  id: SourceType;
  name: string;
  color: string;
}

export const SOURCE_INFO: Record<SourceType, SourceInfo> = {
  [Source.Cursor]: { id: Source.Cursor, name: 'Cursor', color: 'cyan' },
  [Source.ClaudeCode]: { id: Source.ClaudeCode, name: 'Claude Code', color: 'magenta' },
  [Source.Codex]: { id: Source.Codex, name: 'Codex', color: 'yellow' },
  [Source.OpenCode]: { id: Source.OpenCode, name: 'OpenCode', color: 'green' },
};

/**
 * Get display info for a source
 */
export function getSourceInfo(source: string): SourceInfo {
  const normalized = source.toLowerCase();
  const info = SOURCE_INFO[normalized as SourceType];
  if (info) {
    return info;
  }
  // Fallback for unknown sources
  return {
    id: normalized as SourceType,
    name: source.charAt(0).toUpperCase() + source.slice(1),
    color: 'white',
  };
}

// Reference back to original source for deep linking
export const SourceRef = z.object({
  source: SourceTypeSchema,
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
  // Line edit tracking (aggregated from file_edits)
  totalLinesAdded: z.number().optional(),
  totalLinesRemoved: z.number().optional(),
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
  source: SourceTypeSchema,
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
  // Line edit tracking (aggregated from file_edits)
  totalLinesAdded: z.number().optional(),
  totalLinesRemoved: z.number().optional(),
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

// Individual file edit tracked per message
export const FileEdit = z.object({
  id: z.string(), // SHA256 hash for deduplication
  messageId: z.string(),
  conversationId: z.string(),
  filePath: z.string(),
  editType: z.enum(['create', 'modify', 'delete']),
  linesAdded: z.number(),
  linesRemoved: z.number(),
  startLine: z.number().optional(), // Only available for Cursor
  endLine: z.number().optional(), // Only available for Cursor
});
export type FileEdit = z.infer<typeof FileEdit>;

// Sync state for incremental updates
export const SyncState = z.object({
  source: SourceTypeSchema,
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

// Export/backup archive format for migration between machines
export const ExportedConversation = z.object({
  conversation: Conversation,
  messages: z.array(Message),
  toolCalls: z.array(ToolCall),
  files: z.array(ConversationFile),
  messageFiles: z.array(MessageFile),
  fileEdits: z.array(FileEdit),
});
export type ExportedConversation = z.infer<typeof ExportedConversation>;

export const ExportArchive = z.object({
  version: z.string(),
  exportedAt: z.string().datetime(),
  machine: z.string().optional(),
  conversations: z.array(ExportedConversation),
});
export type ExportArchive = z.infer<typeof ExportArchive>;
