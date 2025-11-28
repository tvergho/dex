import { getLlama, LlamaEmbeddingContext, LlamaModel } from 'node-llama-cpp';
import { existsSync, mkdirSync, createWriteStream, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { cpus } from 'os';
import { getDataDir } from '../utils/config';

// Throttling settings for background embedding
// Use 50% of CPU cores (minimum 2) - balanced between speed and user impact
const LOW_PRIORITY_THREADS = Math.max(2, Math.floor(cpus().length * 0.5));
// Batch size for embedding context
const EMBEDDING_BATCH_SIZE = 128;

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

const MODEL_NAME = 'Qwen3-Embedding-0.6B-Q8_0.gguf';
const MODEL_URL =
  'https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF/resolve/main/Qwen3-Embedding-0.6B-Q8_0.gguf';
export const EMBEDDING_DIMENSIONS = 1024;

// Max characters to keep (roughly ~8K tokens with buffer for instruction prefix)
// Qwen3-Embedding supports 32K tokens but we'll be conservative
const MAX_TEXT_CHARS = 24000;

let llamaInstance: Awaited<ReturnType<typeof getLlama>> | null = null;
let model: LlamaModel | null = null;
let embeddingContext: LlamaEmbeddingContext | null = null;

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

export async function initEmbeddings(lowPriority: boolean = false): Promise<void> {
  if (embeddingContext) return;

  const modelPath = getModelPath();

  if (!existsSync(modelPath)) {
    throw new Error(
      `Model not found at ${modelPath}. Run sync to download the model first.`
    );
  }

  // For background embedding, limit threads to minimize CPU impact
  const threadCount = lowPriority ? LOW_PRIORITY_THREADS : undefined;

  llamaInstance = await getLlama({
    // Limit max threads for low-priority background work
    ...(threadCount && { maxThreads: threadCount }),
  });
  model = await llamaInstance.loadModel({ modelPath });
  embeddingContext = await model.createEmbeddingContext({
    // Limit context threads for background work
    ...(threadCount && { threads: threadCount }),
    // Smaller batch size reduces CPU spikes
    ...(lowPriority && { batchSize: EMBEDDING_BATCH_SIZE }),
  });
}

function truncateText(text: string): string {
  if (text.length <= MAX_TEXT_CHARS) {
    return text;
  }
  // Truncate and add indicator
  return text.slice(0, MAX_TEXT_CHARS) + '...';
}

export async function embed(texts: string[]): Promise<number[][]> {
  await initEmbeddings();

  if (!embeddingContext) {
    throw new Error('Embedding context not initialized');
  }

  const embeddings: number[][] = [];
  for (const text of texts) {
    // Truncate long texts to fit context window
    const truncated = truncateText(text);
    // Qwen3-Embedding uses instruction prefixes for best results
    const prefixed = `Instruct: Retrieve relevant code conversations\nQuery: ${truncated}`;
    const result = await embeddingContext.getEmbeddingFor(prefixed);
    embeddings.push(Array.from(result.vector));
  }
  return embeddings;
}

export async function embedQuery(text: string): Promise<number[]> {
  await initEmbeddings();

  if (!embeddingContext) {
    throw new Error('Embedding context not initialized');
  }

  const truncated = truncateText(text);
  const prefixed = `Instruct: Retrieve relevant code conversations\nQuery: ${truncated}`;
  const result = await embeddingContext.getEmbeddingFor(prefixed);
  return Array.from(result.vector);
}

export async function disposeEmbeddings(): Promise<void> {
  if (embeddingContext) {
    await embeddingContext.dispose();
    embeddingContext = null;
  }
  if (model) {
    await model.dispose();
    model = null;
  }
  llamaInstance = null;
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
