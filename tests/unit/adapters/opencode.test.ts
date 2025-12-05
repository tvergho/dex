/**
 * Unit tests for OpenCode adapter parser
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { extractConversation } from '../../../src/adapters/opencode/parser';
import { TempDir } from '../../helpers/temp';
import {
  createOpenCodeStorage,
  type MockOpenCodeSession,
  type MockOpenCodeMessage,
  type MockOpenCodePart,
} from '../../helpers/sources';

describe('OpenCode parser', () => {
  let temp: TempDir;

  beforeEach(() => {
    temp = new TempDir();
  });

  afterEach(async () => {
    await temp.cleanupAll();
  });

  describe('extractConversation', () => {
    it('extracts basic conversation with user and assistant messages', async () => {
      const baseDir = await temp.create();
      const now = Date.now();

      const session: MockOpenCodeSession = {
        id: 'session-1',
        projectID: 'project-1',
        directory: '/home/user/project',
        title: 'Test Conversation',
        time: { created: now - 3600000, updated: now },
      };

      const messages: MockOpenCodeMessage[] = [
        {
          id: 'msg_user1',
          sessionID: 'session-1',
          role: 'user',
          time: { created: now - 3500000 },
        },
        {
          id: 'msg_assistant1',
          sessionID: 'session-1',
          role: 'assistant',
          time: { created: now - 3400000 },
          modelID: 'gpt-4',
        },
      ];

      const parts: MockOpenCodePart[] = [
        {
          id: 'prt_1',
          sessionID: 'session-1',
          messageID: 'msg_user1',
          type: 'text',
          text: 'Hello, how are you?',
        },
        {
          id: 'prt_2',
          sessionID: 'session-1',
          messageID: 'msg_assistant1',
          type: 'text',
          text: 'I am doing well, thank you!',
        },
      ];

      const { sessionFile, messageDir } = await createOpenCodeStorage(baseDir, {
        session,
        messages,
        parts,
      });

      const conversation = extractConversation({
        sessionId: 'session-1',
        sessionFile,
        messageDir,
        workspacePath: '/home/user/project',
      });

      expect(conversation).not.toBeNull();
      expect(conversation!.title).toBe('Test Conversation');
      expect(conversation!.messages.length).toBe(2);
      expect(conversation!.messages[0]!.role).toBe('user');
      expect(conversation!.messages[0]!.content).toBe('Hello, how are you?');
      expect(conversation!.messages[1]!.role).toBe('assistant');
      expect(conversation!.messages[1]!.content).toBe('I am doing well, thank you!');
      expect(conversation!.model).toBe('gpt-4');
    });

    it('uses Untitled as default title when not provided', async () => {
      const baseDir = await temp.create();
      const now = Date.now();

      const session: MockOpenCodeSession = {
        id: 'session-1',
        projectID: 'project-1',
        directory: '/home/user/project',
        time: { created: now },
      };

      const messages: MockOpenCodeMessage[] = [
        { id: 'msg_user1', sessionID: 'session-1', role: 'user', time: { created: now } },
      ];

      const parts: MockOpenCodePart[] = [
        { id: 'prt_1', sessionID: 'session-1', messageID: 'msg_user1', type: 'text', text: 'Hello' },
      ];

      const { sessionFile, messageDir } = await createOpenCodeStorage(baseDir, {
        session,
        messages,
        parts,
      });

      const conversation = extractConversation({
        sessionId: 'session-1',
        sessionFile,
        messageDir,
        workspacePath: '/home/user/project',
      });

      expect(conversation!.title).toBe('Untitled');
    });

    it('extracts tool calls from parts', async () => {
      const baseDir = await temp.create();
      const now = Date.now();

      const session: MockOpenCodeSession = {
        id: 'session-1',
        projectID: 'project-1',
        directory: '/home/user/project',
        time: { created: now },
      };

      const messages: MockOpenCodeMessage[] = [
        { id: 'msg_user1', sessionID: 'session-1', role: 'user', time: { created: now } },
        { id: 'msg_assistant1', sessionID: 'session-1', role: 'assistant', time: { created: now + 1000 } },
      ];

      const parts: MockOpenCodePart[] = [
        { id: 'prt_1', sessionID: 'session-1', messageID: 'msg_user1', type: 'text', text: 'Read file' },
        {
          id: 'prt_2',
          sessionID: 'session-1',
          messageID: 'msg_assistant1',
          type: 'text',
          text: 'Reading the file...',
        },
        {
          id: 'prt_3',
          sessionID: 'session-1',
          messageID: 'msg_assistant1',
          type: 'tool',
          tool: 'read',
          callID: 'call-1',
          state: {
            input: { path: '/path/to/file.ts' },
            output: 'File content here',
          },
        },
      ];

      const { sessionFile, messageDir } = await createOpenCodeStorage(baseDir, {
        session,
        messages,
        parts,
      });

      const conversation = extractConversation({
        sessionId: 'session-1',
        sessionFile,
        messageDir,
        workspacePath: '/home/user/project',
      });

      const assistantMsg = conversation!.messages.find((m) => m.role === 'assistant');
      expect(assistantMsg!.toolCalls.length).toBe(1);
      expect(assistantMsg!.toolCalls[0]!.name).toBe('read');
      expect(assistantMsg!.toolCalls[0]!.filePath).toBe('/path/to/file.ts');
      expect(assistantMsg!.toolCalls[0]!.output).toBe('File content here');
    });

    it('extracts file edits from edit tool calls', async () => {
      const baseDir = await temp.create();
      const now = Date.now();

      const session: MockOpenCodeSession = {
        id: 'session-1',
        projectID: 'project-1',
        directory: '/home/user/project',
        time: { created: now },
      };

      const messages: MockOpenCodeMessage[] = [
        { id: 'msg_user1', sessionID: 'session-1', role: 'user', time: { created: now } },
        { id: 'msg_assistant1', sessionID: 'session-1', role: 'assistant', time: { created: now + 1000 } },
      ];

      const parts: MockOpenCodePart[] = [
        { id: 'prt_1', sessionID: 'session-1', messageID: 'msg_user1', type: 'text', text: 'Edit file' },
        {
          id: 'prt_2',
          sessionID: 'session-1',
          messageID: 'msg_assistant1',
          type: 'tool',
          tool: 'edit',
          callID: 'call-1',
          state: {
            input: {
              path: '/path/to/file.ts',
              old_string: 'const x = 1;',
              new_string: 'const x = 10;\nconst y = 20;',
            },
          },
        },
      ];

      const { sessionFile, messageDir } = await createOpenCodeStorage(baseDir, {
        session,
        messages,
        parts,
      });

      const conversation = extractConversation({
        sessionId: 'session-1',
        sessionFile,
        messageDir,
        workspacePath: '/home/user/project',
      });

      expect(conversation!.fileEdits.length).toBe(1);
      expect(conversation!.fileEdits[0]!.filePath).toBe('/path/to/file.ts');
      expect(conversation!.fileEdits[0]!.editType).toBe('modify');
      expect(conversation!.fileEdits[0]!.linesRemoved).toBe(1);
      expect(conversation!.fileEdits[0]!.linesAdded).toBe(2);
    });

    it('extracts file edits from write tool calls', async () => {
      const baseDir = await temp.create();
      const now = Date.now();

      const session: MockOpenCodeSession = {
        id: 'session-1',
        projectID: 'project-1',
        directory: '/home/user/project',
        time: { created: now },
      };

      const messages: MockOpenCodeMessage[] = [
        { id: 'msg_user1', sessionID: 'session-1', role: 'user', time: { created: now } },
        { id: 'msg_assistant1', sessionID: 'session-1', role: 'assistant', time: { created: now + 1000 } },
      ];

      const parts: MockOpenCodePart[] = [
        { id: 'prt_1', sessionID: 'session-1', messageID: 'msg_user1', type: 'text', text: 'Create file' },
        {
          id: 'prt_2',
          sessionID: 'session-1',
          messageID: 'msg_assistant1',
          type: 'tool',
          tool: 'write',
          callID: 'call-1',
          state: {
            input: {
              path: '/path/to/new-file.ts',
              content: 'line 1\nline 2\nline 3',
            },
          },
        },
      ];

      const { sessionFile, messageDir } = await createOpenCodeStorage(baseDir, {
        session,
        messages,
        parts,
      });

      const conversation = extractConversation({
        sessionId: 'session-1',
        sessionFile,
        messageDir,
        workspacePath: '/home/user/project',
      });

      expect(conversation!.fileEdits.length).toBe(1);
      expect(conversation!.fileEdits[0]!.editType).toBe('create');
      expect(conversation!.fileEdits[0]!.linesAdded).toBe(3);
      expect(conversation!.fileEdits[0]!.linesRemoved).toBe(0);
    });

    it('extracts token usage from messages', async () => {
      const baseDir = await temp.create();
      const now = Date.now();

      const session: MockOpenCodeSession = {
        id: 'session-1',
        projectID: 'project-1',
        directory: '/home/user/project',
        time: { created: now },
      };

      const messages: MockOpenCodeMessage[] = [
        {
          id: 'msg_user1',
          sessionID: 'session-1',
          role: 'user',
          time: { created: now },
        },
        {
          id: 'msg_assistant1',
          sessionID: 'session-1',
          role: 'assistant',
          time: { created: now + 1000 },
          tokens: { input: 500, output: 200 },
        },
      ];

      const parts: MockOpenCodePart[] = [
        { id: 'prt_1', sessionID: 'session-1', messageID: 'msg_user1', type: 'text', text: 'Question' },
        { id: 'prt_2', sessionID: 'session-1', messageID: 'msg_assistant1', type: 'text', text: 'Answer' },
      ];

      const { sessionFile, messageDir } = await createOpenCodeStorage(baseDir, {
        session,
        messages,
        parts,
      });

      const conversation = extractConversation({
        sessionId: 'session-1',
        sessionFile,
        messageDir,
        workspacePath: '/home/user/project',
      });

      expect(conversation!.totalInputTokens).toBe(500);
      expect(conversation!.totalOutputTokens).toBe(200);
    });

    it('extracts timestamps for createdAt and updatedAt', async () => {
      const baseDir = await temp.create();
      const created = new Date('2025-01-15T10:00:00.000Z').getTime();
      const updated = new Date('2025-01-15T12:30:00.000Z').getTime();

      const session: MockOpenCodeSession = {
        id: 'session-1',
        projectID: 'project-1',
        directory: '/home/user/project',
        time: { created, updated },
      };

      const messages: MockOpenCodeMessage[] = [
        { id: 'msg_user1', sessionID: 'session-1', role: 'user', time: { created: created + 1000 } },
      ];

      const parts: MockOpenCodePart[] = [
        { id: 'prt_1', sessionID: 'session-1', messageID: 'msg_user1', type: 'text', text: 'Hello' },
      ];

      const { sessionFile, messageDir } = await createOpenCodeStorage(baseDir, {
        session,
        messages,
        parts,
      });

      const conversation = extractConversation({
        sessionId: 'session-1',
        sessionFile,
        messageDir,
        workspacePath: '/home/user/project',
      });

      expect(conversation!.createdAt).toBe('2025-01-15T10:00:00.000Z');
      expect(conversation!.updatedAt).toBe('2025-01-15T12:30:00.000Z');
    });

    it('returns null for empty sessions (no messages)', async () => {
      const baseDir = await temp.create();
      const now = Date.now();

      const session: MockOpenCodeSession = {
        id: 'session-1',
        projectID: 'project-1',
        directory: '/home/user/project',
        time: { created: now },
      };

      const { sessionFile, messageDir } = await createOpenCodeStorage(baseDir, {
        session,
        messages: [],
        parts: [],
      });

      const conversation = extractConversation({
        sessionId: 'session-1',
        sessionFile,
        messageDir,
        workspacePath: '/home/user/project',
      });

      expect(conversation).toBeNull();
    });

    it('sorts messages by creation time', async () => {
      const baseDir = await temp.create();
      const now = Date.now();

      const session: MockOpenCodeSession = {
        id: 'session-1',
        projectID: 'project-1',
        directory: '/home/user/project',
        time: { created: now },
      };

      // Messages out of order
      const messages: MockOpenCodeMessage[] = [
        { id: 'msg_3', sessionID: 'session-1', role: 'assistant', time: { created: now + 2000 } },
        { id: 'msg_1', sessionID: 'session-1', role: 'user', time: { created: now } },
        { id: 'msg_2', sessionID: 'session-1', role: 'assistant', time: { created: now + 1000 } },
      ];

      const parts: MockOpenCodePart[] = [
        { id: 'prt_1', sessionID: 'session-1', messageID: 'msg_1', type: 'text', text: 'First' },
        { id: 'prt_2', sessionID: 'session-1', messageID: 'msg_2', type: 'text', text: 'Second' },
        { id: 'prt_3', sessionID: 'session-1', messageID: 'msg_3', type: 'text', text: 'Third' },
      ];

      const { sessionFile, messageDir } = await createOpenCodeStorage(baseDir, {
        session,
        messages,
        parts,
      });

      const conversation = extractConversation({
        sessionId: 'session-1',
        sessionFile,
        messageDir,
        workspacePath: '/home/user/project',
      });

      expect(conversation!.messages[0]!.content).toBe('First');
      expect(conversation!.messages[1]!.content).toBe('Second');
      expect(conversation!.messages[2]!.content).toBe('Third');
    });

    it('categorizes files by tool type', async () => {
      const baseDir = await temp.create();
      const now = Date.now();

      const session: MockOpenCodeSession = {
        id: 'session-1',
        projectID: 'project-1',
        directory: '/home/user/project',
        time: { created: now },
      };

      const messages: MockOpenCodeMessage[] = [
        { id: 'msg_user1', sessionID: 'session-1', role: 'user', time: { created: now } },
        { id: 'msg_assistant1', sessionID: 'session-1', role: 'assistant', time: { created: now + 1000 } },
      ];

      const parts: MockOpenCodePart[] = [
        { id: 'prt_1', sessionID: 'session-1', messageID: 'msg_user1', type: 'text', text: 'Do things' },
        {
          id: 'prt_2',
          sessionID: 'session-1',
          messageID: 'msg_assistant1',
          type: 'tool',
          tool: 'read',
          state: { input: { path: '/read.ts' } },
        },
        {
          id: 'prt_3',
          sessionID: 'session-1',
          messageID: 'msg_assistant1',
          type: 'tool',
          tool: 'write',
          state: { input: { path: '/write.ts', content: 'x' } },
        },
        {
          id: 'prt_4',
          sessionID: 'session-1',
          messageID: 'msg_assistant1',
          type: 'tool',
          tool: 'glob',
          state: { input: { path: '/glob.ts' } },
        },
      ];

      const { sessionFile, messageDir } = await createOpenCodeStorage(baseDir, {
        session,
        messages,
        parts,
      });

      const conversation = extractConversation({
        sessionId: 'session-1',
        sessionFile,
        messageDir,
        workspacePath: '/home/user/project',
      });

      const readFile = conversation!.files.find((f) => f.path === '/read.ts');
      const writeFile = conversation!.files.find((f) => f.path === '/write.ts');
      const globFile = conversation!.files.find((f) => f.path === '/glob.ts');

      expect(readFile!.role).toBe('context');
      expect(writeFile!.role).toBe('edited');
      expect(globFile!.role).toBe('context');
    });

    it('extracts mode from messages', async () => {
      const baseDir = await temp.create();
      const now = Date.now();

      const session: MockOpenCodeSession = {
        id: 'session-1',
        projectID: 'project-1',
        directory: '/home/user/project',
        time: { created: now },
      };

      const messages: MockOpenCodeMessage[] = [
        {
          id: 'msg_user1',
          sessionID: 'session-1',
          role: 'user',
          time: { created: now },
        },
        {
          id: 'msg_assistant1',
          sessionID: 'session-1',
          role: 'assistant',
          time: { created: now + 1000 },
          modelID: 'claude-3',
          // @ts-expect-error - mode is not in MockOpenCodeMessage but is in real data
          mode: 'build',
        },
      ];

      const parts: MockOpenCodePart[] = [
        { id: 'prt_1', sessionID: 'session-1', messageID: 'msg_user1', type: 'text', text: 'Build it' },
        { id: 'prt_2', sessionID: 'session-1', messageID: 'msg_assistant1', type: 'text', text: 'Building...' },
      ];

      // Need to add mode to the mock message manually
      const { writeFile } = await import('fs/promises');
      const { join } = await import('path');
      
      const { sessionFile, messageDir } = await createOpenCodeStorage(baseDir, {
        session,
        messages,
        parts,
      });

      // Overwrite the assistant message file with mode
      const msgWithMode = { ...messages[1], mode: 'build' };
      await writeFile(join(messageDir, 'msg_assistant1.json'), JSON.stringify(msgWithMode));

      const conversation = extractConversation({
        sessionId: 'session-1',
        sessionFile,
        messageDir,
        workspacePath: '/home/user/project',
      });

      expect(conversation!.mode).toBe('build');
    });
  });
});





