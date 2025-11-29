import React from 'react';
import { Box, Text } from 'ink';
import { HighlightedText } from './HighlightedText.js';
import {
  formatSourceInfo,
  truncatePath,
  formatPaginationInfo,
  formatFilesDisplay,
  formatMatchCount,
  getFileName,
  formatFileList,
  getRoleColor,
  getRoleLabel,
} from '../../utils/format.js';
import type { ConversationResult, ConversationFile, MessageFile } from '../../schema/index.js';

export interface MatchesViewProps {
  result: ConversationResult;
  files: ConversationFile[];
  messageFiles: MessageFile[];
  width: number;
  height: number;
  scrollOffset: number;
  selectedMatchIndex: number;
  query: string;
}

/**
 * Shows all matching messages within a single conversation
 */
export function MatchesView({
  result,
  files,
  messageFiles,
  width,
  height,
  scrollOffset,
  selectedMatchIndex,
  query,
}: MatchesViewProps) {
  const { conversation, matches } = result;

  const sourceInfo = formatSourceInfo(conversation.source, conversation.model);

  // Get unique file names (just the filename, not full path)
  const fileNames = files.slice(0, 5).map((f) => getFileName(f.filePath));

  // Fixed header height (always 6 lines: title, source/path, files, matches count, separator)
  const headerHeight = 6;
  const availableHeight = height - headerHeight;
  const matchesPerPage = Math.max(1, Math.floor(availableHeight / 3));

  const visibleMatches = matches.slice(scrollOffset, scrollOffset + matchesPerPage);

  // Build workspace display - always show something
  const workspaceDisplay = conversation.workspacePath
    ? truncatePath(conversation.workspacePath, width - sourceInfo.length - 7)
    : '';

  const paginationInfo = formatPaginationInfo(scrollOffset, matchesPerPage, matches.length);

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
        <Text dimColor>{formatMatchCount(matches.length)} · {paginationInfo}</Text>
        <Text dimColor>{'─'.repeat(Math.max(0, width))}</Text>
      </Box>

      {/* Matches - fixed height per match */}
      <Box flexDirection="column" flexGrow={1} marginTop={1}>
        {visibleMatches.map((match, idx) => {
          const actualIdx = scrollOffset + idx;
          const isSelected = actualIdx === selectedMatchIndex;

          // Get files for this message
          const msgFiles = messageFiles.filter((f) => f.messageId === match.messageId);
          const msgFileNames = msgFiles.map((f) => getFileName(f.filePath));

          const roleColor = getRoleColor(match.role);
          const roleLabel = match.role === 'user' ? 'You' : getRoleLabel(match.role);

          const filesDisplay = formatFileList(msgFileNames, 2);

          return (
            <Box
              key={match.messageId}
              flexDirection="column"
              height={3}
            >
              <Box>
                <Text backgroundColor={isSelected ? 'cyan' : undefined} color={isSelected ? 'black' : 'gray'}>
                  {isSelected ? ' ▸ ' : '   '}
                </Text>
                <Box width={14}>
                  <Text color={roleColor} bold={isSelected}>
                    {roleLabel}
                  </Text>
                  <Text dimColor> #{match.messageIndex + 1}</Text>
                </Box>
                {filesDisplay && (
                  <Text dimColor wrap="truncate"> ({filesDisplay})</Text>
                )}
              </Box>
              <Box marginLeft={12}>
                <HighlightedText
                  text={match.content.replace(/\n/g, ' ').slice(0, width - 14)}
                  query={query}
                  dimColor={!isSelected}
                />
              </Box>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
