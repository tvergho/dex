import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { withRetry, acquireSyncLock, releaseSyncLock, isTransientError } from '../../../src/db/index';

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

describe('withRetry', () => {
  it('returns result on success', async () => {
    const result = await withRetry(async () => 'success');
    expect(result).toBe('success');
  });

  it('retries on commit conflict errors', async () => {
    let attempts = 0;
    const result = await withRetry(async () => {
      attempts++;
      if (attempts < 3) {
        throw new Error('Commit conflict detected');
      }
      return 'success after retries';
    });
    
    expect(result).toBe('success after retries');
    expect(attempts).toBe(3);
  });

  it('throws non-commit-conflict errors immediately', async () => {
    let attempts = 0;
    
    await expect(
      withRetry(async () => {
        attempts++;
        throw new Error('Some other error');
      })
    ).rejects.toThrow('Some other error');
    
    expect(attempts).toBe(1);
  });

  it('throws after max retries on persistent conflict', async () => {
    let attempts = 0;
    
    await expect(
      withRetry(async () => {
        attempts++;
        throw new Error('Commit conflict');
      }, 3)
    ).rejects.toThrow('Commit conflict');
    
    expect(attempts).toBe(4); // Initial + 3 retries
  });

  it('uses custom retry count', async () => {
    let attempts = 0;
    
    await expect(
      withRetry(async () => {
        attempts++;
        throw new Error('concurrent commit error');
      }, 5)
    ).rejects.toThrow('concurrent commit error');
    
    expect(attempts).toBe(6); // Initial + 5 retries
  });

  it('handles async operations correctly', async () => {
    let value = 0;
    
    const result = await withRetry(async () => {
      await new Promise(resolve => setTimeout(resolve, 10));
      value++;
      return value;
    });
    
    expect(result).toBe(1);
  });
});

describe('acquireSyncLock / releaseSyncLock', () => {
  it('acquires lock when none exists', () => {
    const acquired = acquireSyncLock();
    expect(acquired).toBe(true);
    
    // Verify lock file exists
    const lockPath = join(tempDir, 'sync.lock');
    expect(existsSync(lockPath)).toBe(true);
    
    // Clean up
    releaseSyncLock();
  });

  it('prevents acquiring lock when already held', () => {
    const first = acquireSyncLock();
    expect(first).toBe(true);
    
    // Second attempt should fail
    const second = acquireSyncLock();
    expect(second).toBe(false);
    
    // Clean up
    releaseSyncLock();
  });

  it('releases lock correctly', () => {
    acquireSyncLock();
    releaseSyncLock();
    
    // Lock file should be removed
    const lockPath = join(tempDir, 'sync.lock');
    expect(existsSync(lockPath)).toBe(false);
    
    // Should be able to acquire again
    const acquired = acquireSyncLock();
    expect(acquired).toBe(true);
    releaseSyncLock();
  });

  it('removes stale lock from dead process', () => {
    const lockPath = join(tempDir, 'sync.lock');
    
    // Create a lock file with a non-existent PID
    const staleLock = {
      pid: 99999999, // Very unlikely to exist
      startedAt: Date.now() - 1000, // Recent but process is dead
    };
    writeFileSync(lockPath, JSON.stringify(staleLock));
    
    // Should be able to acquire lock (stale lock removed)
    const acquired = acquireSyncLock();
    expect(acquired).toBe(true);
    
    releaseSyncLock();
  });

  it('removes very old stale lock', () => {
    const lockPath = join(tempDir, 'sync.lock');
    
    // Create a lock file that's older than 5 minutes
    const staleLock = {
      pid: process.pid, // Our own PID, but very old
      startedAt: Date.now() - 10 * 60 * 1000, // 10 minutes ago
    };
    writeFileSync(lockPath, JSON.stringify(staleLock));
    
    // Should be able to acquire lock (old lock removed)
    const acquired = acquireSyncLock();
    expect(acquired).toBe(true);
    
    releaseSyncLock();
  });

  it('handles corrupted lock file', () => {
    const lockPath = join(tempDir, 'sync.lock');
    
    // Create a corrupted lock file
    writeFileSync(lockPath, 'not valid json');
    
    // Should be able to acquire lock (corrupted lock removed)
    const acquired = acquireSyncLock();
    expect(acquired).toBe(true);
    
    releaseSyncLock();
  });

  it('only releases lock owned by current process', () => {
    const lockPath = join(tempDir, 'sync.lock');
    
    // Create a lock file owned by a different PID
    const otherLock = {
      pid: process.pid + 1, // Different PID
      startedAt: Date.now(),
    };
    writeFileSync(lockPath, JSON.stringify(otherLock));
    
    // Release should not remove the lock (we don't own it)
    releaseSyncLock();
    
    // Lock file should still exist
    expect(existsSync(lockPath)).toBe(true);
  });
});

describe('isTransientError', () => {
  it('returns true for commit conflict errors', () => {
    expect(isTransientError(new Error('Commit conflict detected'))).toBe(true);
    expect(isTransientError(new Error('concurrent commit error'))).toBe(true);
  });

  it('returns true for Not found errors', () => {
    expect(isTransientError(new Error('Not found: some/file.lance'))).toBe(true);
    expect(isTransientError(new Error('External error: Not found'))).toBe(true);
  });

  it('returns true for Failed to get next batch errors', () => {
    expect(isTransientError(new Error('Failed to get next batch from stream'))).toBe(true);
  });

  it('returns true for .lance file errors', () => {
    expect(isTransientError(new Error('Error reading file.lance'))).toBe(true);
    expect(isTransientError(new Error('messages.lance not accessible'))).toBe(true);
  });

  it('returns true for LanceError', () => {
    expect(isTransientError(new Error('LanceError: IO error'))).toBe(true);
  });

  it('returns false for non-transient errors', () => {
    expect(isTransientError(new Error('Some other error'))).toBe(false);
    expect(isTransientError(new Error('Database connection failed'))).toBe(false);
    expect(isTransientError(new Error('Invalid query'))).toBe(false);
  });

  it('returns false for non-Error objects', () => {
    expect(isTransientError('string error')).toBe(false);
    expect(isTransientError(null)).toBe(false);
    expect(isTransientError(undefined)).toBe(false);
    expect(isTransientError({ message: 'Not found' })).toBe(false);
  });
});

describe('withRetry transient errors', () => {
  it('retries on Not found errors', async () => {
    let attempts = 0;
    const result = await withRetry(async () => {
      attempts++;
      if (attempts < 2) {
        throw new Error('Not found: some/data.lance');
      }
      return 'success';
    });

    expect(result).toBe('success');
    expect(attempts).toBe(2);
  });

  it('retries on Failed to get next batch errors', async () => {
    let attempts = 0;
    const result = await withRetry(async () => {
      attempts++;
      if (attempts < 2) {
        throw new Error('Failed to get next batch from stream: lance error');
      }
      return 'success';
    });

    expect(result).toBe('success');
    expect(attempts).toBe(2);
  });

  it('retries on LanceError', async () => {
    let attempts = 0;
    const result = await withRetry(async () => {
      attempts++;
      if (attempts < 3) {
        throw new Error('LanceError(IO): External error');
      }
      return 'success';
    });

    expect(result).toBe('success');
    expect(attempts).toBe(3);
  });
});

