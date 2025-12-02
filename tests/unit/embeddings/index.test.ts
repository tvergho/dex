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
  it('returns false for idle status', () => {
    setEmbeddingProgress({ status: 'idle', total: 0, completed: 0 });
    expect(isEmbeddingInProgress()).toBe(false);
  });

  it('returns true for downloading status', () => {
    setEmbeddingProgress({ status: 'downloading', total: 100, completed: 50 });
    expect(isEmbeddingInProgress()).toBe(true);
  });

  it('returns true for embedding status', () => {
    setEmbeddingProgress({ status: 'embedding', total: 100, completed: 50 });
    expect(isEmbeddingInProgress()).toBe(true);
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

