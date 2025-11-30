/**
 * Integration tests for sync command
 *
 * Tests the runSync function with mocked adapters and real database.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { TestDatabase, setupSyncMocks, mockEmbeddings, createMockNormalized } from '../../helpers';
import { createConversation } from '../../fixtures';
import { Source } from '../../../src/schema/index';
import type { SyncProgress } from '../../../src/cli/commands/sync';

describe('sync command', () => {
  let db: TestDatabase;

  beforeEach(async () => {
    db = new TestDatabase();
    await db.setup();
    mockEmbeddings();
  });

  afterEach(async () => {
    await db.teardown();
  });

  describe('no sources available', () => {
    it('reports done with zero conversations', async () => {
      const progressUpdates: SyncProgress[] = [];

      setupSyncMocks([{
        name: Source.Cursor,
        available: false,
      }]);

      const { runSync } = await import('../../../src/cli/commands/sync');
      await runSync({}, (p) => progressUpdates.push({ ...p }));

      const last = progressUpdates[progressUpdates.length - 1];
      expect(last?.phase).toBe('done');
      expect(last?.conversationsIndexed).toBe(0);
    });
  });

  describe('single source sync', () => {
    it('syncs new conversations', async () => {
      const progressUpdates: SyncProgress[] = [];

      setupSyncMocks([{
        name: Source.Cursor,
        locations: [{ workspacePath: '/test/project' }],
        conversations: [{ id: 'new-conv-1' }],
      }]);

      const { runSync } = await import('../../../src/cli/commands/sync');
      await runSync({}, (p) => progressUpdates.push({ ...p }));

      const last = progressUpdates[progressUpdates.length - 1];
      expect(last?.phase).toBe('done');
      expect(last?.conversationsIndexed).toBe(1);
      expect(last?.messagesIndexed).toBe(2);
    });

    it('syncs multiple conversations from one source', async () => {
      const progressUpdates: SyncProgress[] = [];

      setupSyncMocks([{
        name: Source.Cursor,
        locations: [{ workspacePath: '/project-a' }],
        conversations: [
          { id: 'conv-1' },
          { id: 'conv-2' },
          { id: 'conv-3' },
        ],
      }]);

      const { runSync } = await import('../../../src/cli/commands/sync');
      await runSync({}, (p) => progressUpdates.push({ ...p }));

      const last = progressUpdates[progressUpdates.length - 1];
      expect(last?.conversationsFound).toBe(3);
      expect(last?.conversationsIndexed).toBe(3);
    });
  });

  describe('incremental sync', () => {
    it('skips existing conversations', async () => {
      // Pre-seed a conversation
      const existing = createConversation({
        id: 'existing-conv',
        source: Source.Cursor,
      });
      await db.seed({ conversations: [existing] });

      const progressUpdates: SyncProgress[] = [];

      setupSyncMocks([{
        name: Source.Cursor,
        locations: [{ workspacePath: '/test/project' }],
        conversations: [{ id: 'existing-conv' }],
      }]);

      const { runSync } = await import('../../../src/cli/commands/sync');
      await runSync({}, (p) => progressUpdates.push({ ...p }));

      const last = progressUpdates[progressUpdates.length - 1];
      expect(last?.conversationsIndexed).toBe(0);
    });

    it('syncs only new conversations when some exist', async () => {
      const existing = createConversation({
        id: 'existing-conv',
        source: Source.Cursor,
      });
      await db.seed({ conversations: [existing] });

      const progressUpdates: SyncProgress[] = [];

      setupSyncMocks([{
        name: Source.Cursor,
        locations: [{ workspacePath: '/test/project' }],
        conversations: [
          { id: 'existing-conv' },
          { id: 'new-conv' },
        ],
      }]);

      const { runSync } = await import('../../../src/cli/commands/sync');
      await runSync({}, (p) => progressUpdates.push({ ...p }));

      const last = progressUpdates[progressUpdates.length - 1];
      expect(last?.conversationsFound).toBe(2);
      expect(last?.conversationsIndexed).toBe(1);
    });
  });

  describe('force sync', () => {
    it('re-syncs existing conversations', async () => {
      const existing = createConversation({
        id: 'force-conv',
        source: Source.Cursor,
        title: 'Old Title',
      });
      await db.seed({ conversations: [existing] });

      const progressUpdates: SyncProgress[] = [];

      setupSyncMocks([{
        name: Source.Cursor,
        locations: [{ workspacePath: '/test/project' }],
        conversations: [{ id: 'force-conv' }],
      }]);

      const { runSync } = await import('../../../src/cli/commands/sync');
      await runSync({ force: true }, (p) => progressUpdates.push({ ...p }));

      const last = progressUpdates[progressUpdates.length - 1];
      expect(last?.conversationsIndexed).toBe(1);
    });
  });

  describe('error handling', () => {
    it('reports error on detect failure', async () => {
      const progressUpdates: SyncProgress[] = [];

      setupSyncMocks([{
        name: Source.Cursor,
        error: { phase: 'detect', message: 'Detection failed' },
      }]);

      const { runSync } = await import('../../../src/cli/commands/sync');
      
      try {
        await runSync({}, (p) => progressUpdates.push({ ...p }));
      } catch {
        // Expected
      }

      const last = progressUpdates[progressUpdates.length - 1];
      expect(last?.phase).toBe('error');
      expect(last?.error).toContain('Detection failed');
    });

    it('reports error on extract failure', async () => {
      const progressUpdates: SyncProgress[] = [];

      setupSyncMocks([{
        name: Source.Cursor,
        locations: [{ workspacePath: '/test' }],
        error: { phase: 'extract', message: 'Extract failed' },
      }]);

      const { runSync } = await import('../../../src/cli/commands/sync');
      
      try {
        await runSync({}, (p) => progressUpdates.push({ ...p }));
      } catch {
        // Expected
      }

      const last = progressUpdates[progressUpdates.length - 1];
      expect(last?.phase).toBe('error');
      expect(last?.error).toContain('Extract failed');
    });
  });

  describe('progress phases', () => {
    it('progresses through all phases', async () => {
      const progressUpdates: SyncProgress[] = [];

      setupSyncMocks([{
        name: Source.Cursor,
        locations: [{ workspacePath: '/test/project' }],
        conversations: [{ id: 'phase-test' }],
      }]);

      const { runSync } = await import('../../../src/cli/commands/sync');
      await runSync({}, (p) => progressUpdates.push({ ...p }));

      const phases = progressUpdates.map(p => p.phase);
      
      expect(phases).toContain('detecting');
      expect(phases).toContain('discovering');
      expect(phases).toContain('extracting');
      expect(phases).toContain('syncing');
      expect(phases[phases.length - 1]).toBe('done');
    });

    it('sets currentSource during sync', async () => {
      const progressUpdates: SyncProgress[] = [];

      setupSyncMocks([{
        name: Source.Cursor,
        locations: [{ workspacePath: '/test' }],
        conversations: [{ id: 'source-test' }],
      }]);

      const { runSync } = await import('../../../src/cli/commands/sync');
      await runSync({}, (p) => progressUpdates.push({ ...p }));

      const withSource = progressUpdates.filter(p => p.currentSource === Source.Cursor);
      expect(withSource.length).toBeGreaterThan(0);
    });
  });

  describe('multi-source sync', () => {
    it('syncs from multiple adapters', async () => {
      const progressUpdates: SyncProgress[] = [];

      setupSyncMocks([
        {
          name: Source.Cursor,
          locations: [{ workspacePath: '/cursor-project' }],
          conversations: [{ id: 'cursor-conv' }],
        },
        {
          name: Source.ClaudeCode,
          locations: [{ workspacePath: '/claude-project' }],
          conversations: [{ id: 'claude-conv' }],
        },
      ]);

      const { runSync } = await import('../../../src/cli/commands/sync');
      await runSync({}, (p) => progressUpdates.push({ ...p }));

      const last = progressUpdates[progressUpdates.length - 1];
      expect(last?.conversationsIndexed).toBe(2);
    });

    it('continues if one adapter has no sources', async () => {
      const progressUpdates: SyncProgress[] = [];

      setupSyncMocks([
        {
          name: Source.Cursor,
          available: false,
        },
        {
          name: Source.ClaudeCode,
          locations: [{ workspacePath: '/claude-project' }],
          conversations: [{ id: 'claude-conv' }],
        },
      ]);

      const { runSync } = await import('../../../src/cli/commands/sync');
      await runSync({}, (p) => progressUpdates.push({ ...p }));

      const last = progressUpdates[progressUpdates.length - 1];
      expect(last?.phase).toBe('done');
      expect(last?.conversationsIndexed).toBe(1);
    });
  });
});
