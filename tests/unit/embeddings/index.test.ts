import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, existsSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  getEmbeddingProgress,
  setEmbeddingProgress,
  clearEmbeddingProgress,
  isEmbeddingInProgress,
  getModelsDir,
  getModelPath,
  acquireEmbedLock,
  releaseEmbedLock,
  EMBEDDING_DIMENSIONS,
  type EmbeddingProgress,
} from '../../../src/embeddings/index';

// Mock the config module to use a temp directory
const originalEnv = process.env.DEX_DATA_DIR;
let tempDir: string;

beforeEach(() => {
  tempDir = join('/tmp', `dex-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tempDir, { recursive: true });
  process.env.DEX_DATA_DIR = tempDir;
});

afterEach(() => {
  process.env.DEX_DATA_DIR = originalEnv;
  if (existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe('EMBEDDING_DIMENSIONS', () => {
  it('exports the correct embedding dimensions', () => {
    expect(EMBEDDING_DIMENSIONS).toBe(768);
  });
});

describe('getModelsDir', () => {
  it('returns path under data directory', () => {
    const modelsDir = getModelsDir();
    expect(modelsDir).toBe(join(tempDir, 'models'));
  });

  it('creates the models directory if it does not exist', () => {
    expect(existsSync(join(tempDir, 'models'))).toBe(false);
    getModelsDir();
    expect(existsSync(join(tempDir, 'models'))).toBe(true);
  });
});

describe('getModelPath', () => {
  it('returns path to the model file', () => {
    const modelPath = getModelPath();
    expect(modelPath).toContain('models');
    expect(modelPath).toContain('embeddinggemma');
    expect(modelPath).toEndWith('.gguf');
  });
});

describe('getEmbeddingProgress', () => {
  it('returns idle state when no progress file exists', () => {
    const progress = getEmbeddingProgress();
    expect(progress.status).toBe('idle');
    expect(progress.total).toBe(0);
    expect(progress.completed).toBe(0);
  });

  it('reads progress from file', () => {
    const expected: EmbeddingProgress = {
      status: 'embedding',
      total: 100,
      completed: 50,
      startedAt: '2025-01-01T00:00:00.000Z',
    };
    
    writeFileSync(
      join(tempDir, 'embedding-progress.json'),
      JSON.stringify(expected)
    );
    
    const progress = getEmbeddingProgress();
    expect(progress.status).toBe('embedding');
    expect(progress.total).toBe(100);
    expect(progress.completed).toBe(50);
    expect(progress.startedAt).toBe('2025-01-01T00:00:00.000Z');
  });

  it('returns idle state on corrupted file', () => {
    writeFileSync(join(tempDir, 'embedding-progress.json'), 'not valid json');
    
    const progress = getEmbeddingProgress();
    expect(progress.status).toBe('idle');
    expect(progress.total).toBe(0);
  });
});

describe('setEmbeddingProgress', () => {
  it('writes progress to file', () => {
    const progress: EmbeddingProgress = {
      status: 'downloading',
      total: 200,
      completed: 100,
    };
    
    setEmbeddingProgress(progress);
    
    const raw = readFileSync(join(tempDir, 'embedding-progress.json'), 'utf-8');
    const saved = JSON.parse(raw);
    expect(saved.status).toBe('downloading');
    expect(saved.total).toBe(200);
    expect(saved.completed).toBe(100);
  });

  it('overwrites existing progress', () => {
    setEmbeddingProgress({ status: 'idle', total: 0, completed: 0 });
    setEmbeddingProgress({ status: 'done', total: 100, completed: 100, completedAt: '2025-01-01T12:00:00.000Z' });
    
    const progress = getEmbeddingProgress();
    expect(progress.status).toBe('done');
    expect(progress.completed).toBe(100);
    expect(progress.completedAt).toBe('2025-01-01T12:00:00.000Z');
  });
});

describe('clearEmbeddingProgress', () => {
  it('resets progress to idle state', () => {
    setEmbeddingProgress({
      status: 'embedding',
      total: 100,
      completed: 50,
    });
    
    clearEmbeddingProgress();
    
    const progress = getEmbeddingProgress();
    expect(progress.status).toBe('idle');
    expect(progress.total).toBe(0);
    expect(progress.completed).toBe(0);
  });

  it('does nothing when no progress file exists', () => {
    // Should not throw
    clearEmbeddingProgress();
    
    const progress = getEmbeddingProgress();
    expect(progress.status).toBe('idle');
  });
});

describe('isEmbeddingInProgress', () => {
  // Note: isEmbeddingInProgress now also checks for actual running processes,
  // not just status file. In tests without actual processes running, it returns
  // false for 'downloading'/'embedding' status because no process is found.

  it('returns false for idle status', () => {
    setEmbeddingProgress({ status: 'idle', total: 0, completed: 0 });
    expect(isEmbeddingInProgress()).toBe(false);
  });

  it('returns false for downloading status when no process is running', () => {
    // In test environment, no actual embed process is running
    // so this should return false even with 'downloading' status
    setEmbeddingProgress({ status: 'downloading', total: 100, completed: 50 });
    expect(isEmbeddingInProgress()).toBe(false);
  });

  it('returns false for embedding status when no process is running', () => {
    // In test environment, no actual embed process is running
    // so this should return false even with 'embedding' status
    setEmbeddingProgress({ status: 'embedding', total: 100, completed: 50 });
    expect(isEmbeddingInProgress()).toBe(false);
  });

  it('returns false for done status', () => {
    setEmbeddingProgress({ status: 'done', total: 100, completed: 100 });
    expect(isEmbeddingInProgress()).toBe(false);
  });

  it('returns false for error status', () => {
    setEmbeddingProgress({ status: 'error', total: 100, completed: 50, error: 'Something went wrong' });
    expect(isEmbeddingInProgress()).toBe(false);
  });

  it('returns false when no progress file exists', () => {
    expect(isEmbeddingInProgress()).toBe(false);
  });
});

describe('acquireEmbedLock', () => {
  afterEach(() => {
    // Clean up any lock files
    const lockPath = join(tempDir, 'embed.lock');
    if (existsSync(lockPath)) {
      rmSync(lockPath);
    }
  });

  it('acquires lock when no lock exists', () => {
    const acquired = acquireEmbedLock();
    expect(acquired).toBe(true);
    expect(existsSync(join(tempDir, 'embed.lock'))).toBe(true);
  });

  it('writes correct lock info', () => {
    acquireEmbedLock();
    const lockPath = join(tempDir, 'embed.lock');
    const lockData = JSON.parse(readFileSync(lockPath, 'utf-8'));
    expect(lockData.pid).toBe(process.pid);
    expect(typeof lockData.startedAt).toBe('number');
    expect(lockData.startedAt).toBeLessThanOrEqual(Date.now());
  });

  it('fails to acquire lock when already held by current process', () => {
    const first = acquireEmbedLock();
    expect(first).toBe(true);

    // Second attempt should fail since we already hold it
    const second = acquireEmbedLock();
    expect(second).toBe(false);
  });

  it('acquires lock when existing lock has dead PID', () => {
    // Write a lock with a PID that definitely doesn't exist
    const lockPath = join(tempDir, 'embed.lock');
    writeFileSync(lockPath, JSON.stringify({
      pid: 999999999, // Very unlikely to be a real process
      startedAt: Date.now(),
    }));

    const acquired = acquireEmbedLock();
    expect(acquired).toBe(true);

    // Lock should now be owned by us
    const lockData = JSON.parse(readFileSync(lockPath, 'utf-8'));
    expect(lockData.pid).toBe(process.pid);
  });

  it('acquires lock when existing lock is stale (old timestamp)', () => {
    const lockPath = join(tempDir, 'embed.lock');
    // Write a lock that's older than the timeout (10 minutes)
    writeFileSync(lockPath, JSON.stringify({
      pid: process.pid,
      startedAt: Date.now() - 15 * 60 * 1000, // 15 minutes ago
    }));

    const acquired = acquireEmbedLock();
    expect(acquired).toBe(true);
  });

  it('handles corrupted lock file', () => {
    const lockPath = join(tempDir, 'embed.lock');
    writeFileSync(lockPath, 'not valid json');

    const acquired = acquireEmbedLock();
    expect(acquired).toBe(true);
  });
});

describe('releaseEmbedLock', () => {
  it('removes lock file when owned by current process', () => {
    acquireEmbedLock();
    const lockPath = join(tempDir, 'embed.lock');
    expect(existsSync(lockPath)).toBe(true);

    releaseEmbedLock();
    expect(existsSync(lockPath)).toBe(false);
  });

  it('does not remove lock file owned by another process', () => {
    const lockPath = join(tempDir, 'embed.lock');
    writeFileSync(lockPath, JSON.stringify({
      pid: 999999999, // Different PID
      startedAt: Date.now(),
    }));

    releaseEmbedLock();
    // Lock should still exist since we don't own it
    expect(existsSync(lockPath)).toBe(true);
  });

  it('does nothing when no lock exists', () => {
    // Should not throw
    releaseEmbedLock();
  });

  it('handles corrupted lock file gracefully', () => {
    const lockPath = join(tempDir, 'embed.lock');
    writeFileSync(lockPath, 'not valid json');

    // Should not throw
    releaseEmbedLock();
  });
});

