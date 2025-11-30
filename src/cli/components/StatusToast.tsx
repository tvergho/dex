import React from 'react';
import { Box, Text } from 'ink';

export interface StatusToastProps {
  message: string;
  type: 'success' | 'error';
  width: number;
  height: number;
}

/**
 * Temporary success/error message toast at bottom of screen
 */
export function StatusToast({ message, type, width, height }: StatusToastProps) {
  const bgColor = type === 'success' ? 'green' : 'red';
  const icon = type === 'success' ? '✓' : '✗';

  // Calculate width for the toast (message + padding + icon)
  const toastWidth = Math.min(message.length + 6, width - 4);
  const leftPadding = Math.floor((width - toastWidth) / 2);

  return (
    <Box
      position="absolute"
      marginLeft={leftPadding}
      marginTop={height - 4}
      width={toastWidth}
    >
      <Box
        paddingX={2}
        borderStyle="round"
        borderColor={bgColor}
      >
        <Text color={bgColor} bold>
          {icon} {message}
        </Text>
      </Box>
    </Box>
  );
}
