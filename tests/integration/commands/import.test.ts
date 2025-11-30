/**
 * Integration tests for the import command
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { writeFile } from 'fs/promises';
import { join } from 'path';

import { TestDatabase } from '../../helpers/db';
import { TempDir } from '../../helpers/temp';
import { mockConsole, mockProcessExit } from '../../helpers/cli';
import {
  createConversation,
  createMessage,
  createConversationFile,
  createToolCall,
  createFileEdit,
} from '../../fixtures';
import type { ExportArchive, ExportedConversation } from '../../../src/schema/index';

describe('import command', () => {
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

  // Helper to run import command
  async function runImport(file: string, options: Record<string, unknown> = {}) {
    const { importCommand } = await import('../../../src/cli/commands/import');
    await importCommand(file, options as any);
  }

  // Helper to create a valid backup file
  async function createBackupFile(
    dir: string,
    exportedConversations: ExportedConversation[],
    options: { filename?: string; version?: string } = {}
  ): Promise<string> {
    const archive: ExportArchive = {
      version: options.version ?? '1.0',
      exportedAt: new Date().toISOString(),
      machine: 'test-machine',
      conversations: exportedConversations,
    };

    const filename = options.filename ?? 'backup.json';
    const filePath = join(dir, filename);
    await writeFile(filePath, JSON.stringify(archive, null, 2), 'utf-8');
    return filePath;
  }

  // Helper to create exported conversation data
  function createExportedConversation(
    overrides: Partial<ReturnType<typeof createConversation>> = {}
  ): ExportedConversation {
    const conv = createConversation(overrides);
    const msg = createMessage(conv.id);

    return {
      conversation: conv,
      messages: [msg],
      toolCalls: [],
      files: [],
      messageFiles: [],
      fileEdits: [],
    };
  }

  describe('basic import', () => {
    it('imports conversations from backup file', async () => {
      // Arrange
      const outputDir = await temp.create('import-test');
      const exported = createExportedConversation({ title: 'Imported Conv' });
      const backupFile = await createBackupFile(outputDir, [exported]);

      // Act
      await runImport(backupFile, {});

      // Assert
      const output = consoleMock.logs.join('\n');
      expect(output).toContain('Import complete!');
      expect(output).toContain('Imported: 1');

      // Verify data was actually imported
      const { conversationRepo } = await import('../../../src/db/repository');
      const conv = await conversationRepo.findById(exported.conversation.id);
      expect(conv).not.toBeNull();
      expect(conv!.title).toBe('Imported Conv');
    });

    it('imports messages, files, toolCalls, and fileEdits', async () => {
      // Arrange
      const outputDir = await temp.create('import-test');
      const conv = createConversation({ title: 'Full Conv' });
      const msg = createMessage(conv.id);
      const file = createConversationFile(conv.id);
      const toolCall = createToolCall(msg.id, conv.id);
      const fileEdit = createFileEdit(msg.id, conv.id);

      const exported: ExportedConversation = {
        conversation: conv,
        messages: [msg],
        toolCalls: [toolCall],
        files: [file],
        messageFiles: [],
        fileEdits: [fileEdit],
      };
      const backupFile = await createBackupFile(outputDir, [exported]);

      // Act
      await runImport(backupFile, {});

      // Assert
      const { messageRepo, filesRepo, toolCallRepo, fileEditsRepo } = await import(
        '../../../src/db/repository'
      );
      const messages = await messageRepo.findByConversation(conv.id);
      const files = await filesRepo.findByConversation(conv.id);
      const toolCalls = await toolCallRepo.findByConversation(conv.id);
      const edits = await fileEditsRepo.findByConversation(conv.id);

      expect(messages.length).toBe(1);
      expect(files.length).toBe(1);
      expect(toolCalls.length).toBe(1);
      expect(edits.length).toBe(1);
    });

    it('displays backup info before importing', async () => {
      // Arrange
      const outputDir = await temp.create('import-test');
      const exported = createExportedConversation();
      const backupFile = await createBackupFile(outputDir, [exported]);

      // Act
      await runImport(backupFile, {});

      // Assert
      const output = consoleMock.logs.join('\n');
      expect(output).toContain('Backup Info:');
      expect(output).toContain('Version: 1.0');
      expect(output).toContain('Machine: test-machine');
      expect(output).toContain('Conversations: 1');
    });

    it('handles empty backup file gracefully', async () => {
      // Arrange
      const outputDir = await temp.create('import-test');
      const backupFile = await createBackupFile(outputDir, []);

      // Act
      await runImport(backupFile, {});

      // Assert
      expect(consoleMock.logs.join('\n')).toContain('No conversations to import');
    });
  });

  describe('dry-run mode', () => {
    it('shows preview without importing', async () => {
      // Arrange
      const outputDir = await temp.create('import-test');
      const exported = createExportedConversation({ title: 'Preview Conv' });
      const backupFile = await createBackupFile(outputDir, [exported]);

      // Act
      await runImport(backupFile, { dryRun: true });

      // Assert
      const output = consoleMock.logs.join('\n');
      expect(output).toContain('Dry run - no changes made');
      expect(output).toContain('[new] Preview Conv');
      expect(output).toContain('1 to import');

      // Verify nothing was actually imported
      const { conversationRepo } = await import('../../../src/db/repository');
      const conv = await conversationRepo.findById(exported.conversation.id);
      expect(conv).toBeNull();
    });

    it('shows overwrite preview for existing conversations', async () => {
      // Arrange
      const outputDir = await temp.create('import-test');
      const existing = createConversation({ title: 'Existing' });
      await db.seed({
        conversations: [existing],
        messages: [createMessage(existing.id)],
      });

      const exported: ExportedConversation = {
        conversation: existing, // Same ID
        messages: [createMessage(existing.id)],
        toolCalls: [],
        files: [],
        messageFiles: [],
        fileEdits: [],
      };
      const backupFile = await createBackupFile(outputDir, [exported]);

      // Act
      await runImport(backupFile, { dryRun: true, force: true });

      // Assert
      const output = consoleMock.logs.join('\n');
      expect(output).toContain('[overwrite] Existing');
    });

    it('shows skip count for existing without force', async () => {
      // Arrange
      const outputDir = await temp.create('import-test');
      const existing = createConversation({ title: 'Existing' });
      await db.seed({
        conversations: [existing],
        messages: [createMessage(existing.id)],
      });

      const exported: ExportedConversation = {
        conversation: existing,
        messages: [createMessage(existing.id)],
        toolCalls: [],
        files: [],
        messageFiles: [],
        fileEdits: [],
      };
      const backupFile = await createBackupFile(outputDir, [exported]);

      // Act
      await runImport(backupFile, { dryRun: true });

      // Assert
      const output = consoleMock.logs.join('\n');
      expect(output).toContain('0 to import');
      expect(output).toContain('1 to skip');
    });
  });

  describe('existing conversation handling', () => {
    it('skips existing conversations by default', async () => {
      // Arrange
      const outputDir = await temp.create('import-test');
      const existing = createConversation({ title: 'Existing' });
      await db.seed({
        conversations: [existing],
        messages: [createMessage(existing.id)],
      });

      const exported: ExportedConversation = {
        conversation: { ...existing, title: 'Updated Title' },
        messages: [createMessage(existing.id)],
        toolCalls: [],
        files: [],
        messageFiles: [],
        fileEdits: [],
      };
      const backupFile = await createBackupFile(outputDir, [exported]);

      // Act
      await runImport(backupFile, {});

      // Assert
      const output = consoleMock.logs.join('\n');
      expect(output).toContain('Skipped: 1');

      // Verify original wasn't changed
      const { conversationRepo } = await import('../../../src/db/repository');
      const conv = await conversationRepo.findById(existing.id);
      expect(conv!.title).toBe('Existing'); // Original title preserved
    });

    it('overwrites existing conversations with --force', async () => {
      // Arrange
      const outputDir = await temp.create('import-test');
      const existing = createConversation({ title: 'Original Title' });
      await db.seed({
        conversations: [existing],
        messages: [createMessage(existing.id)],
      });

      const exported: ExportedConversation = {
        conversation: { ...existing, title: 'New Title' },
        messages: [createMessage(existing.id, { content: 'New content' })],
        toolCalls: [],
        files: [],
        messageFiles: [],
        fileEdits: [],
      };
      const backupFile = await createBackupFile(outputDir, [exported]);

      // Act
      await runImport(backupFile, { force: true });

      // Assert
      const output = consoleMock.logs.join('\n');
      expect(output).toContain('Imported: 1');
      expect(output).toContain('Skipped: 0');

      // Verify data was overwritten
      const { conversationRepo, messageRepo } = await import('../../../src/db/repository');
      const conv = await conversationRepo.findById(existing.id);
      expect(conv!.title).toBe('New Title');

      const messages = await messageRepo.findByConversation(existing.id);
      expect(messages[0]!.content).toBe('New content');
    });

    it('imports new conversations while skipping existing', async () => {
      // Arrange
      const outputDir = await temp.create('import-test');
      const existing = createConversation({ title: 'Existing' });
      await db.seed({
        conversations: [existing],
        messages: [createMessage(existing.id)],
      });

      const newConv = createConversation({ title: 'New Conv' });
      const exportedExisting: ExportedConversation = {
        conversation: existing,
        messages: [createMessage(existing.id)],
        toolCalls: [],
        files: [],
        messageFiles: [],
        fileEdits: [],
      };
      const exportedNew: ExportedConversation = {
        conversation: newConv,
        messages: [createMessage(newConv.id)],
        toolCalls: [],
        files: [],
        messageFiles: [],
        fileEdits: [],
      };
      const backupFile = await createBackupFile(outputDir, [exportedExisting, exportedNew]);

      // Act
      await runImport(backupFile, {});

      // Assert
      const output = consoleMock.logs.join('\n');
      expect(output).toContain('Imported: 1');
      expect(output).toContain('Skipped: 1');

      // Verify new was imported
      const { conversationRepo } = await import('../../../src/db/repository');
      const imported = await conversationRepo.findById(newConv.id);
      expect(imported).not.toBeNull();
      expect(imported!.title).toBe('New Conv');
    });
  });

  describe('error handling', () => {
    it('rejects non-existent file', async () => {
      // Arrange
      const exitMock = mockProcessExit();

      // Act & Assert
      try {
        await runImport('/path/to/nonexistent.json', {});
      } catch (e: any) {
        expect(e.name).toBe('ProcessExitError');
      }

      expect(consoleMock.errors.join('\n')).toContain('File not found');
      exitMock.restore();
    });

    it('rejects invalid JSON', async () => {
      // Arrange
      const outputDir = await temp.create('import-test');
      const badFile = join(outputDir, 'bad.json');
      await writeFile(badFile, 'not valid json {{{', 'utf-8');
      const exitMock = mockProcessExit();

      // Act & Assert
      try {
        await runImport(badFile, {});
      } catch (e: any) {
        expect(e.name).toBe('ProcessExitError');
      }

      expect(consoleMock.errors.join('\n')).toContain('Invalid JSON');
      exitMock.restore();
    });

    it('rejects invalid schema', async () => {
      // Arrange
      const outputDir = await temp.create('import-test');
      const badFile = join(outputDir, 'bad-schema.json');
      await writeFile(
        badFile,
        JSON.stringify({ version: '1.0', notConversations: [] }),
        'utf-8'
      );
      const exitMock = mockProcessExit();

      // Act & Assert
      try {
        await runImport(badFile, {});
      } catch (e: any) {
        expect(e.name).toBe('ProcessExitError');
      }

      expect(consoleMock.errors.join('\n')).toContain('Invalid backup file format');
      exitMock.restore();
    });
  });

  describe('output messages', () => {
    it('shows count of new vs existing conversations', async () => {
      // Arrange
      const outputDir = await temp.create('import-test');
      const existing = createConversation({ title: 'Existing' });
      await db.seed({
        conversations: [existing],
        messages: [createMessage(existing.id)],
      });

      const newConv = createConversation({ title: 'New' });
      const exportedExisting: ExportedConversation = {
        conversation: existing,
        messages: [createMessage(existing.id)],
        toolCalls: [],
        files: [],
        messageFiles: [],
        fileEdits: [],
      };
      const exportedNew: ExportedConversation = {
        conversation: newConv,
        messages: [createMessage(newConv.id)],
        toolCalls: [],
        files: [],
        messageFiles: [],
        fileEdits: [],
      };
      const backupFile = await createBackupFile(outputDir, [exportedExisting, exportedNew]);

      // Act
      await runImport(backupFile, {});

      // Assert
      const output = consoleMock.logs.join('\n');
      expect(output).toContain('1 new conversation(s)');
      expect(output).toContain('1 existing');
    });

    it('shows embedding reminder after successful import', async () => {
      // Arrange
      const outputDir = await temp.create('import-test');
      const exported = createExportedConversation();
      const backupFile = await createBackupFile(outputDir, [exported]);

      // Act
      await runImport(backupFile, {});

      // Assert
      const output = consoleMock.logs.join('\n');
      expect(output).toContain('Embedding vectors were not imported');
      expect(output).toContain('dex sync');
    });
  });
});

