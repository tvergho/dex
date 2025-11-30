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
import { spawn, execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { adapters } from '../../adapters/index';
import type { SourceLocation, NormalizedConversation } from '../../adapters/types';
import {
  connect,
  rebuildFtsIndex,
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

/**
 * Kill any running embedding processes to prevent LanceDB commit conflicts.
 * The embedding worker will be restarted after sync completes.
 * Also resets the progress state so the worker can be respawned.
 */
function killEmbeddingProcesses(): void {
  try {
    // Find and kill any bun processes running embed.ts
    // This is platform-specific but works on macOS/Linux
    if (process.platform !== 'win32') {
      execSync('pkill -f "bun.*embed\\.ts" 2>/dev/null || true', { stdio: 'ignore' });
    }
    // Also kill any llama-server processes that might be running
    if (process.platform !== 'win32') {
      execSync('pkill -f "llama-server" 2>/dev/null || true', { stdio: 'ignore' });
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
          {progress.phase === 'extracting' && `Extracting ${progress.currentSource} conversations...`}
          {progress.phase === 'syncing' && `Syncing ${progress.currentSource}...`}
          {progress.phase === 'indexing' && 'Building search index...'}
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
  // Get the path to the embed script
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const embedScript = join(__dirname, 'embed.ts');

  // Spawn background process with low priority (nice 19 = lowest priority)
  // This minimizes impact on user's foreground work
  // On macOS/Linux, nice lowers scheduling priority; on Windows it's ignored
  const isWindows = process.platform === 'win32';
  const command = isWindows ? 'bun' : 'nice';
  const args = isWindows
    ? ['run', embedScript]
    : ['-n', '19', 'bun', 'run', embedScript];

  const child = spawn(command, args, {
    detached: true,
    stdio: 'ignore',
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

  try {
    // Kill any running embedding processes to prevent conflicts during sync
    // The embedding will be restarted after sync if new data was added
    killEmbeddingProcesses();

    // Connect to database
    await connect();

    // ========== PHASE 1: Collect all data from all adapters ==========
    // This is fast - just reading files, no DB operations yet
    const allConversations: { normalized: NormalizedConversation; adapter: typeof adapters[0]; location: SourceLocation }[] = [];
    const locationsToSync: { adapter: typeof adapters[0]; location: SourceLocation }[] = [];

    // Process each adapter
    for (const adapter of adapters) {
      progress.currentSource = adapter.name;
      progress.phase = 'detecting';
      onProgress({ ...progress });

      // Check if this source is available
      const available = await adapter.detect();
      if (!available) continue;

      // Discover workspaces
      progress.phase = 'discovering';
      onProgress({ ...progress });

      const locations = await adapter.discover();

      // Extract from each location
      progress.phase = 'extracting';

      for (const location of locations) {
        // Check if we need to sync this workspace
        if (!options.force) {
          const syncState = await syncStateRepo.get(adapter.name, location.dbPath);
          if (syncState && syncState.lastMtime >= location.mtime) {
            // Skip - no changes since last sync
            continue;
          }
        }

        locationsToSync.push({ adapter, location });

        // Extract and normalize all conversations
        const rawConversations = await adapter.extract(location);

        for (const raw of rawConversations) {
          const normalized = adapter.normalize(raw, location);
          allConversations.push({ normalized, adapter, location });
        }
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

      // Delete related data for all conversations we're about to insert
      for (const id of candidateIds) {
        await Promise.all([
          messageRepo.deleteByConversation(id),
          toolCallRepo.deleteByConversation(id),
          filesRepo.deleteByConversation(id),
          messageFilesRepo.deleteByConversation(id),
          fileEditsRepo.deleteByConversation(id),
        ]);
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

    // ========== PHASE 3: Collect data from NEW conversations only ==========
    const newConvRows: Parameters<typeof conversationRepo.upsert>[0][] = [];
    const newMessages: Parameters<typeof messageRepo.bulkInsert>[0] = [];
    const newToolCalls: Parameters<typeof toolCallRepo.bulkInsert>[0] = [];
    const newFiles: Parameters<typeof filesRepo.bulkInsert>[0] = [];
    const newMessageFiles: Parameters<typeof messageFilesRepo.bulkInsert>[0] = [];
    const newFileEdits: Parameters<typeof fileEditsRepo.bulkInsert>[0] = [];

    for (const { normalized } of conversationsToSync) {
      newConvRows.push(normalized.conversation);

      if (normalized.messages.length > 0) {
        newMessages.push(...normalized.messages);
      }
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

    // ========== PHASE 4: Bulk insert new data ==========
    // For incremental sync, we only add new data (no deletes needed)
    await conversationRepo.bulkUpsert(newConvRows);
    progress.conversationsIndexed = newConvRows.length;
    progress.projectsProcessed = projectPaths.size;
    onProgress({ ...progress });

    if (newMessages.length > 0) {
      await messageRepo.bulkInsert(newMessages);
      progress.messagesIndexed = newMessages.length;
      onProgress({ ...progress });
    }

    if (newToolCalls.length > 0) {
      await toolCallRepo.bulkInsert(newToolCalls);
    }

    if (newFiles.length > 0) {
      await filesRepo.bulkInsert(newFiles);
    }

    if (newMessageFiles.length > 0) {
      await messageFilesRepo.bulkInsert(newMessageFiles);
    }

    if (newFileEdits.length > 0) {
      await fileEditsRepo.bulkInsert(newFileEdits);
    }

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

      // Spawn background embedding process.
      // We killed any existing process at the start of sync, so we can safely spawn.
      // The embed worker checks for messages with zero vectors, so it will correctly
      // embed only what's needed (new messages + any that were interrupted).
      setEmbeddingProgress({
        status: 'idle',
        total: progress.messagesIndexed,
        completed: 0,
      });

      spawnBackgroundEmbedding();
      progress.embeddingStarted = true;
    }

    progress.phase = 'done';
    progress.currentSource = undefined;
    progress.currentProject = undefined;
    onProgress({ ...progress });
  } catch (error) {
    progress.phase = 'error';
    progress.error = error instanceof Error ? error.message : String(error);
    onProgress({ ...progress });
    throw error;
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

  // Show summary stats after sync completes
  await printRichSummary(7);
}
