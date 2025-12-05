/**
 * Unit tests for config utilities
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';

describe('config utilities', () => {
  let originalEnv: string | undefined;
  let testDir: string;

  beforeEach(() => {
    // Save original env
    originalEnv = process.env['DEX_DATA_DIR'];
    // Create unique test directory
    testDir = join(tmpdir(), `dex-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  });

  afterEach(() => {
    // Restore original env
    if (originalEnv !== undefined) {
      process.env['DEX_DATA_DIR'] = originalEnv;
    } else {
      delete process.env['DEX_DATA_DIR'];
    }
    // Clean up test directory
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('getDataDir', () => {
    it('returns default ~/.dex when DEX_DATA_DIR not set', async () => {
      delete process.env['DEX_DATA_DIR'];
      
      // Re-import to get fresh module with new env
      const { getDataDir } = await import('../../../src/utils/config');
      const dataDir = getDataDir();
      
      expect(dataDir).toBe(join(homedir(), '.dex'));
    });

    it('respects DEX_DATA_DIR environment variable', async () => {
      process.env['DEX_DATA_DIR'] = testDir;
      
      // Need to clear module cache and re-import
      // Since Bun caches imports, we test the behavior directly
      const { getDataDir } = await import('../../../src/utils/config');
      const dataDir = getDataDir();
      
      expect(dataDir).toBe(testDir);
    });

    it('creates directory if it does not exist', async () => {
      const newDir = join(testDir, 'new-data-dir');
      process.env['DEX_DATA_DIR'] = newDir;
      
      expect(existsSync(newDir)).toBe(false);
      
      const { getDataDir } = await import('../../../src/utils/config');
      getDataDir();
      
      expect(existsSync(newDir)).toBe(true);
    });

    it('returns existing directory without error', async () => {
      mkdirSync(testDir, { recursive: true });
      process.env['DEX_DATA_DIR'] = testDir;
      
      const { getDataDir } = await import('../../../src/utils/config');
      const result = getDataDir();
      
      expect(result).toBe(testDir);
    });
  });

  describe('getLanceDBPath', () => {
    it('returns lancedb subdirectory of data dir', async () => {
      process.env['DEX_DATA_DIR'] = testDir;
      
      const { getLanceDBPath } = await import('../../../src/utils/config');
      const lanceDbPath = getLanceDBPath();
      
      expect(lanceDbPath).toBe(join(testDir, 'lancedb'));
    });
  });
});





