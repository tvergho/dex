/**
 * Unit tests for Codex adapter parser
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { extractConversation } from '../../../src/adapters/codex/parser';
import { TempDir } from '../../helpers/temp';
import { createCodexSession, type MockCodexEntry } from '../../helpers/sources';

describe('Codex parser', () => {
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
      const entries: MockCodexEntry[] = [
        {
          timestamp: '2025-01-15T10:00:00.000Z',
          type: 'session_meta',
          payload: {
            type: 'session_meta',
            id: 'session-1',
            cwd: '/home/user/project',
          },
        },
        {
          timestamp: '2025-01-15T10:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Hello there!' }],
          },
        },
        {
          timestamp: '2025-01-15T10:00:02.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Hi! How can I help?' }],
          },
        },
      ];

      const filePath = await createCodexSession(baseDir, 'rollout-abc', entries);

      const conversation = extractConversation('rollout-abc', filePath);

      expect(conversation).not.toBeNull();
      expect(conversation!.messages.length).toBe(2);
      expect(conversation!.messages[0]!.role).toBe('user');
      expect(conversation!.messages[0]!.content).toBe('Hello there!');
      expect(conversation!.messages[1]!.role).toBe('assistant');
      expect(conversation!.messages[1]!.content).toBe('Hi! How can I help?');
    });

    it('uses first user message as title', async () => {
      const baseDir = await temp.create();
      const entries: MockCodexEntry[] = [
        {
          timestamp: '2025-01-15T10:00:00.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Help me fix the authentication bug' }],
          },
        },
        {
          timestamp: '2025-01-15T10:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Sure!' }],
          },
        },
      ];

      const filePath = await createCodexSession(baseDir, 'rollout-abc', entries);

      const conversation = extractConversation('rollout-abc', filePath);

      expect(conversation!.title).toBe('Help me fix the authentication bug');
    });

    it('extracts model from turn_context', async () => {
      const baseDir = await temp.create();
      const entries: MockCodexEntry[] = [
        {
          timestamp: '2025-01-15T10:00:00.000Z',
          type: 'turn_context',
          payload: {
            model: 'gpt-4-turbo',
            cwd: '/home/user/project',
          },
        },
        {
          timestamp: '2025-01-15T10:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Hello' }],
          },
        },
      ];

      const filePath = await createCodexSession(baseDir, 'rollout-abc', entries);

      const conversation = extractConversation('rollout-abc', filePath);

      expect(conversation!.model).toBe('gpt-4-turbo');
    });

    it('extracts tool calls with function_call type', async () => {
      const baseDir = await temp.create();
      const entries: MockCodexEntry[] = [
        {
          timestamp: '2025-01-15T10:00:00.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Read file' }],
          },
        },
        {
          timestamp: '2025-01-15T10:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: 'read_file',
            arguments: JSON.stringify({ path: '/path/to/file.ts' }),
            call_id: 'call-1',
          },
        },
        {
          timestamp: '2025-01-15T10:00:02.000Z',
          type: 'response_item',
          payload: {
            type: 'function_call_output',
            call_id: 'call-1',
            output: 'File contents here',
          },
        },
        {
          timestamp: '2025-01-15T10:00:03.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'I read the file.' }],
          },
        },
      ];

      const filePath = await createCodexSession(baseDir, 'rollout-abc', entries);

      const conversation = extractConversation('rollout-abc', filePath);

      const assistantMsg = conversation!.messages.find((m) => m.role === 'assistant');
      expect(assistantMsg!.toolCalls.length).toBe(1);
      expect(assistantMsg!.toolCalls[0]!.name).toBe('read_file');
      expect(assistantMsg!.toolCalls[0]!.output).toBe('File contents here');
    });

    it('extracts token usage from event_msg', async () => {
      const baseDir = await temp.create();
      const entries: MockCodexEntry[] = [
        {
          timestamp: '2025-01-15T10:00:00.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Hello' }],
          },
        },
        {
          timestamp: '2025-01-15T10:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Hi' }],
          },
        },
        {
          timestamp: '2025-01-15T10:00:02.000Z',
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: {
                input_tokens: 1000,
                output_tokens: 500,
              },
              last_token_usage: {
                input_tokens: 800,
                output_tokens: 200,
              },
            },
          },
        },
      ];

      const filePath = await createCodexSession(baseDir, 'rollout-abc', entries);

      const conversation = extractConversation('rollout-abc', filePath);

      expect(conversation!.totalInputTokens).toBe(800);
      expect(conversation!.totalOutputTokens).toBe(500);
    });

    it('parses apply_patch for file edits', async () => {
      const baseDir = await temp.create();
      const patchContent = `*** Begin Patch
*** Add File: src/new-file.ts
+export const x = 1;
+export const y = 2;
*** End Patch
*** Begin Patch
*** Update File: src/existing.ts
@@
-const old = 1;
+const new = 2;
+const extra = 3;
@@
*** End Patch`;

      const entries: MockCodexEntry[] = [
        {
          timestamp: '2025-01-15T10:00:00.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Apply changes' }],
          },
        },
        {
          timestamp: '2025-01-15T10:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: 'apply_patch',
            arguments: patchContent,
            call_id: 'call-1',
          },
        },
        {
          timestamp: '2025-01-15T10:00:02.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Applied the patch.' }],
          },
        },
      ];

      const filePath = await createCodexSession(baseDir, 'rollout-abc', entries);

      const conversation = extractConversation('rollout-abc', filePath);

      expect(conversation!.fileEdits.length).toBe(2);
      
      const newFile = conversation!.fileEdits.find((e) => e.filePath === 'src/new-file.ts');
      expect(newFile!.editType).toBe('create');
      expect(newFile!.linesAdded).toBe(2);
      expect(newFile!.linesRemoved).toBe(0);

      const existingFile = conversation!.fileEdits.find((e) => e.filePath === 'src/existing.ts');
      expect(existingFile!.editType).toBe('modify');
      expect(existingFile!.linesAdded).toBe(2);
      expect(existingFile!.linesRemoved).toBe(1);
    });

    it('filters out system/environment content', async () => {
      const baseDir = await temp.create();
      const entries: MockCodexEntry[] = [
        {
          timestamp: '2025-01-15T10:00:00.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: '<environment_context>System info here</environment_context>' }],
          },
        },
        {
          timestamp: '2025-01-15T10:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Actual user message' }],
          },
        },
      ];

      const filePath = await createCodexSession(baseDir, 'rollout-abc', entries);

      const conversation = extractConversation('rollout-abc', filePath);

      expect(conversation!.messages.length).toBe(1);
      expect(conversation!.messages[0]!.content).toBe('Actual user message');
    });

    it('extracts workspace path from cwd', async () => {
      const baseDir = await temp.create();
      const entries: MockCodexEntry[] = [
        {
          timestamp: '2025-01-15T10:00:00.000Z',
          type: 'session_meta',
          payload: {
            type: 'session_meta',
            id: 'session-1',
            cwd: '/home/user/my-project',
          },
        },
        {
          timestamp: '2025-01-15T10:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Hello' }],
          },
        },
      ];

      const filePath = await createCodexSession(baseDir, 'rollout-abc', entries);

      const conversation = extractConversation('rollout-abc', filePath);

      expect(conversation!.workspacePath).toBe('/home/user/my-project');
      expect(conversation!.projectName).toBe('my-project');
    });

    it('returns null for empty files', async () => {
      const baseDir = await temp.create();
      const filePath = await createCodexSession(baseDir, 'rollout-empty', []);

      const conversation = extractConversation('rollout-empty', filePath);

      expect(conversation).toBeNull();
    });

    it('returns null when no valid messages exist', async () => {
      const baseDir = await temp.create();
      const entries: MockCodexEntry[] = [
        {
          timestamp: '2025-01-15T10:00:00.000Z',
          type: 'session_meta',
          payload: {
            type: 'session_meta',
            id: 'session-1',
          },
        },
      ];

      const filePath = await createCodexSession(baseDir, 'rollout-abc', entries);

      const conversation = extractConversation('rollout-abc', filePath);

      expect(conversation).toBeNull();
    });

    it('extracts timestamps for createdAt and updatedAt', async () => {
      const baseDir = await temp.create();
      const entries: MockCodexEntry[] = [
        {
          timestamp: '2025-01-15T10:00:00.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'First' }],
          },
        },
        {
          timestamp: '2025-01-15T12:30:00.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Last' }],
          },
        },
      ];

      const filePath = await createCodexSession(baseDir, 'rollout-abc', entries);

      const conversation = extractConversation('rollout-abc', filePath);

      expect(conversation!.createdAt).toBe('2025-01-15T10:00:00.000Z');
      expect(conversation!.updatedAt).toBe('2025-01-15T12:30:00.000Z');
    });

    it('categorizes files by tool type', async () => {
      const baseDir = await temp.create();
      const entries: MockCodexEntry[] = [
        {
          timestamp: '2025-01-15T10:00:00.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Do things' }],
          },
        },
        {
          timestamp: '2025-01-15T10:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: 'read_file',
            arguments: JSON.stringify({ path: '/path/read.ts' }),
            call_id: 'call-1',
          },
        },
        {
          timestamp: '2025-01-15T10:00:02.000Z',
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: 'write_file',
            arguments: JSON.stringify({ path: '/path/write.ts', content: 'x' }),
            call_id: 'call-2',
          },
        },
        {
          timestamp: '2025-01-15T10:00:03.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Done' }],
          },
        },
      ];

      const filePath = await createCodexSession(baseDir, 'rollout-abc', entries);

      const conversation = extractConversation('rollout-abc', filePath);

      const readFile = conversation!.files.find((f) => f.path === '/path/read.ts');
      const writeFile = conversation!.files.find((f) => f.path === '/path/write.ts');

      expect(readFile!.role).toBe('context');
      expect(writeFile!.role).toBe('edited');
    });
  });
});




