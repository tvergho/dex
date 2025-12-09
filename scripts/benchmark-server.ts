#!/usr/bin/env bun
/**
 * Benchmark llama-server configurations to find optimal embedding performance.
 *
 * Tests different combinations of:
 * - --parallel (number of slots)
 * - --cont-batching (on/off)
 * - --batch-size / --ubatch-size
 * - --threads
 * - Concurrent request batching
 *
 * Usage:
 *   bun scripts/benchmark-server.ts
 */

import { spawn, ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { cpus } from 'os';

// Import from the project
const DATA_DIR = join(process.env.HOME || '~', '.dex');
const MODEL_PATH = join(DATA_DIR, 'models', 'embeddinggemma-300M-Q8_0.gguf');
const SERVER_PATH = join(DATA_DIR, 'bin', 'llama-server');

// Configuration to test
interface ServerConfig {
  name: string;
  parallel: number;
  contBatching: boolean;
  batchSize: number;
  ubatchSize: number;
  threads: number;
  ctxSize: number;
}

interface BenchmarkResult {
  config: ServerConfig;
  throughput: number;  // messages per second
  latencyP50: number;  // ms
  latencyP99: number;  // ms
  success: boolean;
  error?: string;
}

// Test configurations
const CONFIGS: ServerConfig[] = [
  // Baseline: current config
  {
    name: 'baseline',
    parallel: 1,
    contBatching: true,
    batchSize: 4096,
    ubatchSize: 4096,
    threads: Math.min(6, Math.floor(cpus().length / 2)),
    ctxSize: 4096,
  },
  // More parallel slots
  {
    name: 'parallel-2',
    parallel: 2,
    contBatching: true,
    batchSize: 4096,
    ubatchSize: 4096,
    threads: Math.min(6, Math.floor(cpus().length / 2)),
    ctxSize: 8192,
  },
  {
    name: 'parallel-4',
    parallel: 4,
    contBatching: true,
    batchSize: 4096,
    ubatchSize: 4096,
    threads: Math.min(6, Math.floor(cpus().length / 2)),
    ctxSize: 16384,
  },
  // Without continuous batching
  {
    name: 'no-cont-batching',
    parallel: 1,
    contBatching: false,
    batchSize: 4096,
    ubatchSize: 4096,
    threads: Math.min(6, Math.floor(cpus().length / 2)),
    ctxSize: 4096,
  },
  // More threads
  {
    name: 'more-threads',
    parallel: 1,
    contBatching: true,
    batchSize: 4096,
    ubatchSize: 4096,
    threads: cpus().length,
    ctxSize: 4096,
  },
  // Smaller batches (for streaming)
  {
    name: 'small-batch',
    parallel: 1,
    contBatching: true,
    batchSize: 512,
    ubatchSize: 512,
    threads: Math.min(6, Math.floor(cpus().length / 2)),
    ctxSize: 4096,
  },
  // Larger context
  {
    name: 'large-ctx',
    parallel: 1,
    contBatching: true,
    batchSize: 8192,
    ubatchSize: 8192,
    threads: Math.min(6, Math.floor(cpus().length / 2)),
    ctxSize: 8192,
  },
  // Parallel + more threads
  {
    name: 'parallel-4-more-threads',
    parallel: 4,
    contBatching: true,
    batchSize: 4096,
    ubatchSize: 4096,
    threads: cpus().length,
    ctxSize: 16384,
  },
];

// Sample texts for embedding
const SAMPLE_TEXTS = [
  "How do I implement authentication in React?",
  "The error occurs when trying to connect to the database. Here's the stack trace...",
  "Can you help me refactor this function to be more readable and maintainable?",
  "I need to add a feature that allows users to export their data as CSV.",
  "The performance is slow when loading large datasets. How can I optimize this?",
  "Let me walk you through how the caching layer works in this application.",
  "We should use TypeScript for better type safety and developer experience.",
  "Here's an example of how to use the new API endpoint for fetching user preferences.",
  "The bug appears when multiple users try to edit the same document simultaneously.",
  "I've implemented a retry mechanism with exponential backoff for network requests.",
  "This component uses React hooks for state management and side effects.",
  "The database schema needs to be updated to support the new feature requirements.",
  "We're using WebSockets for real-time communication between clients.",
  "The CI/CD pipeline runs tests, builds the app, and deploys to staging automatically.",
  "Memory usage spikes when processing large files. We should implement streaming.",
  "The authentication flow uses OAuth 2.0 with PKCE for enhanced security.",
];

let serverProcess: ChildProcess | null = null;
let currentPort = 8200;

async function startServer(config: ServerConfig): Promise<number> {
  const port = currentPort++;

  const args = [
    '--model', MODEL_PATH,
    '--port', String(port),
    '--embedding',
    '--pooling', 'mean',
    '--threads', String(config.threads),
    '--ctx-size', String(config.ctxSize),
    '--batch-size', String(config.batchSize),
    '--ubatch-size', String(config.ubatchSize),
    '--n-gpu-layers', '99',  // Metal GPU acceleration
    '--flash-attn', 'on',
  ];

  if (config.contBatching) {
    args.push('--cont-batching');
  }

  if (config.parallel > 1) {
    args.push('--parallel', String(config.parallel));
  }

  serverProcess = spawn(SERVER_PATH, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Wait for server to be ready
  const ready = await waitForServer(port, 30000);
  if (!ready) {
    await stopServer();
    throw new Error('Server failed to start');
  }

  return port;
}

async function stopServer(): Promise<void> {
  if (serverProcess) {
    serverProcess.kill('SIGTERM');
    serverProcess = null;
    await new Promise(r => setTimeout(r, 500));
  }
}

async function waitForServer(port: number, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return true;
    } catch {
      // Not ready yet
    }
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}

async function embedBatch(texts: string[], port: number): Promise<number[][]> {
  const response = await fetch(`http://127.0.0.1:${port}/v1/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      input: texts,
      model: 'embedding',
    }),
  });

  if (!response.ok) {
    throw new Error(`Embedding failed: ${await response.text()}`);
  }

  const result = await response.json() as { data: Array<{ embedding: number[] }> };
  return result.data.map(d => d.embedding);
}

// Test with sequential batches
async function testSequential(port: number, batchSize: number, iterations: number): Promise<number[]> {
  const latencies: number[] = [];

  for (let i = 0; i < iterations; i++) {
    const texts = SAMPLE_TEXTS.slice(0, batchSize);
    const start = performance.now();
    await embedBatch(texts, port);
    latencies.push(performance.now() - start);
  }

  return latencies;
}

// Test with concurrent batches
async function testConcurrent(port: number, batchSize: number, concurrency: number, iterations: number): Promise<number[]> {
  const latencies: number[] = [];

  for (let i = 0; i < iterations; i += concurrency) {
    const promises = Array.from({ length: concurrency }, async () => {
      const texts = SAMPLE_TEXTS.slice(0, batchSize);
      const start = performance.now();
      await embedBatch(texts, port);
      return performance.now() - start;
    });

    const results = await Promise.all(promises);
    latencies.push(...results);
  }

  return latencies;
}

function percentile(arr: number[], p: number): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)] ?? 0;
}

async function benchmarkConfig(config: ServerConfig): Promise<BenchmarkResult> {
  try {
    const port = await startServer(config);

    // Warm up
    await testSequential(port, 8, 3);

    // Test different batch sizes and concurrency levels
    const batchSizes = [4, 8, 16];
    const concurrencies = config.parallel > 1 ? [1, 2, config.parallel] : [1];

    let bestThroughput = 0;
    let bestLatencies: number[] = [];

    for (const batchSize of batchSizes) {
      for (const concurrency of concurrencies) {
        const iterations = 20;
        const latencies = concurrency > 1
          ? await testConcurrent(port, batchSize, concurrency, iterations)
          : await testSequential(port, batchSize, iterations);

        const totalMessages = batchSize * latencies.length;
        const totalTimeMs = latencies.reduce((a, b) => a + b, 0);
        const throughput = (totalMessages / totalTimeMs) * 1000;

        if (throughput > bestThroughput) {
          bestThroughput = throughput;
          bestLatencies = latencies;
        }
      }
    }

    await stopServer();

    return {
      config,
      throughput: bestThroughput,
      latencyP50: percentile(bestLatencies, 50),
      latencyP99: percentile(bestLatencies, 99),
      success: true,
    };
  } catch (error) {
    await stopServer();
    return {
      config,
      throughput: 0,
      latencyP50: 0,
      latencyP99: 0,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main() {
  console.log('🔬 Llama-server Embedding Benchmark\n');

  // Check prerequisites
  if (!existsSync(MODEL_PATH)) {
    console.error(`Model not found: ${MODEL_PATH}`);
    console.error('Run "dex sync" first to download the model.');
    process.exit(1);
  }

  if (!existsSync(SERVER_PATH)) {
    console.error(`Server not found: ${SERVER_PATH}`);
    console.error('Run "dex sync" first to download llama-server.');
    process.exit(1);
  }

  console.log(`Model: ${MODEL_PATH}`);
  console.log(`Server: ${SERVER_PATH}`);
  console.log(`CPU cores: ${cpus().length}\n`);

  console.log('Configuration        | Throughput | P50 Lat | P99 Lat | Status');
  console.log('---------------------|------------|---------|---------|--------');

  const results: BenchmarkResult[] = [];

  for (const config of CONFIGS) {
    process.stdout.write(`${config.name.padEnd(20)} |`);

    const result = await benchmarkConfig(config);
    results.push(result);

    if (result.success) {
      console.log(
        ` ${result.throughput.toFixed(1).padStart(7)} msg/s |` +
        ` ${result.latencyP50.toFixed(0).padStart(5)} ms |` +
        ` ${result.latencyP99.toFixed(0).padStart(5)} ms | ✓`
      );
    } else {
      console.log(`    failed   |    -    |    -    | ✗`);
    }
  }

  // Find best
  const successful = results.filter(r => r.success);
  if (successful.length === 0) {
    console.log('\n❌ All configurations failed!');
    process.exit(1);
  }

  successful.sort((a, b) => b.throughput - a.throughput);
  const best = successful[0]!;

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`✅ Best configuration: ${best.config.name}`);
  console.log(`   Throughput: ${best.throughput.toFixed(1)} msg/s`);
  console.log(`   Latency P50: ${best.latencyP50.toFixed(0)} ms`);
  console.log(`   Latency P99: ${best.latencyP99.toFixed(0)} ms`);
  console.log('\n   Server flags:');
  console.log(`   --parallel ${best.config.parallel}`);
  console.log(`   --threads ${best.config.threads}`);
  console.log(`   --ctx-size ${best.config.ctxSize}`);
  console.log(`   --batch-size ${best.config.batchSize}`);
  console.log(`   --ubatch-size ${best.config.ubatchSize}`);
  if (best.config.contBatching) {
    console.log('   --cont-batching');
  }

  // Compare to baseline
  const baseline = results.find(r => r.config.name === 'baseline');
  if (baseline?.success && best.config.name !== 'baseline') {
    const improvement = ((best.throughput - baseline.throughput) / baseline.throughput) * 100;
    console.log(`\n   📈 ${improvement > 0 ? '+' : ''}${improvement.toFixed(1)}% vs baseline`);
  }
}

main().catch(console.error);
