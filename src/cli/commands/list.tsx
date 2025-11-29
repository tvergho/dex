/**
 * List command - displays all indexed conversations
 *
 * Usage: dex list [--limit <n>] [--source <name>]
 *
 * Interactive TUI with scrolling, or plain text output when piped
 * Navigate with j/k, select with Enter to get conversation ID
 */

import React, { useState, useEffect, useMemo } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import { withFullScreen, useScreenSize } from 'fullscreen-ink';
import { connect } from '../../db/index';
import { conversationRepo } from '../../db/repository';
import {
  formatRelativeTime,
  formatSourceName,
  formatSourceInfo,
  truncatePath,
  formatMessageCount,
  formatTokenPair,
  formatLineCounts,
  getLineCountParts,
} from '../../utils/format';
import type { Conversation } from '../../schema/index';

interface ListOptions {
  limit?: string;
  source?: string;
}

function ConversationRow({
  conversation,
  isSelected,
  width,
}: {
  conversation: Conversation;
  isSelected: boolean;
  width: number;
}) {
  const metaWidth = 25;
  const prefixWidth = 3;
  const maxTitleWidth = Math.max(20, width - metaWidth - prefixWidth - 4);

  const title = conversation.title.length > maxTitleWidth
    ? conversation.title.slice(0, maxTitleWidth - 1) + '…'
    : conversation.title;

  const timeStr = formatRelativeTime(conversation.updatedAt);
  const msgStr = `${conversation.messageCount} msg${conversation.messageCount !== 1 ? 's' : ''}`;
  const sourceName = formatSourceName(conversation.source);
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

  // Truncate workspace path if needed
  const maxPathWidth = width - 6 - sourceName.length - 3;
  const displayPath = conversation.workspacePath
    ? truncatePath(conversation.workspacePath, maxPathWidth)
    : null;

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={isSelected ? 'black' : undefined} backgroundColor={isSelected ? 'cyan' : undefined}>
          {isSelected ? ' ▸ ' : '   '}
        </Text>
        <Text color={isSelected ? 'cyan' : 'white'} bold={isSelected} underline={isSelected}>
          {title}
        </Text>
        <Text dimColor> · {msgStr} · {timeStr}</Text>
      </Box>
      <Box marginLeft={3}>
        <Text color="yellow">{sourceName}</Text>
        {displayPath && (
          <>
            <Text dimColor> · </Text>
            <Text color="magenta">{displayPath}</Text>
          </>
        )}
        {tokenStr && (
          <>
            <Text dimColor> · </Text>
            <Text color="cyan">{tokenStr}</Text>
          </>
        )}
        {lineParts && (
          <>
            <Text dimColor> · </Text>
            <Text color="green">{lineParts.added}</Text>
            <Text color="gray"> / </Text>
            <Text color="red">{lineParts.removed}</Text>
          </>
        )}
      </Box>
    </Box>
  );
}

function ListApp({
  limit,
  source,
}: {
  limit: number;
  source?: string;
}) {
  const { exit } = useApp();
  const { width, height } = useScreenSize();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => {
    async function loadConversations() {
      try {
        await connect();
        const results = await conversationRepo.list({ limit, source });
        setConversations(results);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    }
    loadConversations();
  }, [limit, source]);

  const headerHeight = 3;
  const footerHeight = 2;
  const rowHeight = 2; // Title + optional project info
  const availableHeight = height - headerHeight - footerHeight;
  const visibleCount = Math.max(1, Math.floor(availableHeight / rowHeight));

  const scrollOffset = useMemo(() => {
    const maxOffset = Math.max(0, conversations.length - visibleCount);
    if (selectedIndex < visibleCount) return 0;
    return Math.min(selectedIndex - visibleCount + 1, maxOffset);
  }, [selectedIndex, visibleCount, conversations.length]);

  const visibleConversations = useMemo(() => {
    return conversations.slice(scrollOffset, scrollOffset + visibleCount);
  }, [conversations, scrollOffset, visibleCount]);

  useInput((input, key) => {
    if (input === 'q' || key.escape) {
      exit();
      return;
    }

    if (conversations.length === 0) return;

    if (input === 'j' || key.downArrow) {
      setSelectedIndex((i) => Math.min(i + 1, conversations.length - 1));
    } else if (input === 'k' || key.upArrow) {
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (key.return) {
      const selected = conversations[selectedIndex];
      if (selected) {
        // Exit and print the ID so user can use it
        exit();
        setTimeout(() => {
          console.log(`\nSelected: ${selected.title}`);
          console.log(`ID: ${selected.id}`);
          console.log(`\nRun: dex show ${selected.id}`);
        }, 100);
      }
    }
  });

  if (loading) {
    return (
      <Box width={width} height={height} alignItems="center" justifyContent="center">
        <Text color="cyan">Loading conversations...</Text>
      </Box>
    );
  }

  if (error) {
    return (
      <Box width={width} height={height} flexDirection="column" padding={1}>
        <Text color="red">Error: {error}</Text>
        <Text dimColor>Press q to exit</Text>
      </Box>
    );
  }

  if (conversations.length === 0) {
    return (
      <Box width={width} height={height} flexDirection="column" padding={1}>
        <Text dimColor>No conversations found.</Text>
        <Text dimColor>Run `dex sync` to index your conversations.</Text>
        <Box marginTop={1}>
          <Text dimColor>Press q to exit</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box width={width} height={height} flexDirection="column">
      {/* Header */}
      <Box flexDirection="column" marginBottom={1}>
        <Box paddingX={1}>
          <Text bold color="white">Conversations</Text>
          <Text dimColor> ({conversations.length})</Text>
        </Box>
        <Box paddingX={1}>
          <Text color="gray">{'─'.repeat(Math.max(0, width - 2))}</Text>
        </Box>
      </Box>

      {/* List */}
      <Box flexDirection="column" flexGrow={1} paddingX={1}>
        {visibleConversations.map((conv, idx) => {
          const actualIndex = scrollOffset + idx;
          return (
            <Box key={conv.id} marginBottom={1}>
              <ConversationRow
                conversation={conv}
                isSelected={actualIndex === selectedIndex}
                width={width - 2}
              />
            </Box>
          );
        })}
      </Box>

      {/* Footer */}
      <Box flexDirection="column">
        <Box paddingX={1}>
          <Text color="gray">{'─'.repeat(Math.max(0, width - 2))}</Text>
        </Box>
        <Box paddingX={1} justifyContent="space-between">
          <Text>
            <Text color="white">j/k</Text><Text dimColor>: navigate · </Text>
            <Text color="white">Enter</Text><Text dimColor>: select · </Text>
            <Text color="white">q</Text><Text dimColor>: quit</Text>
          </Text>
          {conversations.length > visibleCount && (
            <Text dimColor>
              {scrollOffset + 1}-{Math.min(scrollOffset + visibleCount, conversations.length)} of {conversations.length}
            </Text>
          )}
        </Box>
      </Box>
    </Box>
  );
}

async function plainList(limit: number, source?: string): Promise<void> {
  await connect();
  const conversations = await conversationRepo.list({ limit, source });

  console.log(`\nConversations (${conversations.length}):\n`);

  if (conversations.length === 0) {
    console.log('No conversations found.');
    console.log('Run `dex sync` to index your conversations.');
    return;
  }

  for (const conv of conversations) {
    console.log(`${conv.title}`);
    const sourceInfo = formatSourceInfo(conv.source, conv.model);
    console.log(`   ${sourceInfo}`);
    if (conv.workspacePath) {
      console.log(`   ${conv.workspacePath}`);
    }
    const tokenStr = formatTokenPair(
      conv.totalInputTokens,
      conv.totalOutputTokens,
      conv.totalCacheCreationTokens,
      conv.totalCacheReadTokens
    );
    const lineCountStr = formatLineCounts(conv.totalLinesAdded, conv.totalLinesRemoved);
    const tokenInfo = tokenStr ? ` · ${tokenStr}` : '';
    const lineInfo = lineCountStr ? ` · ${lineCountStr}` : '';
    console.log(`   ${formatMessageCount(conv.messageCount)} · ${formatRelativeTime(conv.updatedAt)}${tokenInfo}${lineInfo}`);
    console.log(`   ID: ${conv.id}`);
    console.log('');
  }
}

export async function listCommand(options: ListOptions): Promise<void> {
  const limit = parseInt(options.limit ?? '20', 10);

  if (!process.stdin.isTTY) {
    await plainList(limit, options.source);
    return;
  }

  const app = withFullScreen(<ListApp limit={limit} source={options.source} />);
  await app.start();
  await app.waitUntilExit();
}
