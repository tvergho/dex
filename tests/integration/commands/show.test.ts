/**
 * Integration tests for show command
 *
 * Tests the non-TTY (plain text) output mode since TUI is harder to test.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { TestDatabase, setupCliTest } from '../../helpers';
import { createConversation, createMessage, createConversationFile } from '../../fixtures';

describe('show command', () => {
  let db: TestDatabase;
  let cli: ReturnType<typeof setupCliTest>;

  beforeEach(async () => {
    db = new TestDatabase();
    await db.setup();
    cli = setupCliTest();
  });

  afterEach(async () => {
    cli.restore();
    await db.teardown();
  });

  describe('error handling', () => {
    it('shows error for non-existent conversation', async () => {
      const { showCommand } = await import('../../../src/cli/commands/show');

      try {
        await showCommand('non-existent-id');
      } catch (e) {
        // Expected - process.exit was called
      }

      const errorOutput = cli.getErrorOutput();
      expect(errorOutput).toContain('Conversation not found');
      expect(errorOutput).toContain('non-existent-id');
      expect(cli.exitWasCalled()).toBe(true);
      expect(cli.getExitCode()).toBe(1);
    });
  });

  describe('basic display', () => {
    it('shows conversation title', async () => {
      const conv = createConversation({ title: 'My Test Conversation' });
      await db.seed({ conversations: [conv] });

      const { showCommand } = await import('../../../src/cli/commands/show');
      await showCommand(conv.id);

      const output = cli.getOutput();
      expect(output).toContain('My Test Conversation');
    });

    it('shows source name capitalized', async () => {
      const conv = createConversation({ source: 'cursor' });
      await db.seed({ conversations: [conv] });

      const { showCommand } = await import('../../../src/cli/commands/show');
      await showCommand(conv.id);

      const output = cli.getOutput();
      expect(output).toContain('Cursor');
    });

    it('shows model when available', async () => {
      const conv = createConversation({
        source: 'cursor',
        model: 'gpt-4-turbo',
      });
      await db.seed({ conversations: [conv] });

      const { showCommand } = await import('../../../src/cli/commands/show');
      await showCommand(conv.id);

      const output = cli.getOutput();
      expect(output).toContain('Cursor · gpt-4-turbo');
    });

    it('shows workspace path when available', async () => {
      const conv = createConversation({
        workspacePath: '/home/user/my-project',
      });
      await db.seed({ conversations: [conv] });

      const { showCommand } = await import('../../../src/cli/commands/show');
      await showCommand(conv.id);

      const output = cli.getOutput();
      expect(output).toContain('/home/user/my-project');
    });

    it('shows message count', async () => {
      const conv = createConversation({ messageCount: 15 });
      await db.seed({ conversations: [conv] });

      const { showCommand } = await import('../../../src/cli/commands/show');
      await showCommand(conv.id);

      const output = cli.getOutput();
      expect(output).toContain('15 messages');
    });
  });

  describe('message display', () => {
    it('shows all messages in order', async () => {
      const conv = createConversation({ messageCount: 3 });
      const messages = [
        createMessage(conv.id, { messageIndex: 0, role: 'user', content: 'Hello there' }),
        createMessage(conv.id, { messageIndex: 1, role: 'assistant', content: 'Hi! How can I help?' }),
        createMessage(conv.id, { messageIndex: 2, role: 'user', content: 'Can you explain X?' }),
      ];
      await db.seed({ conversations: [conv], messages });

      const { showCommand } = await import('../../../src/cli/commands/show');
      await showCommand(conv.id);

      const output = cli.getOutput();
      expect(output).toContain('[You]');
      expect(output).toContain('Hello there');
      expect(output).toContain('[Assistant]');
      expect(output).toContain('Hi! How can I help?');
      expect(output).toContain('Can you explain X?');

      // Verify order
      const helloIndex = output.indexOf('Hello there');
      const hiIndex = output.indexOf('Hi! How can I help?');
      const explainIndex = output.indexOf('Can you explain X?');
      expect(helloIndex).toBeLessThan(hiIndex);
      expect(hiIndex).toBeLessThan(explainIndex);
    });

    it('shows system messages with correct label', async () => {
      const conv = createConversation({ messageCount: 1 });
      const messages = [
        createMessage(conv.id, { messageIndex: 0, role: 'system', content: 'System prompt here' }),
      ];
      await db.seed({ conversations: [conv], messages });

      const { showCommand } = await import('../../../src/cli/commands/show');
      await showCommand(conv.id);

      const output = cli.getOutput();
      expect(output).toContain('[System]');
      expect(output).toContain('System prompt here');
    });

    it('truncates very long messages', async () => {
      const conv = createConversation({ messageCount: 1 });
      const longContent = 'x'.repeat(5000);
      const messages = [
        createMessage(conv.id, { messageIndex: 0, role: 'assistant', content: longContent }),
      ];
      await db.seed({ conversations: [conv], messages });

      const { showCommand } = await import('../../../src/cli/commands/show');
      await showCommand(conv.id);

      const output = cli.getOutput();
      expect(output).toContain('… (truncated)');
    });
  });

  describe('file display', () => {
    it('shows conversation files', async () => {
      const conv = createConversation();
      const files = [
        createConversationFile(conv.id, { filePath: '/src/app.tsx' }),
        createConversationFile(conv.id, { filePath: '/src/utils.ts' }),
      ];
      await db.seed({ conversations: [conv], files });

      const { showCommand } = await import('../../../src/cli/commands/show');
      await showCommand(conv.id);

      const output = cli.getOutput();
      expect(output).toContain('Files:');
      expect(output).toContain('app.tsx');
      expect(output).toContain('utils.ts');
    });

    it('truncates file list with count when many files', async () => {
      const conv = createConversation();
      const files = Array.from({ length: 10 }, (_, i) =>
        createConversationFile(conv.id, { filePath: `/src/file${i}.ts` })
      );
      await db.seed({ conversations: [conv], files });

      const { showCommand } = await import('../../../src/cli/commands/show');
      await showCommand(conv.id);

      const output = cli.getOutput();
      expect(output).toContain('Files:');
      expect(output).toContain('+5 more');
    });
  });

  describe('conversation with no messages', () => {
    it('shows conversation info even with no messages', async () => {
      const conv = createConversation({
        title: 'Empty Conv',
        messageCount: 0,
      });
      await db.seed({ conversations: [conv] });

      const { showCommand } = await import('../../../src/cli/commands/show');
      await showCommand(conv.id);

      const output = cli.getOutput();
      expect(output).toContain('Empty Conv');
      expect(output).toContain('0 messages');
    });
  });

  describe('different sources', () => {
    it('handles claude-code source', async () => {
      const conv = createConversation({
        source: 'claude-code',
        model: 'claude-3-opus-20240229',
      });
      await db.seed({ conversations: [conv] });

      const { showCommand } = await import('../../../src/cli/commands/show');
      await showCommand(conv.id);

      const output = cli.getOutput();
      expect(output).toContain('Claude-code');
      expect(output).toContain('claude-3-opus-20240229');
    });

    it('handles codex source', async () => {
      const conv = createConversation({ source: 'codex' });
      await db.seed({ conversations: [conv] });

      const { showCommand } = await import('../../../src/cli/commands/show');
      await showCommand(conv.id);

      const output = cli.getOutput();
      expect(output).toContain('Codex');
    });
  });
});
