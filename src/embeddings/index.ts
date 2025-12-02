import { existsSync, mkdirSync, createWriteStream, writeFileSync, readFileSync } from 'fs';
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

// Clear progress file
export function clearEmbeddingProgress(): void {
  const path = getProgressPath();
  if (existsSync(path)) {
    writeFileSync(path, JSON.stringify({ status: 'idle', total: 0, completed: 0 }));
  }
}

// Check if embedding is currently in progress
export function isEmbeddingInProgress(): boolean {
  const progress = getEmbeddingProgress();
  return progress.status === 'downloading' || progress.status === 'embedding';
}
