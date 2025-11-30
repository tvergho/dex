import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';

export type SyncPhase = 'idle' | 'syncing' | 'done' | 'error';

export interface SyncStatus {
  phase: SyncPhase;
  message?: string;
  newConversations?: number;
}

export interface StatusBarProps {
  status: SyncStatus;
  width: number;
  searchMode?: boolean;
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function StatusBar({ status, width, searchMode }: StatusBarProps) {
  const [frame, setFrame] = useState(0);

  // Animate spinner when syncing
  useEffect(() => {
    if (status.phase !== 'syncing') return;

    const timer = setInterval(() => {
      setFrame((f) => (f + 1) % SPINNER_FRAMES.length);
    }, 80);

    return () => clearInterval(timer);
  }, [status.phase]);

  const getStatusDisplay = () => {
    switch (status.phase) {
      case 'syncing':
        return (
          <>
            <Text color="cyan">{SPINNER_FRAMES[frame]} </Text>
            <Text color="cyan">{status.message || 'Syncing...'}</Text>
          </>
        );
      case 'done':
        return (
          <>
            <Text color="green">✓ </Text>
            <Text color="green">Synced</Text>
            {status.newConversations && status.newConversations > 0 && (
              <Text color="yellow"> | {status.newConversations} new</Text>
            )}
          </>
        );
      case 'error':
        return (
          <>
            <Text color="red">✗ </Text>
            <Text color="red">{status.message || 'Sync failed'}</Text>
          </>
        );
      default:
        return <Text color="gray">Ready</Text>;
    }
  };

  const hints = searchMode
    ? 'Enter search  Esc cancel'
    : '/ search  j/k nav  Enter select  q quit';

  return (
    <Box width={width}>
      <Box flexGrow={1}>{getStatusDisplay()}</Box>
      <Text color="gray">{hints}</Text>
    </Box>
  );
}
