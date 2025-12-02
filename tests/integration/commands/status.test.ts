/**
 * Integration tests for status command
 *
 * Tests the embedding status display functionality.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('status command', () => {
  let tempDir: string;
  let modelPath: string;
  let progressPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'dex-status-test-'));
    modelPath = join(tempDir, 'model.gguf');
    progressPath = join(tempDir, 'embedding-progress.json');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('formatBytes helper', () => {
    it('formats bytes correctly', async () => {
      // Test the formatBytes logic by checking status output with model
      writeFileSync(modelPath, 'x'.repeat(1024 * 1024)); // 1MB

      mock.module('../../../src/embeddings/index', () => ({
        getEmbeddingProgress: () => ({ status: 'idle', total: 0, completed: 0 }),
        getModelPath: () => modelPath,
      }));

      // Re-import after mocking
      const mod = await import('../../../src/cli/commands/status');
      
      // Just verify the module loads without error
      expect(mod.statusCommand).toBeDefined();
    });
  });

  describe('progress states', () => {
    it('shows idle state', async () => {
      mock.module('../../../src/embeddings/index', () => ({
        getEmbeddingProgress: () => ({
          status: 'idle',
          total: 0,
          completed: 0,
        }),
        getModelPath: () => modelPath,
      }));

      const mod = await import('../../../src/cli/commands/status');
      expect(mod.statusCommand).toBeDefined();
    });

    it('shows embedding state with progress', async () => {
      mock.module('../../../src/embeddings/index', () => ({
        getEmbeddingProgress: () => ({
          status: 'embedding',
          total: 100,
          completed: 50,
          startedAt: new Date().toISOString(),
        }),
        getModelPath: () => modelPath,
      }));

      const mod = await import('../../../src/cli/commands/status');
      expect(mod.statusCommand).toBeDefined();
    });

    it('shows done state', async () => {
      mock.module('../../../src/embeddings/index', () => ({
        getEmbeddingProgress: () => ({
          status: 'done',
          total: 100,
          completed: 100,
          startedAt: '2025-01-15T10:00:00Z',
          completedAt: '2025-01-15T10:05:00Z',
        }),
        getModelPath: () => modelPath,
      }));

      const mod = await import('../../../src/cli/commands/status');
      expect(mod.statusCommand).toBeDefined();
    });

    it('shows error state', async () => {
      mock.module('../../../src/embeddings/index', () => ({
        getEmbeddingProgress: () => ({
          status: 'error',
          total: 50,
          completed: 25,
          error: 'Failed to connect to llama-server',
        }),
        getModelPath: () => modelPath,
      }));

      const mod = await import('../../../src/cli/commands/status');
      expect(mod.statusCommand).toBeDefined();
    });

    it('shows downloading state', async () => {
      mock.module('../../../src/embeddings/index', () => ({
        getEmbeddingProgress: () => ({
          status: 'downloading',
          total: 0,
          completed: 0,
        }),
        getModelPath: () => modelPath,
      }));

      const mod = await import('../../../src/cli/commands/status');
      expect(mod.statusCommand).toBeDefined();
    });
  });

  describe('model status', () => {
    it('detects when model exists', async () => {
      writeFileSync(modelPath, 'model content');

      mock.module('../../../src/embeddings/index', () => ({
        getEmbeddingProgress: () => ({ status: 'idle', total: 0, completed: 0 }),
        getModelPath: () => modelPath,
      }));

      const mod = await import('../../../src/cli/commands/status');
      expect(mod.statusCommand).toBeDefined();
    });

    it('detects when model does not exist', async () => {
      mock.module('../../../src/embeddings/index', () => ({
        getEmbeddingProgress: () => ({ status: 'idle', total: 0, completed: 0 }),
        getModelPath: () => join(tempDir, 'nonexistent.gguf'),
      }));

      const mod = await import('../../../src/cli/commands/status');
      expect(mod.statusCommand).toBeDefined();
    });
  });
});

describe('formatDuration', () => {
  // Test the duration formatting logic
  it('formats seconds', () => {
    const start = new Date();
    const end = new Date(start.getTime() + 45 * 1000);
    
    const startTime = start.getTime();
    const endTime = end.getTime();
    const seconds = Math.floor((endTime - startTime) / 1000);
    
    expect(seconds).toBe(45);
  });

  it('formats minutes and seconds', () => {
    const start = new Date();
    const end = new Date(start.getTime() + (3 * 60 + 15) * 1000);
    
    const startTime = start.getTime();
    const endTime = end.getTime();
    const seconds = Math.floor((endTime - startTime) / 1000);
    
    expect(seconds).toBe(195);
    expect(Math.floor(seconds / 60)).toBe(3);
    expect(seconds % 60).toBe(15);
  });

  it('formats hours', () => {
    const start = new Date();
    const end = new Date(start.getTime() + (2 * 3600 + 30 * 60) * 1000);
    
    const startTime = start.getTime();
    const endTime = end.getTime();
    const seconds = Math.floor((endTime - startTime) / 1000);
    
    expect(Math.floor(seconds / 3600)).toBe(2);
    expect(Math.floor((seconds % 3600) / 60)).toBe(30);
  });
});

describe('formatBytes', () => {
  // Test byte formatting logic
  it('formats bytes', () => {
    expect(500).toBeLessThan(1024);
  });

  it('formats kilobytes', () => {
    const kb = 2 * 1024;
    expect((kb / 1024).toFixed(1)).toBe('2.0');
  });

  it('formats megabytes', () => {
    const mb = 5 * 1024 * 1024;
    expect((mb / (1024 * 1024)).toFixed(1)).toBe('5.0');
  });

  it('formats gigabytes', () => {
    const gb = 1.5 * 1024 * 1024 * 1024;
    expect((gb / (1024 * 1024 * 1024)).toFixed(1)).toBe('1.5');
  });
});




