import React from 'react';
import { Box, Text } from 'ink';
import { HighlightedText } from './HighlightedText';
import { SelectionIndicator } from './SelectableRow';
import { SourceBadge } from './SourceBadge';
import {
  formatRelativeTime,
  formatMatchCount,
} from '../../utils/format';
import type { ConversationResult } from '../../schema/index';
import type { FileSearchMatch } from '../../db/repository';

export interface ResultRowProps {
  result: ConversationResult;
  isSelected: boolean;
  width: number;
  query: string;
  fileMatches?: FileSearchMatch[];
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
}: ResultRowProps) {
  const { conversation, bestMatch, totalMatches } = result;

  const timeStr = formatRelativeTime(conversation.updatedAt);
  const matchStr = formatMatchCount(totalMatches);

  // Calculate available width for title
  const prefixWidth = 3;
  const timeWidth = timeStr.length + matchStr.length + 5;
  const maxTitleWidth = Math.max(20, width - prefixWidth - timeWidth - 4);

  const title = conversation.title.length > maxTitleWidth
    ? conversation.title.slice(0, maxTitleWidth - 1) + '…'
    : conversation.title;

  // Snippet - truncate to reasonable length
  const snippetContent = bestMatch.snippet.replace(/\n/g, ' ').trim();
  const snippetText = snippetContent.slice(0, Math.max(20, width - 6));

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
      {/* Row 1: Selection + Title + Match count + Time */}
      <Box>
        <SelectionIndicator isSelected={isSelected} />
        <Text color={isSelected ? 'cyan' : 'white'} bold={isSelected}>{title}</Text>
        <Box flexGrow={1} />
        <Text color="gray">{matchStr} · {timeStr}</Text>
      </Box>
      {/* Row 2: Source + snippet or file matches */}
      <Box marginLeft={3}>
        <SourceBadge source={conversation.source} />
        <Text color="gray"> · </Text>
        {hasFileMatches ? (
          <>
            <Text color="green">Files: </Text>
            <Text color="gray">{fileMatchDisplay}</Text>
          </>
        ) : (
          <HighlightedText text={snippetText} query={query} dimColor={false} />
        )}
      </Box>
    </Box>
  );
}
