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
  throughput?: number; // messages per second
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
  const toolBlockPattern = /\n---\n\*\*[^*]+\*\*[^\n]*\n```[\s\S]*?```\n---\n?/g;
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

    // Process in batches
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

      // Build full rows with updated vectors for batch mergeInsert
      const updatedRows = batch
        .map((msg, j) => {
          const vec = vectors[j];
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
        })
        .filter((row): row is NonNullable<typeof row> => row !== null);

      // Use mergeInsert for batch update
      if (updatedRows.length > 0) {
        let retries = 3;
        while (retries > 0) {
          try {
            await table.mergeInsert('id').whenMatchedUpdateAll().execute(updatedRows);
            break;
          } catch (err) {
            retries--;
            if (retries === 0) throw err;
            await new Promise((r) => setTimeout(r, 200));
          }
        }
      }

      // Rebuild FTS index after every batch to keep search working
      // mergeInsert invalidates the index, so we must rebuild immediately
      if (FTS_REBUILD_EVERY_BATCH) {
        await rebuildFtsIndex();
      }

      // Clean up old versions periodically to prevent disk space bloat
      // Each mergeInsert creates a new version - without cleanup this causes 1000x+ bloat
      const batchNumber = Math.floor(i / SERVER_BATCH_SIZE) + 1;
      if (batchNumber % CLEANUP_EVERY_N_BATCHES === 0) {
        await cleanupOldVersions();
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
  throughput: number; // messages per second
  cpuUsage: number;   // percentage (0-100)
  success: boolean;
  error?: string;
}

/**
 * Get CPU usage percentage on macOS using ps
 */
function getCpuUsage(pid: number): number {
  try {
    const output = execSync(`ps -p ${pid} -o %cpu | tail -1`, { encoding: 'utf-8' });
    return parseFloat(output.trim()) || 0;
  } catch {
    return 0;
  }
}

/**
 * Test a specific batch size and measure throughput + CPU usage
 */
async function testBatchSize(
  batchSize: number,
  sampleMessages: MessageRow[],
  port: number
): Promise<BenchmarkResult> {
  const testCount = Math.min(batchSize * 3, sampleMessages.length); // Test 3 batches
  const testMessages = sampleMessages.slice(0, testCount);

  const startTime = Date.now();
  const startCpu = process.cpuUsage();

  try {
    for (let i = 0; i < testMessages.length; i += batchSize) {
      const batch = testMessages.slice(i, i + batchSize);
      const texts = batch.map((m) => {
        const stripped = stripToolOutputs(m.content);
        return truncateText(stripped);
      });

      await embedBatchViaServer(texts, port);
    }

    const elapsed = (Date.now() - startTime) / 1000;
    const endCpu = process.cpuUsage(startCpu);
    const cpuPercent = ((endCpu.user + endCpu.system) / 1000000) / elapsed * 100;

    return {
      batchSize,
      throughput: testCount / elapsed,
      cpuUsage: Math.round(cpuPercent * 10) / 10,
      success: true,
    };
  } catch (error) {
    return {
      batchSize,
      throughput: 0,
      cpuUsage: 0,
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

  // Get sample messages
  const table = await getMessagesTable();
  const allMessages = await withRetry(() => table.query().limit(200).toArray()) as MessageRow[];

  if (allMessages.length < 20) {
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

  successfulResults.sort((a, b) => b.throughput - a.throughput);
  const optimal = successfulResults[0]!;

  const newConfig: EmbedConfig = {
    serverBatchSize: optimal.batchSize,
    maxTextChars: 2000,
    batchDelayMs: 0, // No delay for max throughput
    benchmarkedAt: new Date().toISOString(),
    throughput: optimal.throughput,
  };

  saveConfig(newConfig);
  console.log(`  Optimal: batch size ${optimal.batchSize} (${optimal.throughput.toFixed(0)} msg/s)`);
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

  // Get sample messages for testing
  const table = await getMessagesTable();
  const allMessages = await withRetry(() => table.query().limit(200).toArray()) as MessageRow[];

  if (allMessages.length < 50) {
    console.log('Not enough messages to benchmark (need at least 50). Run sync first.');
    process.exit(1);
  }

  console.log(`Using ${allMessages.length} sample messages for benchmark.\n`);

  // Start server
  console.log('Starting llama-server...');
  const port = await startLlamaServer(modelPath);
  console.log(`Server started on port ${port}\n`);

  // Test different batch sizes (up to 256)
  const batchSizes = [4, 8, 16, 32, 64, 128, 256];
  const results: BenchmarkResult[] = [];

  console.log('Batch Size | Throughput | CPU Usage | Status');
  console.log('-----------|------------|-----------|-------');

  for (const batchSize of batchSizes) {
    process.stdout.write(`    ${batchSize.toString().padEnd(6)} |`);

    const result = await testBatchSize(batchSize, allMessages, port);
    results.push(result);

    if (result.success) {
      console.log(
        ` ${result.throughput.toFixed(1).padStart(7)} msg/s | ` +
        `${result.cpuUsage.toFixed(1).padStart(6)}% | ✓`
      );
    } else {
      console.log(`     -     |     -     | ✗ (${result.error?.slice(0, 30)}...)`);
    }

    // Brief pause between tests
    await new Promise((r) => setTimeout(r, 500));
  }

  await stopLlamaServer();

  // Find optimal: highest throughput among successful results
  const successfulResults = results.filter((r) => r.success);

  if (successfulResults.length === 0) {
    console.log('\n❌ All batch sizes failed. Check llama-server configuration.');
    process.exit(1);
  }

  // Sort by throughput (highest first)
  successfulResults.sort((a, b) => b.throughput - a.throughput);
  const optimal = successfulResults[0]!;

  // If CPU usage is very high (>80%), consider a smaller batch size
  let recommended: BenchmarkResult = optimal;
  if (optimal.cpuUsage > 80 && successfulResults.length > 1) {
    const lowerCpuOption = successfulResults.find((r) => r.cpuUsage < 60);
    if (lowerCpuOption && lowerCpuOption.throughput > optimal.throughput * 0.7) {
      recommended = lowerCpuOption;
      console.log(`\n⚡ Highest throughput: batch ${optimal.batchSize} (${optimal.throughput.toFixed(1)} msg/s, ${optimal.cpuUsage}% CPU)`);
      console.log(`🌡️  Recommended for lower heat: batch ${recommended.batchSize} (${recommended.throughput.toFixed(1)} msg/s, ${recommended.cpuUsage}% CPU)`);
    }
  }

  console.log(`\n✅ Optimal batch size: ${recommended.batchSize}`);
  console.log(`   Throughput: ${recommended.throughput.toFixed(1)} messages/second`);
  console.log(`   CPU usage: ${recommended.cpuUsage}%`);

  // Save config
  const newConfig: EmbedConfig = {
    serverBatchSize: recommended.batchSize,
    maxTextChars: 2000, // Keep this fixed
    batchDelayMs: 0, // No delay for max throughput
    benchmarkedAt: new Date().toISOString(),
    throughput: recommended.throughput,
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
