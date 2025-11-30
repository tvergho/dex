import React from 'react';
import { Box, Text } from 'ink';

export interface ExportPreviewModalProps {
  content: string;
  title: string;
  scrollOffset: number;
  width: number;
  height: number;
}

/**
 * Full-screen scrollable markdown preview
 */
export function ExportPreviewModal({
  content,
  title,
  scrollOffset,
  width,
  height,
}: ExportPreviewModalProps) {
  const headerHeight = 3;
  const footerHeight = 2;
  const contentHeight = height - headerHeight - footerHeight;

  // Split content into lines
  const lines = content.split('\n');
  const visibleLines = lines.slice(scrollOffset, scrollOffset + contentHeight);
  const maxOffset = Math.max(0, lines.length - contentHeight);

  // Truncate title if too long
  const displayTitle =
    title.length > width - 20 ? title.slice(0, width - 23) + '...' : title;

  return (
    <Box width={width} height={height} flexDirection="column">
      {/* Header */}
      <Box flexDirection="column">
        <Box paddingX={1}>
          <Text color="cyan" bold>
            Preview:
          </Text>
          <Text> {displayTitle}</Text>
        </Box>
        <Box paddingX={1}>
          <Text color="gray">{'─'.repeat(Math.max(0, width - 2))}</Text>
        </Box>
      </Box>

      {/* Content */}
      <Box flexDirection="column" flexGrow={1} paddingX={1} overflowY="hidden">
        {visibleLines.map((line, idx) => (
          <Box key={scrollOffset + idx} width={width - 2}>
            <Text wrap="truncate">{line || ' '}</Text>
          </Box>
        ))}
      </Box>

      {/* Footer */}
      <Box flexDirection="column">
        <Box paddingX={1}>
          <Text color="gray">{'─'.repeat(Math.max(0, width - 2))}</Text>
        </Box>
        <Box paddingX={1} justifyContent="space-between">
          <Text color="gray">
            <Text bold color="white">j/k</Text> scroll · <Text bold color="white">g/G</Text> top/bottom · <Text bold color="white">Esc</Text> close
          </Text>
          <Text color="gray">
            {scrollOffset + 1}-{Math.min(scrollOffset + contentHeight, lines.length)} of {lines.length}
          </Text>
        </Box>
      </Box>
    </Box>
  );
}

/**
 * Calculate the maximum scroll offset for preview content
 */
export function getPreviewMaxOffset(content: string, contentHeight: number): number {
  const lines = content.split('\n');
  return Math.max(0, lines.length - contentHeight);
}
