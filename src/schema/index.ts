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
