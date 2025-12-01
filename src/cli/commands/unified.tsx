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
import { spawn, spawnSync } from 'child_process';
import { connect, getMessagesTable } from '../../db/index';
import { conversationRepo, search, searchByFilePath, getFileMatchesForConversations } from '../../db/repository';
// Note: sync runs in child process via runSyncInBackground to avoid blocking UI
import { getLanceDBPath } from '../../utils/config';

// Helper to spawn dex subcommands - works with both dev (bun) and installed (node) versions
function spawnDexCommand(command: string, args: string[] = [], options: Parameters<typeof spawn>[2] = {}) {
  // Use the same runtime that's running this process
  return spawn(process.execPath, [process.argv[1]!, command, ...args], options);
}

// Helper to get the runtime for inline scripts (bun or node)
const isBun = process.versions.bun !== undefined;
const runtimeCmd = isBun ? 'bun' : 'node';

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
    const child = spawn(runtimeCmd, ['-e', script], {
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
    const child = spawnDexCommand('sync', [], {
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

// Get message count via child process (fast check for first load detection)
function getMessageCountInBackground(): Promise<number> {
  return new Promise((resolve) => {
    const dbPath = getLanceDBPath();
    const script = `
import * as lancedb from '@lancedb/lancedb';
try {
  const db = await lancedb.connect('${dbPath}');
  const tables = await db.tableNames();
  if (tables.includes('messages')) {
    const table = await db.openTable('messages');
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
    const child = spawn(runtimeCmd, ['-e', script], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });

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

    // Timeout after 3 seconds
    setTimeout(() => {
      if (resolved) return;
      resolved = true;
      child.kill();
      resolve(0);
    }, 3000);
  });
}

// Sync progress state (matches sync.tsx SyncProgress)
interface FirstLoadSyncProgress {
  phase: 'detecting' | 'discovering' | 'extracting' | 'syncing' | 'indexing' | 'enriching' | 'done' | 'error';
  currentSource?: string;
  projectsFound: number;
  projectsProcessed: number;
  conversationsFound: number;
  conversationsIndexed: number;
  messagesIndexed: number;
  embeddingStarted?: boolean;
  extractionProgress?: { current: number; total: number };
}

// Run sync synchronously (blocking) - used only for first load
function runSyncBlocking(
  onProgress: (progress: FirstLoadSyncProgress) => void
): Promise<{ newCount: number } | null> {
  return new Promise((resolve) => {
    const progress: FirstLoadSyncProgress = {
      phase: 'detecting',
      projectsFound: 0,
      projectsProcessed: 0,
      conversationsFound: 0,
      conversationsIndexed: 0,
      messagesIndexed: 0,
    };
    onProgress(progress);

    const child = spawnDexCommand('sync', [], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout?.on('data', (data: Buffer) => {
      const text = data.toString();

      // Parse progress from sync output (ANSI codes stripped)
      // Detect phase changes from spinner text
      if (text.includes('Detecting sources')) {
        progress.phase = 'detecting';
      } else if (text.includes('Discovering')) {
        progress.phase = 'discovering';
        const match = text.match(/Discovering (\w+)/);
        if (match) progress.currentSource = match[1];
      } else if (text.includes('Extracting')) {
        progress.phase = 'extracting';
        // Match "Extracting cursor (100/2609)..." or "Extracting cursor conversations..."
        const matchWithProgress = text.match(/Extracting (\S+) \((\d+)\/(\d+)\)/);
        const matchSimple = text.match(/Extracting (\S+)/);
        if (matchWithProgress) {
          progress.currentSource = matchWithProgress[1];
          progress.extractionProgress = {
            current: parseInt(matchWithProgress[2]!, 10),
            total: parseInt(matchWithProgress[3]!, 10),
          };
        } else if (matchSimple) {
          progress.currentSource = matchSimple[1];
          progress.extractionProgress = undefined;
        }
      } else if (text.includes('Syncing')) {
        progress.phase = 'syncing';
        const match = text.match(/Syncing (\w+)/);
        if (match) progress.currentSource = match[1];
      } else if (text.includes('Building search index')) {
        progress.phase = 'indexing';
        progress.currentSource = undefined;
      } else if (text.includes('Generating titles')) {
        progress.phase = 'enriching';
        progress.currentSource = undefined;
      } else if (text.includes('Sync complete')) {
        progress.phase = 'done';
        progress.currentSource = undefined;
      }

      // Parse counts from progress line: "Projects: X/Y | Conversations: A/B | Messages: M"
      const countsMatch = text.match(/Projects:\s*(\d+)\/(\d+)\s*\|\s*Conversations:\s*(\d+)\/(\d+)\s*\|\s*Messages:\s*(\d+)/);
      if (countsMatch) {
        progress.projectsProcessed = parseInt(countsMatch[1]!, 10);
        progress.projectsFound = parseInt(countsMatch[2]!, 10);
        progress.conversationsIndexed = parseInt(countsMatch[3]!, 10);
        progress.conversationsFound = parseInt(countsMatch[4]!, 10);
        progress.messagesIndexed = parseInt(countsMatch[5]!, 10);
      }

      // Check if embedding started
      if (text.includes('Embeddings generating')) {
        progress.embeddingStarted = true;
      }

      onProgress({ ...progress });
    });

    child.on('close', (code) => {
      if (code === 0) {
        progress.phase = 'done';
        onProgress({ ...progress });
        getCountInBackground().then((newCount) => {
          resolve({ newCount });
        });
      } else {
        progress.phase = 'error';
        onProgress({ ...progress });
        resolve(null);
      }
    });

    child.on('error', () => {
      progress.phase = 'error';
      onProgress({ ...progress });
      resolve(null);
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

// Help overlay component
function HelpOverlay({ width, height }: { width: number; height: number }) {
  const menuWidth = Math.min(50, width - 4);
  const innerWidth = menuWidth - 2;

  // Center the menu
  const leftPadding = Math.floor((width - menuWidth) / 2);
  const topPadding = Math.floor((height - 12) / 2);

  // Build each row with solid background (similar to ExportActionMenu)
  const buildRow = (content: string, bgColor: string = 'gray', fgColor: string = 'white') => {
    const padded = content.padEnd(innerWidth);
    return (
      <Text>
        <Text backgroundColor="gray" color="white">│</Text>
        <Text backgroundColor={bgColor as any} color={fgColor as any}>{padded}</Text>
        <Text backgroundColor="gray" color="white">│</Text>
      </Text>
    );
  };

  return (
    <Box
      position="absolute"
      marginLeft={leftPadding}
      marginTop={topPadding}
      width={menuWidth}
      flexDirection="column"
    >
      {/* Top border */}
      <Text backgroundColor="gray" color="white">
        {'┌' + '─'.repeat(innerWidth) + '┐'}
      </Text>

      {/* Title */}
      {buildRow(' Search Syntax', 'gray', 'cyan')}

      {/* Divider */}
      <Text backgroundColor="gray" color="white">
        {'├' + '─'.repeat(innerWidth) + '┤'}
      </Text>

      {/* Content */}
      {buildRow(' source:name  Filter by source')}
      {buildRow('   cursor, claude-code, codex, opencode', 'gray', 'whiteBright')}
      {buildRow(' ')}
      {buildRow(' model:name   Filter by model')}
      {buildRow('   opus, sonnet, gpt-4, etc.', 'gray', 'whiteBright')}
      {buildRow(' ')}
      {buildRow(' file:path    Filter by file path')}
      {buildRow('   auth.ts, src/components, etc.', 'gray', 'whiteBright')}

      {/* Divider */}
      <Text backgroundColor="gray" color="white">
        {'├' + '─'.repeat(innerWidth) + '┤'}
      </Text>

      {/* Examples */}
      {buildRow(' Examples', 'gray', 'white')}
      {buildRow('   source:codex', 'gray', 'whiteBright')}
      {buildRow('   file:auth.ts fix bug', 'gray', 'whiteBright')}
      {buildRow('   source:cursor file:components', 'gray', 'whiteBright')}

      {/* Divider */}
      <Text backgroundColor="gray" color="white">
        {'├' + '─'.repeat(innerWidth) + '┤'}
      </Text>

      {/* Footer */}
      {buildRow(' Press any key to close')}

      {/* Bottom border */}
      <Text backgroundColor="gray" color="white">
        {'└' + '─'.repeat(innerWidth) + '┘'}
      </Text>
    </Box>
  );
}

// First load screen - shown during initial sync
function FirstLoadScreen({
  width,
  height,
  progress,
  spinnerFrame,
}: {
  width: number;
  height: number;
  progress: FirstLoadSyncProgress;
  spinnerFrame: number;
}) {
  const logoLines = LOGO.split('\n');
  const spinner = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

  const getPhaseText = () => {
    switch (progress.phase) {
      case 'detecting': return 'Detecting sources...';
      case 'discovering': return `Discovering ${progress.currentSource || ''}...`;
      case 'extracting': {
        const source = progress.currentSource || '';
        if (progress.extractionProgress) {
          return `Extracting ${source} (${progress.extractionProgress.current}/${progress.extractionProgress.total})...`;
        }
        return `Extracting ${source} conversations...`;
      }
      case 'syncing': return `Syncing ${progress.currentSource || ''}...`;
      case 'indexing': return 'Building search index...';
      case 'enriching': return 'Generating titles...';
      case 'done': return 'Sync complete!';
      case 'error': return 'Sync failed';
      default: return 'Syncing...';
    }
  };

  const showCounts = progress.conversationsFound > 0 || progress.messagesIndexed > 0;

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
      </Box>

      <Box marginBottom={1}>
        {progress.phase === 'done' ? (
          <Text color="green">✓ </Text>
        ) : progress.phase === 'error' ? (
          <Text color="red">✗ </Text>
        ) : (
          <Text color="cyan">{spinner[spinnerFrame]} </Text>
        )}
        <Text color="white">{getPhaseText()}</Text>
      </Box>

      {showCounts && (
        <Box marginBottom={1}>
          <Text color="gray">
            Projects: {progress.projectsProcessed}/{progress.projectsFound} |
            Conversations: {progress.conversationsIndexed}/{progress.conversationsFound} |
            Messages: {progress.messagesIndexed}
          </Text>
        </Box>
      )}

      <Text color="gray">First run - indexing your conversations</Text>
    </Box>
  );
}

const ConversationListItem = React.memo(function ConversationListItem({
  conversation,
  isSelected,
  width,
  index,
}: {
  conversation: Conversation;
  isSelected: boolean;
  width: number;
  index: number;
}) {
  const timeStr = formatRelativeTime(conversation.updatedAt);
  const msgCount = conversation.messageCount;

  // Format index with consistent width (right-aligned)
  const indexStr = `${index + 1}.`;
  const indexWidth = 4; // "999." max

  // Calculate available width for title
  const prefixWidth = indexWidth + 1; // index + space
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
      <Text>
        <Text color={isSelected ? 'cyan' : 'gray'}>{indexStr.padStart(indexWidth)} </Text>
        <Text color={isSelected ? 'cyan' : 'white'} bold={isSelected}>
          {title}
        </Text>
        {'  '}
        <Text color="gray">{timeStr}</Text>
      </Text>
      <Box marginLeft={indexWidth + 1}>
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
  isSearching,
}: {
  width: number;
  height: number;
  searchQuery: string;
  syncStatus: SyncStatus;
  conversationCount: number;
  isSearching: boolean;
}) {
  const logoLines = LOGO.split('\n');
  const boxWidth = Math.min(60, width - 4);
  const innerWidth = boxWidth - 4;

  const getStatusIndicator = () => {
    if (isSearching) {
      return <Text color="cyan">Searching...</Text>;
    }
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
          <Text color="white">{searchQuery}</Text>
          <Text color="cyan" inverse> </Text>
          <Text>{' '.repeat(Math.max(0, innerWidth - searchQuery.length - 1))}</Text>
          <Text color="gray"> │</Text>
        </Box>
        <Box><Text color="gray">╰{'─'.repeat(boxWidth - 2)}╯</Text></Box>
      </Box>

      <Box marginBottom={2}>{getStatusIndicator()}</Box>

      <Box flexDirection="column" alignItems="center">
        <Box>
          <Text color="gray">Type to search · </Text>
          <Text color="white" bold>?</Text>
          <Text color="gray"> help · </Text>
          <Text color="white" bold>Tab</Text>
          <Text color="gray"> recent · </Text>
          <Text color="white" bold>^s</Text>
          <Text color="gray"> stats · </Text>
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

  // First load state - blocks UI until sync completes on first run
  const [isFirstLoad, setIsFirstLoad] = useState<boolean | null>(null); // null = checking
  const [firstLoadComplete, setFirstLoadComplete] = useState(false);
  const [firstLoadProgress, setFirstLoadProgress] = useState<FirstLoadSyncProgress>({
    phase: 'detecting',
    projectsFound: 0,
    projectsProcessed: 0,
    conversationsFound: 0,
    conversationsIndexed: 0,
    messagesIndexed: 0,
  });
  const [spinnerFrame, setSpinnerFrame] = useState(0);

  // Spinner animation for first load
  useEffect(() => {
    if (firstLoadComplete || firstLoadProgress.phase === 'done' || firstLoadProgress.phase === 'error') {
      return;
    }
    const timer = setInterval(() => {
      setSpinnerFrame((f) => (f + 1) % 10);
    }, 80);
    return () => clearInterval(timer);
  }, [firstLoadComplete, firstLoadProgress.phase]);

  // Data state
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [searchResults, setSearchResults] = useState<SearchResponse | null>(null);
  const [dbReady, setDbReady] = useState(false);
  const [conversationCount, setConversationCount] = useState(0);

  // Input state
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [showHelp, setShowHelp] = useState(false);

  // Sync state
  const [syncStatus, setSyncStatus] = useState<SyncStatus>({ phase: 'idle' });

  // High-level view mode (home, stats, or navigation modes)
  const [unifiedViewMode, setUnifiedViewMode] = useState<UnifiedViewMode>('home');

  // Layout calculations
  const headerHeight = 3;
  const footerHeight = 2;
  const rowHeight = 5; // 3 content rows + marginBottom=2
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

  // Background sync - runs after DB connection (only for subsequent loads)
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

  // Start initialization - check if first load (no messages)
  useEffect(() => {
    if (initStartedRef.current) return;
    initStartedRef.current = true;

    // Check message count to detect first load
    getMessageCountInBackground().then(async (messageCount) => {
      if (messageCount === 0) {
        // First load - run blocking sync
        setIsFirstLoad(true);

        const result = await runSyncBlocking((progress) => {
          setFirstLoadProgress(progress);
        });

        if (result) {
          setConversationCount(result.newCount);
        }

        // First sync complete - connect to DB and show UI
        await connect();
        setDbReady(true);
        const count = await conversationRepo.count();
        setConversationCount(count);
        setFirstLoadComplete(true);
        setSyncStatus({ phase: 'done', newConversations: count });
      } else {
        // Not first load - show UI immediately and sync in background
        setIsFirstLoad(false);
        setFirstLoadComplete(true);

        // Get conversation count for display
        getCountInBackground().then((count) => {
          setConversationCount(count);
        });

        // Start DB connection so it's ready when user navigates
        dbReadyPromiseRef.current = (async () => {
          await connect();
          setDbReady(true);
          const count = await conversationRepo.count();
          setConversationCount(count);
          startBackgroundSync();
        })();
      }
    });
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
      conversationRepo.list({}).then(setConversations);
    }
  }, [unifiedViewMode, dbReady, conversations.length, searchResults]);

  // Parse filter prefixes from query (e.g., "source:codex model:opus file:auth.ts some text")
  const parseFilters = useCallback((query: string): {
    source?: string;
    model?: string;
    file?: string;
    textQuery: string;
  } => {
    let source: string | undefined;
    let model: string | undefined;
    let file: string | undefined;
    let remaining = query;

    // Extract source:value
    const sourceMatch = remaining.match(/\bsource:(\S+)/i);
    if (sourceMatch) {
      source = sourceMatch[1];
      remaining = remaining.replace(sourceMatch[0], '').trim();
    }

    // Extract model:value
    const modelMatch = remaining.match(/\bmodel:(\S+)/i);
    if (modelMatch) {
      model = modelMatch[1];
      remaining = remaining.replace(modelMatch[0], '').trim();
    }

    // Extract file:value
    const fileMatch = remaining.match(/\bfile:(\S+)/i);
    if (fileMatch) {
      file = fileMatch[1];
      remaining = remaining.replace(fileMatch[0], '').trim();
    }

    return { source, model, file, textQuery: remaining };
  }, []);

  // Execute search (supports filter prefixes like source:codex model:opus file:auth.ts)
  const executeSearch = useCallback(async (query: string) => {
    if (!query.trim()) return;
    setIsSearching(true);
    try {
      await ensureDbReady();

      const { source, model, file, textQuery } = parseFilters(query);

      // Helper to filter results by source/model
      const applyFilters = <T extends { conversation: { source: string; model?: string | null } }>(results: T[]): T[] => {
        let filtered = results;
        if (source) {
          filtered = filtered.filter((r) => r.conversation.source === source);
        }
        if (model) {
          const modelLower = model.toLowerCase();
          filtered = filtered.filter((r) =>
            r.conversation.model?.toLowerCase().includes(modelLower)
          );
        }
        return filtered;
      };

      if (file && !textQuery) {
        // File-only search
        const fileResults = await searchByFilePath(file, 50);
        const convIdToMatches = new Map<string, typeof fileResults>();
        for (const match of fileResults) {
          const existing = convIdToMatches.get(match.conversationId) ?? [];
          existing.push(match);
          convIdToMatches.set(match.conversationId, existing);
        }

        const conversations = await Promise.all(
          Array.from(convIdToMatches.keys()).map((id) => conversationRepo.findById(id))
        );

        const results = applyFilters(conversations
          .filter((conv): conv is NonNullable<typeof conv> => conv !== null)
          .map((conv) => {
            const matches = convIdToMatches.get(conv.id) ?? [];
            const fileScore = matches.reduce((sum, m) => sum + m.score, 0);
            return {
              conversation: conv,
              matches: [],
              bestMatch: {
                messageId: '',
                conversationId: conv.id,
                role: 'user' as const,
                content: '',
                snippet: `${matches.length} file(s) matching "${file}"`,
                highlightRanges: [] as [number, number][],
                score: fileScore,
                messageIndex: 0,
              },
              totalMatches: matches.length,
            };
          })
          .sort((a, b) => b.bestMatch.score - a.bestMatch.score));

        setSearchResults({
          query: file,
          results,
          totalConversations: results.length,
          totalMessages: 0,
          searchTimeMs: 0,
        });
      } else if (file && textQuery) {
        // Combined text + file search
        const result = await search(textQuery, 100);
        const convIds = new Set(result.results.map((r) => r.conversation.id));
        const fileMatchMap = await getFileMatchesForConversations(convIds, file);

        const filteredResults = applyFilters(result.results
          .filter((r) => (fileMatchMap.get(r.conversation.id) ?? []).length > 0)
          .map((r) => {
            const matches = fileMatchMap.get(r.conversation.id) ?? [];
            const fileBoost = matches.reduce((sum, m) => sum + m.score * 0.5, 0);
            return {
              ...r,
              bestMatch: { ...r.bestMatch, score: r.bestMatch.score + fileBoost },
            };
          })
          .sort((a, b) => b.bestMatch.score - a.bestMatch.score))
          .slice(0, 50);

        setSearchResults({
          ...result,
          results: filteredResults,
          totalConversations: filteredResults.length,
        });
      } else if (textQuery) {
        // Text search (filters applied after)
        const results = await search(textQuery, 50);
        const filteredResults = applyFilters(results.results);
        results.results = filteredResults;
        results.totalConversations = filteredResults.length;
        setSearchResults(results);
      } else if (source || model) {
        // Filter-only query (no text search)
        const convs = await conversationRepo.list({ source, model });
        setConversations(convs);
        setSearchResults(null); // Clear search results to show filtered list
      }

      setUnifiedViewMode('list');
      navActions.setSelectedIndex(0);
      navActions.setViewMode('list');
    } catch {
      // Search failed - stay on home
    } finally {
      setIsSearching(false);
    }
  }, [navActions, ensureDbReady, parseFilters]);

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

    // Handle help overlay - any key closes it
    if (showHelp) {
      setShowHelp(false);
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
      if (input === '?') {
        setShowHelp(true);
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

  // First load screen - blocks until sync completes
  if (!firstLoadComplete) {
    return (
      <FirstLoadScreen
        width={width}
        height={height}
        progress={firstLoadProgress}
        spinnerFrame={spinnerFrame}
      />
    );
  }

  // Home screen
  if (unifiedViewMode === 'home') {
    return (
      <Box width={width} height={height}>
        <HomeScreen
          width={width}
          height={height}
          searchQuery={searchQuery}
          syncStatus={syncStatus}
          conversationCount={conversationCount}
          isSearching={isSearching}
        />
        {showHelp && <HelpOverlay width={width} height={height} />}
      </Box>
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
            toolOutputBlocks={navState.toolOutputBlocks}
            contentSegments={navState.contentSegments}
            expandedToolIndices={navState.expandedToolIndices}
            focusedToolIndex={navState.focusedToolIndex}
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
                index={actualIndex}
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
                  index={actualIndex}
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
              navState.toolNavigationMode ? (
                // Tool navigation mode
                <>
                  <Text color="cyan" bold>TOOLS </Text>
                  <Text color="white" bold>j</Text>
                  <Text color="gray">/</Text>
                  <Text color="white" bold>k</Text>
                  <Text color="gray"> nav tools · </Text>
                  <Text color="white" bold>Enter</Text>
                  <Text color="gray">/</Text>
                  <Text color="white" bold>Space</Text>
                  <Text color="gray"> expand · </Text>
                  <Text color="white" bold>Tab</Text>
                  <Text color="gray"> exit · </Text>
                  <Text color="white" bold>Esc</Text>
                  <Text color="gray"> back</Text>
                </>
              ) : (
                // Normal scroll mode
                <>
                  <Text color="white" bold>e</Text>
                  <Text color="gray"> export · </Text>
                  <Text color="white" bold>j</Text>
                  <Text color="gray">/</Text>
                  <Text color="white" bold>k</Text>
                  <Text color="gray"> scroll · </Text>
                  <Text color="white" bold>Tab</Text>
                  <Text color="gray"> tools · </Text>
                  <Text color="white" bold>n</Text>
                  <Text color="gray">/</Text>
                  <Text color="white" bold>p</Text>
                  <Text color="gray"> msg · </Text>
                  <Text color="white" bold>Esc</Text>
                  <Text color="gray"> back</Text>
                </>
              )
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
