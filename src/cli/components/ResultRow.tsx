import React from 'react';
import { Box, Text } from 'ink';
import { HighlightedText } from './HighlightedText';
import { SourceBadge } from './SourceBadge';
import {
  formatRelativeTime,
  formatMatchCount,
  truncatePath,
} from '../../utils/format';
import type { ConversationResult } from '../../schema/index';
import type { FileSearchMatch } from '../../db/repository';

export interface ResultRowProps {
  result: ConversationResult;
  isSelected: boolean;
  width: number;
  query: string;
  fileMatches?: FileSearchMatch[];
  index?: number;
}

/**
 * A single search result row showing conversation title, metadata, and snippet
 */
export function ResultRow({
  result,
  isSelected,
  width,
  query,
  fileMatches,
  index,
}: ResultRowProps) {
  const { conversation, bestMatch, totalMatches } = result;

  const timeStr = formatRelativeTime(conversation.updatedAt);
  const matchStr = formatMatchCount(totalMatches);

  // Format index with consistent width (right-aligned)
  const indexStr = index !== undefined ? `${index + 1}.` : '';
  const indexWidth = index !== undefined ? 4 : 0; // "999." max

  // Calculate available width for title
  const prefixWidth = indexWidth + (indexWidth > 0 ? 1 : 0);
  const timeWidth = timeStr.length + matchStr.length + 5;
  const maxTitleWidth = Math.max(20, width - prefixWidth - timeWidth - 4);

  const title = conversation.title.length > maxTitleWidth
    ? conversation.title.slice(0, maxTitleWidth - 1) + '…'
    : conversation.title;

  // Snippet - truncate to fit width, accounting for left margin
  const snippetContent = bestMatch.snippet.replace(/\n/g, ' ').trim();
  const snippetMaxWidth = Math.max(20, width - (indexWidth + (indexWidth > 0 ? 1 : 0)) - 4);
  const snippetText = snippetContent.length > snippetMaxWidth
    ? snippetContent.slice(0, snippetMaxWidth - 1) + '…'
    : snippetContent;

  // Format workspace path
  const workspacePath = conversation.workspacePath;
  const minPathWidth = 20;
  const maxPathWidth = Math.max(minPathWidth, width - 20);
  const displayPath = workspacePath
    ? truncatePath(workspacePath, maxPathWidth)
    : null;

  // Format file matches display
  const hasFileMatches = fileMatches && fileMatches.length > 0;
  const fileMatchDisplay = hasFileMatches
    ? fileMatches
        .slice(0, 3)
        .map((m) => m.filePath.split('/').pop())
        .join(', ') + (fileMatches.length > 3 ? ` +${fileMatches.length - 3}` : '')
    : null;

  return (
    <Box flexDirection="column" marginBottom={1}>
      {/* Row 1: Index + Title + Match count + Time */}
      <Box>
        {index !== undefined && (
          <Text color={isSelected ? 'cyan' : 'gray'}>{indexStr.padStart(indexWidth)} </Text>
        )}
        <Text color={isSelected ? 'cyan' : 'white'} bold={isSelected}>{title}</Text>
        <Box flexGrow={1} />
        <Text color="gray">{matchStr} · {timeStr}</Text>
      </Box>
      {/* Row 2: Source + workspace path */}
      <Box marginLeft={indexWidth + (indexWidth > 0 ? 1 : 0)}>
        <Text wrap="truncate-end">
          <SourceBadge source={conversation.source} />
          {displayPath && (
            <Text color="magenta"> · {displayPath}</Text>
          )}
        </Text>
      </Box>
      {/* Row 3: Snippet or file matches */}
      <Box marginLeft={indexWidth + (indexWidth > 0 ? 1 : 0)}>
        {hasFileMatches ? (
          <Text wrap="truncate-end">
            <Text color="green">Files: </Text>
            <Text color="gray">{fileMatchDisplay}</Text>
          </Text>
        ) : (
          <HighlightedText text={snippetText} query={query} dimColor={false} />
        )}
      </Box>
    </Box>
  );
}
