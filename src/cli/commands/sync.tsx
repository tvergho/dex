/**
 * Sync command - indexes conversations from AI coding tools into the local database
 *
 * Usage: dex sync [--force] [--source <name>]
 *
 * Detects and syncs from: Cursor, Claude Code, Codex
 * Spawns background embedding worker after sync completes
 */

import React, { useState, useEffect } from 'react';
import { render, Box, Text } from 'ink';
import { spawn, exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
import { adapters } from '../../adapters/index';
import type { SourceLocation, NormalizedConversation } from '../../adapters/types';
import {
  connect,
  rebuildFtsIndex,
  acquireSyncLock,
  releaseSyncLock,
  getMessagesTable,
} from '../../db/index';
import {
  conversationRepo,
  messageRepo,
  toolCallRepo,
  syncStateRepo,
  filesRepo,
  messageFilesRepo,
  fileEditsRepo,
} from '../../db/repository';
import {
  setEmbeddingProgress,
  clearEmbeddingProgress,
} from '../../embeddings/index';
import { printRichSummary } from './stats';
import { loadConfig } from '../../config/index.js';
import { enrichUntitledConversations } from '../../features/enrichment/index.js';

/**
 * Count messages that still need embedding (have zero vectors).
 */
async function countPendingEmbeddings(): Promise<number> {
  try {
    const table = await getMessagesTable();
    const allMessages = await table.query().select(['vector']).toArray();

    return allMessages.filter((row) => {
      const vector = row.vector;
      if (!vector) return true;
      const arr = Array.isArray(vector) ? vector : Array.from(vector as Float32Array);
      return arr.every((v) => v === 0);
    }).length;
  } catch {
    return 0;
  }
}

/**
 * Kill any running embedding processes to prevent LanceDB commit conflicts.
 * The embedding worker will be restarted after sync completes.
 * Also resets the progress state so the worker can be respawned.
 */
async function killEmbeddingProcesses(): Promise<void> {
  try {
    // Find and kill any bun processes running embed.ts
    // This is platform-specific but works on macOS/Linux
    if (process.platform !== 'win32') {
      await execAsync('pkill -f "bun.*embed\\.ts" 2>/dev/null || true').catch(() => {});
    }
    // Also kill any llama-server processes that might be running
    if (process.platform !== 'win32') {
      await execAsync('pkill -f "llama-server" 2>/dev/null || true').catch(() => {});
    }
  } catch {
    // Ignore errors - process may not exist
  }

  // Reset the progress file status since we just killed any running process.
  // The embed worker determines what to embed by checking for zero vectors,
  // so it will correctly resume from where it left off.
  clearEmbeddingProgress();
}

export interface SyncProgress {
  phase:
    | 'detecting'
    | 'discovering'
    | 'extracting'
    | 'syncing'
    | 'indexing'
    | 'enriching'
    | 'done'
    | 'error';
  currentSource?: string;
  currentProject?: string;
  projectsFound: number;
  projectsProcessed: number;
  conversationsFound: number;
  conversationsIndexed: number;
  messagesIndexed: number;
  error?: string;
  embeddingStarted?: boolean;
  extractionProgress?: { current: number; total: number };
  enrichmentProgress?: { current: number; total: number };
}

/**
 * Quick check if any source has new data to sync.
 * This is much faster than running full sync because it only checks mtimes.
 * Returns true if sync is needed, false if everything is up to date.
 */
export async function needsSync(): Promise<boolean> {
  try {
    await connect();

    for (const adapter of adapters) {
      const available = await adapter.detect();
      if (!available) continue;

      const locations = await adapter.discover();

      for (const location of locations) {
        const syncState = await syncStateRepo.get(adapter.name, location.dbPath);
        // If no sync state exists, or mtime has changed, sync is needed
        if (!syncState || syncState.lastMtime < location.mtime) {
          return true;
        }
      }
    }

    return false;
  } catch {
    // On error, assume sync is needed
    return true;
  }
}

interface SyncOptions {
  force?: boolean;
}

function _formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function SyncUI({ progress }: { progress: SyncProgress }) {
  const spinner = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (progress.phase === 'done' || progress.phase === 'error') return;

    const timer = setInterval(() => {
      setFrame((f) => (f + 1) % spinner.length);
    }, 80);

    return () => clearInterval(timer);
  }, [progress.phase]);

  if (progress.phase === 'error') {
    return (
      <Box flexDirection="column">
        <Text color="red">✗ Error: {progress.error}</Text>
      </Box>
    );
  }

  if (progress.phase === 'done') {
    return (
      <Box flexDirection="column">
        <Text color="green">✓ Sync complete</Text>
        <Text dimColor>
          {progress.projectsProcessed} projects, {progress.conversationsIndexed} conversations,{' '}
          {progress.messagesIndexed} messages
        </Text>
        {progress.embeddingStarted && (
          <Text color="cyan">
            Embeddings generating in background. Run "dex status" to check progress.
          </Text>
        )}
      </Box>
    );
  }

  // Format project name for display
  const projectDisplay = progress.currentProject
    ? progress.currentProject.length > 50
      ? '...' + progress.currentProject.slice(-47)
      : progress.currentProject
    : null;

  return (
    <Box flexDirection="column">
      <Box>
        <Text color="cyan">{spinner[frame]} </Text>
        <Text>
          {progress.phase === 'detecting' && 'Detecting sources...'}
          {progress.phase === 'discovering' && `Discovering ${progress.currentSource}...`}
          {progress.phase === 'extracting' && (
            progress.extractionProgress
              ? `Extracting ${progress.currentSource} (${progress.extractionProgress.current}/${progress.extractionProgress.total})...`
              : `Extracting ${progress.currentSource} conversations...`
          )}
          {progress.phase === 'syncing' && `Syncing ${progress.currentSource}...`}
          {progress.phase === 'indexing' && 'Building search index...'}
          {progress.phase === 'enriching' && (
            progress.enrichmentProgress
              ? `Generating titles (${progress.enrichmentProgress.current}/${progress.enrichmentProgress.total})...`
              : 'Generating titles...'
          )}
        </Text>
      </Box>

      {projectDisplay && (
        <Box marginLeft={2}>
          <Text color="magenta">{projectDisplay}</Text>
        </Box>
      )}

      <Box marginLeft={2} marginTop={1}>
        <Text dimColor>
          Projects: {progress.projectsProcessed}/{progress.projectsFound} | Conversations:{' '}
          {progress.conversationsIndexed}/{progress.conversationsFound} | Messages: {progress.messagesIndexed}
        </Text>
      </Box>
    </Box>
  );
}

function spawnBackgroundEmbedding(): void {
  // Spawn background embedding process with low priority (nice 19 = lowest priority)
  // This minimizes impact on user's foreground work
  // Uses the same runtime (node/bun) that's running this process
  const isWindows = process.platform === 'win32';

  // Build command to run `dex embed` in background
  const execPath = process.execPath;
  const scriptPath = process.argv[1]!;

  const command = isWindows
    ? `"${execPath}" "${scriptPath}" embed`
    : `nice -n 19 "${execPath}" "${scriptPath}" embed`;

  const child = spawn(command, [], {
    detached: true,
    stdio: 'ignore',
    shell: true, // Use shell for nice command and proper quoting
  });

  child.unref();
}

export async function runSync(
  options: SyncOptions,
  onProgress: (progress: SyncProgress) => void
): Promise<void> {
  const progress: SyncProgress = {
    phase: 'detecting',
    projectsFound: 0,
    projectsProcessed: 0,
    conversationsFound: 0,
    conversationsIndexed: 0,
    messagesIndexed: 0,
  };

  // Try to acquire sync lock to prevent concurrent operations
  if (!acquireSyncLock()) {
    progress.phase = 'error';
    progress.error = 'Another sync is already running. Please wait for it to complete.';
    onProgress({ ...progress });
    return;
  }

  try {
    // Connect to database
    console.error('[sync] Connecting to database...');
    await connect();
    console.error('[sync] Database connected');

    // ========== PHASE 1: Collect all data from all adapters (PARALLEL) ==========
    // This is fast - just reading files, no DB operations yet
    const allConversations: { normalized: NormalizedConversation; adapter: typeof adapters[0]; location: SourceLocation }[] = [];
    const locationsToSync: { adapter: typeof adapters[0]; location: SourceLocation }[] = [];

    // Phase 1a: Detect all available adapters in parallel
    progress.phase = 'detecting';
    onProgress({ ...progress });

    const adapterAvailability = await Promise.all(
      adapters.map(async (adapter) => ({
        adapter,
        available: await adapter.detect(),
      }))
    );
    const availableAdapters = adapterAvailability
      .filter(({ available }) => available)
      .map(({ adapter }) => adapter);

    // Phase 1b: Discover all locations in parallel across adapters
    progress.phase = 'discovering';
    onProgress({ ...progress });

    const adapterLocations = await Promise.all(
      availableAdapters.map(async (adapter) => ({
        adapter,
        locations: await adapter.discover(),
      }))
    );

    // Phase 1c: Filter locations that need syncing and extract in parallel
    progress.phase = 'extracting';
    progress.currentSource = 'all sources';
    onProgress({ ...progress });

    // Gather all locations that need syncing
    const locationsNeedingSync: { adapter: typeof adapters[0]; location: SourceLocation }[] = [];

    for (const { adapter, locations } of adapterLocations) {
      for (const location of locations) {
        if (!options.force) {
          const syncState = await syncStateRepo.get(adapter.name, location.dbPath);
          if (syncState && syncState.lastMtime >= location.mtime) {
            continue; // Skip - no changes since last sync
          }
        }
        locationsNeedingSync.push({ adapter, location });
        locationsToSync.push({ adapter, location });
      }
    }

    // Extract from all locations in parallel (with concurrency limit to avoid overwhelming the system)
    const EXTRACTION_CONCURRENCY = 4;
    const extractionResults: { adapter: typeof adapters[0]; location: SourceLocation; rawConversations: unknown[] }[] = [];

    for (let i = 0; i < locationsNeedingSync.length; i += EXTRACTION_CONCURRENCY) {
      const batch = locationsNeedingSync.slice(i, i + EXTRACTION_CONCURRENCY);
      const batchResults = await Promise.all(
        batch.map(async ({ adapter, location }) => {
          // Capture adapter name in closure to avoid race condition with parallel extractions
          const adapterName = adapter.name;
          progress.currentSource = adapterName;
          progress.extractionProgress = undefined; // Reset for new extraction
          onProgress({ ...progress });
          const rawConversations = await adapter.extract(location, (extractionProg) => {
            // Use captured adapterName, not progress.currentSource (which may have changed)
            progress.currentSource = adapterName;
            progress.extractionProgress = extractionProg;
            onProgress({ ...progress });
          });
          return { adapter, location, rawConversations };
        })
      );
      extractionResults.push(...batchResults);
    }

    // Normalize all conversations (this is CPU-bound but fast)
    for (const { adapter, location, rawConversations } of extractionResults) {
      for (const raw of rawConversations) {
        const normalized = adapter.normalize(raw, location);
        allConversations.push({ normalized, adapter, location });
      }
    }

    progress.conversationsFound = allConversations.length;

    // Group conversations by project path for progress display
    const projectPaths = new Set(allConversations.map(c => c.normalized.conversation.workspacePath || 'unknown'));
    progress.projectsFound = projectPaths.size;
    onProgress({ ...progress });

    if (allConversations.length === 0) {
      progress.phase = 'done';
      progress.currentSource = undefined;
      onProgress({ ...progress });
      return;
    }

    // ========== PHASE 2: Filter to only NEW conversations (incremental sync) ==========
    progress.phase = 'syncing';
    progress.currentSource = 'all sources';
    onProgress({ ...progress });

    // Get all candidate conversation IDs
    const candidateIds = allConversations.map((c) => c.normalized.conversation.id);

    // In force mode, we re-sync everything; otherwise only sync new conversations
    let conversationsToSync = allConversations;
    let existingIds = new Set<string>();

    if (options.force) {
      // Kill any running embedding processes to prevent conflicts during sync
      // Only kill if we're actually going to modify the database (force mode with data)
      await killEmbeddingProcesses();

      // Force mode: delete all existing data and re-sync everything
      // Track what to delete by source
      const deleteBySource = new Map<string, Set<string>>();
      for (const { adapter, location } of allConversations) {
        const key = adapter.name;
        if (!deleteBySource.has(key)) {
          deleteBySource.set(key, new Set());
        }
        deleteBySource.get(key)!.add(location.workspacePath);
      }

      // Delete existing conversations by source
      for (const [source, workspacePaths] of deleteBySource) {
        for (const workspacePath of workspacePaths) {
          await conversationRepo.deleteBySource(source, workspacePath);
        }
      }

      // Delete related data for all conversations we're about to insert (in parallel batches)
      const DELETE_BATCH_SIZE = 10;
      for (let i = 0; i < candidateIds.length; i += DELETE_BATCH_SIZE) {
        const batchIds = candidateIds.slice(i, i + DELETE_BATCH_SIZE);
        await Promise.all(
          batchIds.flatMap((id) => [
            messageRepo.deleteByConversation(id),
            toolCallRepo.deleteByConversation(id),
            filesRepo.deleteByConversation(id),
            messageFilesRepo.deleteByConversation(id),
            fileEditsRepo.deleteByConversation(id),
          ])
        );
      }
    } else {
      // Incremental mode: only insert NEW conversations (skip existing ones)
      existingIds = await conversationRepo.getExistingIds(candidateIds);
      conversationsToSync = allConversations.filter(
        (c) => !existingIds.has(c.normalized.conversation.id)
      );
    }

    // If nothing new to sync, we're done
    if (conversationsToSync.length === 0) {
      progress.phase = 'done';
      progress.currentSource = undefined;
      progress.conversationsIndexed = 0;
      progress.messagesIndexed = 0;
      onProgress({ ...progress });
      return;
    }

    // For incremental mode, kill embedding processes only if we have work to do
    // (Force mode already killed processes above before deletions)
    if (!options.force) {
      await killEmbeddingProcesses();
    }

    // ========== PHASE 3: Collect data from NEW conversations only ==========
    const newConvRows: Parameters<typeof conversationRepo.upsert>[0][] = [];
    const newMessages: Parameters<typeof messageRepo.bulkInsert>[0] = [];
    const newToolCalls: Parameters<typeof toolCallRepo.bulkInsert>[0] = [];
    const newFiles: Parameters<typeof filesRepo.bulkInsert>[0] = [];
    const newMessageFiles: Parameters<typeof messageFilesRepo.bulkInsert>[0] = [];
    const newFileEdits: Parameters<typeof fileEditsRepo.bulkInsert>[0] = [];

    for (const { normalized } of conversationsToSync) {
      // Skip conversations with no messages (empty/abandoned)
      if (normalized.messages.length === 0) {
        continue;
      }

      newConvRows.push(normalized.conversation);
      newMessages.push(...normalized.messages);

      if (normalized.toolCalls.length > 0) {
        newToolCalls.push(...normalized.toolCalls);
      }
      if (normalized.files && normalized.files.length > 0) {
        newFiles.push(...normalized.files);
      }
      if (normalized.messageFiles && normalized.messageFiles.length > 0) {
        newMessageFiles.push(...normalized.messageFiles);
      }
      if (normalized.fileEdits && normalized.fileEdits.length > 0) {
        newFileEdits.push(...normalized.fileEdits);
      }
    }

    // ========== PHASE 4: Bulk insert new data (parallel writes to different tables) ==========
    // For incremental sync, we only add new data (no deletes needed)
    // Conversations must be inserted first (foreign key dependency), then others in parallel
    await conversationRepo.bulkUpsert(newConvRows);
    progress.conversationsIndexed = newConvRows.length;
    progress.projectsProcessed = projectPaths.size;
    onProgress({ ...progress });

    // Insert messages, tool calls, files, etc. in parallel (different tables)
    const parallelInserts: Promise<void>[] = [];

    if (newMessages.length > 0) {
      parallelInserts.push(
        messageRepo.bulkInsert(newMessages).then(() => {
          progress.messagesIndexed = newMessages.length;
          onProgress({ ...progress });
        })
      );
    }

    if (newToolCalls.length > 0) {
      parallelInserts.push(toolCallRepo.bulkInsert(newToolCalls));
    }

    if (newFiles.length > 0) {
      parallelInserts.push(filesRepo.bulkInsert(newFiles));
    }

    if (newMessageFiles.length > 0) {
      parallelInserts.push(messageFilesRepo.bulkInsert(newMessageFiles));
    }

    if (newFileEdits.length > 0) {
      parallelInserts.push(fileEditsRepo.bulkInsert(newFileEdits));
    }

    await Promise.all(parallelInserts);

    // ========== PHASE 5: Update sync state ==========
    for (const { adapter, location } of locationsToSync) {
      await syncStateRepo.set({
        source: adapter.name,
        workspacePath: location.workspacePath,
        dbPath: location.dbPath,
        lastSyncedAt: new Date().toISOString(),
        lastMtime: location.mtime,
      });
    }

    // ========== PHASE 6: Rebuild FTS index ==========
    if (progress.messagesIndexed > 0) {
      progress.phase = 'indexing';
      progress.currentSource = undefined;
      progress.currentProject = undefined;
      onProgress({ ...progress });

      await rebuildFtsIndex();
    }

    // ========== PHASE 6b: Spawn embedding worker if needed ==========
    // Check for pending embeddings (messages with zero vectors).
    // This handles both new messages and previously interrupted embedding runs.
    const pendingEmbeddings = await countPendingEmbeddings();
    if (pendingEmbeddings > 0) {
      setEmbeddingProgress({
        status: 'idle',
        total: pendingEmbeddings,
        completed: 0,
      });

      spawnBackgroundEmbedding();
      progress.embeddingStarted = true;
    }

    // ========== PHASE 7: Enrich untitled conversations (if enabled) ==========
    const config = loadConfig();
    const claudeEnrichEnabled = config.providers.claudeCode.enabled && config.providers.claudeCode.autoEnrichSummaries;
    const codexEnrichEnabled = config.providers.codex.enabled && config.providers.codex.autoEnrichSummaries;

    if (claudeEnrichEnabled || codexEnrichEnabled) {
      progress.phase = 'enriching';
      progress.currentSource = undefined;
      progress.currentProject = undefined;
      onProgress({ ...progress });

      try {
        await enrichUntitledConversations((current, total) => {
          progress.enrichmentProgress = { current, total };
          onProgress({ ...progress });
        });
      } catch (err) {
        // Log enrichment errors but don't fail sync
        console.error('Enrichment failed:', err);
      }
    }

    progress.phase = 'done';
    progress.currentSource = undefined;
    progress.currentProject = undefined;
    onProgress({ ...progress });

    // Force exit after a brief delay to let UI render and embed process spawn
    // This avoids LanceDB native binding cleanup crash
    setTimeout(() => process.exit(0), 1000);
  } catch (error) {
    progress.phase = 'error';
    progress.error = error instanceof Error ? error.message : String(error);
    onProgress({ ...progress });
    throw error;
  } finally {
    // Always release the lock when sync completes or fails
    releaseSyncLock();
  }
}

function SyncApp({ options }: { options: SyncOptions }) {
  const [progress, setProgress] = useState<SyncProgress>({
    phase: 'detecting',
    projectsFound: 0,
    projectsProcessed: 0,
    conversationsFound: 0,
    conversationsIndexed: 0,
    messagesIndexed: 0,
  });

  useEffect(() => {
    runSync(options, setProgress).catch(() => {
      // Error is already captured in progress
    });
  }, []);

  return <SyncUI progress={progress} />;
}

export async function syncCommand(options: SyncOptions): Promise<void> {
  const { waitUntilExit } = render(<SyncApp options={options} />);
  await waitUntilExit();

  // Note: process.exit(0) is called in runSync() after phase='done'
  // to avoid LanceDB native binding cleanup crash
}
