/**
 * Llama-server based batch embedding
 * Downloads and manages a local llama-server binary for faster batch embeddings
 */

import { existsSync, mkdirSync, createWriteStream, chmodSync, unlinkSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { spawn, ChildProcess } from 'child_process';
import { cpus } from 'os';
import { getDataDir } from '../utils/config';

// Minimal thread count for background work: just 1-2 threads
// Prioritizes keeping the system cool over embedding speed
const LOW_PRIORITY_THREADS = Math.min(2, Math.max(1, Math.floor(cpus().length * 0.125)));

// GitHub API for fetching latest release
const GITHUB_API_LATEST = 'https://api.github.com/repos/ggml-org/llama.cpp/releases/latest';

// Cached version info
let cachedVersion: string | null = null;

async function getLatestVersion(): Promise<string> {
  if (cachedVersion) return cachedVersion;

  // Try to read cached version from disk
  const versionFile = join(getBinDir(), 'llama-version.txt');
  if (existsSync(versionFile)) {
    cachedVersion = readFileSync(versionFile, 'utf-8').trim();
    return cachedVersion;
  }

  // Fetch from GitHub API
  const response = await fetch(GITHUB_API_LATEST);
  if (!response.ok) {
    throw new Error(`Failed to fetch latest llama.cpp version: ${response.statusText}`);
  }

  const data = (await response.json()) as { tag_name: string };
  cachedVersion = data.tag_name;

  // Cache to disk
  writeFileSync(versionFile, cachedVersion);

  return cachedVersion;
}

// Platform-specific binary names
async function getBinaryInfo(): Promise<{ url: string; executable: string } | null> {
  const platform = process.platform;
  const arch = process.arch;
  const version = await getLatestVersion();

  const baseUrl = `https://github.com/ggml-org/llama.cpp/releases/download/${version}`;

  if (platform === 'darwin') {
    const archSuffix = arch === 'arm64' ? 'arm64' : 'x64';
    return {
      url: `${baseUrl}/llama-${version}-bin-macos-${archSuffix}.zip`,
      executable: 'llama-server',
    };
  } else if (platform === 'linux') {
    if (arch === 'x64') {
      return {
        url: `${baseUrl}/llama-${version}-bin-ubuntu-x64.zip`,
        executable: 'llama-server',
      };
    }
  } else if (platform === 'win32') {
    if (arch === 'x64') {
      return {
        url: `${baseUrl}/llama-${version}-bin-win-cpu-x64.zip`,
        executable: 'llama-server.exe',
      };
    } else if (arch === 'arm64') {
      return {
        url: `${baseUrl}/llama-${version}-bin-win-cpu-arm64.zip`,
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
  const info = await getBinaryInfo();
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

  // Small batch sizes to minimize thermal impact
  const args = [
    '--model', modelPath,
    '--port', String(serverPort),
    '--embedding',
    '--pooling', 'mean',
    '--threads', String(threadCount),
    '--ctx-size', '2048',     // Reduced context
    '--batch-size', '512',    // Small batches
    '--ubatch-size', '128',   // Tiny micro-batches
  ];

  // Start with low priority on Unix
  const isWindows = process.platform === 'win32';
  const cmd = isWindows ? serverPath : 'nice';
  const cmdArgs = isWindows ? args : ['-n', '19', serverPath, ...args];

  serverProcess = spawn(cmd, cmdArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  // Wait for server to be ready
  const ready = await waitForServer(serverPort, 30000);
  if (!ready) {
    await stopLlamaServer();
    throw new Error('llama-server failed to start within timeout');
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
