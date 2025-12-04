/**
 * Llama-server based batch embedding
 * Downloads and manages a local llama-server binary for faster batch embeddings
 */

import { existsSync, mkdirSync, createWriteStream, chmodSync, unlinkSync } from 'fs';
import { join } from 'path';
import { spawn, ChildProcess } from 'child_process';
import { cpus } from 'os';
import { getDataDir } from '../utils/config';

// Background thread count: use half the cores (capped at 6) for good balance
// between embedding speed and keeping the system responsive
const LOW_PRIORITY_THREADS = Math.min(6, Math.max(2, Math.floor(cpus().length / 2)));

// Pinned llama.cpp version - always use this exact version for consistency
const LLAMA_VERSION = 'b7225';

// Platform-specific binary names
function getBinaryInfo(): { url: string; executable: string } | null {
  const platform = process.platform;
  const arch = process.arch;

  const baseUrl = `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_VERSION}`;

  if (platform === 'darwin') {
    const archSuffix = arch === 'arm64' ? 'arm64' : 'x64';
    return {
      url: `${baseUrl}/llama-${LLAMA_VERSION}-bin-macos-${archSuffix}.zip`,
      executable: 'llama-server',
    };
  } else if (platform === 'linux') {
    if (arch === 'x64') {
      return {
        url: `${baseUrl}/llama-${LLAMA_VERSION}-bin-ubuntu-x64.zip`,
        executable: 'llama-server',
      };
    }
  } else if (platform === 'win32') {
    if (arch === 'x64') {
      return {
        url: `${baseUrl}/llama-${LLAMA_VERSION}-bin-win-cpu-x64.zip`,
        executable: 'llama-server.exe',
      };
    } else if (arch === 'arm64') {
      return {
        url: `${baseUrl}/llama-${LLAMA_VERSION}-bin-win-cpu-arm64.zip`,
        executable: 'llama-server.exe',
      };
    }
  }

  return null;
}

export function getBinDir(): string {
  const binDir = join(getDataDir(), 'bin');
  if (!existsSync(binDir)) {
    mkdirSync(binDir, { recursive: true });
  }
  return binDir;
}

export function getLlamaServerPath(): string {
  // Use sync version for path - just check for the executable name
  const executable = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
  return join(getBinDir(), executable);
}

export function isLlamaServerInstalled(): boolean {
  return existsSync(getLlamaServerPath());
}

export async function downloadLlamaServer(
  onProgress?: (downloaded: number, total: number) => void
): Promise<void> {
  const info = getBinaryInfo();
  if (!info) {
    throw new Error(`Unsupported platform: ${process.platform}-${process.arch}`);
  }

  const binDir = getBinDir();
  const zipPath = join(binDir, 'llama-server.zip');

  console.log(`Downloading from: ${info.url}`);

  // Download the zip file
  const response = await fetch(info.url, { redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`Failed to download llama-server: ${response.statusText}`);
  }

  const contentLength = response.headers.get('content-length');
  const total = contentLength ? parseInt(contentLength, 10) : 0;
  let downloaded = 0;

  const fileStream = createWriteStream(zipPath);
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

  // Wait for file to be written
  await new Promise<void>((resolve) => fileStream.on('finish', resolve));

  // Extract using unzip command (cross-platform via bun/node child_process)
  await extractZip(zipPath, binDir);

  // Clean up zip file
  unlinkSync(zipPath);

  // Make executable on Unix
  if (process.platform !== 'win32') {
    chmodSync(getLlamaServerPath(), 0o755);
  }
}

async function extractZip(zipPath: string, destDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Use unzip on Unix, tar on Windows (via PowerShell)
    let cmd: string;
    let args: string[];

    if (process.platform === 'win32') {
      cmd = 'powershell';
      args = ['-Command', `Expand-Archive -Path "${zipPath}" -DestinationPath "${destDir}" -Force`];
    } else {
      cmd = 'unzip';
      args = ['-o', zipPath, '-d', destDir];
    }

    const proc = spawn(cmd, args, { stdio: 'pipe' });

    proc.on('close', (code) => {
      if (code === 0) {
        // The zip extracts to a subdirectory, move all files to root
        moveFilesToRoot(destDir)
          .then(resolve)
          .catch(reject);
      } else {
        reject(new Error(`Failed to extract zip: exit code ${code}`));
      }
    });

    proc.on('error', reject);
  });
}

async function moveFilesToRoot(destDir: string): Promise<void> {
  const { readdirSync, renameSync, statSync, rmSync, existsSync } = await import('fs');
  const path = await import('path');

  // Find the build/bin directory (or similar) where the actual files are
  function findBinDir(dir: string): string | null {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const fullPath = path.join(dir, entry);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        // Check if this directory contains llama-server
        const subEntries = readdirSync(fullPath);
        if (subEntries.includes('llama-server') || subEntries.includes('llama-server.exe')) {
          return fullPath;
        }
        // Recurse into subdirectories
        const found = findBinDir(fullPath);
        if (found) return found;
      }
    }
    return null;
  }

  const binDir = findBinDir(destDir);
  if (binDir && binDir !== destDir) {
    // Move all files from binDir to destDir
    const files = readdirSync(binDir);
    for (const file of files) {
      const srcPath = path.join(binDir, file);
      const destPath = path.join(destDir, file);
      if (!existsSync(destPath)) {
        renameSync(srcPath, destPath);
      }
    }

    // Clean up the extracted subdirectories
    const entries = readdirSync(destDir);
    for (const entry of entries) {
      const fullPath = path.join(destDir, entry);
      if (statSync(fullPath).isDirectory()) {
        rmSync(fullPath, { recursive: true, force: true });
      }
    }
  }
}

// Server management
let serverProcess: ChildProcess | null = null;
let serverPort = 8089;

export async function startLlamaServer(modelPath: string, threads?: number): Promise<number> {
  if (serverProcess) {
    return serverPort;
  }

  const serverPath = getLlamaServerPath();
  if (!existsSync(serverPath)) {
    throw new Error('llama-server not installed. Call downloadLlamaServer() first.');
  }

  // Find an available port
  serverPort = 8089 + Math.floor(Math.random() * 100);

  // Use conservative thread count for background embedding
  const threadCount = threads ?? LOW_PRIORITY_THREADS;

  // Detect if we should use GPU acceleration (macOS with Metal)
  const useGpu = process.platform === 'darwin';

  // Server configuration optimized for GPU acceleration when available
  // EmbeddingGemma-300M supports 8K tokens, we use 4096 for faster embedding
  const args = [
    '--model', modelPath,
    '--port', String(serverPort),
    '--embedding',
    '--pooling', 'mean',
    '--threads', String(threadCount),
    '--ctx-size', '4096',
    '--batch-size', '4096',
    '--ubatch-size', '4096',
    // GPU acceleration: offload all layers to Metal on macOS
    ...(useGpu ? ['--n-gpu-layers', '99'] : []),
    // Flash attention: faster processing with lower memory bandwidth
    '--flash-attn', 'on',
    // Continuous batching: process requests as they arrive for better throughput
    '--cont-batching',
  ];

  // Start with low priority on Unix
  const isWindows = process.platform === 'win32';
  const cmd = isWindows ? serverPath : 'nice';
  const cmdArgs = isWindows ? args : ['-n', '19', serverPath, ...args];

  serverProcess = spawn(cmd, cmdArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  // Capture stderr for error reporting
  let stderrOutput = '';
  serverProcess.stderr?.on('data', (data) => {
    stderrOutput += data.toString();
  });

  // Watch for early exit (indicates startup failure)
  let exitedEarly = false;
  let exitCode: number | null = null;
  serverProcess.on('exit', (code) => {
    exitedEarly = true;
    exitCode = code;
  });

  // Wait for server to be ready
  const ready = await waitForServer(serverPort, 30000);
  if (!ready) {
    await stopLlamaServer();
    // Include stderr in error message for debugging
    const errMsg = stderrOutput.trim().split('\n').slice(-5).join('\n'); // Last 5 lines
    if (exitedEarly) {
      throw new Error(`llama-server exited with code ${exitCode}:\n${errMsg}`);
    }
    throw new Error(`llama-server failed to start within timeout:\n${errMsg}`);
  }

  return serverPort;
}

export async function stopLlamaServer(): Promise<void> {
  if (serverProcess) {
    serverProcess.kill('SIGTERM');
    serverProcess = null;
    // Give it time to clean up
    await new Promise((r) => setTimeout(r, 500));
  }
}

/**
 * Get the PID of the running llama-server process (for CPU monitoring)
 */
export function getLlamaServerPid(): number | null {
  return serverProcess?.pid ?? null;
}

async function waitForServer(port: number, maxWaitMs: number): Promise<boolean> {
  const startTime = Date.now();
  while (Date.now() - startTime < maxWaitMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) {
        return true;
      }
    } catch {
      // Server not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// Batch embedding via server
export async function embedBatchViaServer(
  texts: string[],
  port: number
): Promise<number[][]> {
  const response = await fetch(`http://127.0.0.1:${port}/v1/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      input: texts,
      model: 'embedding',
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Embedding request failed: ${error}`);
  }

  const result = (await response.json()) as {
    data: Array<{ embedding: number[]; index: number }>;
  };

  // Sort by index to maintain order
  result.data.sort((a, b) => a.index - b.index);
  return result.data.map((d) => d.embedding);
}

// Cleanup on process exit
process.on('exit', () => {
  if (serverProcess) {
    serverProcess.kill('SIGTERM');
  }
});

process.on('SIGINT', () => {
  if (serverProcess) {
    serverProcess.kill('SIGTERM');
  }
  process.exit();
});

process.on('SIGTERM', () => {
  if (serverProcess) {
    serverProcess.kill('SIGTERM');
  }
  process.exit();
});
