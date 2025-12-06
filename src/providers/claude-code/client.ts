/**
 * Claude Code client wrapper using OpenCode SDK
 *
 * Manages OpenCode server lifecycle and provides an authenticated client
 * for sending prompts using Claude Code credentials.
 */

import { spawn, type ChildProcess } from 'child_process';
import { join } from 'path';
import { homedir } from 'os';
import { mkdirSync, existsSync } from 'fs';
import { getClaudeCodeCredentials } from './credentials.js';
import { getOpencodeBinPath } from '../../utils/paths.js';

const OPENCODE_BIN = getOpencodeBinPath();

// Use a local OpenCode data directory to avoid polluting global state
const DEX_OPENCODE_HOME = join(homedir(), '.dex', 'opencode');

export interface ClaudeCodeClient {
  /** Send a prompt and get a response */
  prompt(text: string, options?: { system?: string }): Promise<string>;
  /** Clean up resources */
  close(): Promise<void>;
}

export interface OpenCodeServerState {
  process: ChildProcess;
  url: string;
  sessionId?: string;
}

export interface StartServerOptions {
  /** Custom XDG_CONFIG_HOME for isolated config */
  xdgConfigHome?: string;
  /** Custom XDG_DATA_HOME for isolated data/auth */
  xdgDataHome?: string;
}

/**
 * Wait for OpenCode server to be ready by polling the output
 */
export function waitForServer(proc: ChildProcess, timeout = 30000): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => {
      reject(new Error('OpenCode server start timeout'));
    }, timeout);

    const onData = (data: Buffer) => {
      output += data.toString();
      // Look for the URL in the output
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
      if (code !== 0) {
        reject(new Error(`OpenCode server exited with code ${code}`));
      }
    });
  });
}

/**
 * Start the OpenCode server with optional isolated directories
 */
export async function startServer(options?: StartServerOptions): Promise<OpenCodeServerState> {
  // Build environment variables
  const env: Record<string, string | undefined> = { ...process.env };

  if (options?.xdgConfigHome) {
    env.XDG_CONFIG_HOME = options.xdgConfigHome;
  }
  if (options?.xdgDataHome) {
    env.XDG_DATA_HOME = options.xdgDataHome;
  }

  // If no XDG options provided, use default isolation via OPENCODE_HOME
  if (!options?.xdgConfigHome && !options?.xdgDataHome) {
    if (!existsSync(DEX_OPENCODE_HOME)) {
      mkdirSync(DEX_OPENCODE_HOME, { recursive: true });
    }
    env.OPENCODE_HOME = DEX_OPENCODE_HOME;
  }

  // Find an available port (let the OS choose)
  const port = 0;

  const proc = spawn(OPENCODE_BIN, ['serve', `--port=${port}`], {
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: false,
    env,
  });

  try {
    const url = await waitForServer(proc);
    return { process: proc, url };
  } catch (error) {
    proc.kill();
    throw error;
  }
}

/**
 * Make an API request to the OpenCode server
 */
export async function apiRequest<T>(
  baseUrl: string,
  path: string,
  method: 'GET' | 'POST' | 'PUT' = 'GET',
  body?: unknown
): Promise<T> {
  const url = `${baseUrl}${path}`;
  const response = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`API error ${response.status}: ${text}`);
  }

  return response.json() as Promise<T>;
}

/**
 * Create an authenticated Claude Code client using local credentials
 *
 * @returns Client instance or null if no valid credentials
 */
export async function createClaudeCodeClient(): Promise<ClaudeCodeClient | null> {
  // Get credentials
  const creds = getClaudeCodeCredentials();
  if (!creds) {
    return null;
  }

  // Start OpenCode server
  let state: OpenCodeServerState;
  try {
    state = await startServer();
  } catch (error) {
    console.error('Failed to start OpenCode server:', error);
    return null;
  }

  // Inject Claude Code credentials via PUT /auth/{provider}
  // OpenCode expects OAuth format: { type: "oauth", access, refresh, expires (timestamp) }
  try {
    await apiRequest(state.url, '/auth/anthropic', 'PUT', {
      type: 'oauth',
      access: creds.accessToken,
      refresh: creds.refreshToken,
      expires: creds.expiresAt, // timestamp in milliseconds
    });
  } catch (error) {
    state.process.kill();
    console.error('Failed to set credentials:', error);
    return null;
  }

  // Create a session via POST /session
  try {
    interface SessionCreateResponse {
      id: string;
    }
    const sessionResponse = await apiRequest<SessionCreateResponse>(
      state.url,
      '/session',
      'POST',
      {}
    );
    state.sessionId = sessionResponse.id;
  } catch (error) {
    state.process.kill();
    console.error('Failed to create session:', error);
    return null;
  }

  return {
    async prompt(text: string, options?: { system?: string }): Promise<string> {
      if (!state.sessionId) {
        throw new Error('No active session');
      }

      interface PromptResponse {
        content?: string;
        text?: string;
        message?: { content?: string };
        parts?: Array<{ type?: string; text?: string; content?: string }>;
      }

      // POST /session/{id}/message
      // OpenCode expects: { parts: [{ type: "text", text: "..." }], system?: "..." }
      const response = await apiRequest<PromptResponse>(
        state.url,
        `/session/${state.sessionId}/message`,
        'POST',
        {
          parts: [{ type: 'text', text }],
          ...(options?.system && { system: options.system }),
        }
      );

      // Extract text from response (structure may vary)
      if (response.content) return response.content;
      if (response.text) return response.text;
      if (response.message?.content) return response.message.content;
      // Response parts are typically assistant responses
      if (response.parts) {
        const textParts = response.parts.filter(p => p.type === 'text' && p.text);
        if (textParts.length > 0) {
          return textParts.map(p => p.text).join('\n');
        }
      }
      return '';
    },

    async close(): Promise<void> {
      if (state.sessionId) {
        try {
          // DELETE /session/{id}
          await fetch(`${state.url}/session/${state.sessionId}`, {
            method: 'DELETE',
          });
        } catch {
          // Ignore cleanup errors
        }
      }
      state.process.kill();
    },
  };
}

