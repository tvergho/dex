/**
 * Integration tests for list command
 *
 * Tests the non-TTY (plain text) output mode since TUI is harder to test.
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { TestDatabase } from '../../helpers/db';
import { createConversation, createMessage } from '../../fixtures';
import { isoDate } from '../../helpers/time';

describe('list command', () => {
  let db: TestDatabase;
  let consoleLogSpy: ReturnType<typeof spyOn>;
  let originalIsTTY: boolean | undefined;

  beforeEach(async () => {
    db = new TestDatabase();
    await db.setup();

    // Capture console output
    consoleLogSpy = spyOn(console, 'log').mockImplementation(() => {});

    // Force non-TTY mode to use plain text output
    originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
  });

  afterEach(async () => {
    consoleLogSpy.mockRestore();
    Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
    await db.teardown();
  });

  function getOutput(): string {
    return consoleLogSpy.mock.calls.map((call) => call.join(' ')).join('\n');
  }

  describe('basic listing', () => {
    it('shows message when no conversations exist', async () => {
      const { listCommand } = await import('../../../src/cli/commands/list');
      await listCommand({});

      const output = getOutput();
      expect(output).toContain('Conversations (0)');
      expect(output).toContain('No conversations found');
      expect(output).toContain('Run `dex sync`');
    });

    it('lists conversations with basic info', async () => {
      const conv = createConversation({
        title: 'Test Conversation',
        source: 'cursor',
        messageCount: 5,
      });
      await db.seed({ conversations: [conv] });

      const { listCommand } = await import('../../../src/cli/commands/list');
      await listCommand({});

      const output = getOutput();
      expect(output).toContain('Conversations (1)');
      expect(output).toContain('Test Conversation');
      expect(output).toContain('Cursor');
      expect(output).toContain('5 messages');
      expect(output).toContain(`ID: ${conv.id}`);
    });

    it('shows workspace path when available', async () => {
      const conv = createConversation({
        title: 'Project Conv',
        workspacePath: '/home/user/my-project',
      });
      await db.seed({ conversations: [conv] });

      const { listCommand } = await import('../../../src/cli/commands/list');
      await listCommand({});

      const output = getOutput();
      expect(output).toContain('/home/user/my-project');
    });

    it('shows model info when available', async () => {
      const conv = createConversation({
        title: 'GPT Conv',
        source: 'cursor',
        model: 'gpt-4-turbo',
      });
      await db.seed({ conversations: [conv] });

      const { listCommand } = await import('../../../src/cli/commands/list');
      await listCommand({});

      const output = getOutput();
      expect(output).toContain('Cursor · gpt-4-turbo');
    });

    it('shows token stats when available', async () => {
      const conv = createConversation({
        title: 'Token Conv',
        totalInputTokens: 10000,
        totalOutputTokens: 5000,
      });
      await db.seed({ conversations: [conv] });

      const { listCommand } = await import('../../../src/cli/commands/list');
      await listCommand({});

      const output = getOutput();
      expect(output).toContain('10K in');
      expect(output).toContain('5.0K out');
    });

    it('shows line count stats when available', async () => {
      const conv = createConversation({
        title: 'Lines Conv',
        totalLinesAdded: 100,
        totalLinesRemoved: 25,
      });
      await db.seed({ conversations: [conv] });

      const { listCommand } = await import('../../../src/cli/commands/list');
      await listCommand({});

      const output = getOutput();
      expect(output).toContain('+100');
      expect(output).toContain('-25');
    });
  });

  describe('sorting', () => {
    it('sorts by updatedAt descending (most recent first)', async () => {
      const old = createConversation({
        title: 'Old Conv',
        updatedAt: isoDate(2025, 1, 1),
      });
      const newer = createConversation({
        title: 'New Conv',
        updatedAt: isoDate(2025, 1, 15),
      });
      const middle = createConversation({
        title: 'Middle Conv',
        updatedAt: isoDate(2025, 1, 10),
      });
      await db.seed({ conversations: [old, newer, middle] });

      const { listCommand } = await import('../../../src/cli/commands/list');
      await listCommand({});

      const output = getOutput();
      const newIndex = output.indexOf('New Conv');
      const middleIndex = output.indexOf('Middle Conv');
      const oldIndex = output.indexOf('Old Conv');

      expect(newIndex).toBeLessThan(middleIndex);
      expect(middleIndex).toBeLessThan(oldIndex);
    });
  });

  describe('limit option', () => {
    it('respects limit option', async () => {
      const convs = Array.from({ length: 10 }, (_, i) =>
        createConversation({
          title: `Conv ${i + 1}`,
          updatedAt: isoDate(2025, 1, i + 1),
        })
      );
      await db.seed({ conversations: convs });

      const { listCommand } = await import('../../../src/cli/commands/list');
      await listCommand({ limit: '3' });

      const output = getOutput();
      expect(output).toContain('Conversations (3)');
      expect(output).toContain('Conv 10'); // Most recent
      expect(output).toContain('Conv 9');
      expect(output).toContain('Conv 8');
      expect(output).not.toContain('Conv 7');
    });

    it('defaults to 20 conversations', async () => {
      const convs = Array.from({ length: 25 }, (_, i) =>
        createConversation({
          title: `Conv ${i + 1}`,
          updatedAt: isoDate(2025, 1, i + 1),
        })
      );
      await db.seed({ conversations: convs });

      const { listCommand } = await import('../../../src/cli/commands/list');
      await listCommand({});

      const output = getOutput();
      expect(output).toContain('Conversations (20)');
    });
  });

  describe('source filter', () => {
    it('filters by source', async () => {
      const cursor = createConversation({
        title: 'Cursor Conv',
        source: 'cursor',
      });
      const claude = createConversation({
        title: 'Claude Conv',
        source: 'claude-code',
      });
      await db.seed({ conversations: [cursor, claude] });

      const { listCommand } = await import('../../../src/cli/commands/list');
      await listCommand({ source: 'cursor' });

      const output = getOutput();
      expect(output).toContain('Conversations (1)');
      expect(output).toContain('Cursor Conv');
      expect(output).not.toContain('Claude Conv');
    });

    it('shows empty when no matches for source', async () => {
      const cursor = createConversation({
        title: 'Cursor Conv',
        source: 'cursor',
      });
      await db.seed({ conversations: [cursor] });

      const { listCommand } = await import('../../../src/cli/commands/list');
      await listCommand({ source: 'codex' });

      const output = getOutput();
      expect(output).toContain('Conversations (0)');
      expect(output).toContain('No conversations found');
    });
  });

  describe('relative time formatting', () => {
    it('shows relative time for recent conversations', async () => {
      const today = createConversation({
        title: 'Today Conv',
        updatedAt: new Date().toISOString(),
      });
      await db.seed({ conversations: [today] });

      const { listCommand } = await import('../../../src/cli/commands/list');
      await listCommand({});

      const output = getOutput();
      expect(output).toContain('today');
    });
  });
});

