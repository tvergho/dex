import React, { useState, useEffect } from 'react';
import { render, Box, Text } from 'ink';
import { adapters } from '../../adapters/index.js';
import type { SourceLocation, NormalizedConversation } from '../../adapters/types.js';
import { connect, rebuildFtsIndex } from '../../db/index.js';
import {
  conversationRepo,
  messageRepo,
  toolCallRepo,
  syncStateRepo,
  filesRepo,
  messageFilesRepo,
} from '../../db/repository.js';

interface SyncProgress {
  phase: 'detecting' | 'discovering' | 'syncing' | 'indexing' | 'done' | 'error';
  currentSource?: string;
  currentWorkspace?: string;
  workspacesFound: number;
  workspacesProcessed: number;
  conversationsFound: number;
  conversationsIndexed: number;
  messagesIndexed: number;
  error?: string;
}

interface SyncOptions {
  force?: boolean;
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
          {progress.workspacesProcessed} workspaces, {progress.conversationsIndexed} conversations,{' '}
          {progress.messagesIndexed} messages
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Box>
        <Text color="cyan">{spinner[frame]} </Text>
        <Text>
          {progress.phase === 'detecting' && 'Detecting sources...'}
          {progress.phase === 'discovering' && `Discovering ${progress.currentSource} workspaces...`}
          {progress.phase === 'syncing' && `Syncing ${progress.currentSource}...`}
          {progress.phase === 'indexing' && 'Building search index...'}
        </Text>
      </Box>

      {progress.currentWorkspace && (
        <Box marginLeft={2}>
          <Text dimColor>
            {progress.currentWorkspace.length > 50
              ? '...' + progress.currentWorkspace.slice(-47)
              : progress.currentWorkspace}
          </Text>
        </Box>
      )}

      <Box marginLeft={2} marginTop={1}>
        <Text dimColor>
          Workspaces: {progress.workspacesProcessed}/{progress.workspacesFound} | Conversations:{' '}
          {progress.conversationsIndexed} | Messages: {progress.messagesIndexed}
        </Text>
      </Box>
    </Box>
  );
}

async function runSync(
  options: SyncOptions,
  onProgress: (progress: SyncProgress) => void
): Promise<void> {
  const progress: SyncProgress = {
    phase: 'detecting',
    workspacesFound: 0,
    workspacesProcessed: 0,
    conversationsFound: 0,
    conversationsIndexed: 0,
    messagesIndexed: 0,
  };

  try {
    // Connect to database
    await connect();

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
      progress.workspacesFound += locations.length;
      onProgress({ ...progress });

      // Process each workspace
      progress.phase = 'syncing';

      for (const location of locations) {
        progress.currentWorkspace = location.workspacePath;
        onProgress({ ...progress });

        // Check if we need to sync this workspace
        if (!options.force) {
          const syncState = await syncStateRepo.get(adapter.name, location.dbPath);
          if (syncState && syncState.lastMtime >= location.mtime) {
            // Skip - no changes since last sync
            progress.workspacesProcessed++;
            onProgress({ ...progress });
            continue;
          }
        }

        // Extract conversations
        const rawConversations = await adapter.extract(location);
        progress.conversationsFound += rawConversations.length;
        onProgress({ ...progress });

        // Delete existing data for this workspace (for clean re-sync)
        await conversationRepo.deleteBySource(adapter.name, location.workspacePath);

        // Normalize and index each conversation
        for (const raw of rawConversations) {
          const normalized = adapter.normalize(raw, location);

          // Delete existing messages, tool calls, and files for this conversation
          await messageRepo.deleteByConversation(normalized.conversation.id);
          await toolCallRepo.deleteByConversation(normalized.conversation.id);
          await filesRepo.deleteByConversation(normalized.conversation.id);
          await messageFilesRepo.deleteByConversation(normalized.conversation.id);

          // Insert conversation (upsert handles duplicates)
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

          onProgress({ ...progress });
        }

        // Update sync state
        await syncStateRepo.set({
          source: adapter.name,
          workspacePath: location.workspacePath,
          dbPath: location.dbPath,
          lastSyncedAt: new Date().toISOString(),
          lastMtime: location.mtime,
        });

        progress.workspacesProcessed++;
        onProgress({ ...progress });
      }
    }

    // Rebuild FTS index after all data is inserted
    if (progress.messagesIndexed > 0) {
      progress.phase = 'indexing';
      progress.currentSource = undefined;
      progress.currentWorkspace = undefined;
      onProgress({ ...progress });

      await rebuildFtsIndex();
    }

    progress.phase = 'done';
    progress.currentSource = undefined;
    progress.currentWorkspace = undefined;
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
    workspacesFound: 0,
    workspacesProcessed: 0,
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
