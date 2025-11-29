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

import React, { useState, useEffect, useMemo } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import { withFullScreen, useScreenSize } from 'fullscreen-ink';
import { connect } from '../../db/index';
import { search, messageRepo, filesRepo, messageFilesRepo } from '../../db/repository';
import {
  ResultRow,
  MatchesView,
  ConversationView,
  MessageDetailView,
} from '../components/index';
import {
  formatRelativeTime,
  formatSourceName,
  formatConversationCount,
  formatMessageCount,
  combineConsecutiveMessages,
  type CombinedMessage,
} from '../../utils/format';
import type { SearchResponse, ConversationFile, MessageFile } from '../../schema/index';

interface SearchOptions {
  limit?: string;
}

type ViewMode = 'list' | 'matches' | 'conversation' | 'message';

function SearchApp({
  query,
  limit,
}: {
  query: string;
  limit: number;
}) {
  const { exit } = useApp();
  const { width, height } = useScreenSize();

  // Search state
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [response, setResponse] = useState<SearchResponse | null>(null);

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

  useEffect(() => {
    async function runSearch() {
      try {
        await connect();
        const result = await search(query, limit);
        setResponse(result);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    }
    runSearch();
  }, [query, limit]);

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

  // Load conversation messages when entering conversation view
  const loadConversation = async (conversationId: string, targetMessageIndex?: number) => {
    const msgs = await messageRepo.findByConversation(conversationId);
    const { messages: combined, indexMap } = combineConsecutiveMessages(msgs);
    setCombinedMessages(combined);
    setMessageIndexMap(indexMap);

    // Scroll to show the highlighted message and select it
    if (targetMessageIndex !== undefined) {
      // Convert original messageIndex to combined index
      const combinedIdx = indexMap.get(targetMessageIndex) ?? 0;
      const messagesPerPage = Math.max(1, Math.floor((height - 6) / 3));
      const targetScroll = Math.max(0, combinedIdx - Math.floor(messagesPerPage / 2));
      setConversationScrollOffset(Math.min(targetScroll, Math.max(0, combined.length - messagesPerPage)));
      setHighlightMessageIndex(combinedIdx);
      setSelectedMessageIndex(combinedIdx);
    } else {
      setConversationScrollOffset(0);
      setHighlightMessageIndex(undefined);
      setSelectedMessageIndex(0);
    }
  };

  useInput((input, key) => {
    if (input === 'q') {
      exit();
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
      if (key.escape || key.backspace || key.delete) {
        setViewMode('matches');
        setCombinedMessages([]);
        setMessageIndexMap(new Map());
        setHighlightMessageIndex(undefined);
        setSelectedMessageIndex(0);
      } else if (input === 'j' || key.downArrow) {
        setSelectedMessageIndex((i) => Math.min(i + 1, combinedMessages.length - 1));
        // Adjust scroll to keep selected message visible
        const messagesPerPage = Math.max(1, Math.floor((height - 6) / 3));
        setConversationScrollOffset((o) => {
          const newIdx = Math.min(selectedMessageIndex + 1, combinedMessages.length - 1);
          if (newIdx >= o + messagesPerPage) {
            return Math.min(o + 1, Math.max(0, combinedMessages.length - messagesPerPage));
          }
          return o;
        });
      } else if (input === 'k' || key.upArrow) {
        setSelectedMessageIndex((i) => Math.max(i - 1, 0));
        setConversationScrollOffset((o) => {
          const newIdx = Math.max(selectedMessageIndex - 1, 0);
          if (newIdx < o) {
            return Math.max(o - 1, 0);
          }
          return o;
        });
      } else if (input === 'g') {
        setConversationScrollOffset(0);
        setSelectedMessageIndex(0);
      } else if (input === 'G') {
        const messagesPerPage = Math.max(1, Math.floor((height - 6) / 3));
        setConversationScrollOffset(Math.max(0, combinedMessages.length - messagesPerPage));
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
          const newIdx = Math.min(i + 1, maxIdx);
          // Adjust scroll if needed
          const matchesPerPage = Math.max(1, Math.floor((height - 8) / 4));
          if (newIdx >= expandedScrollOffset + matchesPerPage) {
            setExpandedScrollOffset((o) => Math.min(o + 1, Math.max(0, expandedResult.matches.length - matchesPerPage)));
          }
          return newIdx;
        });
      } else if (input === 'k' || key.upArrow) {
        setExpandedSelectedMatch((i) => {
          const newIdx = Math.max(i - 1, 0);
          if (newIdx < expandedScrollOffset) {
            setExpandedScrollOffset((o) => Math.max(o - 1, 0));
          }
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
      if (input === 'j' || key.downArrow) {
        setSelectedIndex((i) => Math.min(i + 1, response.results.length - 1));
      } else if (input === 'k' || key.upArrow) {
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (key.return || input === 'o') {
        setViewMode('matches');
        setExpandedIndex(selectedIndex);
        setExpandedScrollOffset(0);
        setExpandedSelectedMatch(0);
      }
    }
  });

  if (loading) {
    return (
      <Box width={width} height={height} alignItems="center" justifyContent="center">
        <Text color="cyan">Searching for "{query}"...</Text>
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

  // Determine footer text based on view mode
  let footerText = 'j/k: navigate · Enter: expand · q: quit';
  if (viewMode === 'matches') {
    footerText = 'j/k: navigate · Enter: view conversation · Esc: back · q: quit';
  } else if (viewMode === 'conversation') {
    footerText = 'j/k: select · Enter: view full message · g/G: top/bottom · Esc: back · q: quit';
  } else if (viewMode === 'message') {
    footerText = 'j/k: scroll · n/p: next/prev message · g/G: top/bottom · Esc: back · q: quit';
  }

  return (
    <Box width={width} height={height} flexDirection="column">
      {/* Header */}
      <Box flexDirection="column" marginBottom={1}>
        <Box paddingX={1}>
          <Text bold color="white">Search </Text>
          <Text color="cyan" bold>"{response.query}"</Text>
          <Text dimColor>
            {' '}— {formatConversationCount(response.totalConversations)}
            , {formatMessageCount(response.totalMessages)} ({response.searchTimeMs}ms)
          </Text>
        </Box>
        <Box paddingX={1}>
          <Text dimColor>{'─'.repeat(Math.max(0, width - 2))}</Text>
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
            return (
              <ResultRow
                key={result.conversation.id}
                result={result}
                isSelected={actualIndex === selectedIndex}
                width={width - 2}
                query={query}
              />
            );
          })
        )}
      </Box>

      {/* Footer */}
      <Box flexDirection="column">
        <Box paddingX={1}>
          <Text dimColor>{'─'.repeat(Math.max(0, width - 2))}</Text>
        </Box>
        <Box paddingX={1} justifyContent="space-between">
          <Text dimColor>{footerText}</Text>
          {viewMode === 'list' && response.results.length > visibleCount && (
            <Text dimColor>
              {scrollOffset + 1}-{Math.min(scrollOffset + visibleCount, response.results.length)} of {response.results.length}
            </Text>
          )}
        </Box>
      </Box>
    </Box>
  );
}

async function plainSearch(query: string, limit: number): Promise<void> {
  await connect();
  const result = await search(query, limit);

  console.log(`\nSearch: "${result.query}"`);
  console.log(
    `${formatConversationCount(result.totalConversations)}, ${formatMessageCount(result.totalMessages)} (${result.searchTimeMs}ms)\n`
  );

  if (result.results.length === 0) {
    console.log('No results found.');
    return;
  }

  for (const r of result.results) {
    console.log(`${r.conversation.title}`);
    const sourceName = formatSourceName(r.conversation.source);
    console.log(`   ${sourceName}`);
    if (r.conversation.workspacePath) {
      console.log(`   ${r.conversation.workspacePath}`);
    }
    console.log(`   ${r.totalMatches} match(es) · ${formatRelativeTime(r.conversation.updatedAt)}`);
    console.log(`   "${r.bestMatch.snippet.replace(/\n/g, ' ').slice(0, 100)}${r.bestMatch.snippet.length > 100 ? '...' : ''}"`);
    console.log(`   ID: ${r.conversation.id}`);
    console.log('');
  }
}

export async function searchCommand(query: string, options: SearchOptions): Promise<void> {
  const limit = parseInt(options.limit ?? '20', 10);

  if (!process.stdin.isTTY) {
    await plainSearch(query, limit);
    return;
  }

  const app = withFullScreen(<SearchApp query={query} limit={limit} />);
  await app.start();
  await app.waitUntilExit();
}
