import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import { marked, type MarkedExtension } from 'marked';
import { markedTerminal } from 'marked-terminal';
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
  width: number;
  height: number;
  scrollOffset: number;
  query: string;
}

/**
 * Full message detail view for viewing untruncated message content
 * Renders markdown with syntax highlighting and formatting
 */
export function MessageDetailView({
  message,
  messageFiles,
  width,
  height,
  scrollOffset,
}: MessageDetailViewProps) {
  const roleLabel = getRoleLabel(message.role);
  const roleColor = getRoleColor(message.role);

  // Get file names for all messages in this combined group
  const fileNames = messageFiles
    .filter((f) => message.messageIds.includes(f.messageId))
    .map((f) => getFileName(f.filePath));

  // Render markdown to terminal-formatted string
  const renderedContent = useMemo(() => {
    // Configure marked-terminal for each render to use current width
    marked.use(markedTerminal({
      reflowText: true,
      width: Math.max(40, width - 4), // Leave some margin
      tab: 2,
    }) as MarkedExtension);

    try {
      return marked.parse(message.content) as string;
    } catch {
      // Fallback to raw content if markdown parsing fails
      return message.content;
    }
  }, [message.content, width]);

  // Split rendered content into lines for scrolling
  const lines = renderedContent.split('\n');
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
        <Text>{visibleLines.join('\n')}</Text>
      </Box>
    </Box>
  );
}
