import React from 'react';
import { Box, Text } from 'ink';
import { HighlightedText } from './HighlightedText';
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
} from '../../utils/format';
import type { ConversationResult, ConversationFile, MessageFile } from '../../schema/index';

export interface MatchesViewProps {
  result: ConversationResult;
  files: ConversationFile[];
  messageFiles: MessageFile[];
  width: number;
  height: number;
  scrollOffset: number;
  selectedMatchIndex: number;
  query: string;
  /** Map from original messageIndex to combined message index */
  indexMap?: Map<number, number>;
  /** Total number of combined messages */
  combinedMessageCount?: number;
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
  indexMap,
  combinedMessageCount: _combinedMessageCount,
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
          <Text color="yellow">{sourceInfo}</Text>
          {workspaceDisplay && <Text dimColor> · </Text>}
          <Text color="magenta">{workspaceDisplay}</Text>
        </Text>
        <Text color="gray">
          {formatFilesDisplay(fileNames, files.length)}
        </Text>
        <Text color="gray">{formatMatchCount(matches.length)} · {paginationInfo}</Text>
        <Text color="gray">{'─'.repeat(Math.max(0, width))}</Text>
      </Box>

      {/* Matches - consistent spacing with explicit spacer */}
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

          // Use combined message index if available, otherwise use original
          const displayIndex = indexMap?.get(match.messageIndex) ?? match.messageIndex;

          // Format index with consistent width (right-aligned)
          const indexStr = `${displayIndex + 1}.`;
          const indexWidth = 4; // "999." max

          // Truncate snippet to fit
          const contentWidth = width - indexWidth - 1;
          const snippetContent = match.content.replace(/\n/g, ' ').trim();
          const snippetText = snippetContent.length > contentWidth - 2
            ? snippetContent.slice(0, contentWidth - 3) + '…'
            : snippetContent;

          return (
            <Box
              key={match.messageId}
              flexDirection="column"
            >
              {/* Row 1: Index + Role + Files */}
              <Box>
                <Text color={isSelected ? 'cyan' : 'gray'}>{indexStr.padStart(indexWidth)} </Text>
                <Text color={roleColor} bold={isSelected} underline={isSelected}>
                  {roleLabel}
                </Text>
                {filesDisplay && (
                  <Text color="gray"> ({filesDisplay})</Text>
                )}
              </Box>
              {/* Row 2: Snippet with highlighting */}
              <Box marginLeft={indexWidth + 1} width={contentWidth}>
                <HighlightedText text={snippetText} query={query} />
              </Box>
              {/* Spacer for consistent vertical spacing */}
              <Box height={1} />
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
