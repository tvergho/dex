#!/usr/bin/env bun
/**
 * Background embedding worker - runs embeddings in background after sync
 * Can be spawned with: bun run src/cli/commands/embed.ts
 *
 * Run with --benchmark to find optimal batch size for your system:
 *   bun run src/cli/commands/embed.ts --benchmark
 *
 * Uses llama-server for fast GPU-accelerated batch embedding
 */

import { connect, rebuildVectorIndex, rebuildFtsIndex, getMessagesTable, compactMessagesTable, cleanupOldVersions, withRetry } from '../../db/index';
import {
  downloadModel,
  getModelPath,
  setEmbeddingProgress,
  getEmbeddingProgress,
  isEmbeddingInProgress,
  clearEmbeddingProgress,
  acquireEmbedLock,
  releaseEmbedLock,
  EMBEDDING_DIMENSIONS,
} from '../../embeddings/index';
import {
  isLlamaServerInstalled,
  downloadLlamaServer,
  startLlamaServer,
  stopLlamaServer,
  embedBatchViaServer,
  getLlamaServerPid,
} from '../../embeddings/llama-server';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getDataDir } from '../../utils/config';
import { execSync } from 'child_process';

// ============ Configurable Settings ============

interface EmbedConfig {
  serverBatchSize: number;
  maxTextChars: number;
  batchDelayMs: number;
  benchmarkedAt?: string;
  throughput?: number;  // messages per second
  efficiency?: number;  // messages per CPU-second (energy efficiency proxy)
}

const DEFAULT_CONFIG: EmbedConfig = {
  serverBatchSize: 32,
  maxTextChars: 2000,
  batchDelayMs: 0, // No delay between batches for maximum throughput
};

function getConfigPath(): string {
  return join(getDataDir(), 'embed-config.json');
}

function loadConfig(): EmbedConfig | null {
  const path = getConfigPath();
  if (existsSync(path)) {
    try {
      return { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(path, 'utf-8')) };
    } catch {
      return null;
    }
  }
  return null; // No config exists - need to benchmark
}

function hasConfig(): boolean {
  return existsSync(getConfigPath());
}

function saveConfig(config: EmbedConfig): void {
  writeFileSync(getConfigPath(), JSON.stringify(config, null, 2));
}

// Config is loaded dynamically - may run benchmark first if not exists
let SERVER_BATCH_SIZE = DEFAULT_CONFIG.serverBatchSize;
let MAX_TEXT_CHARS = DEFAULT_CONFIG.maxTextChars;
let BATCH_DELAY_MS = DEFAULT_CONFIG.batchDelayMs;

function applyConfig(cfg: EmbedConfig): void {
  SERVER_BATCH_SIZE = cfg.serverBatchSize;
  MAX_TEXT_CHARS = cfg.maxTextChars;
  BATCH_DELAY_MS = cfg.batchDelayMs;
}

// Rebuild FTS index after every batch to keep search working during embedding
// mergeInsert invalidates the FTS index immediately, so we must rebuild each time
const FTS_REBUILD_EVERY_BATCH = true;

// Clean up old versions every N batches to prevent disk space bloat
// LanceDB is append-only and creates a new version for each mergeInsert.
// Without cleanup, embedding 13K messages creates ~400 versions = 400x bloat!
const CLEANUP_EVERY_N_BATCHES = 10;

// Max rows per mergeInsert to avoid LanceDB OOM during external sort
// This is separate from SERVER_BATCH_SIZE - we can embed 256 at a time but write 100 at a time
const DB_WRITE_BATCH_SIZE = 100;

// Rebuild vector index every N messages to enable semantic search during embedding
// Without this, vector search works but does brute-force scan until embedding completes
const VECTOR_INDEX_REBUILD_EVERY_N_MESSAGES = 500;

// Database row structure (snake_case column names)
interface MessageRow {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  timestamp: string;
  message_index: number;
  vector: number[] | Float32Array;
}

async function getAllMessagesNeedingEmbedding(): Promise<MessageRow[]> {
  const table = await getMessagesTable();
  // Use withRetry to handle transient LanceDB errors (e.g., "Not found" when files
  // are cleaned up during concurrent sync/optimize operations)
  const allMessages = await withRetry(() => table.query().toArray());

  // Filter messages that have zero vectors or wrong dimensions (model changed)
  return allMessages.filter((row) => {
    const vector = row.vector;
    if (!vector) return true;
    // Convert to array if it's a Float32Array
    const arr = Array.isArray(vector) ? vector : Array.from(vector as Float32Array);
    // Check for wrong dimensions (model changed) or zero vectors (not yet embedded)
    if (arr.length !== EMBEDDING_DIMENSIONS) return true;
    return arr.every((v) => v === 0);
  }) as MessageRow[];
}

function truncateText(text: string): string {
  if (text.length <= MAX_TEXT_CHARS) {
    return text;
  }
  return text.slice(0, MAX_TEXT_CHARS) + '...';
}

/**
 * Strip interleaved tool output blocks from content before embedding.
 * Tool outputs are formatted as:
 *   ---
 *   **ToolName** `filename`
 *   ```
 *   ... code ...
 *   ```
 *   ---
 * We want to embed only the conversational text, not the code.
 */
function stripToolOutputs(text: string): string {
  // Match tool output blocks: ---\n**ToolName**...\n```...```\n---
  // Use a regex to match these blocks and remove them
  // Supports both 3 and 4 backticks (4 is used when content may contain code blocks)
  const toolBlockPattern = /\n---\n\*\*[^*]+\*\*[^\n]*\n(`{3,4})[\s\S]*?\1\n---\n?/g;
  return text.replace(toolBlockPattern, '\n').trim();
}

function prepareTexts(texts: string[]): string[] {
  return texts.map((text) => {
    // Strip tool outputs before embedding to avoid embedding code
    const stripped = stripToolOutputs(text);
    return truncateText(stripped);
  });
}

async function runWithServer(
  messages: MessageRow[],
  table: Awaited<ReturnType<typeof getMessagesTable>>
): Promise<{ success: boolean; error?: string }> {
  const modelPath = getModelPath();

  // Helper to write a batch to DB with retries
  async function writeBatchToDb(rows: NonNullable<ReturnType<typeof buildRow>>[]) {
    if (rows.length === 0) return;
    let retries = 3;
    while (retries > 0) {
      try {
        await table.mergeInsert('id').whenMatchedUpdateAll().execute(rows);
        break;
      } catch (err) {
        retries--;
        if (retries === 0) throw err;
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  }

  // Helper to build a row from message + vector
  function buildRow(msg: MessageRow, vec: number[] | null) {
    if (!vec || vec.length !== EMBEDDING_DIMENSIONS) return null;
    return {
      id: msg.id,
      conversation_id: msg.conversation_id,
      role: msg.role,
      content: msg.content,
      timestamp: msg.timestamp,
      message_index: msg.message_index,
      vector: vec,
    };
  }

  try {
    // Download llama-server if needed
    if (!isLlamaServerInstalled()) {
      console.log('Downloading llama-server...');
      await downloadLlamaServer((downloaded, total) => {
        const pct = Math.round((downloaded / total) * 100);
        process.stdout.write(`\rDownloading llama-server: ${pct}%`);
      });
      console.log('\nllama-server downloaded.');
    }

    // Start server with default low-priority thread count
    console.log('Starting llama-server...');
    const port = await startLlamaServer(modelPath);
    console.log(`llama-server started on port ${port}`);

    // Pending rows to write (accumulate until DB_WRITE_BATCH_SIZE)
    let pendingRows: NonNullable<ReturnType<typeof buildRow>>[] = [];
    let dbWriteCount = 0;

    // Process in batches (large batches for GPU efficiency)
    const totalBatches = Math.ceil(messages.length / SERVER_BATCH_SIZE);
    for (let i = 0; i < messages.length; i += SERVER_BATCH_SIZE) {
      const batch = messages.slice(i, i + SERVER_BATCH_SIZE);
      const batchNum = Math.floor(i / SERVER_BATCH_SIZE) + 1;
      const pct = Math.round((batchNum / totalBatches) * 100);
      process.stdout.write(`\rEmbedding: ${batchNum}/${totalBatches} (${pct}%)`);
      const texts = prepareTexts(batch.map((m) => m.content));

      const vectors = await embedBatchViaServer(texts, port);

      // Validate vector dimensions
      const validVectors = vectors.filter((v) => v && v.length === EMBEDDING_DIMENSIONS);
      if (validVectors.length !== vectors.length) {
        console.warn(`Warning: ${vectors.length - validVectors.length} invalid vectors in batch`);
      }

      // Build rows and add to pending
      for (let j = 0; j < batch.length; j++) {
        const row = buildRow(batch[j]!, vectors[j] ?? null);
        if (row) pendingRows.push(row);
      }

      // Write to DB in smaller chunks to avoid LanceDB OOM
      while (pendingRows.length >= DB_WRITE_BATCH_SIZE) {
        const writeChunk = pendingRows.slice(0, DB_WRITE_BATCH_SIZE);
        pendingRows = pendingRows.slice(DB_WRITE_BATCH_SIZE);

        await writeBatchToDb(writeChunk);
        dbWriteCount++;

        // Rebuild FTS index after every DB write to keep search working
        if (FTS_REBUILD_EVERY_BATCH) {
          await rebuildFtsIndex();
        }

        // Clean up old versions periodically
        if (dbWriteCount % CLEANUP_EVERY_N_BATCHES === 0) {
          await cleanupOldVersions();
        }
      }

      // Rebuild vector index periodically so semantic search works during embedding
      const messagesEmbedded = Math.min(i + SERVER_BATCH_SIZE, messages.length);
      const previousMilestone = Math.floor(i / VECTOR_INDEX_REBUILD_EVERY_N_MESSAGES);
      const currentMilestone = Math.floor(messagesEmbedded / VECTOR_INDEX_REBUILD_EVERY_N_MESSAGES);
      if (currentMilestone > previousMilestone) {
        process.stdout.write(' (rebuilding vector index...)');
        await rebuildVectorIndex();
      }

      // Update progress
      setEmbeddingProgress({
        status: 'embedding',
        total: messages.length,
        completed: Math.min(i + SERVER_BATCH_SIZE, messages.length),
        startedAt: getEmbeddingProgress().startedAt,
      });

      // Optional pause between batches (default 0 for max throughput)
      if (BATCH_DELAY_MS > 0 && i + SERVER_BATCH_SIZE < messages.length) {
        await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
      }
    }

    // Write any remaining pending rows
    if (pendingRows.length > 0) {
      await writeBatchToDb(pendingRows);
      if (FTS_REBUILD_EVERY_BATCH) {
        await rebuildFtsIndex();
      }
    }

    console.log(''); // Newline after progress
    await stopLlamaServer();
    return { success: true };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error('Server embedding failed:', errorMsg);
    await stopLlamaServer();
    return { success: false, error: errorMsg };
  }
}


async function runBackgroundEmbedding(): Promise<void> {
  // Try to acquire the embed lock - this is atomic and prevents race conditions
  if (!acquireEmbedLock()) {
    console.log('Another embedding process is running, exiting');
    return;
  }

  // Also check the legacy progress-based detection
  if (isEmbeddingInProgress()) {
    console.log('Embedding already in progress, exiting');
    releaseEmbedLock();
    return;
  }

  // Set up graceful shutdown handlers
  let isShuttingDown = false;
  const gracefulShutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.log(`\n[embed] Received ${signal}, cleaning up...`);
    try {
      // Stop llama-server first
      await stopLlamaServer();

      // Rebuild FTS index so search works with partial embeddings
      console.log('[embed] Rebuilding FTS index...');
      await rebuildFtsIndex();

      // Update progress to show interrupted state
      const progress = getEmbeddingProgress();
      setEmbeddingProgress({
        ...progress,
        status: 'error',
        error: `Interrupted by ${signal}`,
      });
    } catch (err) {
      console.error('[embed] Error during cleanup:', err);
    } finally {
      releaseEmbedLock();
      process.exit(0);
    }
  };

  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

  // Immediately mark as in-progress to prevent race conditions with other dex instances
  // This must happen BEFORE any async work to ensure other processes see it
  setEmbeddingProgress({
    status: 'downloading',
    total: 0,
    completed: 0,
    startedAt: new Date().toISOString(),
  });

  try {
    await connect();

    // Compact the table to materialize any deletions from force sync.
    // This is required before mergeInsert can work on tables with many deleted rows.
    console.log('Compacting messages table...');
    await compactMessagesTable();

    // Get messages that need embedding
    const messages = await getAllMessagesNeedingEmbedding();

    if (messages.length === 0) {
      setEmbeddingProgress({
        status: 'done',
        total: 0,
        completed: 0,
        completedAt: new Date().toISOString(),
      });
      return;
    }

    console.log(`Found ${messages.length} messages to embed`);

    // Update progress: starting
    setEmbeddingProgress({
      status: 'downloading',
      total: messages.length,
      completed: 0,
      startedAt: new Date().toISOString(),
    });

    // Download model if needed
    const modelPath = getModelPath();
    if (!existsSync(modelPath)) {
      console.log('Downloading embedding model...');
      await downloadModel((downloaded, total) => {
        const pct = Math.round((downloaded / total) * 100);
        process.stdout.write(`\rDownloading model: ${pct}%`);
      });
      console.log('\nModel downloaded.');
    }

    // Auto-benchmark if no config exists (first run calibration)
    if (!hasConfig()) {
      console.log('\n🔬 First run - calibrating optimal batch size for your system...');
      await runAutoBenchmark();
    }

    // Load and apply config
    const cfg = loadConfig();
    if (cfg) {
      applyConfig(cfg);
      console.log(`Using batch size ${cfg.serverBatchSize} (${cfg.throughput?.toFixed(0) || '?'} msg/s)`);
    }

    // Update progress: embedding
    setEmbeddingProgress({
      status: 'embedding',
      total: messages.length,
      completed: 0,
      startedAt: getEmbeddingProgress().startedAt,
    });

    const table = await getMessagesTable();

    // Run server-based embedding (llama-server with GPU acceleration)
    const { success, error } = await runWithServer(messages, table);

    if (!success) {
      throw new Error(`Embedding failed: ${error}`);
    }

    // Rebuild both FTS and vector indexes after all updates
    console.log('Rebuilding indexes...');
    await rebuildFtsIndex();
    await rebuildVectorIndex();

    // Clean up old versions to reclaim disk space
    // LanceDB keeps all historical versions which can cause 1000x+ storage bloat
    console.log('Cleaning up old versions...');
    const cleanupStats = await cleanupOldVersions();
    if (cleanupStats.versionsRemoved > 0) {
      const mbRemoved = Math.round(cleanupStats.bytesRemoved / 1024 / 1024);
      console.log(`Removed ${cleanupStats.versionsRemoved} old versions (${mbRemoved}MB freed)`);
    }

    // Mark as done
    setEmbeddingProgress({
      status: 'done',
      total: messages.length,
      completed: messages.length,
      startedAt: getEmbeddingProgress().startedAt,
      completedAt: new Date().toISOString(),
    });

    console.log('Embedding complete!');
    releaseEmbedLock();
  } catch (error) {
    console.error('Embedding failed:', error);
    setEmbeddingProgress({
      status: 'error',
      total: getEmbeddingProgress().total,
      completed: getEmbeddingProgress().completed,
      error: error instanceof Error ? error.message : String(error),
    });
    releaseEmbedLock();
    await stopLlamaServer();
    process.exit(1);
  }
}

// ============ Benchmark Function ============

interface BenchmarkResult {
  batchSize: number;
  throughput: number;    // messages per second
  cpuUsage: number;      // average CPU % of llama-server (0-100+, can exceed 100 on multi-core)
  gpuUsage: number;      // average GPU % (0-100) from macOS ioreg
  memoryMB: number;      // peak memory usage in MB
  energyProxy: number;   // CPU-seconds (cpuUsage * elapsed / 100) - proxy for energy consumption
  efficiency: number;    // messages per CPU-second (higher = more energy efficient)
  success: boolean;
  error?: string;
}

/**
 * Get CPU usage percentage for a process using ps
 * Returns instantaneous CPU % (can exceed 100% on multi-core)
 */
function getProcessCpuUsage(pid: number): number {
  try {
    const output = execSync(`ps -p ${pid} -o %cpu= 2>/dev/null`, { encoding: 'utf-8' });
    return parseFloat(output.trim()) || 0;
  } catch {
    return 0;
  }
}

/**
 * Get memory usage (RSS) for a process in MB
 */
function getProcessMemoryMB(pid: number): number {
  try {
    // rss is in KB on macOS/Linux
    const output = execSync(`ps -p ${pid} -o rss= 2>/dev/null`, { encoding: 'utf-8' });
    const rssKB = parseInt(output.trim(), 10) || 0;
    return rssKB / 1024;
  } catch {
    return 0;
  }
}

/**
 * Get GPU utilization on macOS via ioreg (no sudo required)
 * Returns device utilization percentage (0-100)
 */
function getGpuUtilization(): number {
  if (process.platform !== 'darwin') return 0;
  try {
    const output = execSync(
      `ioreg -r -d 1 -c IOAccelerator 2>/dev/null | grep -o '"Device Utilization %"=[0-9]*' | head -1`,
      { encoding: 'utf-8' }
    );
    const match = output.match(/=(\d+)/);
    return match && match[1] ? parseInt(match[1], 10) : 0;
  } catch {
    return 0;
  }
}

interface ResourceSamples {
  cpuSamples: number[];
  gpuSamples: number[];
  peakMemoryMB: number;
}

/**
 * Sample CPU, GPU, and memory usage during an async operation
 * Returns samples for averaging and peak memory
 */
async function sampleResourcesDuring<T>(
  pid: number,
  operation: () => Promise<T>,
  intervalMs: number = 200
): Promise<{ result: T; samples: ResourceSamples }> {
  const cpuSamples: number[] = [];
  const gpuSamples: number[] = [];
  let peakMemoryMB = 0;
  let done = false;

  // Start sampling in background
  const sampler = (async () => {
    while (!done) {
      const cpu = getProcessCpuUsage(pid);
      const mem = getProcessMemoryMB(pid);
      const gpu = getGpuUtilization();
      if (cpu > 0) cpuSamples.push(cpu);
      gpuSamples.push(gpu);
      if (mem > peakMemoryMB) peakMemoryMB = mem;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  })();

  // Run the operation
  const result = await operation();
  done = true;

  // Wait for sampler to finish
  await sampler;

  return { result, samples: { cpuSamples, gpuSamples, peakMemoryMB } };
}

/**
 * Test a specific batch size and measure throughput + CPU usage + memory + energy efficiency
 * Tests at least 5 batches OR 500 messages (whichever is larger) to get accurate measurements
 */
async function testBatchSize(
  batchSize: number,
  sampleMessages: MessageRow[],
  port: number
): Promise<BenchmarkResult> {
  // Test enough messages to get accurate throughput: at least 5 batches or 500 messages
  const minMessages = Math.max(batchSize * 5, 500);
  const testCount = Math.min(minMessages, sampleMessages.length);
  const testMessages = sampleMessages.slice(0, testCount);

  const serverPid = getLlamaServerPid();
  if (!serverPid) {
    return {
      batchSize,
      throughput: 0,
      cpuUsage: 0,
      gpuUsage: 0,
      memoryMB: 0,
      energyProxy: 0,
      efficiency: 0,
      success: false,
      error: 'llama-server not running',
    };
  }

  const startTime = Date.now();

  try {
    // Run embedding with resource sampling (CPU + GPU + memory)
    const { samples } = await sampleResourcesDuring(serverPid, async () => {
      for (let i = 0; i < testMessages.length; i += batchSize) {
        const batch = testMessages.slice(i, i + batchSize);
        const texts = batch.map((m) => {
          const stripped = stripToolOutputs(m.content);
          return truncateText(stripped);
        });
        await embedBatchViaServer(texts, port);
      }
    }, 100); // Sample every 100ms for more accuracy

    const elapsed = (Date.now() - startTime) / 1000;

    // Calculate average CPU usage from samples
    const avgCpu = samples.cpuSamples.length > 0
      ? samples.cpuSamples.reduce((a, b) => a + b, 0) / samples.cpuSamples.length
      : 0;

    // Calculate average GPU usage from samples
    const avgGpu = samples.gpuSamples.length > 0
      ? samples.gpuSamples.reduce((a, b) => a + b, 0) / samples.gpuSamples.length
      : 0;

    // Energy proxy: CPU-seconds (total CPU time consumed)
    // Higher CPU% for longer = more energy used
    const energyProxy = (avgCpu * elapsed) / 100;

    // Efficiency: messages per CPU-second (higher = better)
    // This tells us how much work we get per unit of energy
    const efficiency = energyProxy > 0 ? testCount / energyProxy : 0;

    return {
      batchSize,
      throughput: testCount / elapsed,
      cpuUsage: Math.round(avgCpu * 10) / 10,
      gpuUsage: Math.round(avgGpu),
      memoryMB: Math.round(samples.peakMemoryMB),
      energyProxy: Math.round(energyProxy * 100) / 100,
      efficiency: Math.round(efficiency * 10) / 10,
      success: true,
    };
  } catch (error) {
    return {
      batchSize,
      throughput: 0,
      cpuUsage: 0,
      gpuUsage: 0,
      memoryMB: 0,
      energyProxy: 0,
      efficiency: 0,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Auto-benchmark (quiet version) - runs on first sync to calibrate
 */
async function runAutoBenchmark(): Promise<void> {
  // Ensure llama-server is available
  if (!isLlamaServerInstalled()) {
    process.stdout.write('  Downloading llama-server...');
    await downloadLlamaServer((downloaded, total) => {
      const pct = Math.round((downloaded / total) * 100);
      process.stdout.write(`\r  Downloading llama-server: ${pct}%`);
    });
    console.log('');
  }

  // Get sample messages (need at least 1000 for accurate benchmark across all batch sizes)
  const table = await getMessagesTable();
  const allMessages = await withRetry(() => table.query().limit(1000).toArray()) as MessageRow[];

  if (allMessages.length < 500) {
    console.log('  Not enough messages to benchmark, using defaults');
    saveConfig(DEFAULT_CONFIG);
    return;
  }

  // Start server
  const modelPath = getModelPath();
  const port = await startLlamaServer(modelPath);

  // Test batch sizes quickly (up to 256 for GPU acceleration)
  const batchSizes = [8, 16, 32, 64, 128, 256];
  const results: BenchmarkResult[] = [];

  process.stdout.write('  Testing batch sizes: ');
  for (const batchSize of batchSizes) {
    process.stdout.write(`${batchSize}..`);
    const result = await testBatchSize(batchSize, allMessages, port);
    results.push(result);
    if (!result.success) break; // Stop at first failure
  }
  console.log(' done');

  await stopLlamaServer();

  // Find optimal
  const successfulResults = results.filter((r) => r.success);
  if (successfulResults.length === 0) {
    console.log('  Benchmark failed, using defaults');
    saveConfig(DEFAULT_CONFIG);
    return;
  }

  // Sort by efficiency (best energy usage), but also consider throughput
  const byEfficiency = [...successfulResults].sort((a, b) => b.efficiency - a.efficiency);
  const byThroughput = [...successfulResults].sort((a, b) => b.throughput - a.throughput);

  const fastest = byThroughput[0]!;
  const mostEfficient = byEfficiency[0]!;

  // Pick most efficient if it's within 20% of fastest, otherwise pick fastest
  let optimal = fastest;
  if (mostEfficient.batchSize !== fastest.batchSize) {
    const speedRatio = mostEfficient.throughput / fastest.throughput;
    if (speedRatio > 0.8) {
      optimal = mostEfficient;
    }
  }

  const newConfig: EmbedConfig = {
    serverBatchSize: optimal.batchSize,
    maxTextChars: 2000,
    batchDelayMs: 0,
    benchmarkedAt: new Date().toISOString(),
    throughput: optimal.throughput,
    efficiency: optimal.efficiency,
  };

  saveConfig(newConfig);
  console.log(`  Optimal: batch ${optimal.batchSize} (${optimal.throughput.toFixed(0)} msg/s, ${optimal.efficiency.toFixed(0)} msg/CPU-s)`);
}

/**
 * Run benchmark to find optimal batch size for this system
 */
async function runBenchmark(): Promise<void> {
  console.log('🔬 Running embedding benchmark to find optimal settings...\n');

  await connect();

  // Ensure model and server are available
  const modelPath = getModelPath();
  if (!existsSync(modelPath)) {
    console.log('Downloading embedding model...');
    await downloadModel((downloaded, total) => {
      const pct = Math.round((downloaded / total) * 100);
      process.stdout.write(`\rDownloading model: ${pct}%`);
    });
    console.log('\nModel downloaded.');
  }

  if (!isLlamaServerInstalled()) {
    console.log('Downloading llama-server...');
    await downloadLlamaServer((downloaded, total) => {
      const pct = Math.round((downloaded / total) * 100);
      process.stdout.write(`\rDownloading llama-server: ${pct}%`);
    });
    console.log('\nllama-server downloaded.');
  }

  // Get sample messages for testing (need 1000 for accurate benchmark)
  const table = await getMessagesTable();
  const allMessages = await withRetry(() => table.query().limit(1000).toArray()) as MessageRow[];

  if (allMessages.length < 500) {
    console.log('Not enough messages to benchmark (need at least 500). Run sync first.');
    process.exit(1);
  }

  console.log(`Using ${allMessages.length} sample messages for benchmark.\n`);

  // Start server
  console.log('Starting llama-server...');
  const port = await startLlamaServer(modelPath);
  console.log(`Server started on port ${port}\n`);

  // Test different batch sizes (up to 256 - diminishing returns beyond this)
  const batchSizes = [8, 32, 64, 128, 256];
  const results: BenchmarkResult[] = [];

  console.log('Batch  | Throughput |  CPU %  |  GPU %  |  Memory  | Efficiency | Status');
  console.log('-------|------------|---------|---------|----------|------------|-------');

  for (const batchSize of batchSizes) {
    process.stdout.write(`  ${batchSize.toString().padEnd(4)} |`);

    const result = await testBatchSize(batchSize, allMessages, port);
    results.push(result);

    if (result.success) {
      console.log(
        ` ${result.throughput.toFixed(1).padStart(7)} msg/s |` +
        ` ${result.cpuUsage.toFixed(0).padStart(5)}%  |` +
        ` ${result.gpuUsage.toString().padStart(5)}%  |` +
        ` ${result.memoryMB.toString().padStart(5)} MB |` +
        ` ${result.efficiency.toFixed(0).padStart(7)} msg/CPU-s | ✓`
      );
    } else {
      console.log(`     -      |    -    |    -    |     -    |      -     | ✗ ${result.error?.slice(0, 15)}`);
    }

    // Brief pause between tests
    await new Promise((r) => setTimeout(r, 500));
  }

  await stopLlamaServer();

  // Find optimal: highest efficiency (throughput per CPU usage) among successful results
  const successfulResults = results.filter((r) => r.success);

  if (successfulResults.length === 0) {
    console.log('\n❌ All batch sizes failed. Check llama-server configuration.');
    process.exit(1);
  }

  // Find best by different metrics
  const byThroughput = [...successfulResults].sort((a, b) => b.throughput - a.throughput);
  const byEfficiency = [...successfulResults].sort((a, b) => b.efficiency - a.efficiency);

  const fastest = byThroughput[0]!;
  const mostEfficient = byEfficiency[0]!;

  console.log('\n📊 Results:');
  console.log(`   ⚡ Fastest: batch ${fastest.batchSize} (${fastest.throughput.toFixed(1)} msg/s, ${fastest.gpuUsage}% GPU)`);
  console.log(`   🌱 Most efficient: batch ${mostEfficient.batchSize} (${mostEfficient.efficiency.toFixed(0)} msg/CPU-s, ${mostEfficient.gpuUsage}% GPU)`);

  // Default to fastest, but recommend efficient if it's close in speed
  let recommended = fastest;
  if (mostEfficient.batchSize !== fastest.batchSize) {
    const speedRatio = mostEfficient.throughput / fastest.throughput;
    if (speedRatio > 0.8) {
      // Most efficient is within 20% of fastest - recommend it
      recommended = mostEfficient;
      console.log(`\n   → Recommending most efficient (only ${((1 - speedRatio) * 100).toFixed(0)}% slower, uses less energy)`);
    } else {
      console.log(`\n   → Recommending fastest (efficiency option is ${((1 - speedRatio) * 100).toFixed(0)}% slower)`);
    }
  }

  console.log(`\n✅ Selected: batch size ${recommended.batchSize}`);
  console.log(`   Throughput: ${recommended.throughput.toFixed(1)} msg/s`);
  console.log(`   CPU: ${recommended.cpuUsage.toFixed(0)}%  GPU: ${recommended.gpuUsage}%`);
  console.log(`   Memory: ${recommended.memoryMB} MB`);
  console.log(`   Efficiency: ${recommended.efficiency.toFixed(0)} msg/CPU-second`);

  // Save config
  const newConfig: EmbedConfig = {
    serverBatchSize: recommended.batchSize,
    maxTextChars: 2000,
    batchDelayMs: 0,
    benchmarkedAt: new Date().toISOString(),
    throughput: recommended.throughput,
    efficiency: recommended.efficiency,
  };

  saveConfig(newConfig);
  console.log(`\n💾 Saved to ${getConfigPath()}`);

  // Estimate time for full embedding
  const messagesTable = await getMessagesTable();
  const totalMessages = (await withRetry(() => messagesTable.query().toArray())).length;
  const estimatedMinutes = Math.ceil(totalMessages / recommended.throughput / 60);
  console.log(`\n📊 With ${totalMessages} messages, estimated embedding time: ~${estimatedMinutes} minutes`);
}

// ============ Exported Command ============

interface EmbedOptions {
  benchmark?: boolean;
}

export async function embedCommand(options: EmbedOptions = {}): Promise<void> {
  if (options.benchmark) {
    await runBenchmark();
  } else {
    await runBackgroundEmbedding();
  }

  // Force exit to avoid LanceDB native binding cleanup crash
  process.exit(0);
}
