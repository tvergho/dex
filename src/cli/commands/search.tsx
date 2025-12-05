/**
 * Search command - full-text search across all indexed conversations
 *
 * Usage: dex search <query> [--limit <n>]
 *
 * Interactive TUI with 4-level navigation:
 * 1. List view - search results with j/k navigation
 * 2. Matches view - all matches in a conversation
 * 3. Conversation view - full conversation with highlighted message
 * 4. Message view - single message with full content
 */

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import { withFullScreen, useScreenSize } from 'fullscreen-ink';
import { connect } from '../../db/index';
import {
  search,
  searchByFilePath,
  getFileMatchesForConversations,
  conversationRepo,
  type FileSearchMatch,
} from '../../db/repository';
import {
  ResultRow,
  MatchesView,
  ConversationView,
  MessageDetailView,
  ExportActionMenu,
  StatusToast,
} from '../components/index';
import { useNavigation, useExport } from '../hooks/index';
import {
  formatRelativeTime,
  formatSourceLabel,
  formatConversationCount,
  formatMessageCount,
} from '../../utils/format';
import { type SearchResponse, type Conversation, type ConversationResult } from '../../schema/index';

interface SearchOptions {
  limit?: string;
  file?: string;
  source?: string;
  model?: string;
  project?: string;
  from?: string;
  to?: string;
  offset?: string;
  json?: boolean;
}

function SearchApp({
  query,
  limit,
  filePattern,
  sourceFilter,
  modelFilter,
}: {
  query: string;
  limit: number;
  filePattern?: string;
  sourceFilter?: string;
  modelFilter?: string;
}) {
  const { exit } = useApp();
  const { width, height } = useScreenSize();

  // Search state
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [response, setResponse] = useState<SearchResponse | null>(null);
  const [fileMatches, setFileMatches] = useState<Map<string, FileSearchMatch[]>>(new Map());

  // Multi-select state (only in list view)
  const [multiSelectMode, setMultiSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Layout calculations
  const headerHeight = 3;
  const footerHeight = 2;
  const rowHeight = 5; // 3 content rows + marginBottom=2
  const availableHeight = height - headerHeight - footerHeight;
  const visibleCount = Math.max(1, Math.floor(availableHeight / rowHeight));

  // Convert search results to display items
  const displayItems: ConversationResult[] = useMemo(() => {
    if (!response) return [];
    return response.results;
  }, [response]);

  // Navigation hook
  const { state: navState, actions: navActions, expandedResult, handleNavigationInput } = useNavigation({
    displayItems,
    availableHeight,
    width,
    hasSearchResults: true,
    onExitList: undefined, // No back from list in search command
  });

  // Get conversations for export
  const getConversationsToExport = useCallback((): Conversation[] => {
    if (multiSelectMode && selectedIds.size > 0 && response) {
      return response.results
        .filter((r) => selectedIds.has(r.conversation.id))
        .map((r) => r.conversation);
    }
    // Single conversation export based on view
    if (navState.viewMode === 'list' && response) {
      const conv = response.results[navState.selectedIndex]?.conversation;
      return conv ? [conv] : [];
    }
    if (expandedResult) {
      return [expandedResult.conversation];
    }
    return [];
  }, [multiSelectMode, selectedIds, response, navState.viewMode, navState.selectedIndex, expandedResult]);

  // Export hook
  const {
    exportMode,
    exportActionIndex,
    statusMessage,
    statusType,
    statusVisible,
    openExportMenu,
    handleExportInput,
  } = useExport({ getConversations: getConversationsToExport });

  // Run search on mount
  useEffect(() => {
    async function runSearch() {
      try {
        await connect();
        const startTime = Date.now();

        // Helper to filter results by source/model
        const applyFilters = (results: ConversationResult[]): ConversationResult[] => {
          let filtered = results;
          if (sourceFilter) {
            filtered = filtered.filter((r) => r.conversation.source === sourceFilter);
          }
          if (modelFilter) {
            const modelLower = modelFilter.toLowerCase();
            filtered = filtered.filter((r) =>
              r.conversation.model?.toLowerCase().includes(modelLower)
            );
          }
          return filtered;
        };

        if (filePattern && !query) {
          // File-only search
          const fileResults = await searchByFilePath(filePattern, limit);
          const convIdToMatches = new Map<string, FileSearchMatch[]>();
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
                  snippet: `${matches.length} file(s) matching "${filePattern}"`,
                  highlightRanges: [] as [number, number][],
                  score: fileScore,
                  messageIndex: 0,
                },
                totalMatches: matches.length,
              };
            })
            .sort((a, b) => b.bestMatch.score - a.bestMatch.score));

          setResponse({
            query: filePattern,
            results,
            totalConversations: results.length,
            totalMessages: 0,
            searchTimeMs: Date.now() - startTime,
          });
          setFileMatches(convIdToMatches);
        } else if (filePattern && query) {
          // Combined search
          const result = await search(query, limit * 2);
          const convIds = new Set(result.results.map((r) => r.conversation.id));
          const fileMatchMap = await getFileMatchesForConversations(convIds, filePattern);

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
            .slice(0, limit);

          setResponse({
            ...result,
            results: filteredResults,
            totalConversations: filteredResults.length,
            searchTimeMs: Date.now() - startTime,
          });
          setFileMatches(fileMatchMap);
        } else {
          // Standard search
          const result = await search(query, limit);
          const filteredResults = applyFilters(result.results);
          setResponse({
            ...result,
            results: filteredResults,
            totalConversations: filteredResults.length,
          });
          setFileMatches(new Map());
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    }
    runSearch();
  }, [query, limit, filePattern, sourceFilter, modelFilter]);

  // Scroll offset for list view
  const scrollOffset = useMemo(() => {
    if (!response) return 0;
    const maxOffset = Math.max(0, response.results.length - visibleCount);
    if (navState.selectedIndex < visibleCount) return 0;
    return Math.min(navState.selectedIndex - visibleCount + 1, maxOffset);
  }, [navState.selectedIndex, visibleCount, response?.results.length]);

  const visibleResults = useMemo(() => {
    if (!response) return [];
    return response.results.slice(scrollOffset, scrollOffset + visibleCount);
  }, [response, scrollOffset, visibleCount]);

  useInput((input, key) => {
    // Priority 1: Quit
    if (input === 'q') {
      exit();
      return;
    }

    // Priority 2: Export menu handling
    if (handleExportInput(input, key)) {
      return;
    }

    if (!response || response.results.length === 0) return;

    // Priority 3: Export trigger (works in ALL view modes)
    if (input === 'e') {
      if (multiSelectMode) {
        if (selectedIds.size > 0) {
          openExportMenu();
        }
      } else if (getConversationsToExport().length > 0) {
        openExportMenu();
      }
      return;
    }

    // Priority 4: Multi-select mode handling in list view
    if (navState.viewMode === 'list' && multiSelectMode) {
      if (input === ' ') {
        const current = response.results[navState.selectedIndex];
        if (current) {
          setSelectedIds((prev) => {
            const next = new Set(prev);
            if (next.has(current.conversation.id)) {
              next.delete(current.conversation.id);
            } else {
              next.add(current.conversation.id);
            }
            return next;
          });
        }
        return;
      }
      if (input === 'v' || key.escape) {
        setMultiSelectMode(false);
        setSelectedIds(new Set());
        return;
      }
    }

    // Multi-select trigger in list view
    if (navState.viewMode === 'list' && input === 'v') {
      setMultiSelectMode(true);
      return;
    }

    // Priority 5: Navigation (uses shared hook)
    if (handleNavigationInput(input, key)) {
      return;
    }
  });

  if (loading) {
    const searchLabel = filePattern && !query
      ? `files matching "${filePattern}"`
      : filePattern
        ? `"${query}" in files matching "${filePattern}"`
        : `"${query}"`;
    return (
      <Box width={width} height={height} alignItems="center" justifyContent="center">
        <Text color="cyan">Searching for {searchLabel}...</Text>
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

  if (!response) {
    return (
      <Box width={width} height={height} alignItems="center" justifyContent="center">
        <Text color="red">No response</Text>
      </Box>
    );
  }

  // Footer keybindings
  const Key = ({ k }: { k: string }) => <Text color="white">{k}</Text>;
  const Sep = () => <Text dimColor> · </Text>;

  let footerContent: React.ReactNode;
  if (navState.viewMode === 'message') {
    footerContent = navState.toolNavigationMode ? (
      // Tool navigation mode footer
      <>
        <Text color="cyan" bold>TOOLS </Text>
        <Key k="j/k" /><Text dimColor>: nav tools</Text><Sep />
        <Key k="Enter/Space" /><Text dimColor>: expand</Text><Sep />
        <Key k="Tab" /><Text dimColor>: exit</Text><Sep />
        <Key k="Esc" /><Text dimColor>: back</Text><Sep />
        <Key k="q" /><Text dimColor>: quit</Text>
      </>
    ) : (
      // Normal scroll mode footer
      <>
        <Key k="e" /><Text dimColor>: export</Text><Sep />
        <Key k="j/k" /><Text dimColor>: scroll</Text><Sep />
        <Key k="Tab" /><Text dimColor>: tools</Text><Sep />
        <Key k="n/p" /><Text dimColor>: msg</Text><Sep />
        <Key k="Esc" /><Text dimColor>: back</Text><Sep />
        <Key k="q" /><Text dimColor>: quit</Text>
      </>
    );
  } else if (navState.viewMode === 'conversation') {
    footerContent = (
      <>
        <Key k="e" /><Text dimColor>: export</Text><Sep />
        <Key k="j/k" /><Text dimColor>: select</Text><Sep />
        <Key k="Enter" /><Text dimColor>: view full</Text><Sep />
        <Key k="Esc" /><Text dimColor>: back</Text><Sep />
        <Key k="q" /><Text dimColor>: quit</Text>
      </>
    );
  } else if (navState.viewMode === 'matches') {
    footerContent = (
      <>
        <Key k="e" /><Text dimColor>: export</Text><Sep />
        <Key k="j/k" /><Text dimColor>: navigate</Text><Sep />
        <Key k="Enter" /><Text dimColor>: view conversation</Text><Sep />
        <Key k="Esc" /><Text dimColor>: back</Text><Sep />
        <Key k="q" /><Text dimColor>: quit</Text>
      </>
    );
  } else if (multiSelectMode) {
    footerContent = (
      <>
        <Key k="space" /><Text dimColor>: toggle</Text><Sep />
        <Key k="e" /><Text dimColor>: export{selectedIds.size > 0 ? ` (${selectedIds.size})` : ''}</Text><Sep />
        <Key k="j/k" /><Text dimColor>: navigate</Text><Sep />
        <Key k="Esc" /><Text dimColor>: cancel</Text><Sep />
        <Key k="q" /><Text dimColor>: quit</Text>
      </>
    );
  } else {
    footerContent = (
      <>
        <Key k="e" /><Text dimColor>: export</Text><Sep />
        <Key k="v" /><Text dimColor>: select</Text><Sep />
        <Key k="j/k" /><Text dimColor>: navigate</Text><Sep />
        <Key k="Enter" /><Text dimColor>: expand</Text><Sep />
        <Key k="q" /><Text dimColor>: quit</Text>
      </>
    );
  }

  return (
    <Box width={width} height={height} flexDirection="column">
      {/* Header */}
      <Box flexDirection="column" marginBottom={1}>
        <Box paddingX={1}>
          <Text bold color="white">Search </Text>
          {filePattern && !query ? (
            <Text color="yellow" bold>--file "{filePattern}"</Text>
          ) : filePattern ? (
            <>
              <Text color="cyan" bold>"{query}"</Text>
              <Text color="gray"> </Text>
              <Text color="yellow" bold>--file "{filePattern}"</Text>
            </>
          ) : (
            <Text color="cyan" bold>"{response.query}"</Text>
          )}
          <Text dimColor>
            {' '}— {formatConversationCount(response.totalConversations)}
            {response.totalMessages > 0 && `, ${formatMessageCount(response.totalMessages)}`}
            {' '}({response.searchTimeMs}ms)
            {response.searchMode && ` [${response.searchMode}]`}
          </Text>
        </Box>
        <Box paddingX={1}>
          <Text color="gray">{'─'.repeat(Math.max(0, width - 2))}</Text>
        </Box>
      </Box>

      {/* Content */}
      <Box flexDirection="column" flexGrow={1} paddingX={1}>
        {response.results.length === 0 ? (
          <Text dimColor>No results found.</Text>
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
            query={query}
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
            query={query}
            indexMap={navState.messageIndexMap}
            combinedMessageCount={navState.combinedMessages.length}
          />
        ) : (
          visibleResults.map((result, idx) => {
            const actualIndex = scrollOffset + idx;
            const convFileMatches = fileMatches.get(result.conversation.id);
            const isChecked = selectedIds.has(result.conversation.id);
            return (
              <Box key={result.conversation.id} flexDirection="row">
                {multiSelectMode && (
                  <Text color={isChecked ? 'green' : 'gray'}>
                    {isChecked ? '[✓] ' : '[ ] '}
                  </Text>
                )}
                <ResultRow
                  result={result}
                  isSelected={actualIndex === navState.selectedIndex}
                  width={multiSelectMode ? width - 6 : width - 2}
                  query={query}
                  fileMatches={convFileMatches}
                  index={actualIndex}
                />
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
        <Box paddingX={1} justifyContent="space-between">
          <Text>{footerContent}</Text>
          {navState.viewMode === 'list' && response.results.length > visibleCount && (
            <Text color="gray">
              {scrollOffset + 1}-{Math.min(scrollOffset + visibleCount, response.results.length)} of {response.results.length}
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

// --- JSON Output for MCP/Agent Use ---

interface SearchJsonOutput {
  results: Array<{
    id: string;
    title: string;
    project: string;
    source: string;
    date: string;
    snippet: string;
    message_index: number;
    estimated_tokens: number;
  }>;
  total: number;
}

async function printJsonSearch(options: {
  query: string;
  limit: number;
  offset: number;
  filePattern?: string;
  sourceFilter?: string;
  modelFilter?: string;
  projectFilter?: string;
  fromDate?: string;
  toDate?: string;
}): Promise<void> {
  const { query, limit, offset, filePattern, sourceFilter, modelFilter, projectFilter, fromDate, toDate } = options;
  await connect();

  type SearchResult = {
    conversation: Conversation;
    totalMatches: number;
    snippet: string;
    messageIndex: number;
  };

  let allResults: SearchResult[] = [];
  let total = 0;

  // Helper to filter results
  const applyFilters = (items: SearchResult[]): SearchResult[] => {
    let filtered = items;
    if (sourceFilter) {
      filtered = filtered.filter((r) => r.conversation.source === sourceFilter);
    }
    if (modelFilter) {
      const modelLower = modelFilter.toLowerCase();
      filtered = filtered.filter((r) =>
        r.conversation.model?.toLowerCase().includes(modelLower)
      );
    }
    if (projectFilter) {
      const projectLower = projectFilter.toLowerCase();
      filtered = filtered.filter((r) => {
        const workspacePath = (r.conversation.workspacePath || '').toLowerCase();
        const projectName = (r.conversation.projectName || '').toLowerCase();
        return workspacePath.includes(projectLower) || projectName.includes(projectLower);
      });
    }
    if (fromDate) {
      const from = new Date(fromDate).getTime();
      filtered = filtered.filter((r) => {
        const created = r.conversation.createdAt;
        return created && new Date(created).getTime() >= from;
      });
    }
    if (toDate) {
      const to = new Date(toDate).getTime() + 86400000;
      filtered = filtered.filter((r) => {
        const created = r.conversation.createdAt;
        return created && new Date(created).getTime() < to;
      });
    }
    return filtered;
  };

  if (filePattern && !query) {
    const fileResults = await searchByFilePath(filePattern, limit + offset + 100);
    const convIdToMatches = new Map<string, FileSearchMatch[]>();
    for (const match of fileResults) {
      const existing = convIdToMatches.get(match.conversationId) ?? [];
      existing.push(match);
      convIdToMatches.set(match.conversationId, existing);
    }

    const conversations = await Promise.all(
      Array.from(convIdToMatches.keys()).map((id) => conversationRepo.findById(id))
    );

    allResults = applyFilters(conversations
      .filter((conv): conv is NonNullable<typeof conv> => conv !== null)
      .map((conv) => {
        const matches = convIdToMatches.get(conv.id) ?? [];
        return {
          conversation: conv,
          totalMatches: matches.length,
          snippet: matches.slice(0, 3).map((m) => m.filePath.split('/').pop()).join(', '),
          messageIndex: 0,
        };
      }));
  } else if (filePattern && query) {
    const result = await search(query, limit + offset + 100);
    const convIds = new Set(result.results.map((r) => r.conversation.id));
    const fileMatchMap = await getFileMatchesForConversations(convIds, filePattern);

    allResults = applyFilters(result.results
      .filter((r) => (fileMatchMap.get(r.conversation.id) ?? []).length > 0)
      .map((r) => ({
        conversation: r.conversation,
        totalMatches: r.totalMatches,
        snippet: r.bestMatch.snippet,
        messageIndex: r.bestMatch.messageIndex,
      })));
  } else if (!query && (sourceFilter || modelFilter || projectFilter)) {
    const { conversations: convs, total: totalConvs } = await conversationRepo.list({
      source: sourceFilter,
      model: modelFilter,
      project: projectFilter,
      fromDate,
      toDate,
      limit: limit + offset,
    });
    allResults = convs.map((conv) => ({
      conversation: conv,
      totalMatches: 0,
      snippet: conv.subtitle || '',
      messageIndex: 0,
    }));
    total = totalConvs;
  } else {
    const result = await search(query, limit + offset + 100);
    allResults = applyFilters(result.results.map((r) => ({
      conversation: r.conversation,
      totalMatches: r.totalMatches,
      snippet: r.bestMatch.snippet,
      messageIndex: r.bestMatch.messageIndex,
    })));
  }

  // If total wasn't set from filter-only query, use allResults length
  if (total === 0) {
    total = allResults.length;
  }

  // Apply pagination
  const paginatedResults = allResults.slice(offset, offset + limit);

  const output: SearchJsonOutput = {
    results: paginatedResults.map((r) => ({
      id: r.conversation.id,
      title: r.conversation.title,
      project: r.conversation.workspacePath || r.conversation.projectName || '',
      source: r.conversation.source,
      date: r.conversation.createdAt || r.conversation.updatedAt || '',
      snippet: r.snippet.slice(0, 300),
      message_index: r.messageIndex,
      estimated_tokens:
        (r.conversation.totalInputTokens || 0) +
        (r.conversation.totalOutputTokens || 0) +
        (r.conversation.totalCacheCreationTokens || 0) +
        (r.conversation.totalCacheReadTokens || 0),
    })),
    total,
  };

  console.log(JSON.stringify(output, null, 2));
}

async function plainSearch(
  query: string,
  limit: number,
  filePattern?: string,
  sourceFilter?: string,
  modelFilter?: string
): Promise<void> {
  await connect();
  const startTime = Date.now();

  type PlainResult = { conversation: { id: string; title: string; source: string; model?: string; workspacePath?: string; updatedAt?: string }; totalMatches: number; snippet: string };
  let results: PlainResult[] = [];
  let totalConversations = 0;
  let totalMessages = 0;

  // Helper to filter results by source/model
  const applyFilters = (items: PlainResult[]): PlainResult[] => {
    let filtered = items;
    if (sourceFilter) {
      filtered = filtered.filter((r) => r.conversation.source === sourceFilter);
    }
    if (modelFilter) {
      const modelLower = modelFilter.toLowerCase();
      filtered = filtered.filter((r) =>
        r.conversation.model?.toLowerCase().includes(modelLower)
      );
    }
    return filtered;
  };

  if (filePattern && !query) {
    const fileResults = await searchByFilePath(filePattern, limit);
    const convIdToMatches = new Map<string, FileSearchMatch[]>();
    for (const match of fileResults) {
      const existing = convIdToMatches.get(match.conversationId) ?? [];
      existing.push(match);
      convIdToMatches.set(match.conversationId, existing);
    }

    const conversations = await Promise.all(
      Array.from(convIdToMatches.keys()).map((id) => conversationRepo.findById(id))
    );

    results = applyFilters(conversations
      .filter((conv): conv is NonNullable<typeof conv> => conv !== null)
      .map((conv) => {
        const matches = convIdToMatches.get(conv.id) ?? [];
        return {
          conversation: conv,
          totalMatches: matches.length,
          snippet: matches.slice(0, 3).map((m) => m.filePath.split('/').pop()).join(', '),
        };
      }));
    totalConversations = results.length;
  } else if (filePattern && query) {
    const result = await search(query, limit * 2);
    const convIds = new Set(result.results.map((r) => r.conversation.id));
    const fileMatchMap = await getFileMatchesForConversations(convIds, filePattern);

    results = applyFilters(result.results
      .filter((r) => (fileMatchMap.get(r.conversation.id) ?? []).length > 0)
      .slice(0, limit)
      .map((r) => ({
        conversation: r.conversation,
        totalMatches: r.totalMatches,
        snippet: r.bestMatch.snippet,
      })));
    totalConversations = results.length;
    totalMessages = result.totalMessages;
  } else if (sourceFilter || modelFilter) {
    // Filter-only query (no text search)
    const { conversations: convs } = await conversationRepo.list({ source: sourceFilter, model: modelFilter, limit });
    results = convs.map((conv) => ({
      conversation: conv,
      totalMatches: 0,
      snippet: conv.subtitle || '',
    }));
    totalConversations = results.length;
  } else {
    const result = await search(query, limit);
    results = applyFilters(result.results.map((r) => ({
      conversation: r.conversation,
      totalMatches: r.totalMatches,
      snippet: r.bestMatch.snippet,
    })));
    totalConversations = results.length;
    totalMessages = result.totalMessages;
  }

  const searchTimeMs = Date.now() - startTime;
  const filterParts: string[] = [];
  if (query) filterParts.push(`"${query}"`);
  if (filePattern) filterParts.push(`--file "${filePattern}"`);
  if (sourceFilter) filterParts.push(`--source ${sourceFilter}`);
  if (modelFilter) filterParts.push(`--model ${modelFilter}`);
  const searchLabel = filterParts.join(' ');

  console.log(`\nSearch: ${searchLabel}`);
  console.log(
    `${formatConversationCount(totalConversations)}${totalMessages > 0 ? `, ${formatMessageCount(totalMessages)}` : ''} (${searchTimeMs}ms)\n`
  );

  if (results.length === 0) {
    console.log('No results found.');
    return;
  }

  for (const r of results) {
    console.log(`${r.conversation.title}`);
    const sourceName = formatSourceLabel(r.conversation.source);
    console.log(`   ${sourceName}`);
    if (r.conversation.workspacePath) {
      console.log(`   ${r.conversation.workspacePath}`);
    }
    console.log(`   ${r.totalMatches} match(es) · ${formatRelativeTime(r.conversation.updatedAt)}`);

    // Center snippet around search term
    const snippetContent = r.snippet.replace(/\n/g, ' ').trim();
    const maxWidth = 100;
    let snippetText = snippetContent;
    if (snippetContent.length > maxWidth && query) {
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

      if (matchPos !== -1 && matchPos > maxWidth / 2) {
        // Center around the match
        const start = Math.max(0, matchPos - Math.floor(maxWidth / 2));
        const end = Math.min(snippetContent.length, start + maxWidth - 2);
        const prefix = start > 0 ? '...' : '';
        const suffix = end < snippetContent.length ? '...' : '';
        snippetText = prefix + snippetContent.slice(start, end) + suffix;
      } else {
        snippetText = snippetContent.slice(0, maxWidth - 3) + '...';
      }
    } else if (snippetContent.length > maxWidth) {
      snippetText = snippetContent.slice(0, maxWidth - 3) + '...';
    }
    console.log(`   "${snippetText}"`);
    console.log(`   ID: ${r.conversation.id}`);
    console.log('');
  }
}

export async function searchCommand(query: string, options: SearchOptions): Promise<void> {
  const limit = parseInt(options.limit ?? '20', 10);
  const offset = parseInt(options.offset ?? '0', 10);
  const filePattern = options.file;
  const sourceFilter = options.source;
  const modelFilter = options.model;
  const projectFilter = options.project;

  if (!query && !filePattern && !sourceFilter && !modelFilter && !projectFilter) {
    console.error('Error: Please provide a search query, --file pattern, or filter options');
    process.exit(1);
  }

  if (options.json) {
    await printJsonSearch({
      query,
      limit,
      offset,
      filePattern,
      sourceFilter,
      modelFilter,
      projectFilter,
      fromDate: options.from,
      toDate: options.to,
    });
    return;
  }

  if (!process.stdin.isTTY) {
    await plainSearch(query, limit, filePattern, sourceFilter, modelFilter);
    return;
  }

  const app = withFullScreen(
    <SearchApp
      query={query}
      limit={limit}
      filePattern={filePattern}
      sourceFilter={sourceFilter}
      modelFilter={modelFilter}
    />
  );
  await app.start();
  await app.waitUntilExit();
}
