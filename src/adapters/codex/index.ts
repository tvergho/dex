import { createHash } from 'crypto';
import { detectCodex, discoverSessions } from './paths.js';
import { extractConversation, type RawConversation } from './parser.js';
import { Source, type Conversation, type Message, type SourceRef, type ToolCall, type ConversationFile, type MessageFile, type FileEdit } from '../../schema/index.js';
import type { SourceAdapter, SourceLocation, NormalizedConversation, ExtractionProgress } from '../types.js';

export class CodexAdapter implements SourceAdapter {
  name = Source.Codex;

  async detect(): Promise<boolean> {
    return detectCodex();
  }

  async discover(): Promise<SourceLocation[]> {
    const sessions = discoverSessions();

    // Group sessions by workspace path (cwd)
    // For Codex, each session file is a separate conversation, but we can group by workspace
    // For now, return each session as a separate location since we need to read the file to know the cwd
    return sessions.map((session) => ({
      source: Source.Codex,
      workspacePath: session.workspacePath || 'unknown', // Will be updated after extraction
      dbPath: session.filePath, // Use the JSONL file path as dbPath
      mtime: session.mtime,
    }));
  }

  async extract(
    location: SourceLocation,
    _onProgress?: (progress: ExtractionProgress) => void
  ): Promise<RawConversation[]> {
    // Extract session ID from the file path
    const match = location.dbPath.match(/rollout-[\d-T]+-([a-f0-9-]+)\.jsonl$/);
    const sessionId = match?.[1] || location.dbPath;

    const conversation = extractConversation(sessionId, location.dbPath);

    if (!conversation) {
      return [];
    }

    return [conversation];
  }

  normalize(raw: RawConversation, location: SourceLocation): NormalizedConversation {
    // Create deterministic ID from source + session ID
    const conversationId = createHash('sha256').update(`codex:${raw.sessionId}`).digest('hex').slice(0, 32);

    const workspacePath = raw.workspacePath || raw.cwd || location.workspacePath;
    const projectName = raw.projectName || (workspacePath ? workspacePath.split('/').filter(Boolean).pop() : undefined);

    const sourceRef: SourceRef = {
      source: Source.Codex,
      workspacePath,
      originalId: raw.sessionId,
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

    if (raw.updatedAt) {
      try {
        updatedAt = new Date(raw.updatedAt).toISOString();
      } catch {
        // Skip invalid timestamps
      }
    }

    // Build conversation
    const conversation: Conversation = {
      id: conversationId,
      source: Source.Codex,
      title: raw.title,
      subtitle: raw.gitBranch ? `branch: ${raw.gitBranch}` : undefined,
      workspacePath,
      projectName,
      model: raw.model,
      mode: 'agent', // Codex CLI is always agent mode
      createdAt,
      updatedAt,
      messageCount: raw.messages.length,
      sourceRef,
      // Token totals from session
      totalInputTokens: raw.totalInputTokens,
      totalOutputTokens: raw.totalOutputTokens,
      totalCacheReadTokens: raw.totalCacheReadTokens,
      totalLinesAdded: raw.totalLinesAdded,
      totalLinesRemoved: raw.totalLinesRemoved,
    };

    // Build messages
    const messages: Message[] = raw.messages.map((msg) => ({
      id: `${conversationId}:${msg.index}`,
      conversationId,
      role: msg.role,
      content: msg.content,
      timestamp: msg.timestamp,
      messageIndex: msg.index,
      // Codex only has session-level token counts, not per-message
      totalLinesAdded: msg.totalLinesAdded,
      totalLinesRemoved: msg.totalLinesRemoved,
    }));

    // Build conversation files
    const files: ConversationFile[] = raw.files.map((file, index) => ({
      id: `${conversationId}:file:${index}`,
      conversationId,
      filePath: file.path,
      role: file.role,
    }));

    // Build message files (per-message file associations)
    const messageFiles: MessageFile[] = [];
    for (const msg of raw.messages) {
      const messageId = `${conversationId}:${msg.index}`;

      for (let j = 0; j < msg.files.length; j++) {
        const file = msg.files[j];
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

    // Build tool calls
    const toolCalls: ToolCall[] = [];
    for (const msg of raw.messages) {
      const messageId = `${conversationId}:${msg.index}`;

      for (const tc of msg.toolCalls) {
        toolCalls.push({
          id: `${messageId}:tool:${tc.id}`,
          messageId,
          conversationId,
          type: tc.name,
          input: tc.input,
          output: tc.output,
          filePath: tc.filePath,
        });
      }
    }

    // Build file edits
    const fileEdits: FileEdit[] = [];
    for (const msg of raw.messages) {
      const messageId = `${conversationId}:${msg.index}`;

      for (let j = 0; j < msg.fileEdits.length; j++) {
        const edit = msg.fileEdits[j];
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
    // Codex CLI doesn't have URL-based deep linking
    return null;
  }
}

export const codexAdapter = new CodexAdapter();
