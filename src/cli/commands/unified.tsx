/**
 * Unified command - default entry point when running `dex` with no arguments
 *
 * Home screen with logo, search input, and keyboard shortcuts.
 * Press Tab to see recent conversations, type to search.
 *
 * Navigation:
 * - Type to search, Enter to execute
 * - Tab to toggle recent conversations
 * - Enter with empty query shows recent
 * - Escape to go back
 * - q to quit
 */

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import { withFullScreen, useScreenSize } from 'fullscreen-ink';
import { connect } from '../../db/index';
import { conversationRepo, search, messageRepo, filesRepo, messageFilesRepo } from '../../db/repository';
import { runSync, type SyncProgress } from './sync';
import {
  ResultRow,
  MatchesView,
  ConversationView,
  MessageDetailView,
  SelectionIndicator,
  SourceBadge,
  type SyncStatus,
} from '../components/index';
import {
  formatRelativeTime,
  truncatePath,
  formatTokenPair,
  getLineCountParts,
  combineConsecutiveMessages,
  type CombinedMessage,
} from '../../utils/format';
import type { Conversation, ConversationFile, MessageFile, SearchResponse, ConversationResult } from '../../schema/index';

// ASCII art logo
const LOGO = `
     _
  __| | _____  __
 / _\` |/ _ \\ \\/ /
| (_| |  __/>  <
 \\__,_|\\___/_/\\_\\
`.trim();

type ViewMode = 'home' | 'list' | 'search' | 'matches' | 'conversation' | 'message';

function ConversationListItem({
  conversation,
  isSelected,
  width,
}: {
  conversation: Conversation;
  isSelected: boolean;
  width: number;
}) {
  const timeStr = formatRelativeTime(conversation.updatedAt);
  const msgCount = conversation.messageCount;

  // Calculate available width for title
  // Format: [sel] Title                              time
  const prefixWidth = 3; // "▸ " or "  "
  const timeWidth = timeStr.length + 2;
  const maxTitleWidth = Math.max(20, width - prefixWidth - timeWidth - 4);

  const title = conversation.title.length > maxTitleWidth
    ? conversation.title.slice(0, maxTitleWidth - 1) + '…'
    : conversation.title;

  // Secondary info: source badge + message count + optional stats
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

  return (
    <Box flexDirection="column">
      {/* Row 1: Selection + Title + Time (right-aligned feel) */}
      <Box>
        <SelectionIndicator isSelected={isSelected} />
        <Text color={isSelected ? 'cyan' : 'white'} bold={isSelected}>
          {title}
        </Text>
        <Box flexGrow={1} />
        <Text color="gray">{timeStr}</Text>
      </Box>
      {/* Row 2: Source badge + message count + stats */}
      <Box marginLeft={3}>
        <SourceBadge source={conversation.source} />
        <Text color="gray"> · {msgCount} msgs</Text>
        {tokenStr && (
          <Text color="gray"> · {tokenStr}</Text>
        )}
        {lineParts && (
          <>
            <Text color="gray"> · </Text>
            <Text color="green">{lineParts.added}</Text>
            <Text color="gray">/</Text>
            <Text color="red">{lineParts.removed}</Text>
          </>
        )}
      </Box>
    </Box>
  );
}

function HomeScreen({
  width,
  height,
  searchQuery,
  syncStatus,
  conversationCount,
}: {
  width: number;
  height: number;
  searchQuery: string;
  syncStatus: SyncStatus;
  conversationCount: number;
}) {
  const logoLines = LOGO.split('\n');

  // Search box
  const boxWidth = Math.min(60, width - 4);
  const innerWidth = boxWidth - 4;

  // Sync status indicator
  const getSyncIndicator = () => {
    switch (syncStatus.phase) {
      case 'syncing':
        return <Text color="cyan">⟳ Syncing...</Text>;
      case 'done':
        return syncStatus.newConversations && syncStatus.newConversations > 0
          ? <Text color="green">✓ {syncStatus.newConversations} new</Text>
          : <Text color="green">✓ Synced</Text>;
      case 'error':
        return <Text color="red">✗ {syncStatus.message}</Text>;
      default:
        return <Text color="gray">{conversationCount} conversations</Text>;
    }
  };

  return (
    <Box
      width={width}
      height={height}
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
    >
      {/* Logo */}
      <Box flexDirection="column" alignItems="center" marginBottom={2}>
        {logoLines.map((line, i) => (
          <Text key={i} color="cyan" bold>{line}</Text>
        ))}
        <Text color="gray">Search your coding conversations</Text>
      </Box>

      {/* Search box */}
      <Box flexDirection="column" alignItems="center" marginBottom={2}>
        <Box>
          <Text color="gray">╭{'─'.repeat(boxWidth - 2)}╮</Text>
        </Box>
        <Box>
          <Text color="gray">│ </Text>
          <Text color="white">{searchQuery || ' '}</Text>
          <Text color="cyan" inverse> </Text>
          <Text>{' '.repeat(Math.max(0, innerWidth - searchQuery.length - 1))}</Text>
          <Text color="gray"> │</Text>
        </Box>
        <Box>
          <Text color="gray">╰{'─'.repeat(boxWidth - 2)}╯</Text>
        </Box>
      </Box>

      {/* Status */}
      <Box marginBottom={2}>
        {getSyncIndicator()}
      </Box>

      {/* Keyboard hints */}
      <Box flexDirection="column" alignItems="center">
        <Box>
          <Text color="gray">Type to search · </Text>
          <Text color="white" bold>Tab</Text>
          <Text color="gray"> recent · </Text>
          <Text color="white" bold>Enter</Text>
          <Text color="gray"> go · </Text>
          <Text color="white" bold>q</Text>
          <Text color="gray"> quit</Text>
        </Box>
      </Box>
    </Box>
  );
}

function UnifiedApp() {
  const { exit } = useApp();
  const { width, height } = useScreenSize();

  // Data state
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [searchResults, setSearchResults] = useState<SearchResponse | null>(null);
  const [dbReady, setDbReady] = useState(false);
  const [conversationCount, setConversationCount] = useState(0);

  // Input state
  const [searchQuery, setSearchQuery] = useState('');

  // Sync state
  const [syncStatus, setSyncStatus] = useState<SyncStatus>({
    phase: 'idle',
  });

  // Navigation state
  const [viewMode, setViewMode] = useState<ViewMode>('home');
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Matches view state
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);
  const [expandedScrollOffset, setExpandedScrollOffset] = useState(0);
  const [expandedSelectedMatch, setExpandedSelectedMatch] = useState(0);

  // Conversation view state
  const [combinedMessages, setCombinedMessages] = useState<CombinedMessage[]>([]);
  const [messageIndexMap, setMessageIndexMap] = useState<Map<number, number>>(new Map());
  const [conversationFiles, setConversationFiles] = useState<ConversationFile[]>([]);
  const [conversationMessageFiles, setConversationMessageFiles] = useState<MessageFile[]>([]);
  const [conversationScrollOffset, setConversationScrollOffset] = useState(0);
  const [highlightMessageIndex, setHighlightMessageIndex] = useState<number | undefined>(undefined);
  const [selectedMessageIndex, setSelectedMessageIndex] = useState(0);

  // Message detail view state
  const [messageScrollOffset, setMessageScrollOffset] = useState(0);

  // Initialize database and run background sync
  useEffect(() => {
    let cancelled = false;

    const init = async () => {
      await connect();
      if (cancelled) return;
      setDbReady(true);

      // Get initial count (fast)
      const initial = await conversationRepo.list({ limit: 1 });
      const count = initial.length > 0 ? await conversationRepo.count() : 0;
      if (!cancelled) {
        setConversationCount(count);
      }

      // Run background sync
      setSyncStatus({ phase: 'syncing', message: 'Syncing...' });
      try {
        let initialCount = count;
        await runSync({ force: false }, (progress: SyncProgress) => {
          if (cancelled) return;
          if (progress.phase === 'done') {
            conversationRepo.count().then((newCount) => {
              if (!cancelled) {
                const diff = Math.max(0, newCount - initialCount);
                setConversationCount(newCount);
                setSyncStatus({
                  phase: 'done',
                  newConversations: diff,
                });
              }
            });
          } else if (progress.phase === 'error') {
            if (!cancelled) {
              setSyncStatus({
                phase: 'error',
                message: progress.error || 'Sync failed',
              });
            }
          }
        });
      } catch (err) {
        if (!cancelled) {
          setSyncStatus({
            phase: 'error',
            message: err instanceof Error ? err.message : 'Sync failed',
          });
        }
      }
    };

    init();

    return () => {
      cancelled = true;
    };
  }, []);

  // Load conversations when entering list view
  useEffect(() => {
    if (viewMode === 'list' && dbReady && conversations.length === 0) {
      conversationRepo.list({ limit: 100 }).then(setConversations);
    }
  }, [viewMode, dbReady, conversations.length]);

  // Execute search
  const executeSearch = useCallback(async (query: string) => {
    if (!query.trim()) return;

    try {
      const results = await search(query, 50);
      setSearchResults(results);
      setViewMode('search');
      setSelectedIndex(0);
    } catch (err) {
      // Search failed - stay on home
    }
  }, []);

  // Load files and messages when expanding a conversation
  useEffect(() => {
    if (expandedIndex !== null) {
      let conv: Conversation | undefined;

      // Check search results first
      if (searchResults && searchResults.results[expandedIndex]) {
        conv = searchResults.results[expandedIndex]?.conversation;
      } else if (conversations[expandedIndex]) {
        // Fall back to conversations list
        conv = conversations[expandedIndex];
      }

      if (conv) {
        filesRepo.findByConversation(conv.id).then(setConversationFiles);
        messageFilesRepo.findByConversation(conv.id).then(setConversationMessageFiles);
        messageRepo.findByConversation(conv.id).then((msgs) => {
          const { messages: combined, indexMap } = combineConsecutiveMessages(msgs);
          setCombinedMessages(combined);
          setMessageIndexMap(indexMap);
        });
      }
    } else {
      setConversationFiles([]);
      setConversationMessageFiles([]);
      setCombinedMessages([]);
      setMessageIndexMap(new Map());
    }
  }, [expandedIndex, searchResults, conversations]);

  // Display items for list/search views
  // Note: We compute this independently of viewMode so that expandedResult
  // remains valid when transitioning from list/search to conversation view
  const displayItems = useMemo((): ConversationResult[] => {
    // If we have search results, use those
    if (searchResults) {
      return searchResults.results;
    }
    // Otherwise, use the conversations list (for recent/list view)
    if (conversations.length > 0) {
      return conversations.map((conv) => ({
        conversation: conv,
        matches: [],
        bestMatch: {
          messageId: '',
          conversationId: conv.id,
          role: 'user' as const,
          content: '',
          snippet: '',
          highlightRanges: [] as [number, number][],
          score: 0,
          messageIndex: 0,
        },
        totalMatches: 0,
      }));
    }
    return [];
  }, [searchResults, conversations]);

  const expandedResult = expandedIndex !== null ? displayItems[expandedIndex] : null;

  // Layout calculations - each row is 2 lines content + 1 line separator = 3 lines
  const headerHeight = 3;
  const footerHeight = 2;
  const rowHeight = 3; // 2 lines content + 1 line separator
  const availableHeight = height - headerHeight - footerHeight;
  const visibleCount = Math.max(1, Math.floor(availableHeight / rowHeight));

  const scrollOffset = useMemo(() => {
    const maxOffset = Math.max(0, displayItems.length - visibleCount);
    if (selectedIndex < visibleCount) return 0;
    return Math.min(selectedIndex - visibleCount + 1, maxOffset);
  }, [selectedIndex, visibleCount, displayItems.length]);

  const visibleItems = useMemo(() => {
    return displayItems.slice(scrollOffset, scrollOffset + visibleCount);
  }, [displayItems, scrollOffset, visibleCount]);

  // Map a match to its combined message index
  const getCombinedIndexForMatch = (match: { messageIndex: number } | undefined): number | null => {
    if (!match) return null;
    return messageIndexMap.get(match.messageIndex) ?? match.messageIndex;
  };

  // Find the next/previous distinct match
  const findNextDistinctMatch = (startIdx: number, direction: 1 | -1): number => {
    if (!expandedResult) return startIdx;
    const matches = expandedResult.matches;
    const currentCombined = getCombinedIndexForMatch(matches[startIdx]);

    let i = startIdx + direction;
    while (i >= 0 && i < matches.length) {
      const combinedIdx = getCombinedIndexForMatch(matches[i]);
      if (combinedIdx !== currentCombined) {
        return i;
      }
      i += direction;
    }

    return startIdx;
  };

  // Load conversation for full view
  const loadConversation = async (conversationId: string, targetMessageIndex?: number) => {
    const msgs = await messageRepo.findByConversation(conversationId);
    const { messages: combined, indexMap } = combineConsecutiveMessages(msgs);
    setCombinedMessages(combined);
    setMessageIndexMap(indexMap);

    const headerH = 5 + (conversationFiles.length > 0 ? 1 : 0);
    const messagesPerPage = Math.max(1, Math.floor((availableHeight - headerH) / 3));

    if (targetMessageIndex !== undefined) {
      const combinedIdx = indexMap.get(targetMessageIndex) ?? 0;
      const targetScroll = Math.max(0, combinedIdx - Math.floor(messagesPerPage / 2));
      const maxScrollOffset = Math.max(0, combined.length - messagesPerPage);
      setConversationScrollOffset(Math.min(targetScroll, maxScrollOffset));
      setHighlightMessageIndex(combinedIdx);
      setSelectedMessageIndex(combinedIdx);
    } else {
      setConversationScrollOffset(0);
      setHighlightMessageIndex(undefined);
      setSelectedMessageIndex(0);
    }
  };

  // Go to list view
  const goToList = useCallback(() => {
    setViewMode('list');
    setSelectedIndex(0);
  }, []);

  useInput((input, key) => {
    // Quit from home/list/search
    if (input === 'q' && (viewMode === 'home' || viewMode === 'list' || viewMode === 'search')) {
      exit();
      return;
    }

    // Home view input handling
    if (viewMode === 'home') {
      if (key.escape) {
        if (searchQuery) {
          setSearchQuery('');
        }
        return;
      }
      if (key.tab) {
        goToList();
        return;
      }
      if (key.return) {
        if (searchQuery.trim()) {
          executeSearch(searchQuery);
        } else {
          // Empty enter = show recent
          goToList();
        }
        return;
      }
      if (key.backspace || key.delete) {
        setSearchQuery((q) => q.slice(0, -1));
        return;
      }
      // Type to search (any character, including 'r')
      if (input && input.length === 1 && !key.ctrl && !key.meta) {
        setSearchQuery((q) => q + input);
        return;
      }
      return;
    }

    // Back to home from list/search
    if ((viewMode === 'list' || viewMode === 'search') && key.escape) {
      setViewMode('home');
      setSearchQuery('');
      setSearchResults(null);
      setSelectedIndex(0);
      return;
    }

    // Message detail view navigation
    // j/k navigate between messages, arrow keys scroll within message
    if (viewMode === 'message' && combinedMessages.length > 0) {
      const currentMessage = combinedMessages[selectedMessageIndex];
      if (key.escape || key.backspace || key.delete) {
        setViewMode('conversation');
        setMessageScrollOffset(0);
      } else if (input === 'j') {
        // j = next message
        if (selectedMessageIndex < combinedMessages.length - 1) {
          setSelectedMessageIndex((i) => i + 1);
          setMessageScrollOffset(0);
        }
      } else if (input === 'k') {
        // k = previous message
        if (selectedMessageIndex > 0) {
          setSelectedMessageIndex((i) => i - 1);
          setMessageScrollOffset(0);
        }
      } else if (key.downArrow) {
        // Down arrow = scroll within message
        const lines = currentMessage?.content.split('\n') || [];
        const maxOffset = Math.max(0, lines.length - (height - 5));
        setMessageScrollOffset((o) => Math.min(o + 1, maxOffset));
      } else if (key.upArrow) {
        // Up arrow = scroll within message
        setMessageScrollOffset((o) => Math.max(o - 1, 0));
      } else if (input === 'g') {
        setMessageScrollOffset(0);
      } else if (input === 'G') {
        const lines = currentMessage?.content.split('\n') || [];
        setMessageScrollOffset(Math.max(0, lines.length - (height - 5)));
      }
      return;
    }

    // Conversation view navigation
    if (viewMode === 'conversation' && expandedResult) {
      const headerH = 5 + (conversationFiles.length > 0 ? 1 : 0);
      const messagesPerPage = Math.max(1, Math.floor((availableHeight - headerH) / 3));
      const maxScrollOffset = Math.max(0, combinedMessages.length - messagesPerPage);

      if (key.escape || key.backspace || key.delete) {
        if (searchResults && expandedResult.matches.length > 0) {
          setViewMode('matches');
        } else {
          setViewMode(searchResults ? 'search' : 'list');
          setExpandedIndex(null);
        }
        setCombinedMessages([]);
        setMessageIndexMap(new Map());
        setHighlightMessageIndex(undefined);
        setSelectedMessageIndex(0);
      } else if (input === 'j' || key.downArrow) {
        const newIdx = Math.min(selectedMessageIndex + 1, combinedMessages.length - 1);
        setSelectedMessageIndex(newIdx);
        if (newIdx >= conversationScrollOffset + messagesPerPage) {
          setConversationScrollOffset(Math.min(newIdx - messagesPerPage + 1, maxScrollOffset));
        }
      } else if (input === 'k' || key.upArrow) {
        const newIdx = Math.max(selectedMessageIndex - 1, 0);
        setSelectedMessageIndex(newIdx);
        if (newIdx < conversationScrollOffset) {
          setConversationScrollOffset(newIdx);
        }
      } else if (input === 'g') {
        setConversationScrollOffset(0);
        setSelectedMessageIndex(0);
      } else if (input === 'G') {
        setConversationScrollOffset(maxScrollOffset);
        setSelectedMessageIndex(combinedMessages.length - 1);
      } else if (key.return) {
        setViewMode('message');
        setMessageScrollOffset(0);
      }
      return;
    }

    // Matches view navigation
    if (viewMode === 'matches' && expandedResult) {
      if (key.escape || key.backspace || key.delete) {
        setViewMode('search');
        setExpandedIndex(null);
        setExpandedScrollOffset(0);
        setExpandedSelectedMatch(0);
      } else if (input === 'j' || key.downArrow) {
        const maxIdx = expandedResult.matches.length - 1;
        setExpandedSelectedMatch((i) => {
          const newIdx = Math.min(findNextDistinctMatch(i, 1), maxIdx);
          const matchesPerPage = Math.max(1, Math.floor((height - 8) / 4));
          const maxOffset = Math.max(0, expandedResult.matches.length - matchesPerPage);
          let offset = expandedScrollOffset;
          if (newIdx >= offset + matchesPerPage) {
            offset = newIdx - matchesPerPage + 1;
          }
          setExpandedScrollOffset(Math.min(Math.max(offset, 0), maxOffset));
          return newIdx;
        });
      } else if (input === 'k' || key.upArrow) {
        setExpandedSelectedMatch((i) => {
          const newIdx = Math.max(findNextDistinctMatch(i, -1), 0);
          const matchesPerPage = Math.max(1, Math.floor((height - 8) / 4));
          let offset = expandedScrollOffset;
          if (newIdx < offset) {
            offset = newIdx;
          }
          setExpandedScrollOffset(Math.max(offset, 0));
          return newIdx;
        });
      } else if (key.return) {
        const selectedMatch = expandedResult.matches[expandedSelectedMatch];
        if (selectedMatch) {
          setViewMode('conversation');
          loadConversation(expandedResult.conversation.id, selectedMatch.messageIndex);
        }
      }
      return;
    }

    // List/Search view navigation
    if (viewMode === 'list' || viewMode === 'search') {
      if (displayItems.length === 0) return;

      if (input === 'j' || key.downArrow) {
        setSelectedIndex((i) => Math.min(i + 1, displayItems.length - 1));
      } else if (input === 'k' || key.upArrow) {
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (key.return) {
        const item = displayItems[selectedIndex];
        if (item) {
          if (viewMode === 'search' && item.matches.length > 0) {
            // Search result with matches - show matches view
            setViewMode('matches');
            setExpandedIndex(selectedIndex);
            setExpandedScrollOffset(0);
            setExpandedSelectedMatch(0);
          } else {
            // List item or search result without matches - go directly to conversation
            setViewMode('conversation');
            setExpandedIndex(selectedIndex);
            loadConversation(item.conversation.id);
          }
        }
      }
    }
  });

  // Home screen
  if (viewMode === 'home') {
    return (
      <HomeScreen
        width={width}
        height={height}
        searchQuery={searchQuery}
        syncStatus={syncStatus}
        conversationCount={conversationCount}
      />
    );
  }

  // Get current query for display
  const activeQuery = viewMode === 'search' && searchResults ? searchQuery : '';

  // Show scroll indicator
  const totalItems = displayItems.length;
  const showingFrom = scrollOffset + 1;
  const showingTo = Math.min(scrollOffset + visibleCount, totalItems);
  const scrollIndicator = totalItems > visibleCount ? ` (${showingFrom}-${showingTo} of ${totalItems})` : '';

  return (
    <Box width={width} height={height} flexDirection="column">
      {/* Header */}
      <Box flexDirection="column" marginBottom={1}>
        <Box paddingX={1}>
          <Text bold color="cyan">dex</Text>
          {viewMode === 'search' ? (
            <>
              <Text color="gray"> / </Text>
              <Text color="white">{searchQuery}</Text>
              <Text color="gray"> — {searchResults?.totalConversations ?? 0} results{scrollIndicator}</Text>
            </>
          ) : (
            <>
              <Text color="gray"> — Recent conversations</Text>
              <Text color="gray">{scrollIndicator}</Text>
            </>
          )}
        </Box>
        <Box paddingX={1}>
          <Text color="gray">{'─'.repeat(Math.max(0, width - 2))}</Text>
        </Box>
      </Box>

      {/* Content */}
      <Box flexDirection="column" flexGrow={1} paddingX={1}>
        {displayItems.length === 0 ? (
          <Box flexDirection="column" alignItems="center" justifyContent="center" height={availableHeight}>
            <Text color="gray">
              {viewMode === 'search' ? 'No results found.' : 'No conversations yet.'}
            </Text>
            {viewMode === 'list' && (
              <Text color="gray">Run `dex sync` to index your conversations.</Text>
            )}
          </Box>
        ) : viewMode === 'message' && combinedMessages[selectedMessageIndex] ? (
          <MessageDetailView
            message={combinedMessages[selectedMessageIndex]!}
            messageFiles={conversationMessageFiles}
            width={width - 2}
            height={availableHeight}
            scrollOffset={messageScrollOffset}
            query={activeQuery}
          />
        ) : viewMode === 'conversation' && expandedResult ? (
          <ConversationView
            conversation={expandedResult.conversation}
            messages={combinedMessages}
            files={conversationFiles}
            messageFiles={conversationMessageFiles}
            width={width - 2}
            height={availableHeight}
            scrollOffset={conversationScrollOffset}
            highlightMessageIndex={highlightMessageIndex}
            selectedIndex={selectedMessageIndex}
          />
        ) : viewMode === 'matches' && expandedResult ? (
          <MatchesView
            result={expandedResult}
            files={conversationFiles}
            messageFiles={conversationMessageFiles}
            width={width - 2}
            height={availableHeight}
            scrollOffset={expandedScrollOffset}
            selectedMatchIndex={expandedSelectedMatch}
            query={activeQuery}
            indexMap={messageIndexMap}
            combinedMessageCount={combinedMessages.length}
          />
        ) : viewMode === 'search' ? (
          // Search results view
          visibleItems.map((item, idx) => {
            const actualIndex = scrollOffset + idx;
            if (!item?.conversation) return null;
            return (
              <ResultRow
                key={item.conversation.id}
                result={item}
                isSelected={actualIndex === selectedIndex}
                width={width - 2}
                query={activeQuery}
              />
            );
          })
        ) : (
          // List view - using new consistent component with separators
          visibleItems.map((item, idx) => {
            const actualIndex = scrollOffset + idx;
            if (!item?.conversation) return null;
            const isLast = idx === visibleItems.length - 1;
            return (
              <Box key={item.conversation.id} flexDirection="column">
                <ConversationListItem
                  conversation={item.conversation}
                  isSelected={actualIndex === selectedIndex}
                  width={width - 2}
                />
                {!isLast && (
                  <Box height={1} />
                )}
              </Box>
            );
          })
        )}
      </Box>

      {/* Footer */}
      <Box flexDirection="column">
        <Box paddingX={1}>
          <Text color="gray">{'─'.repeat(Math.max(0, width - 2))}</Text>
        </Box>
        <Box paddingX={1}>
          <Text color="gray">
            {viewMode === 'list' || viewMode === 'search' ? (
              <>
                <Text color="white" bold>j</Text>
                <Text color="gray">/</Text>
                <Text color="white" bold>k</Text>
                <Text color="gray"> nav · </Text>
                <Text color="white" bold>Enter</Text>
                <Text color="gray"> select · </Text>
                <Text color="white" bold>Esc</Text>
                <Text color="gray"> home · </Text>
                <Text color="white" bold>q</Text>
                <Text color="gray"> quit</Text>
              </>
            ) : viewMode === 'conversation' ? (
              <>
                <Text color="white" bold>j</Text>
                <Text color="gray">/</Text>
                <Text color="white" bold>k</Text>
                <Text color="gray"> nav · </Text>
                <Text color="white" bold>Enter</Text>
                <Text color="gray"> full msg · </Text>
                <Text color="white" bold>Esc</Text>
                <Text color="gray"> back</Text>
              </>
            ) : viewMode === 'message' ? (
              <>
                <Text color="white" bold>j</Text>
                <Text color="gray">/</Text>
                <Text color="white" bold>k</Text>
                <Text color="gray"> nav · </Text>
                <Text color="white" bold>↑</Text>
                <Text color="gray">/</Text>
                <Text color="white" bold>↓</Text>
                <Text color="gray"> scroll · </Text>
                <Text color="white" bold>Esc</Text>
                <Text color="gray"> back</Text>
              </>
            ) : viewMode === 'matches' ? (
              <>
                <Text color="white" bold>j</Text>
                <Text color="gray">/</Text>
                <Text color="white" bold>k</Text>
                <Text color="gray"> nav · </Text>
                <Text color="white" bold>Enter</Text>
                <Text color="gray"> view · </Text>
                <Text color="white" bold>Esc</Text>
                <Text color="gray"> back</Text>
              </>
            ) : null}
          </Text>
        </Box>
      </Box>
    </Box>
  );
}

export async function unifiedCommand(): Promise<void> {
  if (!process.stdin.isTTY) {
    console.log('Run `dex` in a terminal for interactive mode.');
    console.log('Use `dex list` or `dex search <query>` for non-interactive use.');
    return;
  }

  const app = withFullScreen(<UnifiedApp />);
  await app.start();
  await app.waitUntilExit();
}
