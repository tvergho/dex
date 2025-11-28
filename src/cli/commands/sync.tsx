import React, { useState, useEffect } from 'react';
import { render, Box, Text } from 'ink';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { adapters } from '../../adapters/index.js';
import type { SourceLocation, NormalizedConversation } from '../../adapters/types.js';
import {
  connect,
  rebuildFtsIndex,
} from '../../db/index.js';
import {
  conversationRepo,
  messageRepo,
  toolCallRepo,
  syncStateRepo,
  filesRepo,
  messageFilesRepo,
} from '../../db/repository.js';
import {
  setEmbeddingProgress,
  clearEmbeddingProgress,
  isEmbeddingInProgress,
} from '../../embeddings/index.js';

interface SyncProgress {
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

function formatBytes(bytes: number): string {
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

async function runSync(
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
    // Connect to database
    await connect();

    // Collect all normalized conversations from all adapters first
    const allConversations: { normalized: NormalizedConversation; adapter: typeof adapters[0]; location: SourceLocation }[] = [];

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

        // Extract and normalize all conversations
        const rawConversations = await adapter.extract(location);

        for (const raw of rawConversations) {
          const normalized = adapter.normalize(raw, location);
          allConversations.push({ normalized, adapter, location });
        }

        // Update sync state after extraction
        await syncStateRepo.set({
          source: adapter.name,
          workspacePath: location.workspacePath,
          dbPath: location.dbPath,
          lastSyncedAt: new Date().toISOString(),
          lastMtime: location.mtime,
        });
      }
    }

    progress.conversationsFound = allConversations.length;
    onProgress({ ...progress });

    // Group conversations by project path
    const byProject = new Map<string, typeof allConversations>();
    for (const item of allConversations) {
      const projectPath = item.normalized.conversation.workspacePath || 'unknown';
      if (!byProject.has(projectPath)) {
        byProject.set(projectPath, []);
      }
      byProject.get(projectPath)!.push(item);
    }

    progress.projectsFound = byProject.size;
    onProgress({ ...progress });

    // Process by project
    progress.phase = 'syncing';

    for (const [projectPath, conversations] of byProject) {
      progress.currentProject = projectPath;
      onProgress({ ...progress });

      if (options.force) {
        // Force mode: Delete existing data for this project
        // We need to delete by each adapter/workspace combo
        const seen = new Set<string>();
        for (const { adapter, location } of conversations) {
          const key = `${adapter.name}:${location.workspacePath}`;
          if (!seen.has(key)) {
            seen.add(key);
            await conversationRepo.deleteBySource(adapter.name, location.workspacePath);
          }
        }
      }

      for (const { normalized } of conversations) {
        if (options.force) {
          // Force mode: Delete and re-insert everything
          await messageRepo.deleteByConversation(normalized.conversation.id);
          await toolCallRepo.deleteByConversation(normalized.conversation.id);
          await filesRepo.deleteByConversation(normalized.conversation.id);
          await messageFilesRepo.deleteByConversation(normalized.conversation.id);

          // Insert conversation
          await conversationRepo.upsert(normalized.conversation);
          progress.conversationsIndexed++;

          // Insert messages
          if (normalized.messages.length > 0) {
            await messageRepo.bulkInsert(normalized.messages);
            progress.messagesIndexed += normalized.messages.length;
          }

          // Insert tool calls
          if (normalized.toolCalls.length > 0) {
            await toolCallRepo.bulkInsert(normalized.toolCalls);
          }

          // Insert files
          if (normalized.files && normalized.files.length > 0) {
            await filesRepo.bulkInsert(normalized.files);
          }

          // Insert message files
          if (normalized.messageFiles && normalized.messageFiles.length > 0) {
            await messageFilesRepo.bulkInsert(normalized.messageFiles);
          }
        } else {
          // Incremental mode: Only insert new data, preserve existing embeddings
          const conversationExists = await conversationRepo.exists(normalized.conversation.id);

          // Always upsert conversation metadata
          await conversationRepo.upsert(normalized.conversation);
          progress.conversationsIndexed++;

          if (conversationExists) {
            // Get existing message IDs to avoid duplicates
            const existingMessageIds = await messageRepo.getExistingIds(normalized.conversation.id);

            // Only insert new messages
            if (normalized.messages.length > 0) {
              const newCount = await messageRepo.bulkInsertNew(normalized.messages, existingMessageIds);
              progress.messagesIndexed += newCount;
            }
          } else {
            // New conversation: insert everything
            if (normalized.messages.length > 0) {
              await messageRepo.bulkInsert(normalized.messages);
              progress.messagesIndexed += normalized.messages.length;
            }

            if (normalized.toolCalls.length > 0) {
              await toolCallRepo.bulkInsert(normalized.toolCalls);
            }

            if (normalized.files && normalized.files.length > 0) {
              await filesRepo.bulkInsert(normalized.files);
            }

            if (normalized.messageFiles && normalized.messageFiles.length > 0) {
              await messageFilesRepo.bulkInsert(normalized.messageFiles);
            }
          }
        }

        onProgress({ ...progress });
      }

      progress.projectsProcessed++;
      onProgress({ ...progress });
    }

    // Rebuild FTS index after all data is inserted
    if (progress.messagesIndexed > 0) {
      progress.phase = 'indexing';
      progress.currentSource = undefined;
      progress.currentProject = undefined;
      onProgress({ ...progress });

      await rebuildFtsIndex();

      // Only spawn embed if not already in progress
      if (!isEmbeddingInProgress()) {
        clearEmbeddingProgress();
        setEmbeddingProgress({
          status: 'idle',
          total: progress.messagesIndexed,
          completed: 0,
        });

        // Spawn background process for embedding generation
        spawnBackgroundEmbedding();
        progress.embeddingStarted = true;
      }
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
}
