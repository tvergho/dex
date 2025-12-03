/**
 * Unified OpenCode Server Manager
 *
 * Singleton that manages a single OpenCode server instance for the dex process.
 * Credentials are injected as they become available.
 * Server starts lazily on first use and shuts down on process exit.
 */

import { spawn, type ChildProcess } from 'child_process';
import { join } from 'path';
import { homedir } from 'os';
import { mkdirSync, existsSync } from 'fs';
import { getClaudeCodeCredentials } from './claude-code/credentials.js';
import { getCodexCredentials } from './codex/credentials.js';
import { getOpencodeBinPath } from '../utils/paths.js';

const OPENCODE_BIN = getOpencodeBinPath();

// Isolated data directory for dex's OpenCode instance
const DEX_OPENCODE_HOME = join(homedir(), '.dex', 'opencode');

type ProviderId = 'anthropic' | 'openai';

interface ServerState {
  process: ChildProcess | null;
  url: string | null;
  starting: Promise<string> | null;
  credentialsSet: Set<ProviderId>;
}

const state: ServerState = {
  process: null,
  url: null,
  starting: null,
  credentialsSet: new Set(),
};

/**
 * Wait for OpenCode server to be ready
 */
function waitForServerReady(proc: ChildProcess, timeout = 30000): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => {
      reject(new Error('OpenCode server start timeout'));
    }, timeout);

    const onData = (data: Buffer) => {
      output += data.toString();
      const match = output.match(/http:\/\/[\d.]+:\d+/);
      if (match) {
        clearTimeout(timer);
        proc.stdout?.off('data', onData);
        proc.stderr?.off('data', onData);
        resolve(match[0]);
      }
    };

    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    proc.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0 && !state.url) {
        reject(new Error(`OpenCode server exited with code ${code}`));
      }
    });
  });
}

/**
 * Make an API request to the OpenCode server
 */
async function apiRequest<T>(
  path: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'GET',
  body?: unknown
): Promise<T> {
  if (!state.url) {
    throw new Error('Server not running');
  }

  const url = `${state.url}${path}`;
  const response = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`API error ${response.status}: ${text}`);
  }

  // Handle empty responses
  const text = await response.text();
  if (!text) {
    return {} as T;
  }

  return JSON.parse(text) as T;
}

/**
 * Start the OpenCode server if not already running
 */
async function ensureServer(): Promise<string> {
  // Already running
  if (state.url) {
    return state.url;
  }

  // Already starting
  if (state.starting) {
    return state.starting;
  }

  // Start the server
  state.starting = (async () => {
    // Ensure data directory exists
    if (!existsSync(DEX_OPENCODE_HOME)) {
      mkdirSync(DEX_OPENCODE_HOME, { recursive: true });
    }

    const proc = spawn(OPENCODE_BIN, ['serve', '--port=0'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: false,
      env: {
        ...process.env,
        OPENCODE_HOME: DEX_OPENCODE_HOME,
      },
    });

    state.process = proc;

    // Handle unexpected exit
    proc.on('exit', (code) => {
      if (state.process === proc) {
        state.process = null;
        state.url = null;
        state.starting = null;
        state.credentialsSet.clear();
      }
    });

    try {
      const url = await waitForServerReady(proc);
      state.url = url;
      state.starting = null;

      // Inject any existing credentials
      await injectStoredCredentials();

      return url;
    } catch (error) {
      proc.kill();
      state.process = null;
      state.starting = null;
      throw error;
    }
  })();

  return state.starting;
}

/**
 * Inject stored credentials for all providers
 */
async function injectStoredCredentials(): Promise<void> {
  // Claude Code (Anthropic)
  const claudeCreds = getClaudeCodeCredentials();
  if (claudeCreds) {
    try {
      await setCredentials('anthropic', {
        access: claudeCreds.accessToken,
        refresh: claudeCreds.refreshToken,
        expires: claudeCreds.expiresAt,
      });
    } catch {
      // Ignore - credentials may be invalid
    }
  }

  // Codex (OpenAI)
  const codexCreds = getCodexCredentials();
  if (codexCreds) {
    try {
      await setCredentials('openai', {
        access: codexCreds.accessToken,
        refresh: codexCreds.refreshToken,
        expires: codexCreds.expiresAt,
      });
    } catch {
      // Ignore - credentials may be invalid
    }
  }
}

/**
 * Set credentials for a provider
 */
export async function setCredentials(
  provider: ProviderId,
  creds: { access: string; refresh: string; expires: number }
): Promise<void> {
  await ensureServer();

  await apiRequest(`/auth/${provider}`, 'PUT', {
    type: 'oauth',
    access: creds.access,
    refresh: creds.refresh,
    expires: creds.expires,
  });

  state.credentialsSet.add(provider);
}

/**
 * Check if credentials are set for a provider
 */
export function hasCredentials(provider: ProviderId): boolean {
  return state.credentialsSet.has(provider);
}

/**
 * Refresh credentials for a provider from storage
 */
export async function refreshCredentials(provider: ProviderId): Promise<boolean> {
  if (provider === 'anthropic') {
    const creds = getClaudeCodeCredentials();
    if (creds) {
      await setCredentials('anthropic', {
        access: creds.accessToken,
        refresh: creds.refreshToken,
        expires: creds.expiresAt,
      });
      return true;
    }
  } else if (provider === 'openai') {
    const creds = getCodexCredentials();
    if (creds) {
      await setCredentials('openai', {
        access: creds.accessToken,
        refresh: creds.refreshToken,
        expires: creds.expiresAt,
      });
      return true;
    }
  }
  return false;
}

export interface TestResult {
  success: boolean;
  message: string;
  latencyMs?: number;
}

/**
 * Test connection for a provider by creating a session and sending a prompt
 */
export async function testConnection(provider: ProviderId): Promise<TestResult> {
  const startTime = Date.now();

  try {
    await ensureServer();

    // Refresh credentials from storage
    const hasNewCreds = await refreshCredentials(provider);
    if (!hasNewCreds && !hasCredentials(provider)) {
      return {
        success: false,
        message: `No credentials found for ${provider === 'anthropic' ? 'Claude Code' : 'Codex'}`,
      };
    }

    // Create a test session with a lightweight model
    // Use cheapest models to minimize cost for test pings
    const testModel = provider === 'anthropic'
      ? 'claude-haiku-4-5'           // Cheapest/fastest Claude model
      : 'gpt-5.1-codex-mini-medium'; // Cheapest 5.1 model via Codex OAuth

    interface SessionResponse {
      id: string;
    }
    const session = await apiRequest<SessionResponse>('/session', 'POST', {
      provider,
      model: testModel,
    });

    if (!session.id) {
      return {
        success: false,
        message: 'Failed to create session',
        latencyMs: Date.now() - startTime,
      };
    }

    // Send a minimal test prompt
    interface MessageResponse {
      content?: string;
      text?: string;
      parts?: Array<{ type?: string; text?: string }>;
    }

    const response = await apiRequest<MessageResponse>(
      `/session/${session.id}/message`,
      'POST',
      {
        parts: [{ type: 'text', text: 'Reply with only: ok' }],
      }
    );

    // Clean up session
    try {
      await apiRequest(`/session/${session.id}`, 'DELETE');
    } catch {
      // Ignore cleanup errors
    }

    const latencyMs = Date.now() - startTime;

    // Check for response
    const hasResponse =
      response.content ||
      response.text ||
      (response.parts && response.parts.some((p) => p.text));

    if (hasResponse) {
      return {
        success: true,
        message: `Connected (${latencyMs}ms)`,
        latencyMs,
      };
    }

    return {
      success: false,
      message: 'Empty response from API',
      latencyMs,
    };
  } catch (error) {
    const latencyMs = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    // Parse common errors
    if (errorMessage.includes('401') || errorMessage.includes('unauthorized')) {
      return {
        success: false,
        message: 'Authentication failed - please re-authenticate',
        latencyMs,
      };
    }

    if (errorMessage.includes('429') || errorMessage.includes('rate')) {
      return {
        success: false,
        message: 'Rate limited - try again later',
        latencyMs,
      };
    }

    return {
      success: false,
      message: errorMessage,
      latencyMs,
    };
  }
}

/**
 * Send a prompt using the shared server
 */
export async function prompt(
  provider: ProviderId,
  text: string,
  options?: { system?: string }
): Promise<string> {
  await ensureServer();

  // Ensure credentials are set
  if (!hasCredentials(provider)) {
    await refreshCredentials(provider);
  }

  // Create session
  interface SessionResponse {
    id: string;
  }
  const session = await apiRequest<SessionResponse>('/session', 'POST', {
    provider,
  });

  try {
    // Send message
    interface MessageResponse {
      content?: string;
      text?: string;
      message?: { content?: string };
      parts?: Array<{ type?: string; text?: string; content?: string }>;
    }

    const response = await apiRequest<MessageResponse>(
      `/session/${session.id}/message`,
      'POST',
      {
        parts: [{ type: 'text', text }],
        ...(options?.system && { system: options.system }),
      }
    );

    // Extract text from response
    if (response.content) return response.content;
    if (response.text) return response.text;
    if (response.message?.content) return response.message.content;
    if (response.parts) {
      const textParts = response.parts.filter((p) => p.type === 'text' && p.text);
      if (textParts.length > 0) {
        return textParts.map((p) => p.text).join('\n');
      }
    }
    return '';
  } finally {
    // Clean up session
    try {
      await apiRequest(`/session/${session.id}`, 'DELETE');
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Get the server URL (starts server if needed)
 */
export async function getServerUrl(): Promise<string> {
  return ensureServer();
}

/**
 * Check if server is running
 */
export function isServerRunning(): boolean {
  return state.url !== null;
}

/**
 * Stop the server
 */
export function stopServer(): void {
  if (state.process) {
    state.process.kill();
    state.process = null;
    state.url = null;
    state.starting = null;
    state.credentialsSet.clear();
  }
}

// Clean up on process exit
process.on('exit', () => {
  stopServer();
});

process.on('SIGINT', () => {
  stopServer();
  process.exit(0);
});

process.on('SIGTERM', () => {
  stopServer();
  process.exit(0);
});
