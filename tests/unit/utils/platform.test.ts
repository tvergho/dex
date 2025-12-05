/**
 * Unit tests for platform utilities
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { homedir } from 'os';
import { join } from 'path';

describe('platform utilities', () => {
  describe('getPlatform', () => {
    it('returns current platform', async () => {
      const { getPlatform } = await import('../../../src/utils/platform');
      const platform = getPlatform();
      
      // Should be one of the supported platforms
      expect(['darwin', 'win32', 'linux']).toContain(platform);
      
      // Should match the actual process platform
      expect(platform).toBe(process.platform);
    });
  });

  describe('expandPath', () => {
    it('expands ~/ to home directory', async () => {
      const { expandPath } = await import('../../../src/utils/platform');
      
      const result = expandPath('~/Documents/test');
      
      expect(result).toBe(join(homedir(), 'Documents/test'));
    });

    it('expands ~/. paths correctly', async () => {
      const { expandPath } = await import('../../../src/utils/platform');
      
      const result = expandPath('~/.dex/data');
      
      expect(result).toBe(join(homedir(), '.dex/data'));
    });

    it('returns path unchanged if no expansion needed', async () => {
      const { expandPath } = await import('../../../src/utils/platform');
      
      const absolutePath = '/usr/local/bin';
      const result = expandPath(absolutePath);
      
      expect(result).toBe(absolutePath);
    });

    it('returns relative paths unchanged', async () => {
      const { expandPath } = await import('../../../src/utils/platform');
      
      const relativePath = 'some/relative/path';
      const result = expandPath(relativePath);
      
      expect(result).toBe(relativePath);
    });

    it('handles ~ without trailing slash', async () => {
      const { expandPath } = await import('../../../src/utils/platform');
      
      // Only ~/... paths should be expanded, not bare ~
      const result = expandPath('~test');
      
      expect(result).toBe('~test');
    });
  });

  describe('expandPath with APPDATA', () => {
    let originalAppData: string | undefined;

    beforeEach(() => {
      originalAppData = process.env['APPDATA'];
    });

    afterEach(() => {
      if (originalAppData !== undefined) {
        process.env['APPDATA'] = originalAppData;
      } else {
        delete process.env['APPDATA'];
      }
    });

    it('expands %APPDATA% when env var is set', async () => {
      process.env['APPDATA'] = 'C:\\Users\\Test\\AppData\\Roaming';
      
      const { expandPath } = await import('../../../src/utils/platform');
      
      const result = expandPath('%APPDATA%/SomeApp/config');
      
      expect(result).toBe('C:\\Users\\Test\\AppData\\Roaming/SomeApp/config');
    });

    it('throws when %APPDATA% used but env var not set', async () => {
      delete process.env['APPDATA'];
      
      const { expandPath } = await import('../../../src/utils/platform');
      
      expect(() => expandPath('%APPDATA%/SomeApp')).toThrow('APPDATA environment variable not set');
    });
  });
});





