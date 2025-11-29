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
