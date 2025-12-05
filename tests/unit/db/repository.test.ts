/**
 * Unit tests for repository layer
 * Tests database operations with isolated test databases
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { TestDatabase } from '../../helpers/db';
import {
  createConversation,
  createMessage,
  createConversationFile,
  createToolCall,
  createFileEdit,
} from '../../fixtures';
import { isoDate, dateString } from '../../helpers/time';

describe('conversationRepo', () => {
  let db: TestDatabase;

  beforeEach(async () => {
    db = new TestDatabase();
    await db.setup();
  });

  afterEach(async () => {
    await db.teardown();
  });

  describe('exists', () => {
    it('returns false for non-existent conversation', async () => {
      const { conversationRepo } = await import('../../../src/db/repository');
      const exists = await conversationRepo.exists('non-existent-id');
      expect(exists).toBe(false);
    });

    it('returns true for existing conversation', async () => {
      const conv = createConversation();
      await db.seed({ conversations: [conv] });

      const { conversationRepo } = await import('../../../src/db/repository');
      const exists = await conversationRepo.exists(conv.id);
      expect(exists).toBe(true);
    });
  });

  describe('upsert', () => {
    it('inserts new conversation', async () => {
      const { conversationRepo } = await import('../../../src/db/repository');
      const conv = createConversation({ title: 'New Conv' });

      await conversationRepo.upsert(conv);

      const found = await conversationRepo.findById(conv.id);
      expect(found).not.toBeNull();
      expect(found!.title).toBe('New Conv');
    });

    it('updates existing conversation', async () => {
      const conv = createConversation({ title: 'Original' });
      await db.seed({ conversations: [conv] });

      const { conversationRepo } = await import('../../../src/db/repository');
      await conversationRepo.upsert({ ...conv, title: 'Updated' });

      const found = await conversationRepo.findById(conv.id);
      expect(found!.title).toBe('Updated');
    });
  });

  describe('findById', () => {
    it('returns null for non-existent id', async () => {
      const { conversationRepo } = await import('../../../src/db/repository');
      const result = await conversationRepo.findById('non-existent');
      expect(result).toBeNull();
    });

    it('returns conversation with all fields', async () => {
      const conv = createConversation({
        title: 'Test Conv',
        source: 'cursor',
        workspacePath: '/path/to/project',
        projectName: 'myproject',
        model: 'gpt-4',
        mode: 'agent',
        totalInputTokens: 1000,
        totalOutputTokens: 500,
      });
      await db.seed({ conversations: [conv] });

      const { conversationRepo } = await import('../../../src/db/repository');
      const found = await conversationRepo.findById(conv.id);

      expect(found).not.toBeNull();
      expect(found!.title).toBe('Test Conv');
      expect(found!.source).toBe('cursor');
      expect(found!.workspacePath).toBe('/path/to/project');
      expect(found!.projectName).toBe('myproject');
      expect(found!.model).toBe('gpt-4');
      expect(found!.mode).toBe('agent');
      expect(found!.totalInputTokens).toBe(1000);
      expect(found!.totalOutputTokens).toBe(500);
    });
  });

  describe('list', () => {
    it('returns empty array for empty database', async () => {
      const { conversationRepo } = await import('../../../src/db/repository');
      const { conversations, total } = await conversationRepo.list();
      expect(conversations).toEqual([]);
      expect(total).toBe(0);
    });

    it('returns conversations sorted by updatedAt descending', async () => {
      const conv1 = createConversation({ title: 'Old', updatedAt: isoDate(2025, 1, 1) });
      const conv2 = createConversation({ title: 'New', updatedAt: isoDate(2025, 1, 15) });
      const conv3 = createConversation({ title: 'Middle', updatedAt: isoDate(2025, 1, 10) });
      await db.seed({ conversations: [conv1, conv2, conv3] });

      const { conversationRepo } = await import('../../../src/db/repository');
      const { conversations, total } = await conversationRepo.list();

      expect(conversations.length).toBe(3);
      expect(total).toBe(3);
      expect(conversations[0]!.title).toBe('New');
      expect(conversations[1]!.title).toBe('Middle');
      expect(conversations[2]!.title).toBe('Old');
    });

    it('filters by source', async () => {
      const cursor = createConversation({ source: 'cursor', title: 'Cursor' });
      const claude = createConversation({ source: 'claude-code', title: 'Claude' });
      await db.seed({ conversations: [cursor, claude] });

      const { conversationRepo } = await import('../../../src/db/repository');
      const { conversations, total } = await conversationRepo.list({ source: 'cursor' });

      expect(conversations.length).toBe(1);
      expect(total).toBe(1);
      expect(conversations[0]!.title).toBe('Cursor');
    });

    it('respects limit', async () => {
      const convs = Array.from({ length: 10 }, (_, i) =>
        createConversation({ title: `Conv ${i}`, updatedAt: isoDate(2025, 1, i + 1) })
      );
      await db.seed({ conversations: convs });

      const { conversationRepo } = await import('../../../src/db/repository');
      const { conversations, total } = await conversationRepo.list({ limit: 3 });

      expect(conversations.length).toBe(3);
      expect(total).toBe(10); // total should be all matching, not just limited
    });
  });

  describe('count', () => {
    it('returns 0 for empty database', async () => {
      const { conversationRepo } = await import('../../../src/db/repository');
      const count = await conversationRepo.count();
      expect(count).toBe(0);
    });

    it('returns correct count', async () => {
      const convs = [
        createConversation(),
        createConversation(),
        createConversation(),
      ];
      await db.seed({ conversations: convs });

      const { conversationRepo } = await import('../../../src/db/repository');
      const count = await conversationRepo.count();
      expect(count).toBe(3);
    });
  });

  describe('delete', () => {
    it('removes conversation', async () => {
      const conv = createConversation();
      await db.seed({ conversations: [conv] });

      const { conversationRepo } = await import('../../../src/db/repository');
      await conversationRepo.delete(conv.id);

      const found = await conversationRepo.findById(conv.id);
      expect(found).toBeNull();
    });

    it('does not fail on non-existent id', async () => {
      const { conversationRepo } = await import('../../../src/db/repository');
      // Should not throw
      await conversationRepo.delete('non-existent');
    });
  });

  describe('deleteBySource', () => {
    it('deletes all conversations for source', async () => {
      const cursor1 = createConversation({ source: 'cursor' });
      const cursor2 = createConversation({ source: 'cursor' });
      const claude = createConversation({ source: 'claude-code' });
      await db.seed({ conversations: [cursor1, cursor2, claude] });

      const { conversationRepo } = await import('../../../src/db/repository');
      await conversationRepo.deleteBySource('cursor');

      const { conversations: remaining } = await conversationRepo.list();
      expect(remaining.length).toBe(1);
      expect(remaining[0]!.source).toBe('claude-code');
    });

    it('filters by workspace path', async () => {
      const conv1 = createConversation({ source: 'cursor', workspacePath: '/project1' });
      const conv2 = createConversation({ source: 'cursor', workspacePath: '/project2' });
      await db.seed({ conversations: [conv1, conv2] });

      const { conversationRepo } = await import('../../../src/db/repository');
      await conversationRepo.deleteBySource('cursor', '/project1');

      const { conversations: remaining } = await conversationRepo.list();
      expect(remaining.length).toBe(1);
      expect(remaining[0]!.workspacePath).toBe('/project2');
    });
  });

  describe('findByFilters', () => {
    it('filters by source', async () => {
      const cursor = createConversation({ source: 'cursor' });
      const claude = createConversation({ source: 'claude-code' });
      await db.seed({ conversations: [cursor, claude] });

      const { conversationRepo } = await import('../../../src/db/repository');
      const results = await conversationRepo.findByFilters({ source: 'cursor' });

      expect(results.length).toBe(1);
      expect(results[0]!.source).toBe('cursor');
    });

    it('filters by workspace path substring', async () => {
      const match = createConversation({ workspacePath: '/home/user/myproject' });
      const noMatch = createConversation({ workspacePath: '/home/user/other' });
      await db.seed({ conversations: [match, noMatch] });

      const { conversationRepo } = await import('../../../src/db/repository');
      const results = await conversationRepo.findByFilters({ workspacePath: 'myproject' });

      expect(results.length).toBe(1);
    });

    it('filters by date range', async () => {
      const old = createConversation({ createdAt: isoDate(2025, 1, 1) });
      const middle = createConversation({ createdAt: isoDate(2025, 1, 15) });
      const newer = createConversation({ createdAt: isoDate(2025, 2, 1) });
      await db.seed({ conversations: [old, middle, newer] });

      const { conversationRepo } = await import('../../../src/db/repository');
      const results = await conversationRepo.findByFilters({
        fromDate: dateString(2025, 1, 10),
        toDate: dateString(2025, 1, 20),
      });

      expect(results.length).toBe(1);
    });

    it('filters by specific ids', async () => {
      const conv1 = createConversation();
      const conv2 = createConversation();
      const conv3 = createConversation();
      await db.seed({ conversations: [conv1, conv2, conv3] });

      const { conversationRepo } = await import('../../../src/db/repository');
      const results = await conversationRepo.findByFilters({ ids: [conv1.id, conv3.id] });

      expect(results.length).toBe(2);
      const ids = results.map(r => r.id);
      expect(ids).toContain(conv1.id);
      expect(ids).toContain(conv3.id);
    });
  });
});

describe('messageRepo', () => {
  let db: TestDatabase;

  beforeEach(async () => {
    db = new TestDatabase();
    await db.setup();
  });

  afterEach(async () => {
    await db.teardown();
  });

  describe('bulkInsert', () => {
    it('inserts multiple messages', async () => {
      const conv = createConversation();
      const msg1 = createMessage(conv.id, { content: 'Hello' });
      const msg2 = createMessage(conv.id, { content: 'World' });
      await db.seed({ conversations: [conv] });

      const { messageRepo } = await import('../../../src/db/repository');
      await messageRepo.bulkInsert([msg1, msg2]);

      const messages = await messageRepo.findByConversation(conv.id);
      expect(messages.length).toBe(2);
    });

    it('does nothing for empty array', async () => {
      const { messageRepo } = await import('../../../src/db/repository');
      // Should not throw
      await messageRepo.bulkInsert([]);
    });
  });

  describe('findByConversation', () => {
    it('returns messages sorted by messageIndex', async () => {
      const conv = createConversation();
      const msg1 = createMessage(conv.id, { messageIndex: 2, content: 'Third' });
      const msg2 = createMessage(conv.id, { messageIndex: 0, content: 'First' });
      const msg3 = createMessage(conv.id, { messageIndex: 1, content: 'Second' });
      await db.seed({
        conversations: [conv],
        messages: [msg1, msg2, msg3],
      });

      const { messageRepo } = await import('../../../src/db/repository');
      const messages = await messageRepo.findByConversation(conv.id);

      expect(messages.length).toBe(3);
      expect(messages[0]!.content).toBe('First');
      expect(messages[1]!.content).toBe('Second');
      expect(messages[2]!.content).toBe('Third');
    });

    it('returns empty array for non-existent conversation', async () => {
      const { messageRepo } = await import('../../../src/db/repository');
      const messages = await messageRepo.findByConversation('non-existent');
      expect(messages).toEqual([]);
    });

    it('includes all message fields', async () => {
      const conv = createConversation();
      const msg = createMessage(conv.id, {
        role: 'assistant',
        content: 'Test',
        inputTokens: 100,
        outputTokens: 50,
        totalLinesAdded: 10,
        totalLinesRemoved: 5,
      });
      await db.seed({ conversations: [conv], messages: [msg] });

      const { messageRepo } = await import('../../../src/db/repository');
      const messages = await messageRepo.findByConversation(conv.id);

      expect(messages[0]!.role).toBe('assistant');
      expect(messages[0]!.content).toBe('Test');
      expect(messages[0]!.inputTokens).toBe(100);
      expect(messages[0]!.outputTokens).toBe(50);
      expect(messages[0]!.totalLinesAdded).toBe(10);
      expect(messages[0]!.totalLinesRemoved).toBe(5);
    });
  });

  describe('deleteByConversation', () => {
    it('deletes all messages for conversation', async () => {
      const conv1 = createConversation();
      const conv2 = createConversation();
      const msg1 = createMessage(conv1.id);
      const msg2 = createMessage(conv1.id);
      const msg3 = createMessage(conv2.id);
      await db.seed({
        conversations: [conv1, conv2],
        messages: [msg1, msg2, msg3],
      });

      const { messageRepo } = await import('../../../src/db/repository');
      await messageRepo.deleteByConversation(conv1.id);

      const remaining1 = await messageRepo.findByConversation(conv1.id);
      const remaining2 = await messageRepo.findByConversation(conv2.id);

      expect(remaining1.length).toBe(0);
      expect(remaining2.length).toBe(1);
    });
  });

  describe('getExistingIds', () => {
    it('returns set of message ids for conversation', async () => {
      const conv = createConversation();
      const msg1 = createMessage(conv.id);
      const msg2 = createMessage(conv.id);
      await db.seed({ conversations: [conv], messages: [msg1, msg2] });

      const { messageRepo } = await import('../../../src/db/repository');
      const ids = await messageRepo.getExistingIds(conv.id);

      expect(ids.size).toBe(2);
      expect(ids.has(msg1.id)).toBe(true);
      expect(ids.has(msg2.id)).toBe(true);
    });
  });
});

describe('toolCallRepo', () => {
  let db: TestDatabase;

  beforeEach(async () => {
    db = new TestDatabase();
    await db.setup();
  });

  afterEach(async () => {
    await db.teardown();
  });

  describe('bulkInsert', () => {
    it('inserts tool calls', async () => {
      const conv = createConversation();
      const msg = createMessage(conv.id);
      const tc1 = createToolCall(msg.id, conv.id, { type: 'edit' });
      const tc2 = createToolCall(msg.id, conv.id, { type: 'read' });
      await db.seed({ conversations: [conv], messages: [msg] });

      const { toolCallRepo } = await import('../../../src/db/repository');
      await toolCallRepo.bulkInsert([tc1, tc2]);

      const results = await toolCallRepo.findByConversation(conv.id);
      expect(results.length).toBe(2);
    });
  });

  describe('findByConversation', () => {
    it('returns tool calls for conversation', async () => {
      const conv = createConversation();
      const msg = createMessage(conv.id);
      const tc = createToolCall(msg.id, conv.id, { type: 'write', filePath: '/path/file.ts' });
      await db.seed({ conversations: [conv], messages: [msg], toolCalls: [tc] });

      const { toolCallRepo } = await import('../../../src/db/repository');
      const results = await toolCallRepo.findByConversation(conv.id);

      expect(results.length).toBe(1);
      expect(results[0]!.type).toBe('write');
      expect(results[0]!.filePath).toBe('/path/file.ts');
    });
  });

  describe('deleteByConversation', () => {
    it('removes tool calls for conversation', async () => {
      const conv1 = createConversation();
      const conv2 = createConversation();
      const msg1 = createMessage(conv1.id);
      const msg2 = createMessage(conv2.id);
      const tc1 = createToolCall(msg1.id, conv1.id);
      const tc2 = createToolCall(msg2.id, conv2.id);
      await db.seed({
        conversations: [conv1, conv2],
        messages: [msg1, msg2],
        toolCalls: [tc1, tc2],
      });

      const { toolCallRepo } = await import('../../../src/db/repository');
      await toolCallRepo.deleteByConversation(conv1.id);

      const remaining1 = await toolCallRepo.findByConversation(conv1.id);
      const remaining2 = await toolCallRepo.findByConversation(conv2.id);

      expect(remaining1.length).toBe(0);
      expect(remaining2.length).toBe(1);
    });
  });
});

describe('filesRepo', () => {
  let db: TestDatabase;

  beforeEach(async () => {
    db = new TestDatabase();
    await db.setup();
  });

  afterEach(async () => {
    await db.teardown();
  });

  describe('findByConversation', () => {
    it('returns files for conversation', async () => {
      const conv = createConversation();
      const file = createConversationFile(conv.id, { filePath: '/src/app.ts', role: 'edited' });
      await db.seed({ conversations: [conv], files: [file] });

      const { filesRepo } = await import('../../../src/db/repository');
      const results = await filesRepo.findByConversation(conv.id);

      expect(results.length).toBe(1);
      expect(results[0]!.filePath).toBe('/src/app.ts');
      expect(results[0]!.role).toBe('edited');
    });
  });

  describe('deleteByConversation', () => {
    it('removes files for conversation', async () => {
      const conv = createConversation();
      const file = createConversationFile(conv.id);
      await db.seed({ conversations: [conv], files: [file] });

      const { filesRepo } = await import('../../../src/db/repository');
      await filesRepo.deleteByConversation(conv.id);

      const remaining = await filesRepo.findByConversation(conv.id);
      expect(remaining.length).toBe(0);
    });
  });
});

describe('fileEditsRepo', () => {
  let db: TestDatabase;

  beforeEach(async () => {
    db = new TestDatabase();
    await db.setup();
  });

  afterEach(async () => {
    await db.teardown();
  });

  describe('findByConversation', () => {
    it('returns file edits for conversation', async () => {
      const conv = createConversation();
      const msg = createMessage(conv.id);
      const edit = createFileEdit(msg.id, conv.id, {
        filePath: '/src/file.ts',
        linesAdded: 10,
        linesRemoved: 5,
      });
      await db.seed({
        conversations: [conv],
        messages: [msg],
        fileEdits: [edit],
      });

      const { fileEditsRepo } = await import('../../../src/db/repository');
      const results = await fileEditsRepo.findByConversation(conv.id);

      expect(results.length).toBe(1);
      expect(results[0]!.filePath).toBe('/src/file.ts');
      expect(results[0]!.linesAdded).toBe(10);
      expect(results[0]!.linesRemoved).toBe(5);
    });
  });

  describe('deleteByConversation', () => {
    it('removes file edits for conversation', async () => {
      const conv = createConversation();
      const msg = createMessage(conv.id);
      const edit = createFileEdit(msg.id, conv.id);
      await db.seed({
        conversations: [conv],
        messages: [msg],
        fileEdits: [edit],
      });

      const { fileEditsRepo } = await import('../../../src/db/repository');
      await fileEditsRepo.deleteByConversation(conv.id);

      const remaining = await fileEditsRepo.findByConversation(conv.id);
      expect(remaining.length).toBe(0);
    });
  });

  describe('findByMessage', () => {
    it('returns file edits for specific message', async () => {
      const conv = createConversation();
      const msg1 = createMessage(conv.id);
      const msg2 = createMessage(conv.id);
      const edit1 = createFileEdit(msg1.id, conv.id);
      const edit2 = createFileEdit(msg2.id, conv.id);
      await db.seed({
        conversations: [conv],
        messages: [msg1, msg2],
        fileEdits: [edit1, edit2],
      });

      const { fileEditsRepo } = await import('../../../src/db/repository');
      const results = await fileEditsRepo.findByMessage(msg1.id);

      expect(results.length).toBe(1);
      expect(results[0]!.messageId).toBe(msg1.id);
    });
  });
});





