/**
 * Tests for messageCount filtering behavior across adapters.
 *
 * These tests verify that tool-only messages (messages with empty content)
 * are excluded from the messageCount in all adapters, ensuring consistency.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { TempDir } from '../../helpers/temp';
import {
  createClaudeCodeProject,
  createOpenCodeStorage,
  type MockClaudeEntry,
  type MockOpenCodeSession,
  type MockOpenCodeMessage,
  type MockOpenCodePart,
} from '../../helpers/sources';
import { extractConversations as extractClaudeCode } from '../../../src/adapters/claude-code/parser';
import { extractConversation as extractOpenCode } from '../../../src/adapters/opencode/parser';
import { ClaudeCodeAdapter } from '../../../src/adapters/claude-code/index';
import { OpenCodeAdapter } from '../../../src/adapters/opencode/index';
import { Source } from '../../../src/schema/index';

describe('messageCount filtering', () => {
  let temp: TempDir;

  beforeEach(() => {
    temp = new TempDir();
  });

  afterEach(async () => {
    await temp.cleanupAll();
  });

  describe('Claude Code adapter', () => {
    const adapter = new ClaudeCodeAdapter();

    it('excludes sidechain messages from messageCount', async () => {
      const baseDir = await temp.create();
      const entries: MockClaudeEntry[] = [
        {
          type: 'user',
          uuid: 'msg-1',
          timestamp: '2025-01-15T10:00:00.000Z',
          message: { role: 'user', content: 'Hello' },
        },
        {
          type: 'assistant',
          uuid: 'msg-2',
          timestamp: '2025-01-15T10:00:01.000Z',
          message: { role: 'assistant', content: 'Hi there!' },
        },
        {
          type: 'assistant',
          uuid: 'msg-3',
          timestamp: '2025-01-15T10:00:02.000Z',
          isSidechain: true, // Sidechain message - should be excluded
          message: { role: 'assistant', content: 'Sidechain content' },
        },
      ];

      const sessionsDir = await createClaudeCodeProject(baseDir, [
        { sessionId: 'session-1', entries },
      ]);

      const rawConversations = extractClaudeCode({
        sessionsDir,
        workspacePath: '/home/user/project',
      });

      const normalized = adapter.normalize(rawConversations[0]!, {
        source: Source.ClaudeCode,
        workspacePath: '/home/user/project',
        dbPath: sessionsDir,
        mtime: Date.now(),
      });

      // Should have 2 messages (user + non-sidechain assistant), not 3
      expect(normalized.conversation.messageCount).toBe(2);
      expect(normalized.messages.length).toBe(2);
    });

    it('excludes messages with empty content from messageCount', async () => {
      const baseDir = await temp.create();
      const entries: MockClaudeEntry[] = [
        {
          type: 'user',
          uuid: 'msg-1',
          timestamp: '2025-01-15T10:00:00.000Z',
          message: { role: 'user', content: 'Hello' },
        },
        {
          type: 'assistant',
          uuid: 'msg-2',
          timestamp: '2025-01-15T10:00:01.000Z',
          message: { role: 'assistant', content: 'Let me help you.' },
        },
        {
          type: 'assistant',
          uuid: 'msg-3',
          timestamp: '2025-01-15T10:00:02.000Z',
          message: {
            role: 'assistant',
            // Empty string content - this is a tool-only message with no text
            content: '',
            usage: { output_tokens: 100 },
          },
        },
        {
          type: 'assistant',
          uuid: 'msg-4',
          timestamp: '2025-01-15T10:00:03.000Z',
          message: { role: 'assistant', content: 'Done reading the file.' },
        },
      ];

      const sessionsDir = await createClaudeCodeProject(baseDir, [
        { sessionId: 'session-1', entries },
      ]);

      const rawConversations = extractClaudeCode({
        sessionsDir,
        workspacePath: '/home/user/project',
      });

      const normalized = adapter.normalize(rawConversations[0]!, {
        source: Source.ClaudeCode,
        workspacePath: '/home/user/project',
        dbPath: sessionsDir,
        mtime: Date.now(),
      });

      // msg-1: user "Hello" -> included
      // msg-2: assistant "Let me help you." -> included
      // msg-3: assistant empty content -> EXCLUDED
      // msg-4: assistant "Done reading the file." -> included
      expect(normalized.conversation.messageCount).toBe(3);
      expect(normalized.messages.length).toBe(3);
      expect(normalized.messages.map((m) => m.content)).toEqual([
        'Hello',
        'Let me help you.',
        'Done reading the file.',
      ]);
    });

    it('excludes whitespace-only messages from messageCount', async () => {
      const baseDir = await temp.create();
      const entries: MockClaudeEntry[] = [
        {
          type: 'user',
          uuid: 'msg-1',
          timestamp: '2025-01-15T10:00:00.000Z',
          message: { role: 'user', content: 'Hello' },
        },
        {
          type: 'assistant',
          uuid: 'msg-2',
          timestamp: '2025-01-15T10:00:01.000Z',
          message: { role: 'assistant', content: '   ' }, // Whitespace only
        },
        {
          type: 'assistant',
          uuid: 'msg-3',
          timestamp: '2025-01-15T10:00:02.000Z',
          message: { role: 'assistant', content: 'Real response' },
        },
      ];

      const sessionsDir = await createClaudeCodeProject(baseDir, [
        { sessionId: 'session-1', entries },
      ]);

      const rawConversations = extractClaudeCode({
        sessionsDir,
        workspacePath: '/home/user/project',
      });

      const normalized = adapter.normalize(rawConversations[0]!, {
        source: Source.ClaudeCode,
        workspacePath: '/home/user/project',
        dbPath: sessionsDir,
        mtime: Date.now(),
      });

      // Should only have 2 messages, whitespace-only is excluded
      expect(normalized.conversation.messageCount).toBe(2);
      expect(normalized.messages.length).toBe(2);
    });

    it('messageCount matches stored messages length', async () => {
      const baseDir = await temp.create();
      const entries: MockClaudeEntry[] = [
        {
          type: 'user',
          uuid: 'msg-1',
          timestamp: '2025-01-15T10:00:00.000Z',
          message: { role: 'user', content: 'Query 1' },
        },
        {
          type: 'assistant',
          uuid: 'msg-2',
          timestamp: '2025-01-15T10:00:01.000Z',
          message: { role: 'assistant', content: '' }, // Empty - excluded
        },
        {
          type: 'assistant',
          uuid: 'msg-3',
          timestamp: '2025-01-15T10:00:02.000Z',
          isSidechain: true, // Sidechain - excluded
          message: { role: 'assistant', content: 'Sidechain' },
        },
        {
          type: 'assistant',
          uuid: 'msg-4',
          timestamp: '2025-01-15T10:00:03.000Z',
          message: { role: 'assistant', content: 'Response 1' },
        },
        {
          type: 'user',
          uuid: 'msg-5',
          timestamp: '2025-01-15T10:00:04.000Z',
          message: { role: 'user', content: 'Query 2' },
        },
        {
          type: 'assistant',
          uuid: 'msg-6',
          timestamp: '2025-01-15T10:00:05.000Z',
          message: { role: 'assistant', content: '\n\t\n' }, // Whitespace - excluded
        },
        {
          type: 'assistant',
          uuid: 'msg-7',
          timestamp: '2025-01-15T10:00:06.000Z',
          message: { role: 'assistant', content: 'Response 2' },
        },
      ];

      const sessionsDir = await createClaudeCodeProject(baseDir, [
        { sessionId: 'session-1', entries },
      ]);

      const rawConversations = extractClaudeCode({
        sessionsDir,
        workspacePath: '/home/user/project',
      });

      const normalized = adapter.normalize(rawConversations[0]!, {
        source: Source.ClaudeCode,
        workspacePath: '/home/user/project',
        dbPath: sessionsDir,
        mtime: Date.now(),
      });

      // messageCount should always equal messages.length
      expect(normalized.conversation.messageCount).toBe(normalized.messages.length);
      // Should be 4: Query 1, Response 1, Query 2, Response 2
      expect(normalized.conversation.messageCount).toBe(4);
    });

    it('propagates stats from tool-only messages to visible messages', async () => {
      const baseDir = await temp.create();
      const entries: MockClaudeEntry[] = [
        {
          type: 'user',
          uuid: 'msg-1',
          timestamp: '2025-01-15T10:00:00.000Z',
          message: { role: 'user', content: 'Edit the file' },
        },
        {
          type: 'assistant',
          uuid: 'msg-2',
          timestamp: '2025-01-15T10:00:01.000Z',
          message: {
            role: 'assistant',
            content: 'I will edit the file.',
            usage: { output_tokens: 50 },
          },
        },
        {
          type: 'assistant',
          uuid: 'msg-3',
          timestamp: '2025-01-15T10:00:02.000Z',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'tool-1',
                name: 'Edit',
                input: { file_path: '/file.ts', old_string: 'a', new_string: 'b\nc' },
              },
            ],
            usage: { output_tokens: 100, input_tokens: 500 },
          },
        },
      ];

      const sessionsDir = await createClaudeCodeProject(baseDir, [
        { sessionId: 'session-1', entries },
      ]);

      const rawConversations = extractClaudeCode({
        sessionsDir,
        workspacePath: '/home/user/project',
      });

      const normalized = adapter.normalize(rawConversations[0]!, {
        source: Source.ClaudeCode,
        workspacePath: '/home/user/project',
        dbPath: sessionsDir,
        mtime: Date.now(),
      });

      // Only 2 messages (user + visible assistant), not 3
      expect(normalized.conversation.messageCount).toBe(2);
      expect(normalized.messages.length).toBe(2);

      // The visible assistant message should have aggregated stats
      const visibleAssistant = normalized.messages.find((m) => m.role === 'assistant');
      expect(visibleAssistant).toBeDefined();
      // Output tokens should be summed: 50 + 100 = 150
      expect(visibleAssistant!.outputTokens).toBe(150);
    });
  });

  describe('OpenCode adapter', () => {
    const adapter = new OpenCodeAdapter();

    it('excludes messages with empty content from messageCount', async () => {
      const baseDir = await temp.create();
      const now = Date.now();

      const session: MockOpenCodeSession = {
        id: 'session-1',
        projectID: 'project-1',
        directory: '/home/user/project',
        title: 'Test',
        time: { created: now },
      };

      // Create messages where one has no text parts (only tool), so content is empty
      // Note: message IDs must start with "msg_" to match the parser's expectations
      const messages: MockOpenCodeMessage[] = [
        { id: 'msg_1', sessionID: 'session-1', role: 'user', time: { created: now } },
        { id: 'msg_2', sessionID: 'session-1', role: 'assistant', time: { created: now + 1000 } },
        { id: 'msg_3', sessionID: 'session-1', role: 'assistant', time: { created: now + 2000 } }, // Tool-only, no text parts
        { id: 'msg_4', sessionID: 'session-1', role: 'assistant', time: { created: now + 3000 } }, // Has text
      ];

      const parts: MockOpenCodePart[] = [
        { id: 'prt_1', sessionID: 'session-1', messageID: 'msg_1', type: 'text', text: 'Hello' },
        { id: 'prt_2', sessionID: 'session-1', messageID: 'msg_2', type: 'text', text: 'Hi there!' },
        // msg_3 only has a tool part, no text - will be empty content
        {
          id: 'prt_3',
          sessionID: 'session-1',
          messageID: 'msg_3',
          type: 'tool',
          tool: 'read',
          state: { input: { path: '/file.ts' } },
        },
        { id: 'prt_4', sessionID: 'session-1', messageID: 'msg_4', type: 'text', text: 'Done!' },
      ];

      const { sessionFile, messageDir } = await createOpenCodeStorage(baseDir, {
        session,
        messages,
        parts,
      });

      const rawConversation = extractOpenCode({
        sessionId: 'session-1',
        sessionFile,
        messageDir,
        workspacePath: '/home/user/project',
      });

      expect(rawConversation).not.toBeNull();

      const normalized = adapter.normalize(rawConversation!, {
        source: Source.OpenCode,
        workspacePath: '/home/user/project',
        dbPath: sessionFile,
        mtime: Date.now(),
      });

      // Should have 3 messages (user + 2 assistants with text), not 4
      // msg-3 has empty content (tool-only) and should be excluded
      expect(normalized.conversation.messageCount).toBe(3);
      expect(normalized.messages.length).toBe(3);
    });

    it('excludes whitespace-only messages from messageCount', async () => {
      const baseDir = await temp.create();
      const now = Date.now();

      const session: MockOpenCodeSession = {
        id: 'session-1',
        projectID: 'project-1',
        directory: '/home/user/project',
        time: { created: now },
      };

      const messages: MockOpenCodeMessage[] = [
        { id: 'msg_1', sessionID: 'session-1', role: 'user', time: { created: now } },
        { id: 'msg_2', sessionID: 'session-1', role: 'assistant', time: { created: now + 1000 } },
        { id: 'msg_3', sessionID: 'session-1', role: 'assistant', time: { created: now + 2000 } },
      ];

      const parts: MockOpenCodePart[] = [
        { id: 'prt_1', sessionID: 'session-1', messageID: 'msg_1', type: 'text', text: 'Hello' },
        { id: 'prt_2', sessionID: 'session-1', messageID: 'msg_2', type: 'text', text: '   ' }, // Whitespace only
        { id: 'prt_3', sessionID: 'session-1', messageID: 'msg_3', type: 'text', text: 'Response' },
      ];

      const { sessionFile, messageDir } = await createOpenCodeStorage(baseDir, {
        session,
        messages,
        parts,
      });

      const rawConversation = extractOpenCode({
        sessionId: 'session-1',
        sessionFile,
        messageDir,
        workspacePath: '/home/user/project',
      });

      expect(rawConversation).not.toBeNull();

      const normalized = adapter.normalize(rawConversation!, {
        source: Source.OpenCode,
        workspacePath: '/home/user/project',
        dbPath: sessionFile,
        mtime: Date.now(),
      });

      // Should have 2 messages, whitespace-only excluded
      expect(normalized.conversation.messageCount).toBe(2);
      expect(normalized.messages.length).toBe(2);
    });

    it('messageCount matches stored messages length', async () => {
      const baseDir = await temp.create();
      const now = Date.now();

      const session: MockOpenCodeSession = {
        id: 'session-1',
        projectID: 'project-1',
        directory: '/home/user/project',
        time: { created: now },
      };

      const messages: MockOpenCodeMessage[] = [
        { id: 'msg_1', sessionID: 'session-1', role: 'user', time: { created: now } },
        { id: 'msg_2', sessionID: 'session-1', role: 'assistant', time: { created: now + 1000 } },
        { id: 'msg_3', sessionID: 'session-1', role: 'assistant', time: { created: now + 2000 } }, // Tool-only
        { id: 'msg_4', sessionID: 'session-1', role: 'user', time: { created: now + 3000 } },
        { id: 'msg_5', sessionID: 'session-1', role: 'assistant', time: { created: now + 4000 } },
      ];

      const parts: MockOpenCodePart[] = [
        { id: 'prt_1', sessionID: 'session-1', messageID: 'msg_1', type: 'text', text: 'Query 1' },
        { id: 'prt_2', sessionID: 'session-1', messageID: 'msg_2', type: 'text', text: 'Response 1' },
        // msg_3 has no text parts - tool only, empty content
        { id: 'prt_3', sessionID: 'session-1', messageID: 'msg_3', type: 'tool', tool: 'read', state: {} },
        { id: 'prt_4', sessionID: 'session-1', messageID: 'msg_4', type: 'text', text: 'Query 2' },
        { id: 'prt_5', sessionID: 'session-1', messageID: 'msg_5', type: 'text', text: 'Response 2' },
      ];

      const { sessionFile, messageDir } = await createOpenCodeStorage(baseDir, {
        session,
        messages,
        parts,
      });

      const rawConversation = extractOpenCode({
        sessionId: 'session-1',
        sessionFile,
        messageDir,
        workspacePath: '/home/user/project',
      });

      expect(rawConversation).not.toBeNull();

      const normalized = adapter.normalize(rawConversation!, {
        source: Source.OpenCode,
        workspacePath: '/home/user/project',
        dbPath: sessionFile,
        mtime: Date.now(),
      });

      // messageCount should always equal messages.length
      expect(normalized.conversation.messageCount).toBe(normalized.messages.length);
      // Should be 4: Query 1, Response 1, Query 2, Response 2 (msg-3 excluded)
      expect(normalized.conversation.messageCount).toBe(4);
    });
  });

  describe('consistency across adapters', () => {
    it('all adapters use same filtering logic for empty content', async () => {
      const baseDir = await temp.create();

      // Test Claude Code
      const claudeAdapter = new ClaudeCodeAdapter();
      const claudeEntries: MockClaudeEntry[] = [
        {
          type: 'user',
          uuid: 'msg-1',
          timestamp: '2025-01-15T10:00:00.000Z',
          message: { role: 'user', content: 'Hello' },
        },
        {
          type: 'assistant',
          uuid: 'msg-2',
          timestamp: '2025-01-15T10:00:01.000Z',
          message: { role: 'assistant', content: '' }, // Empty - excluded
        },
        {
          type: 'assistant',
          uuid: 'msg-3',
          timestamp: '2025-01-15T10:00:02.000Z',
          message: { role: 'assistant', content: 'Response' },
        },
      ];

      const claudeSessionsDir = await createClaudeCodeProject(baseDir, [
        { sessionId: 'session-1', entries: claudeEntries },
      ]);

      const claudeRaw = extractClaudeCode({
        sessionsDir: claudeSessionsDir,
        workspacePath: '/home/user/project',
      });

      const claudeNormalized = claudeAdapter.normalize(claudeRaw[0]!, {
        source: Source.ClaudeCode,
        workspacePath: '/home/user/project',
        dbPath: claudeSessionsDir,
        mtime: Date.now(),
      });

      // Test OpenCode - need to create a separate temp dir to avoid conflicts
      const openCodeBaseDir = await temp.create();
      const openCodeAdapter = new OpenCodeAdapter();
      const now = Date.now();

      const session: MockOpenCodeSession = {
        id: 'session-1',
        projectID: 'project-1',
        directory: '/home/user/project',
        time: { created: now },
      };

      const messages: MockOpenCodeMessage[] = [
        { id: 'msg_1', sessionID: 'session-1', role: 'user', time: { created: now } },
        { id: 'msg_2', sessionID: 'session-1', role: 'assistant', time: { created: now + 1000 } },
        { id: 'msg_3', sessionID: 'session-1', role: 'assistant', time: { created: now + 2000 } },
      ];

      const parts: MockOpenCodePart[] = [
        { id: 'prt_1', sessionID: 'session-1', messageID: 'msg_1', type: 'text', text: 'Hello' },
        // msg_2 has no text parts, so content will be empty
        { id: 'prt_2', sessionID: 'session-1', messageID: 'msg_2', type: 'tool', tool: 'read', state: {} },
        { id: 'prt_3', sessionID: 'session-1', messageID: 'msg_3', type: 'text', text: 'Response' },
      ];

      const { sessionFile, messageDir } = await createOpenCodeStorage(openCodeBaseDir, {
        session,
        messages,
        parts,
      });

      const openCodeRaw = extractOpenCode({
        sessionId: 'session-1',
        sessionFile,
        messageDir,
        workspacePath: '/home/user/project',
      });

      expect(openCodeRaw).not.toBeNull();

      const openCodeNormalized = openCodeAdapter.normalize(openCodeRaw!, {
        source: Source.OpenCode,
        workspacePath: '/home/user/project',
        dbPath: sessionFile,
        mtime: Date.now(),
      });

      // Both should have same count: 2 (user + non-empty assistant)
      expect(claudeNormalized.conversation.messageCount).toBe(2);
      expect(openCodeNormalized.conversation.messageCount).toBe(2);

      // Both should satisfy: messageCount === messages.length
      expect(claudeNormalized.conversation.messageCount).toBe(claudeNormalized.messages.length);
      expect(openCodeNormalized.conversation.messageCount).toBe(openCodeNormalized.messages.length);
    });
  });
});
