/**
 * Temporary directory management for tests
 */

import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join, dirname } from 'path';

/**
 * Manages temporary directories for tests with automatic cleanup
 */
export class TempDir {
  private dirs: string[] = [];

  /**
   * Create a new temporary directory
   */
  async create(prefix = 'dex-test'): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), `${prefix}-`));
    this.dirs.push(dir);
    return dir;
  }

  /**
   * Create a temporary directory with pre-populated files
   */
  async createWithFiles(files: Record<string, string>): Promise<string> {
    const dir = await this.create();
    for (const [relativePath, content] of Object.entries(files)) {
      const fullPath = join(dir, relativePath);
      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, content, 'utf-8');
    }
    return dir;
  }

  /**
   * Clean up all created temporary directories
   */
  async cleanupAll(): Promise<void> {
    await Promise.all(
      this.dirs.map((d) => rm(d, { recursive: true, force: true }))
    );
    this.dirs = [];
  }

  /**
   * Get the list of created directories (for debugging)
   */
  getCreatedDirs(): string[] {
    return [...this.dirs];
  }
}

/**
 * Singleton instance for simple use cases
 */
export const tempDir = new TempDir();




