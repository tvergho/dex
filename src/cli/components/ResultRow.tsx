import React from 'react';
import { Box, Text } from 'ink';
import { HighlightedText } from './HighlightedText';
import {
  formatRelativeTime,
  formatMatchCount,
  truncatePath,
  formatTokenPair,
  getLineCountParts,
  formatSourceLabel,
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
  const contentWidth = width - indexWidth - (indexWidth > 0 ? 1 : 0);

  // Calculate available width for title
  const prefixWidth = indexWidth + (indexWidth > 0 ? 1 : 0);
  const timeWidth = timeStr.length + matchStr.length + 5;
  const maxTitleWidth = Math.max(20, width - prefixWidth - timeWidth - 4);

  const rawTitle = conversation.title || 'Untitled';
  const title = rawTitle.length > maxTitleWidth
    ? rawTitle.slice(0, maxTitleWidth - 1) + '…'
    : rawTitle;

  // Build row 2 metadata parts for colored display
  const sourceName = formatSourceLabel(conversation.source);
  const tokenStr = formatTokenPair(
    conversation.totalInputTokens,
    conversation.totalOutputTokens,
    conversation.totalCacheCreationTokens,
    conversation.totalCacheReadTokens
  );
  const lineParts = getLineCountParts(
    conversation.totalLinesAdded,
    conversation.totalLinesRemoved
  );

  // Calculate how much space we have for the path
  const linePartsLen = lineParts ? ` · ${lineParts.added} / ${lineParts.removed}`.length : 0;
  const fixedPartsLen = sourceName.length +
    (tokenStr ? ` · ${tokenStr}`.length : 0) +
    linePartsLen;
  const availableForPath = contentWidth - fixedPartsLen - 10; // Leave some buffer

  const pathStr = conversation.workspacePath
    ? truncatePath(conversation.workspacePath, Math.max(15, availableForPath))
    : null;

  // Snippet - truncate to fit width, centered on the search term
  const snippetContent = bestMatch.snippet.replace(/\n/g, ' ').trim();
  const snippetMaxWidth = Math.max(20, contentWidth - 2);
  let snippetText = snippetContent;
  if (snippetContent.length > snippetMaxWidth) {
    // Find the first search term position to center the truncation
    const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 0);
    const lowerSnippet = snippetContent.toLowerCase();

    // Try full phrase first, then individual terms
    let matchPos = lowerSnippet.indexOf(query.toLowerCase());
    if (matchPos === -1) {
      for (const term of terms) {
        const pos = lowerSnippet.indexOf(term);
        if (pos !== -1) {
          matchPos = pos;
          break;
        }
      }
    }

    if (matchPos !== -1 && matchPos > snippetMaxWidth / 2) {
      // Center around the match
      const start = Math.max(0, matchPos - Math.floor(snippetMaxWidth / 2));
      const end = Math.min(snippetContent.length, start + snippetMaxWidth - 2);
      const prefix = start > 0 ? '…' : '';
      const suffix = end < snippetContent.length ? '…' : '';
      snippetText = prefix + snippetContent.slice(start, end) + suffix;
    } else {
      // Match is near the beginning, just truncate from end
      snippetText = snippetContent.slice(0, snippetMaxWidth - 1) + '…';
    }
  }

  // Format file matches display - truncate to fit
  const hasFileMatches = fileMatches && fileMatches.length > 0;
  let fileMatchDisplay = '';
  if (hasFileMatches) {
    fileMatchDisplay = 'Files: ' + fileMatches
      .slice(0, 3)
      .map((m) => m.filePath.split('/').pop())
      .join(', ') + (fileMatches.length > 3 ? ` +${fileMatches.length - 3}` : '');
    if (fileMatchDisplay.length > contentWidth - 2) {
      fileMatchDisplay = fileMatchDisplay.slice(0, contentWidth - 3) + '…';
    }
  }

  return (
    <Box flexDirection="column" marginBottom={2}>
      {/* Row 1: Index + Title + Match count + Time */}
      <Text>
        {index !== undefined && (
          <Text color={isSelected ? 'cyan' : 'gray'}>{indexStr.padStart(indexWidth)} </Text>
        )}
        <Text color={isSelected ? 'cyan' : 'white'} bold={isSelected} underline={isSelected}>{title}</Text>
        {'  '}
        <Text bold color="yellow">{matchStr}</Text>
        <Text color="gray"> · {timeStr}</Text>
      </Text>
      {/* Row 2: Source + workspace path + tokens + lines */}
      <Box marginLeft={indexWidth + (indexWidth > 0 ? 1 : 0)} width={contentWidth}>
        <Text wrap="truncate-end">
          <Text color="yellow">{sourceName}</Text>
          {pathStr && <Text color="magenta"> · {pathStr}</Text>}
          {tokenStr && <Text color="cyan"> · {tokenStr}</Text>}
          {lineParts && <Text color="gray"> · </Text>}
          {lineParts && <Text color="green">{lineParts.added}</Text>}
          {lineParts && <Text color="gray"> / </Text>}
          {lineParts && <Text color="red">{lineParts.removed}</Text>}
        </Text>
      </Box>
      {/* Row 3: Snippet or file matches */}
      <Box marginLeft={indexWidth + (indexWidth > 0 ? 1 : 0)} width={contentWidth}>
        {hasFileMatches ? (
          <Text color="gray" wrap="truncate-end">{fileMatchDisplay}</Text>
        ) : (
          <HighlightedText text={snippetText} query={query} dimColor />
        )}
      </Box>
      {/* Row 4: Adjacent context (e.g., assistant response after user query) */}
      {!hasFileMatches && bestMatch.adjacentContext && (
        <Box marginLeft={indexWidth + (indexWidth > 0 ? 1 : 0)} width={contentWidth}>
          <Text color="gray" wrap="truncate-end">
            {bestMatch.adjacentContext.role === 'assistant' ? '→ ' : '← '}
            <Text color={bestMatch.adjacentContext.role === 'assistant' ? 'green' : 'blue'}>
              {bestMatch.adjacentContext.role === 'assistant' ? 'Assistant' : 'You'}
            </Text>
            {': '}
            {bestMatch.adjacentContext.snippet.length > contentWidth - 15
              ? bestMatch.adjacentContext.snippet.slice(0, contentWidth - 18) + '…'
              : bestMatch.adjacentContext.snippet}
          </Text>
        </Box>
      )}
    </Box>
  );
}
