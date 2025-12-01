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

import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import { withFullScreen, useScreenSize } from 'fullscreen-ink';
import { spawn } from 'child_process';
import { connect } from '../../db/index';
import { conversationRepo, search } from '../../db/repository';
// Note: sync runs in child process via runSyncInBackground to avoid blocking UI
import { getLanceDBPath } from '../../utils/config';

// Get count via child process to avoid blocking UI
function getCountInBackground(): Promise<number> {
  return new Promise((resolve) => {
    const dbPath = getLanceDBPath();
    const script = `
import * as lancedb from '@lancedb/lancedb';
try {
  const db = await lancedb.connect('${dbPath}');
  const tables = await db.tableNames();
  if (tables.includes('conversations')) {
    const table = await db.openTable('conversations');
    const count = await table.countRows();
    console.log(count);
  } else {
    console.log(0);
  }
} catch (e) {
  console.log(0);
}
process.exit(0);
`;

    let resolved = false;
    const child = spawn('bun', ['-e', script], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    // Don't let child process keep parent alive
    child.unref();

    let output = '';
    child.stdout?.on('data', (data: Buffer) => {
      output += data.toString();
    });

    child.on('close', () => {
      if (resolved) return;
      resolved = true;
      const count = parseInt(output.trim(), 10);
      resolve(isNaN(count) ? 0 : count);
    });

    child.on('error', () => {
      if (resolved) return;
      resolved = true;
      resolve(0);
    });

    // Timeout after 5 seconds
    setTimeout(() => {
      if (resolved) return;
      resolved = true;
      child.kill();
      resolve(0);
    }, 5000);
  });
}

// Run sync in child process to avoid blocking UI
// Returns: { newCount: number } on success, null on error
function runSyncInBackground(
  onComplete: (result: { newCount: number; diff: number } | null) => void
): void {
  // Get initial count first, then spawn sync
  getCountInBackground().then((initialCount) => {
    const child = spawn('bun', ['run', 'dev', 'sync'], {
      stdio: ['ignore', 'ignore', 'ignore'],
      detached: true,
    });

    // Don't let child process keep parent alive
    child.unref();

    child.on('close', (code) => {
      if (code === 0) {
        // Get new count after sync
        getCountInBackground().then((newCount) => {
          onComplete({ newCount, diff: Math.max(0, newCount - initialCount) });
        });
      } else {
        onComplete(null);
      }
    });

    child.on('error', () => {
      onComplete(null);
    });
  });
}
import { StatsContent } from './stats';
import {
  ResultRow,
  MatchesView,
  ConversationView,
  MessageDetailView,
  SelectionIndicator,
  SourceBadge,
  ExportActionMenu,
  StatusToast,
  type SyncStatus,
} from '../components/index';
import { useExport, useNavigation, type NavigationViewMode } from '../hooks/index';
import {
  formatRelativeTime,
  formatTokenPair,
  getLineCountParts,
} from '../../utils/format';
import type { Conversation, SearchResponse, ConversationResult } from '../../schema/index';

// ASCII art logo
const LOGO = `
     _
  __| | _____  __
 / _\` |/ _ \\ \\/ /
| (_| |  __/>  <
 \\__,_|\\___/_/\\_\\
`.trim();

// Unified view mode includes home and stats in addition to navigation modes
type UnifiedViewMode = 'home' | 'stats' | NavigationViewMode;

const ConversationListItem = React.memo(function ConversationListItem({
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
  const prefixWidth = 3;
  const timeWidth = timeStr.length + 2;
  const maxTitleWidth = Math.max(20, width - prefixWidth - timeWidth - 4);

  const title = conversation.title.length > maxTitleWidth
    ? conversation.title.slice(0, maxTitleWidth - 1) + '…'
    : conversation.title;

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
      <Box>
        <SelectionIndicator isSelected={isSelected} />
        <Text color={isSelected ? 'cyan' : 'white'} bold={isSelected}>
          {title}
        </Text>
        <Box flexGrow={1} />
        <Text color="gray">{timeStr}</Text>
      </Box>
      <Box marginLeft={3}>
        <SourceBadge source={conversation.source} />
        <Text color="gray"> · {msgCount} msgs</Text>
        {tokenStr && <Text color="gray"> · {tokenStr}</Text>}
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
});

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
  const boxWidth = Math.min(60, width - 4);
  const innerWidth = boxWidth - 4;

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
      <Box flexDirection="column" alignItems="center" marginBottom={2}>
        {logoLines.map((line, i) => (
          <Text key={i} color="cyan" bold>{line}</Text>
        ))}
        <Text color="gray">Search your coding conversations</Text>
      </Box>

      <Box flexDirection="column" alignItems="center" marginBottom={2}>
        <Box><Text color="gray">╭{'─'.repeat(boxWidth - 2)}╮</Text></Box>
        <Box>
          <Text color="gray">│ </Text>
          <Text color="white">{searchQuery || ' '}</Text>
          <Text color="cyan" inverse> </Text>
          <Text>{' '.repeat(Math.max(0, innerWidth - searchQuery.length - 1))}</Text>
          <Text color="gray"> │</Text>
        </Box>
        <Box><Text color="gray">╰{'─'.repeat(boxWidth - 2)}╯</Text></Box>
      </Box>

      <Box marginBottom={2}>{getSyncIndicator()}</Box>

      <Box flexDirection="column" alignItems="center">
        <Box>
          <Text color="gray">Type to search · </Text>
          <Text color="white" bold>Tab</Text>
          <Text color="gray"> recent · </Text>
          <Text color="white" bold>^s</Text>
          <Text color="gray"> stats · </Text>
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
  const [syncStatus, setSyncStatus] = useState<SyncStatus>({ phase: 'idle' });

  // High-level view mode (home, stats, or navigation modes)
  const [unifiedViewMode, setUnifiedViewMode] = useState<UnifiedViewMode>('home');

  // Layout calculations
  const headerHeight = 3;
  const footerHeight = 2;
  const rowHeight = 3;
  const availableHeight = height - headerHeight - footerHeight;
  const visibleCount = Math.max(1, Math.floor(availableHeight / rowHeight));

  // Convert data to display items
  const displayItems: ConversationResult[] = useMemo(() => {
    if (searchResults) {
      return searchResults.results;
    }
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

  // Determine if we're in a navigation view
  const isInNavigationView = unifiedViewMode !== 'home' && unifiedViewMode !== 'stats';

  // Navigation hook
  const { state: navState, actions: navActions, expandedResult, handleNavigationInput } = useNavigation({
    displayItems,
    availableHeight,
    width,
    hasSearchResults: !!searchResults,
    onExitList: () => {
      setUnifiedViewMode('home');
      setSearchQuery('');
      setSearchResults(null);
    },
  });

  // Sync navigation hook's view mode with unified view mode
  useEffect(() => {
    if (isInNavigationView) {
      // Keep unified view mode in sync with navigation state
      if (navState.viewMode !== unifiedViewMode) {
        setUnifiedViewMode(navState.viewMode);
      }
    }
  }, [navState.viewMode, isInNavigationView, unifiedViewMode]);

  // Get current conversation for export
  const getCurrentConversation = useCallback((): Conversation[] => {
    if (navState.viewMode === 'conversation' || navState.viewMode === 'message' || navState.viewMode === 'matches') {
      const conv = expandedResult?.conversation;
      return conv ? [conv] : [];
    }
    if (navState.viewMode === 'list') {
      const conv = displayItems[navState.selectedIndex]?.conversation;
      return conv ? [conv] : [];
    }
    return [];
  }, [navState.viewMode, expandedResult, displayItems, navState.selectedIndex]);

  // Export hook
  const {
    exportMode,
    exportActionIndex,
    statusMessage,
    statusType,
    statusVisible,
    openExportMenu,
    handleExportInput,
  } = useExport({ getConversations: getCurrentConversation });

  // Background sync - runs after DB connection
  const syncStartedRef = useRef(false);
  const initStartedRef = useRef(false);
  const dbReadyPromiseRef = useRef<Promise<void> | null>(null);

  const startBackgroundSync = useCallback(() => {
    if (syncStartedRef.current) return;
    syncStartedRef.current = true;

    setSyncStatus({ phase: 'syncing', message: 'Syncing...' });

    // Run sync in separate child process to avoid blocking UI
    runSyncInBackground((result) => {
      if (result) {
        setConversationCount(result.newCount);
        setSyncStatus({ phase: 'done', newConversations: result.diff });
      } else {
        setSyncStatus({ phase: 'error', message: 'Sync failed' });
      }
    });
  }, []);

  // Start DB connection immediately on mount (non-blocking)
  useEffect(() => {
    if (initStartedRef.current) return;
    initStartedRef.current = true;

    // Get count in background child process (fast, non-blocking)
    getCountInBackground().then((count) => {
      setConversationCount(count);
    });

    // Start DB connection immediately so it's ready when user navigates
    dbReadyPromiseRef.current = (async () => {
      await connect();
      setDbReady(true);
      const count = await conversationRepo.count();
      setConversationCount(count);
      startBackgroundSync();
    })();
  }, [startBackgroundSync]);

  // Wait for DB to be ready (returns immediately if already connected)
  const ensureDbReady = useCallback(async () => {
    if (dbReady) return;
    // Wait for the existing connection promise instead of starting a new one
    if (dbReadyPromiseRef.current) {
      await dbReadyPromiseRef.current;
    }
  }, [dbReady]);

  // Load conversations when entering list view (DB should already be ready from goToList)
  useEffect(() => {
    if (unifiedViewMode === 'list' && dbReady && conversations.length === 0 && !searchResults) {
      conversationRepo.list({ limit: 100 }).then(setConversations);
    }
  }, [unifiedViewMode, dbReady, conversations.length, searchResults]);

  // Execute search
  const executeSearch = useCallback(async (query: string) => {
    if (!query.trim()) return;
    try {
      await ensureDbReady();
      const results = await search(query, 50);
      setSearchResults(results);
      setUnifiedViewMode('list');
      navActions.setSelectedIndex(0);
      navActions.setViewMode('list');
    } catch {
      // Search failed - stay on home
    }
  }, [navActions, ensureDbReady]);

  // Go to list view
  const goToList = useCallback(async () => {
    await ensureDbReady();
    setUnifiedViewMode('list');
    navActions.setViewMode('list');
    navActions.setSelectedIndex(0);
  }, [navActions, ensureDbReady]);

  // Scroll offset for list view
  const scrollOffset = useMemo(() => {
    const maxOffset = Math.max(0, displayItems.length - visibleCount);
    if (navState.selectedIndex < visibleCount) return 0;
    return Math.min(navState.selectedIndex - visibleCount + 1, maxOffset);
  }, [navState.selectedIndex, visibleCount, displayItems.length]);

  const visibleItems = useMemo(() => {
    return displayItems.slice(scrollOffset, scrollOffset + visibleCount);
  }, [displayItems, scrollOffset, visibleCount]);

  // Show scroll indicator
  const totalItems = displayItems.length;
  const showingFrom = scrollOffset + 1;
  const showingTo = Math.min(scrollOffset + visibleCount, totalItems);
  const scrollIndicator = totalItems > visibleCount ? ` (${showingFrom}-${showingTo} of ${totalItems})` : '';

  // Get current query for display
  const activeQuery = searchResults ? searchQuery : '';

  useInput((input, key) => {
    // Handle export menu first
    if (handleExportInput(input, key)) {
      return;
    }

    // Quit from home/list (but not from deeper views)
    if (input === 'q' && (unifiedViewMode === 'home' || unifiedViewMode === 'list')) {
      exit();
      // Force exit after short delay to avoid hanging on open connections
      setTimeout(() => process.exit(0), 100);
      return;
    }

    // Home view input handling
    if (unifiedViewMode === 'home') {
      if (key.escape) {
        if (searchQuery) setSearchQuery('');
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
          goToList();
        }
        return;
      }
      if (key.backspace || key.delete) {
        setSearchQuery((q) => q.slice(0, -1));
        return;
      }
      if (input === 's' && key.ctrl) {
        setUnifiedViewMode('stats');
        return;
      }
      if (input && input.length === 1 && !key.ctrl && !key.meta) {
        setSearchQuery((q) => q + input);
        return;
      }
      return;
    }

    // Stats view - back to home
    if (unifiedViewMode === 'stats') {
      if (key.escape || input === 'q') {
        setUnifiedViewMode('home');
      }
      return;
    }

    // Export trigger - works in ALL navigation views
    if (input === 'e' && isInNavigationView) {
      openExportMenu();
      return;
    }

    // Navigation views - use shared hook
    if (isInNavigationView) {
      // Handle back from list specially to go to home
      if ((key.escape || key.backspace || key.delete) && navState.viewMode === 'list') {
        setUnifiedViewMode('home');
        setSearchQuery('');
        setSearchResults(null);
        navActions.resetNavigation();
        return;
      }

      if (handleNavigationInput(input, key)) {
        // Update unified view mode to match navigation state
        setUnifiedViewMode(navState.viewMode);
        return;
      }
    }
  });

  // Home screen
  if (unifiedViewMode === 'home') {
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

  // Stats dashboard
  if (unifiedViewMode === 'stats') {
    return (
      <StatsContent
        width={width}
        height={height}
        period={30}
        onBack={() => setUnifiedViewMode('home')}
      />
    );
  }

  return (
    <Box width={width} height={height} flexDirection="column">
      {/* Header */}
      <Box flexDirection="column" marginBottom={1}>
        <Box paddingX={1}>
          <Text bold color="cyan">dex</Text>
          {searchResults ? (
            <>
              <Text color="gray"> / </Text>
              <Text color="white">{searchQuery}</Text>
              <Text color="gray"> — {searchResults.totalConversations} results{scrollIndicator}</Text>
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
              {searchResults ? 'No results found.' : 'No conversations yet.'}
            </Text>
            {!searchResults && (
              <Text color="gray">Run `dex sync` to index your conversations.</Text>
            )}
          </Box>
        ) : navState.viewMode === 'message' && navState.combinedMessages[navState.selectedMessageIndex] ? (
          <MessageDetailView
            message={navState.combinedMessages[navState.selectedMessageIndex]!}
            messageFiles={navState.conversationMessageFiles}
            toolCalls={navState.conversationToolCalls}
            fileEdits={navState.conversationFileEdits}
            width={width - 2}
            height={availableHeight}
            scrollOffset={navState.messageScrollOffset}
            query={activeQuery}
          />
        ) : navState.viewMode === 'conversation' && expandedResult ? (
          <ConversationView
            conversation={expandedResult.conversation}
            messages={navState.combinedMessages}
            files={navState.conversationFiles}
            messageFiles={navState.conversationMessageFiles}
            width={width - 2}
            height={availableHeight}
            scrollOffset={navState.conversationScrollOffset}
            highlightMessageIndex={navState.highlightMessageIndex}
            selectedIndex={navState.selectedMessageIndex}
          />
        ) : navState.viewMode === 'matches' && expandedResult ? (
          <MatchesView
            result={expandedResult}
            files={navState.conversationFiles}
            messageFiles={navState.conversationMessageFiles}
            width={width - 2}
            height={availableHeight}
            scrollOffset={navState.expandedScrollOffset}
            selectedMatchIndex={navState.expandedSelectedMatch}
            query={activeQuery}
            indexMap={navState.messageIndexMap}
            combinedMessageCount={navState.combinedMessages.length}
          />
        ) : searchResults ? (
          // Search results view
          visibleItems.map((item, idx) => {
            const actualIndex = scrollOffset + idx;
            if (!item?.conversation) return null;
            return (
              <ResultRow
                key={item.conversation.id}
                result={item}
                isSelected={actualIndex === navState.selectedIndex}
                width={width - 2}
                query={activeQuery}
              />
            );
          })
        ) : (
          // Recent conversations list
          visibleItems.map((item, idx) => {
            const actualIndex = scrollOffset + idx;
            if (!item?.conversation) return null;
            const isLast = idx === visibleItems.length - 1;
            return (
              <Box key={item.conversation.id} flexDirection="column">
                <ConversationListItem
                  conversation={item.conversation}
                  isSelected={actualIndex === navState.selectedIndex}
                  width={width - 2}
                />
                {!isLast && <Box height={1} />}
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
            {navState.viewMode === 'list' ? (
              <>
                <Text color="white" bold>e</Text>
                <Text color="gray"> export · </Text>
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
            ) : navState.viewMode === 'conversation' ? (
              <>
                <Text color="white" bold>e</Text>
                <Text color="gray"> export · </Text>
                <Text color="white" bold>j</Text>
                <Text color="gray">/</Text>
                <Text color="white" bold>k</Text>
                <Text color="gray"> nav · </Text>
                <Text color="white" bold>Enter</Text>
                <Text color="gray"> full msg · </Text>
                <Text color="white" bold>Esc</Text>
                <Text color="gray"> back</Text>
              </>
            ) : navState.viewMode === 'message' ? (
              <>
                <Text color="white" bold>e</Text>
                <Text color="gray"> export · </Text>
                <Text color="white" bold>j</Text>
                <Text color="gray">/</Text>
                <Text color="white" bold>k</Text>
                <Text color="gray"> scroll · </Text>
                <Text color="white" bold>n</Text>
                <Text color="gray">/</Text>
                <Text color="white" bold>p</Text>
                <Text color="gray"> nav · </Text>
                <Text color="white" bold>Esc</Text>
                <Text color="gray"> back</Text>
              </>
            ) : navState.viewMode === 'matches' ? (
              <>
                <Text color="white" bold>e</Text>
                <Text color="gray"> export · </Text>
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

      {/* Export action menu overlay */}
      {exportMode === 'action-menu' && (
        <ExportActionMenu
          selectedIndex={exportActionIndex}
          conversationCount={1}
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
