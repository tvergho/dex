import { createHash } from 'crypto';
import { getGlobalDatabase } from './paths';
import { extractConversations, type RawConversation } from './parser';
import type { Conversation, Message, SourceRef, ToolCall, ConversationFile, MessageFile } from '../../schema/index';
import type { SourceAdapter, SourceLocation, NormalizedConversation } from '../types';

export class CursorAdapter implements SourceAdapter {
  name = 'cursor' as const;

  async detect(): Promise<boolean> {
    const globalDb = getGlobalDatabase();
    return globalDb !== null;
  }

  async discover(): Promise<SourceLocation[]> {
    const globalDb = getGlobalDatabase();
    if (!globalDb) return [];

    // Cursor stores all conversations in a single global database
    return [{
      source: 'cursor' as const,
      workspacePath: 'global',
      dbPath: globalDb.dbPath,
      mtime: globalDb.mtime,
    }];
  }

  async extract(location: SourceLocation): Promise<RawConversation[]> {
    return extractConversations(location.dbPath);
  }

  normalize(raw: RawConversation, location: SourceLocation): NormalizedConversation {
    // Create deterministic ID from source + original ID to avoid duplicates on re-sync
    const conversationId = createHash('sha256')
      .update(`cursor:${raw.composerId}`)
      .digest('hex')
      .slice(0, 32);

    const sourceRef: SourceRef = {
      source: 'cursor',
      workspacePath: undefined,
      originalId: raw.composerId,
      dbPath: location.dbPath,
    };

    // Parse timestamps
    let createdAt: string | undefined;
    let updatedAt: string | undefined;

    if (raw.createdAt) {
      try {
        createdAt = new Date(raw.createdAt).toISOString();
      } catch {
        // Skip invalid timestamps
      }
    }

    if (raw.lastUpdatedAt) {
      try {
        updatedAt = new Date(raw.lastUpdatedAt).toISOString();
      } catch {
        // Skip invalid timestamps
      }
    }

    // Build conversation
    const conversation: Conversation = {
      id: conversationId,
      source: 'cursor',
      title: raw.name || 'Untitled',
      subtitle: undefined,
      workspacePath: raw.workspacePath,
      projectName: raw.projectName,
      model: raw.model,
      mode: raw.mode,
      createdAt,
      updatedAt,
      messageCount: raw.bubbles.length,
      sourceRef,
      totalInputTokens: raw.totalInputTokens,
      totalOutputTokens: raw.totalOutputTokens,
    };

    // Build messages (filter out empty content)
    const messages: Message[] = raw.bubbles
      .filter((bubble) => bubble.text.trim().length > 0)
      .map((bubble, index) => {
        return {
          id: `${conversationId}:${bubble.bubbleId}`,
          conversationId,
          role: bubble.type,
          content: bubble.text,
          timestamp: undefined,
          messageIndex: index,
          inputTokens: bubble.inputTokens,
          outputTokens: bubble.outputTokens,
        };
      });

    // Build conversation files
    const files: ConversationFile[] = raw.files.map((file, index) => ({
      id: `${conversationId}:file:${index}`,
      conversationId,
      filePath: file.path,
      role: file.role,
    }));

    // Build message files (per-message file associations)
    const messageFiles: MessageFile[] = [];
    for (let i = 0; i < raw.bubbles.length; i++) {
      const bubble = raw.bubbles[i];
      if (!bubble) continue;
      const messageId = `${conversationId}:${bubble.bubbleId}`;

      for (let j = 0; j < bubble.files.length; j++) {
        const file = bubble.files[j];
        if (!file) continue;
        messageFiles.push({
          id: `${messageId}:file:${j}`,
          messageId,
          conversationId,
          filePath: file.path,
          role: file.role,
        });
      }
    }

    // Tool calls - not implemented yet
    const toolCalls: ToolCall[] = [];

    return {
      conversation,
      messages,
      toolCalls,
      files,
      messageFiles,
    };
  }

  getDeepLink(_ref: SourceRef): string | null {
    // Cursor doesn't have a way to open a specific conversation via URL/CLI
    return null;
  }
}

export const cursorAdapter = new CursorAdapter();
