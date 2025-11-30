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
  messageRepo,
  filesRepo,
  messageFilesRepo,
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
  ExportPreviewModal,
  StatusToast,
  getPreviewMaxOffset,
} from '../components/index';
import {
  formatRelativeTime,
  formatSourceName,
  formatConversationCount,
  formatMessageCount,
  combineConsecutiveMessages,
  type CombinedMessage,
} from '../../utils/format';
import {
  exportConversationsToFile,
  exportConversationsToClipboard,
  generatePreviewContent,
} from '../../utils/export-actions';
import type { SearchResponse, ConversationFile, MessageFile, Conversation } from '../../schema/index';

interface SearchOptions {
  limit?: string;
  file?: string;
}

type ViewMode = 'list' | 'matches' | 'conversation' | 'message';
type ExportMode = 'none' | 'action-menu' | 'preview';

function SearchApp({
  query,
  limit,
  filePattern,
}: {
  query: string;
  limit: number;
  filePattern?: string;
}) {
  const { exit } = useApp();
  const { width, height } = useScreenSize();

  // Search state
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [response, setResponse] = useState<SearchResponse | null>(null);
  const [fileMatches, setFileMatches] = useState<Map<string, FileSearchMatch[]>>(new Map());

  // Navigation state
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [selectedIndex, setSelectedIndex] = useState(0);
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

  // Multi-select state (only in list view)
  const [multiSelectMode, setMultiSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Export state
  const [exportMode, setExportMode] = useState<ExportMode>('none');
  const [exportActionIndex, setExportActionIndex] = useState(0);
  const [previewContent, setPreviewContent] = useState('');
  const [previewScrollOffset, setPreviewScrollOffset] = useState(0);

  // Status toast
  const [statusMessage, setStatusMessage] = useState('');
  const [statusType, setStatusType] = useState<'success' | 'error'>('success');
  const [statusVisible, setStatusVisible] = useState(false);

  useEffect(() => {
    async function runSearch() {
      try {
        await connect();
        const startTime = Date.now();

        if (filePattern && !query) {
          // File-only search: find conversations by file path
          const fileResults = await searchByFilePath(filePattern, limit);

          // Group by conversation and get unique conversation IDs
          const convIdToMatches = new Map<string, FileSearchMatch[]>();
          for (const match of fileResults) {
            const existing = convIdToMatches.get(match.conversationId) ?? [];
            existing.push(match);
            convIdToMatches.set(match.conversationId, existing);
          }

          // Fetch conversation metadata
          const conversations = await Promise.all(
            Array.from(convIdToMatches.keys()).map((id) => conversationRepo.findById(id))
          );

          // Build search response with file-based results
          const results = conversations
            .filter((conv): conv is NonNullable<typeof conv> => conv !== null)
            .map((conv) => {
              const matches = convIdToMatches.get(conv.id) ?? [];
              // Calculate score from file matches (sum of file scores)
              const fileScore = matches.reduce((sum, m) => sum + m.score, 0);
              return {
                conversation: conv,
                matches: [], // No message matches for file-only search
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
            .sort((a, b) => b.bestMatch.score - a.bestMatch.score);

          setResponse({
            query: filePattern,
            results,
            totalConversations: results.length,
            totalMessages: 0,
            searchTimeMs: Date.now() - startTime,
          });
          setFileMatches(convIdToMatches);
        } else if (filePattern && query) {
          // Combined search: search messages, then filter/enrich by file matches
          const result = await search(query, limit * 2); // Get more to filter

          // Get file matches for the result conversations
          const convIds = new Set(result.results.map((r) => r.conversation.id));
          const fileMatchMap = await getFileMatchesForConversations(convIds, filePattern);

          // Filter to only conversations with file matches, boost scores
          const filteredResults = result.results
            .filter((r) => {
              const matches = fileMatchMap.get(r.conversation.id) ?? [];
              return matches.length > 0;
            })
            .map((r) => {
              const matches = fileMatchMap.get(r.conversation.id) ?? [];
              const fileBoost = matches.reduce((sum, m) => sum + m.score * 0.5, 0);
              return {
                ...r,
                bestMatch: {
                  ...r.bestMatch,
                  score: r.bestMatch.score + fileBoost,
                },
              };
            })
            .sort((a, b) => b.bestMatch.score - a.bestMatch.score)
            .slice(0, limit);

          setResponse({
            ...result,
            results: filteredResults,
            totalConversations: filteredResults.length,
            searchTimeMs: Date.now() - startTime,
          });
          setFileMatches(fileMatchMap);
        } else {
          // Standard message search
          const result = await search(query, limit);
          setResponse(result);
          setFileMatches(new Map());
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    }
    runSearch();
  }, [query, limit, filePattern]);

  // Load files and compute combined messages when expanding a conversation
  useEffect(() => {
    if (expandedIndex !== null && response?.results[expandedIndex]) {
      const convId = response.results[expandedIndex]!.conversation.id;
      filesRepo.findByConversation(convId).then(setConversationFiles);
      messageFilesRepo.findByConversation(convId).then(setConversationMessageFiles);
      // Pre-compute combined messages for index mapping in matches view
      messageRepo.findByConversation(convId).then((msgs) => {
        const { messages: combined, indexMap } = combineConsecutiveMessages(msgs);
        setCombinedMessages(combined);
        setMessageIndexMap(indexMap);
      });
    } else {
      setConversationFiles([]);
      setConversationMessageFiles([]);
      setCombinedMessages([]);
      setMessageIndexMap(new Map());
    }
  }, [expandedIndex, response]);

  const headerHeight = 3;
  const footerHeight = 2;
  const rowHeight = 4; // title + source + snippet + margin
  const availableHeight = height - headerHeight - footerHeight;
  const visibleCount = Math.max(1, Math.floor(availableHeight / rowHeight));

  const scrollOffset = useMemo(() => {
    if (!response) return 0;
    const maxOffset = Math.max(0, response.results.length - visibleCount);
    if (selectedIndex < visibleCount) return 0;
    return Math.min(selectedIndex - visibleCount + 1, maxOffset);
  }, [selectedIndex, visibleCount, response?.results.length]);

  const visibleResults = useMemo(() => {
    if (!response) return [];
    return response.results.slice(scrollOffset, scrollOffset + visibleCount);
  }, [response, scrollOffset, visibleCount]);

  const expandedResult = expandedIndex !== null ? response?.results[expandedIndex] : null;

  // Map a match to its combined message index (fallback to original index)
  const getCombinedIndexForMatch = (match: { messageIndex: number } | undefined): number | null => {
    if (!match) return null;
    return messageIndexMap.get(match.messageIndex) ?? match.messageIndex;
  };

  // Find the next/previous match that points to a different combined message
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

  // Load conversation messages when entering conversation view
  const loadConversation = async (conversationId: string, targetMessageIndex?: number) => {
    const msgs = await messageRepo.findByConversation(conversationId);
    const { messages: combined, indexMap } = combineConsecutiveMessages(msgs);
    setCombinedMessages(combined);
    setMessageIndexMap(indexMap);

    // Use same calculation as ConversationView component
    // Note: conversationFiles may not be loaded yet, so use 6 as safe estimate (5 base + 1 for files)
    const headerHeight = 6;
    const messagesPerPage = Math.max(1, Math.floor((availableHeight - headerHeight) / 3));

    // Scroll to show the highlighted message and select it
    if (targetMessageIndex !== undefined) {
      // Convert original messageIndex to combined index
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

  // Show status toast with auto-dismiss
  const showStatus = useCallback((message: string, type: 'success' | 'error') => {
    setStatusMessage(message);
    setStatusType(type);
    setStatusVisible(true);
    setTimeout(() => setStatusVisible(false), 3000);
  }, []);

  // Get the current conversation for export (based on view mode)
  const getCurrentConversation = useCallback((): Conversation | null => {
    if (viewMode === 'list' && response) {
      return response.results[selectedIndex]?.conversation ?? null;
    }
    if (expandedIndex !== null && response) {
      return response.results[expandedIndex]?.conversation ?? null;
    }
    return null;
  }, [viewMode, response, selectedIndex, expandedIndex]);

  // Get conversations to export
  const getConversationsToExport = useCallback((): Conversation[] => {
    if (multiSelectMode && selectedIds.size > 0 && response) {
      return response.results
        .filter((r) => selectedIds.has(r.conversation.id))
        .map((r) => r.conversation);
    }
    const current = getCurrentConversation();
    return current ? [current] : [];
  }, [multiSelectMode, selectedIds, response, getCurrentConversation]);

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
      } else if (exportActionIndex === 2) {
        // Show preview (only first conversation)
        const content = await generatePreviewContent(toExport[0]!);
        setPreviewContent(content);
        setPreviewScrollOffset(0);
        setExportMode('preview');
      }
    } catch (err) {
      showStatus(`Export failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
      setExportMode('none');
    }
  }, [getConversationsToExport, exportActionIndex, showStatus]);

  // Preview content height for scrolling
  const previewContentHeight = height - 5;
  const previewMaxOffset = getPreviewMaxOffset(previewContent, previewContentHeight);

  useInput((input, key) => {
    // Priority 1: Quit
    if (input === 'q') {
      exit();
      return;
    }

    // Priority 2: Export preview mode
    if (exportMode === 'preview') {
      if (input === 'j' || key.downArrow) {
        setPreviewScrollOffset((o) => Math.min(o + 1, previewMaxOffset));
      } else if (input === 'k' || key.upArrow) {
        setPreviewScrollOffset((o) => Math.max(o - 1, 0));
      } else if (input === 'g') {
        setPreviewScrollOffset(0);
      } else if (input === 'G') {
        setPreviewScrollOffset(previewMaxOffset);
      } else if (key.escape) {
        setExportMode('action-menu');
      }
      return;
    }

    // Priority 3: Export action menu
    if (exportMode === 'action-menu') {
      if (input === 'j' || key.downArrow) {
        setExportActionIndex((i) => Math.min(i + 1, 2));
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

    if (!response || response.results.length === 0) return;

    if (viewMode === 'message' && combinedMessages.length > 0) {
      // Message detail view navigation
      const currentMessage = combinedMessages[selectedMessageIndex];
      if (key.escape || key.backspace || key.delete) {
        setViewMode('conversation');
        setMessageScrollOffset(0);
      } else if (input === 'j' || key.downArrow) {
        const lines = currentMessage?.content.split('\n') || [];
        const maxOffset = Math.max(0, lines.length - (height - 5));
        setMessageScrollOffset((o) => Math.min(o + 1, maxOffset));
      } else if (input === 'k' || key.upArrow) {
        setMessageScrollOffset((o) => Math.max(o - 1, 0));
      } else if (input === 'g') {
        setMessageScrollOffset(0);
      } else if (input === 'G') {
        const lines = currentMessage?.content.split('\n') || [];
        setMessageScrollOffset(Math.max(0, lines.length - (height - 5)));
      } else if (input === 'n') {
        // Next message
        if (selectedMessageIndex < combinedMessages.length - 1) {
          setSelectedMessageIndex((i) => i + 1);
          setMessageScrollOffset(0);
        }
      } else if (input === 'p') {
        // Previous message
        if (selectedMessageIndex > 0) {
          setSelectedMessageIndex((i) => i - 1);
          setMessageScrollOffset(0);
        }
      }
    } else if (viewMode === 'conversation' && expandedResult) {
      // Conversation view navigation
      // Use same calculation as ConversationView component
      const headerHeight = 5 + (conversationFiles.length > 0 ? 1 : 0);
      const messagesPerPage = Math.max(1, Math.floor((availableHeight - headerHeight) / 3));
      const maxScrollOffset = Math.max(0, combinedMessages.length - messagesPerPage);

      if (key.escape || key.backspace || key.delete) {
        setViewMode('matches');
        setCombinedMessages([]);
        setMessageIndexMap(new Map());
        setHighlightMessageIndex(undefined);
        setSelectedMessageIndex(0);
      } else if (input === 'j' || key.downArrow) {
        const newIdx = Math.min(selectedMessageIndex + 1, combinedMessages.length - 1);
        setSelectedMessageIndex(newIdx);
        // Adjust scroll to keep selected message visible
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
        // Open message detail view
        setViewMode('message');
        setMessageScrollOffset(0);
      }
    } else if (viewMode === 'matches' && expandedResult) {
      // Matches view navigation
      if (key.escape || key.backspace || key.delete) {
        setViewMode('list');
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
          if (newIdx < offset) {
            offset = newIdx;
          } else if (newIdx >= offset + matchesPerPage) {
            offset = newIdx - matchesPerPage + 1;
          }
          offset = Math.min(Math.max(offset, 0), maxOffset);
          setExpandedScrollOffset(offset);
          return newIdx;
        });
      } else if (input === 'k' || key.upArrow) {
        setExpandedSelectedMatch((i) => {
          const newIdx = Math.max(findNextDistinctMatch(i, -1), 0);
          const matchesPerPage = Math.max(1, Math.floor((height - 8) / 4));
          const maxOffset = Math.max(0, expandedResult.matches.length - matchesPerPage);
          let offset = expandedScrollOffset;
          if (newIdx < offset) {
            offset = newIdx;
          } else if (newIdx >= offset + matchesPerPage) {
            offset = newIdx - matchesPerPage + 1;
          }
          offset = Math.min(Math.max(offset, 0), maxOffset);
          setExpandedScrollOffset(offset);
          return newIdx;
        });
      } else if (key.return) {
        // Open full conversation view, scrolled to the selected match
        const selectedMatch = expandedResult.matches[expandedSelectedMatch];
        if (selectedMatch) {
          setViewMode('conversation');
          loadConversation(expandedResult.conversation.id, selectedMatch.messageIndex);
        }
      }
    } else {
      // List view navigation

      // Multi-select mode handling
      if (multiSelectMode) {
        if (input === ' ') {
          const current = response.results[selectedIndex];
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

      // Export trigger (single conversation, any view)
      if (input === 'e' && !multiSelectMode) {
        setExportMode('action-menu');
        return;
      }

      // Multi-select trigger
      if (input === 'v') {
        setMultiSelectMode(true);
        return;
      }

      // Standard navigation
      if (input === 'j' || key.downArrow) {
        setSelectedIndex((i) => Math.min(i + 1, response.results.length - 1));
      } else if (input === 'k' || key.upArrow) {
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (key.return || input === 'o') {
        if (!multiSelectMode) {
          setViewMode('matches');
          setExpandedIndex(selectedIndex);
          setExpandedScrollOffset(0);
          setExpandedSelectedMatch(0);
        }
      }
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

  // Footer keybindings styled with keys highlighted
  const Key = ({ k }: { k: string }) => <Text color="white">{k}</Text>;
  const Sep = () => <Text dimColor> · </Text>;

  let footerContent: React.ReactNode;
  if (viewMode === 'message') {
    footerContent = (
      <>
        <Key k="j/k" /><Text dimColor>: scroll</Text><Sep />
        <Key k="n/p" /><Text dimColor>: next/prev</Text><Sep />
        <Key k="g/G" /><Text dimColor>: top/bottom</Text><Sep />
        <Key k="Esc" /><Text dimColor>: back</Text><Sep />
        <Key k="q" /><Text dimColor>: quit</Text>
      </>
    );
  } else if (viewMode === 'conversation') {
    footerContent = (
      <>
        <Key k="j/k" /><Text dimColor>: select</Text><Sep />
        <Key k="Enter" /><Text dimColor>: view full</Text><Sep />
        <Key k="g/G" /><Text dimColor>: top/bottom</Text><Sep />
        <Key k="Esc" /><Text dimColor>: back</Text><Sep />
        <Key k="q" /><Text dimColor>: quit</Text>
      </>
    );
  } else if (viewMode === 'matches') {
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
            <>
              <Text color="yellow" bold>--file "{filePattern}"</Text>
            </>
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
        ) : viewMode === 'message' && combinedMessages[selectedMessageIndex] ? (
          <MessageDetailView
            message={combinedMessages[selectedMessageIndex]!}
            messageFiles={conversationMessageFiles}
            width={width - 2}
            height={availableHeight}
            scrollOffset={messageScrollOffset}
            query={query}
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
            query={query}
            indexMap={messageIndexMap}
            combinedMessageCount={combinedMessages.length}
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
                  isSelected={actualIndex === selectedIndex}
                  width={multiSelectMode ? width - 6 : width - 2}
                  query={query}
                  fileMatches={convFileMatches}
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
          {viewMode === 'list' && response.results.length > visibleCount && (
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

      {/* Export preview overlay */}
      {exportMode === 'preview' && (
        <ExportPreviewModal
          content={previewContent}
          title={getConversationsToExport()[0]?.title ?? 'Preview'}
          scrollOffset={previewScrollOffset}
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

async function plainSearch(query: string, limit: number, filePattern?: string): Promise<void> {
  await connect();
  const startTime = Date.now();

  let results: { conversation: { id: string; title: string; source: string; workspacePath?: string; updatedAt?: string }; totalMatches: number; snippet: string }[] = [];
  let totalConversations = 0;
  let totalMessages = 0;

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

    results = conversations
      .filter((conv): conv is NonNullable<typeof conv> => conv !== null)
      .map((conv) => {
        const matches = convIdToMatches.get(conv.id) ?? [];
        return {
          conversation: conv,
          totalMatches: matches.length,
          snippet: matches.slice(0, 3).map((m) => m.filePath.split('/').pop()).join(', '),
        };
      });
    totalConversations = results.length;
  } else if (filePattern && query) {
    // Combined search
    const result = await search(query, limit * 2);
    const convIds = new Set(result.results.map((r) => r.conversation.id));
    const fileMatchMap = await getFileMatchesForConversations(convIds, filePattern);

    results = result.results
      .filter((r) => (fileMatchMap.get(r.conversation.id) ?? []).length > 0)
      .slice(0, limit)
      .map((r) => ({
        conversation: r.conversation,
        totalMatches: r.totalMatches,
        snippet: r.bestMatch.snippet,
      }));
    totalConversations = results.length;
    totalMessages = result.totalMessages;
  } else {
    // Standard search
    const result = await search(query, limit);
    results = result.results.map((r) => ({
      conversation: r.conversation,
      totalMatches: r.totalMatches,
      snippet: r.bestMatch.snippet,
    }));
    totalConversations = result.totalConversations;
    totalMessages = result.totalMessages;
  }

  const searchTimeMs = Date.now() - startTime;
  const searchLabel = filePattern && !query
    ? `--file "${filePattern}"`
    : filePattern
      ? `"${query}" --file "${filePattern}"`
      : `"${query}"`;

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
    const sourceName = formatSourceName(r.conversation.source as 'cursor' | 'claude-code' | 'codex' | 'opencode');
    console.log(`   ${sourceName}`);
    if (r.conversation.workspacePath) {
      console.log(`   ${r.conversation.workspacePath}`);
    }
    console.log(`   ${r.totalMatches} match(es) · ${formatRelativeTime(r.conversation.updatedAt)}`);
    console.log(`   "${r.snippet.replace(/\n/g, ' ').slice(0, 100)}${r.snippet.length > 100 ? '...' : ''}"`);
    console.log(`   ID: ${r.conversation.id}`);
    console.log('');
  }
}

export async function searchCommand(query: string, options: SearchOptions): Promise<void> {
  const limit = parseInt(options.limit ?? '20', 10);
  const filePattern = options.file;

  // Require at least query or file pattern
  if (!query && !filePattern) {
    console.error('Error: Please provide a search query or --file pattern');
    process.exit(1);
  }

  if (!process.stdin.isTTY) {
    await plainSearch(query, limit, filePattern);
    return;
  }

  const app = withFullScreen(<SearchApp query={query} limit={limit} filePattern={filePattern} />);
  await app.start();
  await app.waitUntilExit();
}
