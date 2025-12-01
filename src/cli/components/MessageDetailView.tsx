import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import {
  formatPaginationInfo,
  getFileName,
  getRoleColor,
  getRoleLabel,
  renderMarkdownContent,
  type CombinedMessage,
} from '../../utils/format';
import type { MessageFile, ToolCall, FileEdit } from '../../schema/index';

export interface MessageDetailViewProps {
  message: CombinedMessage;
  messageFiles: MessageFile[];
  toolCalls?: ToolCall[];
  fileEdits?: FileEdit[];
  width: number;
  height: number;
  scrollOffset: number;
  query: string;
}

/**
 * Format tool outputs as markdown for rendering
 */
function formatToolOutputs(
  toolCalls: ToolCall[],
  fileEdits: FileEdit[],
  messageIds: string[]
): string {
  const msgToolCalls = toolCalls.filter(
    (tc) => messageIds.includes(tc.messageId) && tc.output
  );
  const msgFileEdits = fileEdits.filter(
    (fe) => messageIds.includes(fe.messageId) && fe.newContent
  );

  if (msgToolCalls.length === 0 && msgFileEdits.length === 0) {
    return '';
  }

  const lines: string[] = ['', '---', '', '### Tool Outputs', ''];

  for (const tc of msgToolCalls) {
    const fileName = tc.filePath ? getFileName(tc.filePath) : '';
    lines.push(`**${tc.type}**${fileName ? ` \`${fileName}\`` : ''}`);
    lines.push('```');
    lines.push(tc.output!);
    lines.push('```');
    lines.push('');
  }

  for (const fe of msgFileEdits) {
    const fileName = getFileName(fe.filePath);
    lines.push(`**Edit** \`${fileName}\` (+${fe.linesAdded}/-${fe.linesRemoved})`);
    lines.push('```');
    lines.push(fe.newContent!);
    lines.push('```');
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Full message detail view for viewing untruncated message content
 * Renders markdown with syntax highlighting and formatting
 */
export function MessageDetailView({
  message,
  messageFiles,
  toolCalls = [],
  fileEdits = [],
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

  // Build full content including tool outputs for assistant messages
  const fullContent = useMemo(() => {
    // DEBUG: Log what we're receiving
    console.error('[MessageDetailView] DEBUG:');
    console.error('  toolCalls length:', toolCalls.length);
    console.error('  fileEdits length:', fileEdits.length);
    console.error('  message.role:', message.role);
    console.error('  message.messageIds:', message.messageIds);
    
    let content = message.content;
    if (message.role === 'assistant') {
      const toolOutput = formatToolOutputs(toolCalls, fileEdits, message.messageIds);
      console.error('  toolOutput length:', toolOutput.length);
      content += toolOutput;
    }
    console.error('  final content length:', content.length);
    return content;
  }, [message.content, message.role, message.messageIds, toolCalls, fileEdits]);

  // Render markdown to terminal-formatted string using shared function
  const renderedContent = useMemo(() => {
    return renderMarkdownContent(fullContent, width);
  }, [fullContent, width]);

  // Split rendered content into lines for scrolling
  const lines = renderedContent.split('\n');
  const headerHeight = 3; // Role label + line count + separator
  // Note: No footerHeight reservation - the parent component handles the footer
  const availableHeight = height - headerHeight;
  const visibleLines = lines.slice(scrollOffset, scrollOffset + availableHeight);

  const paginationInfo = formatPaginationInfo(scrollOffset, availableHeight, lines.length);

  return (
    <Box flexDirection="column" height={height}>
      <Box flexDirection="column">
        <Box>
          <Text color={roleColor} bold>{roleLabel}</Text>
          <Text color="gray"> #{message.combinedIndex + 1}</Text>
          {fileNames.length > 0 && (
            <Text color="gray"> · {fileNames.join(', ')}</Text>
          )}
        </Box>
        <Text dimColor>
          {lines.length} lines · {paginationInfo}
        </Text>
        <Text color="gray">{'─'.repeat(Math.max(0, width))}</Text>
      </Box>

      <Box flexDirection="column" flexGrow={1} marginTop={1}>
        <Text>{visibleLines.join('\n')}</Text>
      </Box>
    </Box>
  );
}
