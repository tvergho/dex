/**
 * Integration tests for the backup command
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';

import { TestDatabase } from '../../helpers/db';
import { TempDir } from '../../helpers/temp';
import { mockConsole, mockProcessExit } from '../../helpers/cli';
import { expectFileExists } from '../../helpers/assertions';
import {
  createConversation,
  createMessage,
  createConversationFile,
  createToolCall,
  createFileEdit,
} from '../../fixtures';
import { isoDate, dateString } from '../../helpers/time';
import type { ExportArchive } from '../../../src/schema/index';

describe('backup command', () => {
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

  // Helper to run backup command
  async function runBackup(options: Record<string, unknown> = {}) {
    const { backupCommand } = await import('../../../src/cli/commands/backup');
    await backupCommand(options as any);
  }

  // Helper to read backup file
  async function readBackupFile(filePath: string): Promise<ExportArchive> {
    const content = await readFile(filePath, 'utf-8');
    return JSON.parse(content) as ExportArchive;
  }

  describe('basic backup', () => {
    it('exports all conversations to JSON file', async () => {
      // Arrange
      const conv1 = createConversation({ source: 'cursor', title: 'Conv 1' });
      const conv2 = createConversation({ source: 'claude-code', title: 'Conv 2' });
      await db.seed({
        conversations: [conv1, conv2],
        messages: [
          createMessage(conv1.id, { role: 'user', content: 'Hello 1' }),
          createMessage(conv2.id, { role: 'user', content: 'Hello 2' }),
        ],
      });
      const outputDir = await temp.create('backup-test');
      const outputFile = join(outputDir, 'test-backup.json');

      // Act
      await runBackup({ output: outputFile });

      // Assert
      expectFileExists(outputFile);
      const archive = await readBackupFile(outputFile);
      expect(archive.version).toBe('1.0');
      expect(archive.conversations.length).toBe(2);
      expect(consoleMock.logs.join('\n')).toContain('Backup complete!');
    });

    it('includes messages, files, toolCalls, and fileEdits', async () => {
      // Arrange
      const conv = createConversation({ title: 'Full Conv' });
      const msg = createMessage(conv.id, { role: 'assistant', content: 'Response' });
      const file = createConversationFile(conv.id, { filePath: '/path/to/file.ts' });
      const toolCall = createToolCall(msg.id, conv.id, { type: 'edit' });
      const fileEdit = createFileEdit(msg.id, conv.id, { linesAdded: 10, linesRemoved: 5 });

      await db.seed({
        conversations: [conv],
        messages: [msg],
        files: [file],
        toolCalls: [toolCall],
        fileEdits: [fileEdit],
      });
      const outputDir = await temp.create('backup-test');
      const outputFile = join(outputDir, 'full-backup.json');

      // Act
      await runBackup({ output: outputFile });

      // Assert
      const archive = await readBackupFile(outputFile);
      const exported = archive.conversations[0]!;
      expect(exported.messages.length).toBe(1);
      expect(exported.files.length).toBe(1);
      expect(exported.toolCalls.length).toBe(1);
      expect(exported.fileEdits.length).toBe(1);
    });

    it('generates timestamped filename when output not specified', async () => {
      // Arrange
      const conv = createConversation();
      await db.seed({
        conversations: [conv],
        messages: [createMessage(conv.id)],
      });

      // Act - no output option
      await runBackup({});

      // Assert - look for the generated file
      const output = consoleMock.logs.join('\n');
      expect(output).toContain('dex-backup-');
      expect(output).toContain('.json');

      // Clean up the generated file
      const match = output.match(/File: (dex-backup-[^\s]+\.json)/);
      if (match && existsSync(match[1]!)) {
        const { unlink } = await import('fs/promises');
        await unlink(match[1]!);
      }
    });

    it('shows no conversations message when database is empty', async () => {
      // Arrange - empty database
      const outputDir = await temp.create('backup-test');
      const outputFile = join(outputDir, 'empty-backup.json');

      // Act
      await runBackup({ output: outputFile });

      // Assert
      expect(consoleMock.logs.join('\n')).toContain('No conversations found');
      expect(existsSync(outputFile)).toBe(false);
    });

    it('includes machine hostname and exportedAt timestamp', async () => {
      // Arrange
      const conv = createConversation();
      await db.seed({
        conversations: [conv],
        messages: [createMessage(conv.id)],
      });
      const outputDir = await temp.create('backup-test');
      const outputFile = join(outputDir, 'meta-backup.json');

      // Act
      await runBackup({ output: outputFile });

      // Assert
      const archive = await readBackupFile(outputFile);
      expect(archive.machine).toBeDefined();
      expect(archive.exportedAt).toBeDefined();
      expect(new Date(archive.exportedAt).getTime()).not.toBeNaN();
    });
  });

  describe('source filter', () => {
    it('filters backup by source', async () => {
      // Arrange
      const cursorConv = createConversation({ source: 'cursor', title: 'Cursor Conv' });
      const claudeConv = createConversation({ source: 'claude-code', title: 'Claude Conv' });
      await db.seed({
        conversations: [cursorConv, claudeConv],
        messages: [createMessage(cursorConv.id), createMessage(claudeConv.id)],
      });
      const outputDir = await temp.create('backup-test');
      const outputFile = join(outputDir, 'cursor-backup.json');

      // Act
      await runBackup({ source: 'cursor', output: outputFile });

      // Assert
      const archive = await readBackupFile(outputFile);
      expect(archive.conversations.length).toBe(1);
      expect(archive.conversations[0]!.conversation.source).toBe('cursor');
    });

    it('rejects invalid source with error', async () => {
      // Arrange
      const outputDir = await temp.create('backup-test');
      const outputFile = join(outputDir, 'backup.json');
      const exitMock = mockProcessExit();

      // Act & Assert
      try {
        await runBackup({ source: 'invalid-source', output: outputFile });
      } catch (e: any) {
        expect(e.name).toBe('ProcessExitError');
      }

      expect(consoleMock.errors.join('\n')).toContain('Invalid --source');
      exitMock.restore();
    });
  });

  describe('project filter', () => {
    it('filters backup by project path substring', async () => {
      // Arrange
      const matchConv = createConversation({
        workspacePath: '/home/user/myapp',
        title: 'Match',
      });
      const noMatchConv = createConversation({
        workspacePath: '/home/user/other',
        title: 'No Match',
      });
      await db.seed({
        conversations: [matchConv, noMatchConv],
        messages: [createMessage(matchConv.id), createMessage(noMatchConv.id)],
      });
      const outputDir = await temp.create('backup-test');
      const outputFile = join(outputDir, 'project-backup.json');

      // Act
      await runBackup({ project: 'myapp', output: outputFile });

      // Assert
      const archive = await readBackupFile(outputFile);
      expect(archive.conversations.length).toBe(1);
      expect(archive.conversations[0]!.conversation.title).toBe('Match');
    });
  });

  describe('date filters', () => {
    it('filters by from date', async () => {
      // Arrange
      const oldConv = createConversation({ title: 'Old', createdAt: isoDate(2025, 1, 1) });
      const newConv = createConversation({ title: 'New', createdAt: isoDate(2025, 1, 20) });
      await db.seed({
        conversations: [oldConv, newConv],
        messages: [createMessage(oldConv.id), createMessage(newConv.id)],
      });
      const outputDir = await temp.create('backup-test');
      const outputFile = join(outputDir, 'from-backup.json');

      // Act
      await runBackup({ from: dateString(2025, 1, 15), output: outputFile });

      // Assert
      const archive = await readBackupFile(outputFile);
      expect(archive.conversations.length).toBe(1);
      expect(archive.conversations[0]!.conversation.title).toBe('New');
    });

    it('filters by to date', async () => {
      // Arrange
      const oldConv = createConversation({ title: 'Old', createdAt: isoDate(2025, 1, 1) });
      const newConv = createConversation({ title: 'New', createdAt: isoDate(2025, 1, 20) });
      await db.seed({
        conversations: [oldConv, newConv],
        messages: [createMessage(oldConv.id), createMessage(newConv.id)],
      });
      const outputDir = await temp.create('backup-test');
      const outputFile = join(outputDir, 'to-backup.json');

      // Act
      await runBackup({ to: dateString(2025, 1, 10), output: outputFile });

      // Assert
      const archive = await readBackupFile(outputFile);
      expect(archive.conversations.length).toBe(1);
      expect(archive.conversations[0]!.conversation.title).toBe('Old');
    });

    it('filters by date range', async () => {
      // Arrange
      const conv1 = createConversation({ title: 'Before', createdAt: isoDate(2025, 1, 1) });
      const conv2 = createConversation({ title: 'During', createdAt: isoDate(2025, 1, 15) });
      const conv3 = createConversation({ title: 'After', createdAt: isoDate(2025, 2, 1) });
      await db.seed({
        conversations: [conv1, conv2, conv3],
        messages: [createMessage(conv1.id), createMessage(conv2.id), createMessage(conv3.id)],
      });
      const outputDir = await temp.create('backup-test');
      const outputFile = join(outputDir, 'range-backup.json');

      // Act
      await runBackup({
        from: dateString(2025, 1, 10),
        to: dateString(2025, 1, 20),
        output: outputFile,
      });

      // Assert
      const archive = await readBackupFile(outputFile);
      expect(archive.conversations.length).toBe(1);
      expect(archive.conversations[0]!.conversation.title).toBe('During');
    });

    it('rejects invalid from date format', async () => {
      // Arrange
      const outputDir = await temp.create('backup-test');
      const outputFile = join(outputDir, 'backup.json');
      const exitMock = mockProcessExit();

      // Act & Assert
      try {
        await runBackup({ from: 'not-a-date', output: outputFile });
      } catch (e: any) {
        expect(e.name).toBe('ProcessExitError');
      }

      expect(consoleMock.errors.join('\n')).toContain('Invalid --from date');
      exitMock.restore();
    });

    it('rejects invalid to date format', async () => {
      // Arrange
      const outputDir = await temp.create('backup-test');
      const outputFile = join(outputDir, 'backup.json');
      const exitMock = mockProcessExit();

      // Act & Assert
      try {
        await runBackup({ to: 'invalid', output: outputFile });
      } catch (e: any) {
        expect(e.name).toBe('ProcessExitError');
      }

      expect(consoleMock.errors.join('\n')).toContain('Invalid --to date');
      exitMock.restore();
    });
  });

  describe('output statistics', () => {
    it('shows content statistics in output', async () => {
      // Arrange
      const conv = createConversation();
      const msg1 = createMessage(conv.id, { role: 'user' });
      const msg2 = createMessage(conv.id, { role: 'assistant' });
      const file = createConversationFile(conv.id);
      const toolCall = createToolCall(msg2.id, conv.id);
      const fileEdit = createFileEdit(msg2.id, conv.id);

      await db.seed({
        conversations: [conv],
        messages: [msg1, msg2],
        files: [file],
        toolCalls: [toolCall],
        fileEdits: [fileEdit],
      });
      const outputDir = await temp.create('backup-test');
      const outputFile = join(outputDir, 'stats-backup.json');

      // Act
      await runBackup({ output: outputFile });

      // Assert
      const output = consoleMock.logs.join('\n');
      expect(output).toContain('Conversations: 1');
      expect(output).toContain('Messages: 2');
      expect(output).toContain('Tool calls: 1');
      expect(output).toContain('Files: 1');
      expect(output).toContain('File edits: 1');
      expect(output).toContain('KB');
    });

    it('shows import instructions after backup', async () => {
      // Arrange
      const conv = createConversation();
      await db.seed({
        conversations: [conv],
        messages: [createMessage(conv.id)],
      });
      const outputDir = await temp.create('backup-test');
      const outputFile = join(outputDir, 'backup.json');

      // Act
      await runBackup({ output: outputFile });

      // Assert
      const output = consoleMock.logs.join('\n');
      expect(output).toContain('dex import');
      expect(output).toContain(outputFile);
    });
  });
});

