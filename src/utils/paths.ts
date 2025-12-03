/**
 * Path utilities for finding package resources
 *
 * These utilities work correctly in both:
 * - Development mode (running via bun/tsx from source)
 * - Production mode (running compiled dist/index.js)
 * - Globally linked mode (running via npm/bun link)
 */

import { dirname, join } from 'path';
import { existsSync, realpathSync } from 'fs';

/**
 * Find the package root by walking up from the entry script
 * Works for both source and compiled code
 */
function findPackageRoot(): string {
  // Start from the entry script (process.argv[1])
  let scriptPath = process.argv[1];
  if (!scriptPath) {
    throw new Error('Cannot determine script path');
  }

  // Resolve symlinks (important for bun link / npm link)
  try {
    scriptPath = realpathSync(scriptPath);
  } catch {
    // If realpath fails, continue with original path
  }

  let dir = dirname(scriptPath);

  // Walk up until we find package.json
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, 'package.json'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break; // Reached root
    dir = parent;
  }

  // Fallback: use script directory's parent (works for dist/index.js)
  return dirname(dirname(scriptPath));
}

// Cache the package root
let cachedPackageRoot: string | null = null;

/**
 * Get the package root directory
 */
export function getPackageRoot(): string {
  if (!cachedPackageRoot) {
    cachedPackageRoot = findPackageRoot();
  }
  return cachedPackageRoot;
}

/**
 * Get the path to the opencode binary in node_modules
 */
export function getOpencodeBinPath(): string {
  return join(getPackageRoot(), 'node_modules', '.bin', 'opencode');
}
