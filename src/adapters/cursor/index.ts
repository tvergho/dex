import { createHash } from 'crypto';
import { getGlobalDatabase } from './paths';
import { extractConversations, type RawConversation } from './parser';
import { Source, type Conversation, type Message, type SourceRef, type ToolCall, type ConversationFile, type MessageFile, type FileEdit } from '../../schema/index';
import type { SourceAdapter, SourceLocation, NormalizedConversation } from '../types';

export class CursorAdapter implements SourceAdapter {
  name = Source.Cursor;

  async detect(): Promise<boolean> {
    const globalDb = getGlobalDatabase();
    return globalDb !== null;
  }

  async discover(): Promise<SourceLocation[]> {
    const globalDb = getGlobalDatabase();
    if (!globalDb) return [];

    // Cursor stores all conversations in a single global database
    return [{
      source: Source.Cursor,
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
      source: Source.Cursor,
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
      source: Source.Cursor,
      title: raw.name || 'Untitled',
      subtitle: undefined,
      workspacePath: raw.workspacePath,
      projectName: raw.projectName || (raw.workspacePath ? undefined : '(cursor)'),
      model: raw.model,
      mode: raw.mode,
      createdAt,
      updatedAt,
      messageCount: raw.bubbles.length,
      sourceRef,
      totalInputTokens: raw.totalInputTokens,
      totalOutputTokens: raw.totalOutputTokens,
      totalLinesAdded: raw.totalLinesAdded,
      totalLinesRemoved: raw.totalLinesRemoved,
    };

    // Filter to main messages (with content)
    const mainBubbles = raw.bubbles.filter((bubble) => bubble.text.trim().length > 0);

    // Propagate stats from tool-only bubbles to the nearest visible assistant bubble
    // Tool-only bubbles (empty text but have tokens/line edits) get filtered out, but we want
    // their stats to show on the visible assistant message
    const mainBubbleIds = new Set(mainBubbles.map((b) => b.bubbleId));

    // Track aggregated stats per visible bubble
    interface AggregatedStats {
      added: number;
      removed: number;
      outputTokens: number;
      // For input, track peak context
      peakInputTokens: number;
    }
    const aggregatedStats = new Map<string, AggregatedStats>();

    // Initialize stats for main bubbles
    for (const bubble of mainBubbles) {
      aggregatedStats.set(bubble.bubbleId, {
        added: bubble.totalLinesAdded ?? 0,
        removed: bubble.totalLinesRemoved ?? 0,
        outputTokens: bubble.outputTokens ?? 0,
        peakInputTokens: bubble.inputTokens ?? 0,
      });
    }

    // For each tool-only bubble, find the nearest visible assistant bubble and add its stats
    for (let i = 0; i < raw.bubbles.length; i++) {
      const bubble = raw.bubbles[i];
      if (!bubble) continue;

      // Skip if this is a main bubble (already has its own stats)
      if (mainBubbleIds.has(bubble.bubbleId)) continue;

      // This is a tool-only bubble - find nearest visible assistant bubble
      if (bubble.type === 'assistant') {
        // Look backwards for the nearest visible assistant bubble
        for (let j = i - 1; j >= 0; j--) {
          const prev = raw.bubbles[j];
          if (prev && prev.type === 'assistant' && mainBubbleIds.has(prev.bubbleId)) {
            const stats = aggregatedStats.get(prev.bubbleId);
            if (stats) {
              // Sum line counts and output tokens
              stats.added += bubble.totalLinesAdded ?? 0;
              stats.removed += bubble.totalLinesRemoved ?? 0;
              stats.outputTokens += bubble.outputTokens ?? 0;

              // For input, use peak (each API call has full context)
              const inputTokens = bubble.inputTokens ?? 0;
              if (inputTokens > stats.peakInputTokens) {
                stats.peakInputTokens = inputTokens;
              }
            }
            break;
          }
        }
      }
    }

    const messages: Message[] = mainBubbles.map((bubble, index) => {
      const stats = aggregatedStats.get(bubble.bubbleId);
      return {
        id: `${conversationId}:${bubble.bubbleId}`,
        conversationId,
        role: bubble.type,
        content: bubble.text,
        timestamp: undefined,
        messageIndex: index,
        inputTokens: stats?.peakInputTokens,
        outputTokens: stats && stats.outputTokens > 0 ? stats.outputTokens : undefined,
        totalLinesAdded: stats && stats.added > 0 ? stats.added : undefined,
        totalLinesRemoved: stats && stats.removed > 0 ? stats.removed : undefined,
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

    // Build file edits
    const fileEdits: FileEdit[] = [];
    for (let i = 0; i < raw.bubbles.length; i++) {
      const bubble = raw.bubbles[i];
      if (!bubble) continue;
      const messageId = `${conversationId}:${bubble.bubbleId}`;

      for (let j = 0; j < bubble.fileEdits.length; j++) {
        const edit = bubble.fileEdits[j];
        if (!edit) continue;

        // Create deterministic ID from edit properties
        const editId = createHash('sha256')
          .update(`${messageId}:edit:${j}:${edit.filePath}`)
          .digest('hex')
          .slice(0, 32);

        fileEdits.push({
          id: editId,
          messageId,
          conversationId,
          filePath: edit.filePath,
          editType: edit.editType,
          linesAdded: edit.linesAdded,
          linesRemoved: edit.linesRemoved,
          startLine: edit.startLine,
          endLine: edit.endLine,
          newContent: edit.newContent,
        });
      }
    }

    return {
      conversation,
      messages,
      toolCalls,
      files,
      messageFiles,
      fileEdits,
    };
  }

  getDeepLink(_ref: SourceRef): string | null {
    // Cursor doesn't have a way to open a specific conversation via URL/CLI
    return null;
  }
}

export const cursorAdapter = new CursorAdapter();
