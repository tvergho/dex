import React from 'react';
import { Box, Text } from 'ink';
import { HighlightedText } from './HighlightedText';
import {
  formatRelativeTime,
  formatSourceName,
  truncatePath,
  formatMatchCount,
} from '../../utils/format';
import type { ConversationResult } from '../../schema/index';

export interface ResultRowProps {
  result: ConversationResult;
  isSelected: boolean;
  width: number;
  query: string;
}

/**
 * A single search result row showing conversation title, metadata, and snippet
 */
export function ResultRow({
  result,
  isSelected,
  width,
  query,
}: ResultRowProps) {
  const { conversation, bestMatch, totalMatches } = result;

  const metaWidth = 25;
  const prefixWidth = 3;
  const maxTitleWidth = Math.max(20, width - metaWidth - prefixWidth - 4);

  const title = conversation.title.length > maxTitleWidth
    ? conversation.title.slice(0, maxTitleWidth - 1) + '…'
    : conversation.title;

  const timeStr = formatRelativeTime(conversation.updatedAt);
  const matchStr = formatMatchCount(totalMatches);
  const sourceName = formatSourceName(conversation.source);

  // Truncate workspace path if needed - ensure minimum display width
  const workspacePath = conversation.workspacePath;
  const minPathWidth = 20;
  const maxPathWidth = Math.max(minPathWidth, width - sourceName.length - 8);
  const displayPath = workspacePath
    ? truncatePath(workspacePath, maxPathWidth)
    : null;

  // Snippet - truncate to reasonable length
  const snippetContent = bestMatch.snippet.replace(/\n/g, ' ').trim();
  const snippetText = snippetContent.slice(0, Math.max(20, width - 6));

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color={isSelected ? 'black' : undefined} backgroundColor={isSelected ? 'cyan' : undefined}>
          {isSelected ? '▸ ' : '  '}
        </Text>
        <Text color={isSelected ? 'cyan' : 'white'} bold={isSelected} underline={isSelected}>{title}</Text>
        <Text dimColor> · {matchStr} · {timeStr}</Text>
      </Box>
      <Box>
        <Text color="yellow">{'  '}{sourceName}</Text>
        {displayPath && (
          <Text color="magenta"> · {displayPath}</Text>
        )}
      </Box>
      <Box>
        <Text>{'  '}</Text>
        <HighlightedText text={snippetText} query={query} dimColor={false} />
      </Box>
    </Box>
  );
}
