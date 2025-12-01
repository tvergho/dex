/**
 * Custom assertion helpers for file system and content verification
 */

import { existsSync } from 'fs';
import { readFile, readdir } from 'fs/promises';
import { join } from 'path';
import { expect } from 'bun:test';

/**
 * Assert that a file exists at the given path
 */
export function expectFileExists(path: string): void {
  expect(existsSync(path)).toBe(true);
}

/**
 * Assert that a file does not exist at the given path
 */
export function expectFileNotExists(path: string): void {
  expect(existsSync(path)).toBe(false);
}

/**
 * Assert that a file exists and contains all specified substrings
 */
export async function expectFileContains(
  path: string,
  ...substrings: string[]
): Promise<void> {
  expectFileExists(path);
  const content = await readFile(path, 'utf-8');
  for (const substring of substrings) {
    expect(content).toContain(substring);
  }
}

/**
 * Assert that a file exists and does NOT contain any of the specified substrings
 */
export async function expectFileNotContains(
  path: string,
  ...substrings: string[]
): Promise<void> {
  expectFileExists(path);
  const content = await readFile(path, 'utf-8');
  for (const substring of substrings) {
    expect(content).not.toContain(substring);
  }
}

/**
 * Assert that a directory contains exactly the expected files/subdirs
 */
export async function expectDirectoryContents(
  dirPath: string,
  expected: string[]
): Promise<void> {
  expectFileExists(dirPath);
  const contents = await readdir(dirPath);
  expect(contents.sort()).toEqual(expected.sort());
}

/**
 * Assert that specific paths exist relative to a root directory
 */
export async function expectDirectoryStructure(
  root: string,
  expectedPaths: string[]
): Promise<void> {
  for (const relativePath of expectedPaths) {
    const fullPath = join(root, relativePath);
    expect(existsSync(fullPath)).toBe(true);
  }
}

/**
 * Count files with a specific extension in a directory (recursive)
 */
export async function countFilesWithExtension(
  dirPath: string,
  extension: string
): Promise<number> {
  if (!existsSync(dirPath)) return 0;

  let count = 0;
  const entries = await readdir(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      count += await countFilesWithExtension(fullPath, extension);
    } else if (entry.name.endsWith(extension)) {
      count++;
    }
  }

  return count;
}

/**
 * Get all files with a specific extension in a directory (recursive)
 */
export async function findFilesWithExtension(
  dirPath: string,
  extension: string
): Promise<string[]> {
  if (!existsSync(dirPath)) return [];

  const files: string[] = [];
  const entries = await readdir(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await findFilesWithExtension(fullPath, extension)));
    } else if (entry.name.endsWith(extension)) {
      files.push(fullPath);
    }
  }

  return files;
}


