#!/usr/bin/env bun
/**
 * Benchmark different client-side batch sizes for embedding.
 *
 * This tests how many messages to send per API call to llama-server.
 * The server-side configs showed minimal differences, so let's focus
 * on finding the optimal batch size for the API calls.
 *
 * Usage:
 *   bun scripts/benchmark-batch-size.ts
 */

import { spawn, ChildProcess } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { cpus } from 'os';

const DATA_DIR = join(process.env.HOME || '~', '.dex');
const MODEL_PATH = join(DATA_DIR, 'models', 'embeddinggemma-300M-Q8_0.gguf');
const SERVER_PATH = join(DATA_DIR, 'bin', 'llama-server');

let serverProcess: ChildProcess | null = null;

async function startServer(): Promise<number> {
  const port = 8300;
  const threads = cpus().length;

  // Use the best server config from previous benchmark
  const args = [
    '--model', MODEL_PATH,
    '--port', String(port),
    '--embedding',
    '--pooling', 'mean',
    '--threads', String(threads),
    '--ctx-size', '16384',
    '--batch-size', '4096',
    '--ubatch-size', '4096',
    '--n-gpu-layers', '99',
    '--flash-attn', 'on',
    '--cont-batching',
    '--parallel', '4',
  ];

  serverProcess = spawn(SERVER_PATH, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  serverProcess.stderr?.on('data', d => stderr += d.toString());

  const ready = await waitForServer(port, 30000);
  if (!ready) {
    console.error('Server stderr:', stderr.slice(-500));
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
      // Not ready
    }
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}

async function embedBatch(texts: string[], port: number): Promise<void> {
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

  await response.json();
}

// Generate realistic test messages (varying lengths like real conversations)
function generateTestMessages(count: number): string[] {
  const templates = [
    'Short message here.',
    'A medium length message that contains more information about the topic at hand.',
    'This is a longer message that might contain multiple sentences. It represents typical assistant responses that explain concepts in detail and provide examples.',
    `Here is a very long message that simulates code responses:
\`\`\`typescript
async function processData(input: string[]): Promise<Result[]> {
  const results: Result[] = [];
  for (const item of input) {
    const processed = await transform(item);
    results.push(processed);
  }
  return results;
}
\`\`\`
The function above handles data processing with proper async/await patterns.`,
    'Can you help me with this error? I keep getting "TypeError: Cannot read property of undefined" when I try to access the user object.',
  ];

  return Array.from({ length: count }, (_, i) => templates[i % templates.length]!);
}

interface Result {
  batchSize: number;
  concurrency: number;
  throughput: number;
  latencyMs: number;
}

async function testBatchConfig(
  messages: string[],
  port: number,
  batchSize: number,
  concurrency: number
): Promise<Result> {
  const totalMessages = messages.length;
  const batches: string[][] = [];

  for (let i = 0; i < totalMessages; i += batchSize) {
    batches.push(messages.slice(i, i + batchSize));
  }

  const start = performance.now();

  if (concurrency === 1) {
    // Sequential
    for (const batch of batches) {
      await embedBatch(batch, port);
    }
  } else {
    // Concurrent batches
    for (let i = 0; i < batches.length; i += concurrency) {
      const chunk = batches.slice(i, i + concurrency);
      await Promise.all(chunk.map(b => embedBatch(b, port)));
    }
  }

  const elapsed = performance.now() - start;

  return {
    batchSize,
    concurrency,
    throughput: (totalMessages / elapsed) * 1000,
    latencyMs: elapsed / batches.length,
  };
}

async function main() {
  console.log('🔬 Client Batch Size Benchmark\n');

  if (!existsSync(MODEL_PATH) || !existsSync(SERVER_PATH)) {
    console.error('Model or server not found. Run "dex sync" first.');
    process.exit(1);
  }

  console.log(`CPU cores: ${cpus().length}`);
  console.log('Starting optimized server...\n');

  const port = await startServer();
  console.log(`Server ready on port ${port}\n`);

  // Generate test data
  const testMessages = generateTestMessages(500);
  console.log(`Testing with ${testMessages.length} messages\n`);

  // Warm up
  await embedBatch(testMessages.slice(0, 8), port);

  const batchSizes = [4, 8, 16, 32, 64, 128, 256];
  const concurrencies = [1, 2, 4];

  console.log('Batch | Conc | Throughput  | Latency');
  console.log('------|------|-------------|--------');

  const results: Result[] = [];

  for (const batchSize of batchSizes) {
    for (const concurrency of concurrencies) {
      try {
        const result = await testBatchConfig(testMessages, port, batchSize, concurrency);
        results.push(result);

        console.log(
          `${String(batchSize).padStart(5)} |` +
          `${String(concurrency).padStart(4)}  |` +
          `${result.throughput.toFixed(1).padStart(9)} msg/s |` +
          `${result.latencyMs.toFixed(0).padStart(5)} ms`
        );
      } catch (error) {
        console.log(
          `${String(batchSize).padStart(5)} |` +
          `${String(concurrency).padStart(4)}  |` +
          `   FAILED   |    -`
        );
      }

      // Brief pause between tests
      await new Promise(r => setTimeout(r, 200));
    }
  }

  await stopServer();

  // Find best
  results.sort((a, b) => b.throughput - a.throughput);
  const best = results[0];

  if (best) {
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`✅ Optimal: batch=${best.batchSize}, concurrency=${best.concurrency}`);
    console.log(`   Throughput: ${best.throughput.toFixed(1)} msg/s`);
    console.log(`   Latency: ${best.latencyMs.toFixed(0)} ms per batch`);

    // Show top 3
    console.log('\n   Top 3 configurations:');
    for (let i = 0; i < Math.min(3, results.length); i++) {
      const r = results[i]!;
      console.log(`   ${i + 1}. batch=${r.batchSize}, conc=${r.concurrency}: ${r.throughput.toFixed(1)} msg/s`);
    }
  }
}

main().catch(console.error);
