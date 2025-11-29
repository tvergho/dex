import { existsSync, statSync } from 'fs';
import { getPlatform, expandPath } from '../../utils/platform.js';

export interface CursorGlobalDB {
  dbPath: string;
  mtime: number;
}

// Platform-specific Cursor global storage locations
const CURSOR_GLOBAL_PATHS = {
  darwin: '~/Library/Application Support/Cursor/User/globalStorage/state.vscdb',
  win32: '%APPDATA%/Cursor/User/globalStorage/state.vscdb',
  linux: '~/.config/Cursor/User/globalStorage/state.vscdb',
};

export function getCursorGlobalDbPath(): string {
  const platform = getPlatform();
  const path = CURSOR_GLOBAL_PATHS[platform];
  return expandPath(path);
}

export function getGlobalDatabase(): CursorGlobalDB | null {
  const dbPath = getCursorGlobalDbPath();

  if (!existsSync(dbPath)) {
    return null;
  }

  const stats = statSync(dbPath);
  return {
    dbPath,
    mtime: stats.mtimeMs,
  };
}
