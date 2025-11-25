import React, { useState, useEffect, useMemo } from 'react';
import { render, Box, Text, useInput, useApp } from 'ink';
import { withFullScreen, useScreenSize } from 'fullscreen-ink';
import { connect } from '../../db/index.js';
import { conversationRepo } from '../../db/repository.js';
import type { Conversation } from '../../schema/index.js';

interface ListOptions {
  limit?: string;
  source?: string;
}

function formatRelativeTime(isoDate: string | undefined): string {
  if (!isoDate) return '';

  const date = new Date(isoDate);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return 'today';
  if (diffDays === 1) return 'yesterday';
  if (diffDays < 7) return `${diffDays}d ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
  if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo ago`;
  return `${Math.floor(diffDays / 365)}y ago`;
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
  const prefixWidth = 2;
  const maxTitleWidth = Math.max(20, width - metaWidth - prefixWidth - 4);

  const title = conversation.title.length > maxTitleWidth
    ? conversation.title.slice(0, maxTitleWidth - 1) + '…'
    : conversation.title;

  const timeStr = formatRelativeTime(conversation.updatedAt);
  const msgStr = `${conversation.messageCount} msg${conversation.messageCount !== 1 ? 's' : ''}`;

  // Build project info line
  const projectParts: string[] = [];
  if (conversation.projectName) {
    projectParts.push(conversation.projectName);
  }
  if (conversation.mode) {
    projectParts.push(conversation.mode);
  }
  if (conversation.model) {
    projectParts.push(conversation.model);
  }
  const projectInfo = projectParts.length > 0 ? projectParts.join(' · ') : null;

  // Truncate workspace path if needed
  const workspacePath = conversation.workspacePath;
  const maxPathWidth = width - 6;
  const displayPath = workspacePath
    ? (workspacePath.length > maxPathWidth ? '…' + workspacePath.slice(-(maxPathWidth - 1)) : workspacePath)
    : null;

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={isSelected ? 'cyan' : 'white'} bold={isSelected}>
          {isSelected ? '▸ ' : '  '}
          {title}
        </Text>
        <Text dimColor> · {msgStr} · {timeStr}</Text>
      </Box>
      {projectInfo && (
        <Box marginLeft={4}>
          <Text color="yellow" dimColor>{projectInfo}</Text>
        </Box>
      )}
      {isSelected && displayPath && (
        <Box marginLeft={4}>
          <Text dimColor>{displayPath}</Text>
        </Box>
      )}
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
      <Box paddingX={1} marginBottom={1}>
        <Text bold>Conversations</Text>
        <Text dimColor> ({conversations.length})</Text>
      </Box>

      {/* List */}
      <Box flexDirection="column" flexGrow={1} paddingX={1}>
        {visibleConversations.map((conv, idx) => {
          const actualIndex = scrollOffset + idx;
          return (
            <ConversationRow
              key={conv.id}
              conversation={conv}
              isSelected={actualIndex === selectedIndex}
              width={width - 2}
            />
          );
        })}
      </Box>

      {/* Scroll indicator */}
      {conversations.length > visibleCount && (
        <Box paddingX={1}>
          <Text dimColor>
            {scrollOffset + 1}-{Math.min(scrollOffset + visibleCount, conversations.length)} of {conversations.length}
          </Text>
        </Box>
      )}

      {/* Footer */}
      <Box paddingX={1} marginTop={1}>
        <Text dimColor>j/k: navigate · Enter: select · q: quit</Text>
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
    console.log(`${conv.title} [${conv.source}]`);
    const projectParts: string[] = [];
    if (conv.projectName) projectParts.push(conv.projectName);
    if (conv.mode) projectParts.push(conv.mode);
    if (conv.model) projectParts.push(conv.model);
    if (projectParts.length > 0) {
      console.log(`   ${projectParts.join(' · ')}`);
    }
    if (conv.workspacePath) {
      console.log(`   ${conv.workspacePath}`);
    }
    console.log(`   ${conv.messageCount} message(s) · ${formatRelativeTime(conv.updatedAt)}`);
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
