import React from 'react';
import { Box, Text } from 'ink';
import {
  formatSourceInfo,
  truncatePath,
  formatPaginationInfo,
  formatFilesDisplay,
  formatMessageCount,
  getFileName,
  formatFileList,
  getRoleColor,
  getRoleLabel,
} from '../../utils/format.js';
import type { Conversation, Message, ConversationFile, MessageFile } from '../../schema/index.js';

export interface ConversationViewProps {
  conversation: Conversation;
  messages: Message[];
  files: ConversationFile[];
  messageFiles: MessageFile[];
  width: number;
  height: number;
  scrollOffset: number;
  highlightMessageIndex?: number;
  selectedIndex: number;
}

/**
 * Full conversation view with all messages
 */
export function ConversationView({
  conversation,
  messages,
  files,
  messageFiles,
  width,
  height,
  scrollOffset,
  highlightMessageIndex,
  selectedIndex,
}: ConversationViewProps) {
  const sourceInfo = formatSourceInfo(conversation.source, conversation.model);

  // Get file names
  const fileNames = files.slice(0, 5).map((f) => getFileName(f.filePath));

  // Header: title + project info + workspace path + files (optional) + message count + separator
  const headerHeight = 5 + (files.length > 0 ? 1 : 0);
  const availableHeight = height - headerHeight;
  const messagesPerPage = Math.max(1, Math.floor(availableHeight / 3));

  const visibleMessages = messages.slice(scrollOffset, scrollOffset + messagesPerPage);

  // Always show pagination info when more than 1 message
  const paginationInfo = messages.length > 0
    ? formatPaginationInfo(scrollOffset, messagesPerPage, messages.length)
    : '';

  // Build workspace display - always show something
  const workspaceDisplay = conversation.workspacePath
    ? truncatePath(conversation.workspacePath, width - sourceInfo.length - 7)
    : '';

  return (
    <Box flexDirection="column" height={height}>
      {/* Fixed header - always same structure */}
      <Box flexDirection="column">
        <Text bold color="cyan">{conversation.title}</Text>
        <Text>
          <Text color="yellow" dimColor>{sourceInfo}</Text>
          {workspaceDisplay && <Text dimColor> · </Text>}
          <Text color="magenta" dimColor>{workspaceDisplay}</Text>
        </Text>
        <Text dimColor>
          {formatFilesDisplay(fileNames, files.length)}
        </Text>
        <Text dimColor>{formatMessageCount(messages.length)} · {paginationInfo}</Text>
        <Text dimColor>{'─'.repeat(Math.max(0, width))}</Text>
      </Box>

      {/* Messages - fixed height per message */}
      <Box flexDirection="column" flexGrow={1} marginTop={1}>
        {visibleMessages.map((msg, idx) => {
          const actualIdx = scrollOffset + idx;
          const isHighlighted = actualIdx === highlightMessageIndex;
          const isSelected = actualIdx === selectedIndex;
          const roleLabel = getRoleLabel(msg.role);
          const roleColor = getRoleColor(msg.role);

          // Get files for this message
          const msgFiles = messageFiles.filter((f) => f.messageId === msg.id);
          const msgFileNames = msgFiles.map((f) => getFileName(f.filePath));

          const filesDisplay = formatFileList(msgFileNames, 2);

          // Truncate messages to ~1 line for readable view
          const maxLen = width - 14;
          const truncatedContent = msg.content.replace(/\n/g, ' ').slice(0, maxLen);
          const isTruncated = msg.content.length > maxLen;
          const totalLines = msg.content.split('\n').length;

          // Determine visual state
          const showIndicator = isSelected || isHighlighted;

          return (
            <Box
              key={msg.id}
              flexDirection="column"
              height={3}
            >
              <Box>
                <Text backgroundColor={isSelected ? 'cyan' : isHighlighted ? 'yellow' : undefined} color={showIndicator ? 'black' : 'gray'}>
                  {isSelected ? ' ▸ ' : isHighlighted ? ' ★ ' : '   '}
                </Text>
                <Box width={9}>
                  <Text color={roleColor} bold={isSelected || isHighlighted}>
                    {roleLabel}
                  </Text>
                </Box>
                {filesDisplay && (
                  <Text dimColor wrap="truncate"> ({filesDisplay})</Text>
                )}
                {isHighlighted && !isSelected && (
                  <Text color="yellow" dimColor> matched</Text>
                )}
              </Box>
              <Box marginLeft={12}>
                <Text dimColor={!isSelected && !isHighlighted} wrap="truncate">
                  {truncatedContent}
                  {isTruncated && <Text dimColor> ({totalLines} lines)</Text>}
                </Text>
              </Box>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
