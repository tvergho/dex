import React from 'react';
import { render, Box, Text } from 'ink';
import { getEmbeddingProgress, getModelPath, type EmbeddingProgress } from '../../embeddings/index.js';
import { existsSync, statSync } from 'fs';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatDuration(start: string, end?: string): string {
  const startTime = new Date(start).getTime();
  const endTime = end ? new Date(end).getTime() : Date.now();
  const seconds = Math.floor((endTime - startTime) / 1000);

  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function StatusUI({ progress }: { progress: EmbeddingProgress }) {
  const modelPath = getModelPath();
  const modelExists = existsSync(modelPath);
  const modelSize = modelExists ? statSync(modelPath).size : 0;

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold>Embedding Status</Text>
      <Text dimColor>{'─'.repeat(40)}</Text>

      <Box marginTop={1}>
        <Text>Model: </Text>
        {modelExists ? (
          <Text color="green">✓ Downloaded ({formatBytes(modelSize)})</Text>
        ) : (
          <Text color="yellow">Not downloaded</Text>
        )}
      </Box>

      <Box marginTop={1}>
        <Text>Status: </Text>
        {progress.status === 'idle' && <Text color="gray">Idle</Text>}
        {progress.status === 'downloading' && <Text color="cyan">Downloading model...</Text>}
        {progress.status === 'embedding' && <Text color="cyan">Generating embeddings...</Text>}
        {progress.status === 'done' && <Text color="green">✓ Complete</Text>}
        {progress.status === 'error' && <Text color="red">✗ Error</Text>}
      </Box>

      {progress.status === 'embedding' && (
        <Box marginTop={1} flexDirection="column">
          <Text>
            Progress: {progress.completed}/{progress.total} messages (
            {Math.round((progress.completed / progress.total) * 100)}%)
          </Text>
          <Box marginTop={1}>
            <Text dimColor>
              [{'█'.repeat(Math.floor((progress.completed / progress.total) * 30))}
              {'░'.repeat(30 - Math.floor((progress.completed / progress.total) * 30))}]
            </Text>
          </Box>
          {progress.startedAt && (
            <Text dimColor>Elapsed: {formatDuration(progress.startedAt)}</Text>
          )}
        </Box>
      )}

      {progress.status === 'done' && (
        <Box marginTop={1} flexDirection="column">
          <Text>Messages: {progress.total} embedded</Text>
          {progress.startedAt && progress.completedAt && (
            <Text dimColor>Duration: {formatDuration(progress.startedAt, progress.completedAt)}</Text>
          )}
        </Box>
      )}

      {progress.status === 'error' && progress.error && (
        <Box marginTop={1}>
          <Text color="red">Error: {progress.error}</Text>
        </Box>
      )}

      <Box marginTop={2}>
        <Text dimColor>
          {progress.status === 'embedding'
            ? 'Embeddings are being generated in the background.'
            : progress.status === 'idle'
              ? 'Run "dex sync" to start syncing and embedding.'
              : progress.status === 'done'
                ? 'Embeddings are ready. Search will use hybrid FTS + vector.'
                : ''}
        </Text>
      </Box>
    </Box>
  );
}

export async function statusCommand(): Promise<void> {
  const progress = getEmbeddingProgress();
  const { unmount } = render(<StatusUI progress={progress} />);

  // Exit after rendering
  setTimeout(() => {
    unmount();
  }, 100);
}
