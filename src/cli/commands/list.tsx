/**
 * List command - displays all indexed conversations
 *
 * Usage: dex list [--limit <n>] [--source <name>]
 *
 * Interactive TUI with scrolling, or plain text output when piped
 * Navigate with j/k, select with Enter to get conversation ID
 */

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import { withFullScreen, useScreenSize } from 'fullscreen-ink';
import { connect } from '../../db/index';
import { conversationRepo } from '../../db/repository';
import {
  formatRelativeTime,
  formatSourceLabel,
  formatSourceInfo,
  truncatePath,
  formatMessageCount,
  formatTokenPair,
  formatLineCounts,
  getLineCountParts,
} from '../../utils/format';
import type { Conversation } from '../../schema/index';
import { ExportActionMenu, StatusToast } from '../components/index';
import {
  exportConversationsToFile,
  exportConversationsToClipboard,
} from '../../utils/export-actions';

interface ListOptions {
  limit?: string;
  source?: string;
  project?: string;
  from?: string;
  to?: string;
  offset?: string;
  json?: boolean;
}

function ConversationRow({
  conversation,
  isSelected,
  isChecked,
  multiSelectMode,
  width,
}: {
  conversation: Conversation;
  isSelected: boolean;
  isChecked?: boolean;
  multiSelectMode?: boolean;
  width: number;
}) {
  const metaWidth = 25;
  const checkboxWidth = multiSelectMode ? 4 : 0;
  const prefixWidth = 3;
  const maxTitleWidth = Math.max(20, width - metaWidth - prefixWidth - checkboxWidth - 4);

  const title = conversation.title.length > maxTitleWidth
    ? conversation.title.slice(0, maxTitleWidth - 1) + '…'
    : conversation.title;

  const timeStr = formatRelativeTime(conversation.updatedAt);
  const msgStr = `${conversation.messageCount} msg${conversation.messageCount !== 1 ? 's' : ''}`;
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
        {multiSelectMode && (
          <Text color={isChecked ? 'green' : 'gray'}>
            {isChecked ? '[✓] ' : '[ ] '}
          </Text>
        )}
        <Text color={isSelected ? 'cyan' : 'white'} bold={isSelected} underline={isSelected}>
          {title}
        </Text>
        <Text dimColor> · {msgStr} · {timeStr}</Text>
      </Box>
      <Box marginLeft={multiSelectMode ? 7 : 3}>
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

type ExportMode = 'none' | 'action-menu';

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

  // Multi-select state
  const [multiSelectMode, setMultiSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Export state
  const [exportMode, setExportMode] = useState<ExportMode>('none');
  const [exportActionIndex, setExportActionIndex] = useState(0);

  // Status toast
  const [statusMessage, setStatusMessage] = useState('');
  const [statusType, setStatusType] = useState<'success' | 'error'>('success');
  const [statusVisible, setStatusVisible] = useState(false);

  useEffect(() => {
    async function loadConversations() {
      try {
        await connect();
        const { conversations: results } = await conversationRepo.list({ limit, source });
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

  // Show status toast with auto-dismiss
  const showStatus = useCallback((message: string, type: 'success' | 'error') => {
    setStatusMessage(message);
    setStatusType(type);
    setStatusVisible(true);
    setTimeout(() => setStatusVisible(false), 3000);
  }, []);

  // Get conversations to export
  const getConversationsToExport = useCallback((): Conversation[] => {
    if (multiSelectMode && selectedIds.size > 0) {
      return conversations.filter((c) => selectedIds.has(c.id));
    }
    const current = conversations[selectedIndex];
    return current ? [current] : [];
  }, [conversations, selectedIndex, multiSelectMode, selectedIds]);

  // Execute the selected export action
  const executeExportAction = useCallback(async () => {
    const toExport = getConversationsToExport();
    if (toExport.length === 0) return;

    try {
      if (exportActionIndex === 0) {
        // Export to file
        const outputDir = await exportConversationsToFile(toExport);
        showStatus(`Exported ${toExport.length} to ${outputDir}`, 'success');
        setExportMode('none');
        setExportActionIndex(0);
        setMultiSelectMode(false);
        setSelectedIds(new Set());
      } else if (exportActionIndex === 1) {
        // Copy to clipboard
        await exportConversationsToClipboard(toExport);
        showStatus(`Copied ${toExport.length} conversation(s)`, 'success');
        setExportMode('none');
        setExportActionIndex(0);
        setMultiSelectMode(false);
        setSelectedIds(new Set());
      }
    } catch (err) {
      showStatus(`Export failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
      setExportMode('none');
    }
  }, [getConversationsToExport, exportActionIndex, showStatus]);

  useInput((input, key) => {
    // Priority 1: Quit
    if (input === 'q') {
      exit();
      return;
    }

    // Priority 2: Export action menu
    if (exportMode === 'action-menu') {
      if (input === 'j' || key.downArrow) {
        setExportActionIndex((i) => Math.min(i + 1, 1)); // Only 2 options (0-1)
      } else if (input === 'k' || key.upArrow) {
        setExportActionIndex((i) => Math.max(i - 1, 0));
      } else if (key.return) {
        executeExportAction();
      } else if (key.escape) {
        setExportMode('none');
        setExportActionIndex(0);
      }
      return;
    }

    // Priority 4: Multi-select mode
    if (multiSelectMode) {
      if (input === ' ') {
        const current = conversations[selectedIndex];
        if (current) {
          setSelectedIds((prev) => {
            const next = new Set(prev);
            if (next.has(current.id)) {
              next.delete(current.id);
            } else {
              next.add(current.id);
            }
            return next;
          });
        }
        return;
      }
      if (input === 'e' && selectedIds.size > 0) {
        setExportMode('action-menu');
        return;
      }
      if (input === 'v' || key.escape) {
        setMultiSelectMode(false);
        setSelectedIds(new Set());
        return;
      }
      // Fall through to navigation
    }

    // Priority 5: Escape exits in normal mode
    if (key.escape) {
      exit();
      return;
    }

    if (conversations.length === 0) return;

    // Priority 6: Export trigger (single)
    if (input === 'e' && !multiSelectMode) {
      setExportMode('action-menu');
      return;
    }

    // Priority 7: Multi-select trigger
    if (input === 'v') {
      setMultiSelectMode(true);
      return;
    }

    // Priority 8: Navigation
    if (input === 'j' || key.downArrow) {
      setSelectedIndex((i) => Math.min(i + 1, conversations.length - 1));
    } else if (input === 'k' || key.upArrow) {
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (key.return && !multiSelectMode) {
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
                isChecked={selectedIds.has(conv.id)}
                multiSelectMode={multiSelectMode}
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
          {multiSelectMode ? (
            <Text color="gray">
              <Text bold color="white">space</Text> toggle · <Text bold color="white">e</Text> export{selectedIds.size > 0 ? ` (${selectedIds.size})` : ''} · <Text bold color="white">Esc</Text> cancel
            </Text>
          ) : (
            <Text color="gray">
              <Text bold color="white">e</Text> export · <Text bold color="white">v</Text> select · <Text bold color="white">j/k</Text> navigate · <Text bold color="white">Enter</Text> show · <Text bold color="white">q</Text> quit
            </Text>
          )}
          {conversations.length > visibleCount && (
            <Text color="gray">
              {scrollOffset + 1}-{Math.min(scrollOffset + visibleCount, conversations.length)} of {conversations.length}
            </Text>
          )}
        </Box>
      </Box>

      {/* Export action menu overlay */}
      {exportMode === 'action-menu' && (
        <ExportActionMenu
          selectedIndex={exportActionIndex}
          conversationCount={getConversationsToExport().length}
          width={width}
          height={height}
        />
      )}

      {/* Status toast */}
      {statusVisible && (
        <StatusToast
          message={statusMessage}
          type={statusType}
          width={width}
          height={height}
        />
      )}
    </Box>
  );
}

async function plainList(limit: number, source?: string): Promise<void> {
  await connect();
  const { conversations } = await conversationRepo.list({ limit, source });

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

// --- JSON Output for MCP/Agent Use ---

interface ListJsonOutput {
  conversations: Array<{
    id: string;
    title: string;
    project: string;
    source: string;
    date: string;
    message_count: number;
    estimated_tokens: number;
  }>;
  total: number;
}

async function printJsonList(options: {
  limit: number;
  offset: number;
  source?: string;
  project?: string;
  fromDate?: string;
  toDate?: string;
}): Promise<void> {
  await connect();
  const { conversations, total } = await conversationRepo.list({
    limit: options.limit,
    offset: options.offset,
    source: options.source,
    project: options.project,
    fromDate: options.fromDate,
    toDate: options.toDate,
  });

  const output: ListJsonOutput = {
    conversations: conversations.map((conv) => ({
      id: conv.id,
      title: conv.title,
      project: conv.workspacePath || conv.projectName || '',
      source: conv.source,
      date: conv.createdAt || conv.updatedAt || '',
      message_count: conv.messageCount,
      estimated_tokens:
        (conv.totalInputTokens || 0) +
        (conv.totalOutputTokens || 0) +
        (conv.totalCacheCreationTokens || 0) +
        (conv.totalCacheReadTokens || 0),
    })),
    total,
  };

  console.log(JSON.stringify(output, null, 2));
}

export async function listCommand(options: ListOptions): Promise<void> {
  const limit = parseInt(options.limit ?? '20', 10);
  const offset = parseInt(options.offset ?? '0', 10);

  if (options.json) {
    await printJsonList({
      limit,
      offset,
      source: options.source,
      project: options.project,
      fromDate: options.from,
      toDate: options.to,
    });
    return;
  }

  if (!process.stdin.isTTY) {
    await plainList(limit, options.source);
    return;
  }

  const app = withFullScreen(<ListApp limit={limit} source={options.source} />);
  await app.start();
  await app.waitUntilExit();
}
