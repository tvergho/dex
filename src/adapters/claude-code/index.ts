import { createHash } from 'crypto';
import { detectClaudeCode, discoverProjects } from './paths.js';
import { extractConversations, type RawConversation } from './parser.js';
import { Source, type Conversation, type Message, type SourceRef, type ToolCall, type ConversationFile, type MessageFile, type FileEdit } from '../../schema/index.js';
import type { SourceAdapter, SourceLocation, NormalizedConversation, ExtractionProgress } from '../types.js';

export class ClaudeCodeAdapter implements SourceAdapter {
  name = Source.ClaudeCode;

  async detect(): Promise<boolean> {
    return detectClaudeCode();
  }

  async discover(): Promise<SourceLocation[]> {
    const projects = discoverProjects();

    return projects.map((project) => ({
      source: Source.ClaudeCode,
      workspacePath: project.workspacePath,
      dbPath: project.sessionsDir,
      mtime: project.mtime,
    }));
  }

  async extract(
    location: SourceLocation,
    _onProgress?: (progress: ExtractionProgress) => void
  ): Promise<RawConversation[]> {
    // Find the project that matches this location
    const projects = discoverProjects();
    const project = projects.find((p) => p.sessionsDir === location.dbPath);

    if (!project) {
      return [];
    }

    return extractConversations(project);
  }

  normalize(raw: RawConversation, location: SourceLocation): NormalizedConversation {
    // Create deterministic ID from source + session ID
    const conversationId = createHash('sha256')
      .update(`claude-code:${raw.sessionId}`)
      .digest('hex')
      .slice(0, 32);

    const sourceRef: SourceRef = {
      source: Source.ClaudeCode,
      workspacePath: location.workspacePath,
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
      source: Source.ClaudeCode,
      title: raw.title,
      subtitle: raw.gitBranch ? `branch: ${raw.gitBranch}` : undefined,
      workspacePath: raw.workspacePath || raw.cwd,
      projectName: (raw.workspacePath || raw.cwd)?.split('/').pop(),
      model: raw.model,
      mode: 'agent', // Claude Code is always agent mode
      createdAt,
      updatedAt,
      messageCount: raw.messages.length,
      sourceRef,
      totalInputTokens: raw.totalInputTokens,
      totalOutputTokens: raw.totalOutputTokens,
      totalCacheCreationTokens: raw.totalCacheCreationTokens,
      totalCacheReadTokens: raw.totalCacheReadTokens,
      totalLinesAdded: raw.totalLinesAdded,
      totalLinesRemoved: raw.totalLinesRemoved,
    };

    // Filter to main messages (non-sidechain with content)
    const mainMessages = raw.messages.filter((m) => !m.isSidechain && m.content.trim().length > 0);

    // Propagate stats from tool-only assistant messages to the nearest visible assistant message
    // Tool-only messages (empty content but have tokens/line edits) get filtered out, but we want
    // their stats to show on the visible assistant message
    const mainMessageUuids = new Set(mainMessages.map((m) => m.uuid));

    // Track aggregated stats per visible message
    interface AggregatedStats {
      added: number;
      removed: number;
      outputTokens: number;
      // For input, track peak context message
      peakInputTokens: number;
      peakCacheCreationTokens: number;
      peakCacheReadTokens: number;
      peakContext: number;
      // Track file edits from this message and propagated tool-only messages
      fileEdits: typeof raw.messages[0]['fileEdits'];
    }
    const aggregatedStats = new Map<string, AggregatedStats>();

    // Initialize stats for main messages
    for (const msg of mainMessages) {
      const ctx = (msg.inputTokens ?? 0) + (msg.cacheCreationTokens ?? 0) + (msg.cacheReadTokens ?? 0);
      aggregatedStats.set(msg.uuid, {
        added: msg.totalLinesAdded ?? 0,
        removed: msg.totalLinesRemoved ?? 0,
        outputTokens: msg.outputTokens ?? 0,
        peakInputTokens: msg.inputTokens ?? 0,
        peakCacheCreationTokens: msg.cacheCreationTokens ?? 0,
        peakCacheReadTokens: msg.cacheReadTokens ?? 0,
        peakContext: ctx,
        fileEdits: [...msg.fileEdits], // Copy file edits from this message
      });
    }

    // For each tool-only message, find the nearest visible assistant message and add its stats
    for (let i = 0; i < raw.messages.length; i++) {
      const msg = raw.messages[i];
      if (!msg || msg.isSidechain) continue;

      // Skip if this is a main message (already has its own stats)
      if (mainMessageUuids.has(msg.uuid)) continue;

      // This is a tool-only message - find nearest visible assistant message
      if (msg.role === 'assistant') {
        // Look backwards for the nearest visible assistant message
        for (let j = i - 1; j >= 0; j--) {
          const prev = raw.messages[j];
          if (prev && prev.role === 'assistant' && mainMessageUuids.has(prev.uuid)) {
            const stats = aggregatedStats.get(prev.uuid);
            if (stats) {
              // Sum line counts and output tokens
              stats.added += msg.totalLinesAdded ?? 0;
              stats.removed += msg.totalLinesRemoved ?? 0;
              stats.outputTokens += msg.outputTokens ?? 0;

              // For input, use peak context (each API call has full context)
              const ctx = (msg.inputTokens ?? 0) + (msg.cacheCreationTokens ?? 0) + (msg.cacheReadTokens ?? 0);
              if (ctx > stats.peakContext) {
                stats.peakInputTokens = msg.inputTokens ?? 0;
                stats.peakCacheCreationTokens = msg.cacheCreationTokens ?? 0;
                stats.peakCacheReadTokens = msg.cacheReadTokens ?? 0;
                stats.peakContext = ctx;
              }

              // Propagate file edits from tool-only messages
              if (msg.fileEdits.length > 0) {
                stats.fileEdits.push(...msg.fileEdits);
              }
            }
            break;
          }
        }
      }
    }

    const messages: Message[] = mainMessages.map((msg, index) => {
      const stats = aggregatedStats.get(msg.uuid);
      return {
        id: `${conversationId}:${msg.uuid}`,
        conversationId,
        role: msg.role,
        content: msg.content,
        timestamp: msg.timestamp,
        messageIndex: index,
        inputTokens: stats?.peakInputTokens,
        outputTokens: stats && stats.outputTokens > 0 ? stats.outputTokens : undefined,
        cacheCreationTokens: stats?.peakCacheCreationTokens,
        cacheReadTokens: stats?.peakCacheReadTokens,
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
    for (let i = 0; i < mainMessages.length; i++) {
      const msg = mainMessages[i];
      if (!msg) continue;
      const messageId = `${conversationId}:${msg.uuid}`;

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
    for (let i = 0; i < mainMessages.length; i++) {
      const msg = mainMessages[i];
      if (!msg) continue;
      const messageId = `${conversationId}:${msg.uuid}`;

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

    // Build file edits (using aggregated stats which include edits from tool-only messages)
    const fileEdits: FileEdit[] = [];
    for (let i = 0; i < mainMessages.length; i++) {
      const msg = mainMessages[i];
      if (!msg) continue;
      const messageId = `${conversationId}:${msg.uuid}`;
      const stats = aggregatedStats.get(msg.uuid);
      const msgFileEdits = stats?.fileEdits ?? msg.fileEdits;

      for (let j = 0; j < msgFileEdits.length; j++) {
        const edit = msgFileEdits[j];
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
    // Claude Code CLI doesn't have URL-based deep linking
    return null;
  }
}

export const claudeCodeAdapter = new ClaudeCodeAdapter();
