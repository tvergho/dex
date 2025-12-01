/**
 * Cross-platform Claude Code credential reader
 *
 * Storage locations:
 * - macOS: Keychain via `security find-generic-password -s "Claude Code-credentials"`
 * - Linux: $XDG_CONFIG_HOME/claude-code/credentials.json or ~/.config/claude-code/credentials.json
 * - Windows: %APPDATA%/claude-code/credentials.json
 */

import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export interface ClaudeCodeCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export interface CredentialStatus {
  isAuthenticated: boolean;
  subscriptionType?: string; // 'max', 'pro', etc.
  error?: string;
}

interface RawClaudeCodeCredentials {
  claudeAiOauth?: {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
    subscriptionType?: string;
  };
}

/**
 * Get credentials file path for Linux/Windows
 */
function getCredentialsFilePath(): string {
  const platform = process.platform;

  if (platform === 'win32') {
    // Windows: %APPDATA%/claude-code/credentials.json
    const appData = process.env['APPDATA'] || join(homedir(), 'AppData', 'Roaming');
    return join(appData, 'claude-code', 'credentials.json');
  }

  // Linux: $XDG_CONFIG_HOME/claude-code/credentials.json or ~/.config/claude-code/credentials.json
  const configHome = process.env['XDG_CONFIG_HOME'] || join(homedir(), '.config');
  return join(configHome, 'claude-code', 'credentials.json');
}

/**
 * Read credentials from macOS Keychain
 */
function readFromKeychain(): RawClaudeCodeCredentials | null {
  try {
    const output = execSync(
      'security find-generic-password -s "Claude Code-credentials" -w',
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
    return JSON.parse(output.trim()) as RawClaudeCodeCredentials;
  } catch {
    return null;
  }
}

/**
 * Read credentials from JSON file (Linux/Windows)
 */
function readFromFile(): RawClaudeCodeCredentials | null {
  const filePath = getCredentialsFilePath();

  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const content = readFileSync(filePath, 'utf-8');
    return JSON.parse(content) as RawClaudeCodeCredentials;
  } catch {
    return null;
  }
}

/**
 * Get Claude Code credentials from the appropriate platform storage
 */
export function getClaudeCodeCredentials(): ClaudeCodeCredentials | null {
  const platform = process.platform;

  // Read raw credentials based on platform
  const raw = platform === 'darwin' ? readFromKeychain() : readFromFile();

  if (!raw?.claudeAiOauth) {
    return null;
  }

  const oauth = raw.claudeAiOauth;

  // Validate required fields
  if (!oauth.accessToken || !oauth.refreshToken || !oauth.expiresAt) {
    return null;
  }

  return {
    accessToken: oauth.accessToken,
    refreshToken: oauth.refreshToken,
    expiresAt: oauth.expiresAt,
  };
}

/**
 * Get credential status (for UI display)
 */
export function getClaudeCodeCredentialStatus(): CredentialStatus {
  const platform = process.platform;

  try {
    // Read raw credentials based on platform
    const raw = platform === 'darwin' ? readFromKeychain() : readFromFile();

    if (!raw?.claudeAiOauth) {
      return {
        isAuthenticated: false,
        error: 'No Claude Code credentials found. Please log in to Claude Code first.',
      };
    }

    const oauth = raw.claudeAiOauth;

    // Check if token is expired
    if (oauth.expiresAt && oauth.expiresAt < Date.now()) {
      return {
        isAuthenticated: false,
        error: 'Claude Code credentials have expired. Please re-authenticate in Claude Code.',
      };
    }

    // Validate required fields
    if (!oauth.accessToken || !oauth.refreshToken) {
      return {
        isAuthenticated: false,
        error: 'Incomplete Claude Code credentials. Please re-authenticate in Claude Code.',
      };
    }

    return {
      isAuthenticated: true,
      subscriptionType: oauth.subscriptionType,
    };
  } catch (error) {
    return {
      isAuthenticated: false,
      error: error instanceof Error ? error.message : 'Failed to read credentials',
    };
  }
}

