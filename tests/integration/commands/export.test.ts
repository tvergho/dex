/**
 * Integration tests for the export command
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';

import { TestDatabase } from '../../helpers/db';
import { TempDir } from '../../helpers/temp';
import { mockConsole, mockProcessExit } from '../../helpers/cli';
import {
  expectFileExists,
  expectFileContains,
  countFilesWithExtension,
  findFilesWithExtension,
} from '../../helpers/assertions';
import { createConversation, createMessage, createConversationFile } from '../../fixtures';
import { isoDate, dateString } from '../../helpers/time';

describe('export command', () => {
  let db: TestDatabase;
  let temp: TempDir;
  let consoleMock: ReturnType<typeof mockConsole>;

  beforeEach(async () => {
    db = new TestDatabase();
    temp = new TempDir();
    consoleMock = mockConsole();
    await db.setup();
  });

  afterEach(async () => {
    consoleMock.restore();
    await temp.cleanupAll();
    await db.teardown();
  });

  // Helper to run export command
  async function runExport(options: Record<string, unknown> = {}) {
    // Dynamically import to pick up test database
    const { exportCommand } = await import('../../../src/cli/commands/export');
    await exportCommand(options as any);
  }

  describe('basic export', () => {
    it('exports all conversations to output directory', async () => {
      // Arrange
      const conv1 = createConversation({ source: 'cursor', title: 'Conv 1' });
      const conv2 = createConversation({ source: 'claude-code', title: 'Conv 2' });
      await db.seed({
        conversations: [conv1, conv2],
        messages: [
          createMessage(conv1.id, { role: 'user', content: 'Hello' }),
          createMessage(conv2.id, { role: 'user', content: 'Hi' }),
        ],
      });
      const outputDir = await temp.create('export-test');

      // Act
      await runExport({ output: outputDir });

      // Assert
      const mdFiles = await countFilesWithExtension(outputDir, '.md');
      expect(mdFiles).toBe(2);
      expect(consoleMock.logs.join('\n')).toContain('Exported: 2 conversation(s)');
    });

    it('creates source/project directory structure', async () => {
      // Arrange
      const conv = createConversation({
        source: 'cursor',
        workspacePath: '/home/user/myproject',
      });
      await db.seed({
        conversations: [conv],
        messages: [createMessage(conv.id)],
      });
      const outputDir = await temp.create('export-test');

      // Act
      await runExport({ output: outputDir });

      // Assert
      expect(existsSync(join(outputDir, 'cursor'))).toBe(true);
      expect(existsSync(join(outputDir, 'cursor', 'myproject'))).toBe(true);
    });

    it('handles missing project path with unknown-project directory', async () => {
      // Arrange
      const conv = createConversation({
        source: 'cursor',
        workspacePath: undefined,
      });
      await db.seed({
        conversations: [conv],
        messages: [createMessage(conv.id)],
      });
      const outputDir = await temp.create('export-test');

      // Act
      await runExport({ output: outputDir });

      // Assert
      expect(existsSync(join(outputDir, 'cursor', 'unknown-project'))).toBe(true);
    });

    it('shows no conversations message when database is empty', async () => {
      // Arrange - empty database
      const outputDir = await temp.create('export-test');

      // Act
      await runExport({ output: outputDir });

      // Assert
      expect(consoleMock.logs.join('\n')).toContain('No conversations found');
      const mdFiles = await countFilesWithExtension(outputDir, '.md');
      expect(mdFiles).toBe(0);
    });
  });

  describe('source filter', () => {
    it('filters conversations by source', async () => {
      // Arrange
      const cursorConv = createConversation({ source: 'cursor', title: 'Cursor Conv' });
      const claudeConv = createConversation({ source: 'claude-code', title: 'Claude Conv' });
      await db.seed({
        conversations: [cursorConv, claudeConv],
        messages: [
          createMessage(cursorConv.id),
          createMessage(claudeConv.id),
        ],
      });
      const outputDir = await temp.create('export-test');

      // Act
      await runExport({ source: 'cursor', output: outputDir });

      // Assert
      const mdFiles = await countFilesWithExtension(outputDir, '.md');
      expect(mdFiles).toBe(1);
      expect(existsSync(join(outputDir, 'cursor'))).toBe(true);
      expect(existsSync(join(outputDir, 'claude-code'))).toBe(false);
    });

    it('rejects invalid source with error', async () => {
      // Arrange
      const outputDir = await temp.create('export-test');
      const exitMock = mockProcessExit();

      // Act & Assert
      try {
        await runExport({ source: 'invalid-source', output: outputDir });
      } catch (e: any) {
        expect(e.name).toBe('ProcessExitError');
      }

      expect(consoleMock.errors.join('\n')).toContain('Invalid --source');
      expect(consoleMock.errors.join('\n')).toContain('cursor, claude-code, codex, opencode');
      exitMock.restore();
    });
  });

  describe('project filter', () => {
    it('filters by project path substring', async () => {
      // Arrange
      const matchConv = createConversation({
        workspacePath: '/home/user/myapp',
        title: 'Matching',
      });
      const noMatchConv = createConversation({
        workspacePath: '/home/user/other',
        title: 'Not Matching',
      });
      await db.seed({
        conversations: [matchConv, noMatchConv],
        messages: [
          createMessage(matchConv.id),
          createMessage(noMatchConv.id),
        ],
      });
      const outputDir = await temp.create('export-test');

      // Act
      await runExport({ project: 'myapp', output: outputDir });

      // Assert
      const files = await findFilesWithExtension(outputDir, '.md');
      expect(files.length).toBe(1);
      const content = await readFile(files[0]!, 'utf-8');
      expect(content).toContain('Matching');
    });
  });

  describe('date filters', () => {
    it('filters by from date', async () => {
      // Arrange
      const oldConv = createConversation({
        title: 'Old',
        createdAt: isoDate(2025, 1, 1),
      });
      const newConv = createConversation({
        title: 'New',
        createdAt: isoDate(2025, 1, 20),
      });
      await db.seed({
        conversations: [oldConv, newConv],
        messages: [
          createMessage(oldConv.id),
          createMessage(newConv.id),
        ],
      });
      const outputDir = await temp.create('export-test');

      // Act
      await runExport({ from: dateString(2025, 1, 15), output: outputDir });

      // Assert
      const files = await findFilesWithExtension(outputDir, '.md');
      expect(files.length).toBe(1);
      const content = await readFile(files[0]!, 'utf-8');
      expect(content).toContain('New');
    });

    it('filters by to date', async () => {
      // Arrange
      const oldConv = createConversation({
        title: 'Old',
        createdAt: isoDate(2025, 1, 1),
      });
      const newConv = createConversation({
        title: 'New',
        createdAt: isoDate(2025, 1, 20),
      });
      await db.seed({
        conversations: [oldConv, newConv],
        messages: [
          createMessage(oldConv.id),
          createMessage(newConv.id),
        ],
      });
      const outputDir = await temp.create('export-test');

      // Act
      await runExport({ to: dateString(2025, 1, 10), output: outputDir });

      // Assert
      const files = await findFilesWithExtension(outputDir, '.md');
      expect(files.length).toBe(1);
      const content = await readFile(files[0]!, 'utf-8');
      expect(content).toContain('Old');
    });

    it('filters by date range', async () => {
      // Arrange
      const conv1 = createConversation({ title: 'Before', createdAt: isoDate(2025, 1, 1) });
      const conv2 = createConversation({ title: 'During', createdAt: isoDate(2025, 1, 15) });
      const conv3 = createConversation({ title: 'After', createdAt: isoDate(2025, 2, 1) });
      await db.seed({
        conversations: [conv1, conv2, conv3],
        messages: [
          createMessage(conv1.id),
          createMessage(conv2.id),
          createMessage(conv3.id),
        ],
      });
      const outputDir = await temp.create('export-test');

      // Act
      await runExport({
        from: dateString(2025, 1, 10),
        to: dateString(2025, 1, 20),
        output: outputDir,
      });

      // Assert
      const files = await findFilesWithExtension(outputDir, '.md');
      expect(files.length).toBe(1);
      const content = await readFile(files[0]!, 'utf-8');
      expect(content).toContain('During');
    });

    it('rejects invalid from date format', async () => {
      // Arrange
      const outputDir = await temp.create('export-test');
      const exitMock = mockProcessExit();

      // Act & Assert
      try {
        await runExport({ from: 'not-a-date', output: outputDir });
      } catch (e: any) {
        expect(e.name).toBe('ProcessExitError');
      }

      expect(consoleMock.errors.join('\n')).toContain('Invalid --from date');
      exitMock.restore();
    });

    it('rejects invalid to date format', async () => {
      // Arrange
      const outputDir = await temp.create('export-test');
      const exitMock = mockProcessExit();

      // Act & Assert
      try {
        await runExport({ to: 'invalid', output: outputDir });
      } catch (e: any) {
        expect(e.name).toBe('ProcessExitError');
      }

      expect(consoleMock.errors.join('\n')).toContain('Invalid --to date');
      exitMock.restore();
    });
  });

  describe('single ID export', () => {
    it('exports single conversation by ID', async () => {
      // Arrange
      const targetConv = createConversation({ id: 'target-id-123', title: 'Target' });
      const otherConv = createConversation({ id: 'other-id-456', title: 'Other' });
      await db.seed({
        conversations: [targetConv, otherConv],
        messages: [
          createMessage(targetConv.id),
          createMessage(otherConv.id),
        ],
      });
      const outputDir = await temp.create('export-test');

      // Act
      await runExport({ id: 'target-id-123', output: outputDir });

      // Assert
      const files = await findFilesWithExtension(outputDir, '.md');
      expect(files.length).toBe(1);
      const content = await readFile(files[0]!, 'utf-8');
      expect(content).toContain('Target');
    });

    it('handles non-existent ID gracefully', async () => {
      // Arrange
      await db.seed({
        conversations: [createConversation()],
        messages: [],
      });
      const outputDir = await temp.create('export-test');

      // Act
      await runExport({ id: 'non-existent-id', output: outputDir });

      // Assert
      expect(consoleMock.logs.join('\n')).toContain('No conversations found');
      const mdFiles = await countFilesWithExtension(outputDir, '.md');
      expect(mdFiles).toBe(0);
    });
  });

  describe('markdown content', () => {
    it('generates correct markdown structure', async () => {
      // Arrange
      const conv = createConversation({
        title: 'Test Conversation',
        source: 'cursor',
        workspacePath: '/home/user/project',
        model: 'gpt-4',
        mode: 'chat',
        messageCount: 2,
        totalInputTokens: 100,
        totalOutputTokens: 200,
        totalLinesAdded: 50,
        totalLinesRemoved: 10,
      });
      const messages = [
        createMessage(conv.id, { role: 'user', content: 'User question here', messageIndex: 0 }),
        createMessage(conv.id, { role: 'assistant', content: 'Assistant response', messageIndex: 1 }),
      ];
      const files = [
        createConversationFile(conv.id, { filePath: '/project/src/index.ts' }),
      ];
      await db.seed({ conversations: [conv], messages, files });
      const outputDir = await temp.create('export-test');

      // Act
      await runExport({ output: outputDir });

      // Assert
      const mdFiles = await findFilesWithExtension(outputDir, '.md');
      expect(mdFiles.length).toBe(1);

      await expectFileContains(
        mdFiles[0]!,
        '# Test Conversation',
        '**Source:** Cursor',
        '**Project:** /home/user/project',
        '**Model:** gpt-4',
        '**Mode:** chat',
        '**Messages:** 2',
        '**Tokens:**',
        '**Lines Changed:**',
        '**Files:** index.ts',
        '## You',
        'User question here',
        '## Assistant',
        'Assistant response',
        '---'
      );
    });
  });

  describe('filename handling', () => {
    it('generates dated filenames', async () => {
      // Arrange
      const conv = createConversation({
        title: 'My Test',
        createdAt: '2025-01-15T10:00:00.000Z',
      });
      await db.seed({
        conversations: [conv],
        messages: [createMessage(conv.id)],
      });
      const outputDir = await temp.create('export-test');

      // Act
      await runExport({ output: outputDir });

      // Assert
      const files = await findFilesWithExtension(outputDir, '.md');
      expect(files.length).toBe(1);
      expect(files[0]).toContain('2025-01-15_my-test.md');
    });

    it('handles filename collisions with ID suffix', async () => {
      // Arrange - two conversations with same title and date
      const conv1 = createConversation({
        id: 'aaaaaaaa1111',
        title: 'Same Title',
        createdAt: '2025-01-15T10:00:00.000Z',
        workspacePath: '/project1',
      });
      const conv2 = createConversation({
        id: 'bbbbbbbb2222',
        title: 'Same Title',
        createdAt: '2025-01-15T11:00:00.000Z',
        workspacePath: '/project1',
      });
      await db.seed({
        conversations: [conv1, conv2],
        messages: [
          createMessage(conv1.id),
          createMessage(conv2.id),
        ],
      });
      const outputDir = await temp.create('export-test');

      // Act
      await runExport({ output: outputDir });

      // Assert
      const files = await findFilesWithExtension(outputDir, '.md');
      expect(files.length).toBe(2);
      // One should have the ID suffix
      const hasIdSuffix = files.some(f => f.includes('-aaaaaaaa') || f.includes('-bbbbbbbb'));
      expect(hasIdSuffix).toBe(true);
    });
  });

  describe('progress output', () => {
    it('shows progress for multiple conversations', async () => {
      // Arrange - create 15 conversations to trigger progress output
      const conversations = Array.from({ length: 15 }, (_, i) =>
        createConversation({ title: `Conv ${i}` })
      );
      const messages = conversations.map(c => createMessage(c.id));
      await db.seed({ conversations, messages });
      const outputDir = await temp.create('export-test');

      // Act
      await runExport({ output: outputDir });

      // Assert
      expect(consoleMock.logs.join('\n')).toContain('Exported 10/15');
      expect(consoleMock.logs.join('\n')).toContain('Exported 15/15');
    });

    it('shows export complete summary', async () => {
      // Arrange
      const conv = createConversation();
      await db.seed({
        conversations: [conv],
        messages: [createMessage(conv.id)],
      });
      const outputDir = await temp.create('export-test');

      // Act
      await runExport({ output: outputDir });

      // Assert
      expect(consoleMock.logs.join('\n')).toContain('Export complete!');
      expect(consoleMock.logs.join('\n')).toContain('Exported: 1 conversation(s)');
      expect(consoleMock.logs.join('\n')).toContain(`Output: ${outputDir}`);
    });
  });
});


