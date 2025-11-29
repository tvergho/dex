import { createHash } from 'crypto';
import { detectClaudeCode, discoverProjects } from './paths.js';
import { extractConversations, type RawConversation } from './parser.js';
import type { Conversation, Message, SourceRef, ToolCall, ConversationFile, MessageFile } from '../../schema/index.js';
import type { SourceAdapter, SourceLocation, NormalizedConversation } from '../types.js';

export class ClaudeCodeAdapter implements SourceAdapter {
  name = 'claude-code' as const;

  async detect(): Promise<boolean> {
    return detectClaudeCode();
  }

  async discover(): Promise<SourceLocation[]> {
    const projects = discoverProjects();

    return projects.map((project) => ({
      source: 'claude-code' as const,
      workspacePath: project.workspacePath,
      dbPath: project.sessionsDir,
      mtime: project.mtime,
    }));
  }

  async extract(location: SourceLocation): Promise<RawConversation[]> {
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
      source: 'claude-code',
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
      source: 'claude-code',
      title: raw.title,
      subtitle: raw.gitBranch ? `branch: ${raw.gitBranch}` : undefined,
      workspacePath: raw.workspacePath || raw.cwd,
      projectName: raw.workspacePath?.split('/').pop(),
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
    };

    // Build messages (filter out empty content and sidechain messages)
    const mainMessages = raw.messages.filter((m) => !m.isSidechain && m.content.trim().length > 0);

    const messages: Message[] = mainMessages.map((msg, index) => ({
      id: `${conversationId}:${msg.uuid}`,
      conversationId,
      role: msg.role,
      content: msg.content,
      timestamp: msg.timestamp,
      messageIndex: index,
      inputTokens: msg.inputTokens,
      outputTokens: msg.outputTokens,
      cacheCreationTokens: msg.cacheCreationTokens,
      cacheReadTokens: msg.cacheReadTokens,
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

    return {
      conversation,
      messages,
      toolCalls,
      files,
      messageFiles,
    };
  }

  getDeepLink(_ref: SourceRef): string | null {
    // Claude Code CLI doesn't have URL-based deep linking
    return null;
  }
}

export const claudeCodeAdapter = new ClaudeCodeAdapter();
