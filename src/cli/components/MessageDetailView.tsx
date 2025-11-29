import React from 'react';
import { Box, Text } from 'ink';
import { HighlightedText } from './HighlightedText';
import {
  formatPaginationInfo,
  getFileName,
  getRoleColor,
  getRoleLabel,
  type CombinedMessage,
} from '../../utils/format';
import type { MessageFile } from '../../schema/index';

export interface MessageDetailViewProps {
  message: CombinedMessage;
  messageFiles: MessageFile[];
  height: number;
  scrollOffset: number;
  query: string;
}

/**
 * Full message detail view for viewing untruncated message content
 */
export function MessageDetailView({
  message,
  messageFiles,
  height,
  scrollOffset,
  query,
}: MessageDetailViewProps) {
  const roleLabel = getRoleLabel(message.role);
  const roleColor = getRoleColor(message.role);

  // Get file names for all messages in this combined group
  const fileNames = messageFiles
    .filter((f) => message.messageIds.includes(f.messageId))
    .map((f) => getFileName(f.filePath));

  // Split content into lines for scrolling
  const lines = message.content.split('\n');
  const headerHeight = 3;
  const footerHeight = 2;
  const availableHeight = height - headerHeight - footerHeight;
  const visibleLines = lines.slice(scrollOffset, scrollOffset + availableHeight);

  const paginationInfo = formatPaginationInfo(scrollOffset, availableHeight, lines.length);

  return (
    <Box flexDirection="column" height={height}>
      <Box flexDirection="column" marginBottom={1}>
        <Box>
          <Text color={roleColor} bold>[{roleLabel}]</Text>
          <Text dimColor> · Message {message.combinedIndex + 1}</Text>
          {fileNames.length > 0 && (
            <Text dimColor> · Files: {fileNames.join(', ')}</Text>
          )}
        </Box>
        <Text dimColor>
          {lines.length} lines · {paginationInfo}
        </Text>
      </Box>

      <Box flexDirection="column" flexGrow={1}>
        <HighlightedText
          text={visibleLines.join('\n')}
          query={query}
        />
      </Box>
    </Box>
  );
}
