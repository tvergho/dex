import { existsSync, mkdirSync, createWriteStream, writeFileSync, readFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { getDataDir } from '../utils/config';
import {
  startLlamaServer,
  stopLlamaServer,
  embedBatchViaServer,
  isLlamaServerInstalled,
} from './llama-server';

// Embedding progress state
export interface EmbeddingProgress {
  status: 'idle' | 'downloading' | 'embedding' | 'done' | 'error';
  total: number;
  completed: number;
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

function getProgressPath(): string {
  return join(getDataDir(), 'embedding-progress.json');
}

// ============ Embed Lock to Prevent Multiple Processes ============

const EMBED_LOCK_FILE = 'embed.lock';
const EMBED_LOCK_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes - stale lock threshold

interface EmbedLockInfo {
  pid: number;
  startedAt: number;
}

function getEmbedLockPath(): string {
  return join(getDataDir(), EMBED_LOCK_FILE);
}

/**
 * Try to acquire the embed lock. Returns true if acquired, false if another process holds it.
 */
export function acquireEmbedLock(): boolean {
  const lockPath = getEmbedLockPath();

  // Check for existing lock
  if (existsSync(lockPath)) {
    try {
      const lockData = JSON.parse(readFileSync(lockPath, 'utf-8')) as EmbedLockInfo;
      const lockAge = Date.now() - lockData.startedAt;

      // Check if lock is stale
      if (lockAge < EMBED_LOCK_TIMEOUT_MS) {
        // Check if process is still running
        try {
          process.kill(lockData.pid, 0); // Signal 0 = check if process exists
          return false; // Process still running, lock is valid
        } catch {
          // Process is dead, lock is stale - fall through to acquire
        }
      }
      // Lock is stale, remove it
      unlinkSync(lockPath);
    } catch {
      // Corrupted lock file, remove it
      try { unlinkSync(lockPath); } catch { /* ignore */ }
    }
  }

  // Acquire lock
  const lockInfo: EmbedLockInfo = {
    pid: process.pid,
    startedAt: Date.now(),
  };

  try {
    writeFileSync(lockPath, JSON.stringify(lockInfo), { flag: 'wx' }); // wx = fail if exists
    return true;
  } catch {
    return false; // Another process beat us to it
  }
}

/**
 * Release the embed lock.
 */
export function releaseEmbedLock(): void {
  const lockPath = getEmbedLockPath();
  try {
    if (existsSync(lockPath)) {
      const lockData = JSON.parse(readFileSync(lockPath, 'utf-8')) as EmbedLockInfo;
      // Only release if we own the lock
      if (lockData.pid === process.pid) {
        unlinkSync(lockPath);
      }
    }
  } catch {
    // Ignore errors during cleanup
  }
}

export function getEmbeddingProgress(): EmbeddingProgress {
  const path = getProgressPath();
  if (!existsSync(path)) {
    return { status: 'idle', total: 0, completed: 0 };
  }
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return { status: 'idle', total: 0, completed: 0 };
  }
}

export function setEmbeddingProgress(progress: EmbeddingProgress): void {
  writeFileSync(getProgressPath(), JSON.stringify(progress, null, 2));
}

// EmbeddingGemma-300M: 2.5x faster than Qwen3-0.6B, half the model size
const MODEL_NAME = 'embeddinggemma-300M-Q8_0.gguf';
const MODEL_URL =
  'https://huggingface.co/unsloth/embeddinggemma-300m-GGUF/resolve/main/embeddinggemma-300M-Q8_0.gguf';
export const EMBEDDING_DIMENSIONS = 768;

// Max characters to keep (roughly ~6K tokens)
// EmbeddingGemma supports 8K tokens
const MAX_TEXT_CHARS = 18000;

// Cached server port for query embedding
let queryServerPort: number | null = null;

export function getModelsDir(): string {
  const modelsDir = join(getDataDir(), 'models');
  if (!existsSync(modelsDir)) {
    mkdirSync(modelsDir, { recursive: true });
  }
  return modelsDir;
}

export function getModelPath(): string {
  return join(getModelsDir(), MODEL_NAME);
}

export async function downloadModel(
  onProgress?: (downloaded: number, total: number) => void
): Promise<void> {
  const modelPath = getModelPath();

  if (existsSync(modelPath)) {
    return;
  }

  // Follow redirects (Hugging Face uses 302 redirects)
  const response = await fetch(MODEL_URL, { redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`Failed to download model: ${response.statusText}`);
  }

  const contentLength = response.headers.get('content-length');
  const total = contentLength ? parseInt(contentLength, 10) : 0;
  let downloaded = 0;

  const fileStream = createWriteStream(modelPath);
  const reader = response.body?.getReader();

  if (!reader) {
    throw new Error('Failed to get response reader');
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      fileStream.write(Buffer.from(value));
      downloaded += value.length;

      if (onProgress && total > 0) {
        onProgress(downloaded, total);
      }
    }
  } finally {
    fileStream.end();
  }
}

function truncateText(text: string): string {
  if (text.length <= MAX_TEXT_CHARS) {
    return text;
  }
  // Truncate and add indicator
  return text.slice(0, MAX_TEXT_CHARS) + '...';
}

/**
 * Ensure llama-server is running for query embedding.
 * Starts the server if not already running.
 */
async function ensureQueryServer(): Promise<number> {
  if (queryServerPort !== null) {
    // Check if server is still healthy
    try {
      const response = await fetch(`http://127.0.0.1:${queryServerPort}/health`);
      if (response.ok) {
        return queryServerPort;
      }
    } catch {
      // Server not responding, restart it
      queryServerPort = null;
    }
  }

  // Check prerequisites
  const modelPath = getModelPath();
  if (!existsSync(modelPath)) {
    throw new Error(
      `Model not found at ${modelPath}. Run sync to download the model first.`
    );
  }

  if (!isLlamaServerInstalled()) {
    throw new Error('llama-server not installed. Run sync first.');
  }

  // Start server
  queryServerPort = await startLlamaServer(modelPath);
  return queryServerPort;
}

/**
 * Embed a single query using llama-server.
 * Starts the server if not already running.
 */
export async function embedQuery(text: string): Promise<number[]> {
  const port = await ensureQueryServer();
  const truncated = truncateText(text);
  const vectors = await embedBatchViaServer([truncated], port);
  return vectors[0] || [];
}

/**
 * Stop the query embedding server if running.
 */
export async function stopQueryServer(): Promise<void> {
  if (queryServerPort !== null) {
    await stopLlamaServer();
    queryServerPort = null;
  }
}

/**
 * Pre-warm the query server so searches are fast.
 * Call this on app startup. Safe to call multiple times.
 */
export async function warmupQueryServer(): Promise<void> {
  try {
    await ensureQueryServer();
  } catch {
    // Silently fail - server will start on first search if needed
  }
}

// Clear progress file
export function clearEmbeddingProgress(): void {
  const path = getProgressPath();
  if (existsSync(path)) {
    writeFileSync(path, JSON.stringify({ status: 'idle', total: 0, completed: 0 }));
  }
}

// Check if embedding is currently in progress
// Returns false if no embedding process is running, even if status shows 'embedding'
// (handles the case where a previous process crashed)
export function isEmbeddingInProgress(): boolean {
  const progress = getEmbeddingProgress();
  if (progress.status !== 'downloading' && progress.status !== 'embedding') {
    return false;
  }

  // Check if the embedding process is actually still running by checking for llama-server
  // or dex embed processes. If no process is running, the status file is stale.
  try {
    // Use pgrep to check for running dex embed or llama-server processes
    // This is a lightweight check that doesn't require spawning a shell
    const { execSync } = require('child_process');
    if (process.platform !== 'win32') {
      try {
        // Check for any embed process (dex embed, embed.ts, or node/bun running embed)
        execSync('pgrep -f "dex embed" 2>/dev/null || pgrep -f "embed\\.ts" 2>/dev/null || pgrep -f "node.*embed" 2>/dev/null || pgrep -f "bun.*embed" 2>/dev/null', { stdio: 'pipe', shell: true });
        return true; // Process found
      } catch {
        // No embed process found, check llama-server
        try {
          execSync('pgrep -f "llama-server" 2>/dev/null', { stdio: 'pipe' });
          return true; // Process found
        } catch {
          // No embedding processes found - status is stale
          return false;
        }
      }
    } else {
      // On Windows, use tasklist to check for processes
      try {
        execSync('tasklist /FI "IMAGENAME eq node.exe" 2>nul | findstr /I "embed"', { stdio: 'pipe' });
        return true; // Process found
      } catch {
        try {
          execSync('tasklist /FI "IMAGENAME eq llama-server.exe" 2>nul', { stdio: 'pipe' });
          return true; // Process found
        } catch {
          // No embedding processes found - status is stale
          return false;
        }
      }
    }
  } catch {
    // On error checking for processes, assume no process is running
    // (safer to return false than true when we can't verify)
    return false;
  }
}
