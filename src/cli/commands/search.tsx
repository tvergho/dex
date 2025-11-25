import React, { useState, useEffect, useMemo } from 'react';
import { render, Box, Text, useInput, useApp } from 'ink';
import { withFullScreen, useScreenSize } from 'fullscreen-ink';
import { connect } from '../../db/index.js';
import { search, conversationRepo, messageRepo, filesRepo, messageFilesRepo } from '../../db/repository.js';
import type { SearchResponse, ConversationResult, MessageMatch, Conversation, Message, ConversationFile, MessageFile } from '../../schema/index.js';

interface SearchOptions {
  limit?: string;
}

type ViewMode = 'list' | 'matches' | 'conversation' | 'message';

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

// Render text with highlighted search terms
function HighlightedText({
  text,
  query,
  dimColor,
}: {
  text: string;
  query: string;
  dimColor?: boolean;
}) {
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 0);
  if (terms.length === 0) {
    return <Text dimColor={dimColor}>{text}</Text>;
  }

  // Build regex to match any term
  const escapedTerms = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const regex = new RegExp(`(${escapedTerms.join('|')})`, 'gi');

  const parts = text.split(regex);

  return (
    <Text dimColor={dimColor} wrap="wrap">
      {parts.map((part, i) => {
        const isMatch = terms.some((t) => part.toLowerCase() === t);
        if (isMatch) {
          return <Text key={i} color="yellow" bold>{part}</Text>;
        }
        return <Text key={i}>{part}</Text>;
      })}
    </Text>
  );
}

function ResultRow({
  result,
  isSelected,
  width,
  query,
}: {
  result: ConversationResult;
  isSelected: boolean;
  width: number;
  query: string;
}) {
  const { conversation, bestMatch, totalMatches } = result;

  const metaWidth = 25;
  const prefixWidth = 2;
  const maxTitleWidth = Math.max(20, width - metaWidth - prefixWidth - 4);

  const title = conversation.title.length > maxTitleWidth
    ? conversation.title.slice(0, maxTitleWidth - 1) + '…'
    : conversation.title;

  const timeStr = formatRelativeTime(conversation.updatedAt);
  const matchStr = `${totalMatches} match${totalMatches !== 1 ? 'es' : ''}`;

  // Build project info line
  const projectParts: string[] = [];
  if (conversation.projectName) {
    projectParts.push(conversation.projectName);
  }
  if (conversation.mode) {
    projectParts.push(conversation.mode);
  }
  const projectInfo = projectParts.length > 0 ? projectParts.join(' · ') : null;

  // Truncate workspace path if needed
  const workspacePath = conversation.workspacePath;
  const maxPathWidth = width - 6;
  const displayPath = workspacePath
    ? (workspacePath.length > maxPathWidth ? '…' + workspacePath.slice(-(maxPathWidth - 1)) : workspacePath)
    : null;

  const snippetText = bestMatch.snippet.replace(/\n/g, ' ').slice(0, width - 6);

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={isSelected ? 'cyan' : 'white'} bold={isSelected}>
          {isSelected ? '▸ ' : '  '}
          {title}
        </Text>
        <Text dimColor> · {matchStr} · {timeStr}</Text>
      </Box>
      {projectInfo && (
        <Box marginLeft={4}>
          <Text color="yellow" dimColor>{projectInfo}</Text>
        </Box>
      )}
      {displayPath && (
        <Box marginLeft={4}>
          <Text color="magenta">{displayPath}</Text>
        </Box>
      )}
      <Box marginLeft={4}>
        <HighlightedText text={snippetText} query={query} dimColor />
      </Box>
    </Box>
  );
}

function MatchesView({
  result,
  files,
  messageFiles,
  width,
  height,
  scrollOffset,
  selectedMatchIndex,
  query,
}: {
  result: ConversationResult;
  files: ConversationFile[];
  messageFiles: MessageFile[];
  width: number;
  height: number;
  scrollOffset: number;
  selectedMatchIndex: number;
  query: string;
}) {
  const { conversation, matches } = result;

  // Build project context info
  const projectParts: string[] = [];
  if (conversation.projectName) {
    projectParts.push(conversation.projectName);
  } else if (conversation.workspacePath) {
    // Extract last part of workspace path as project name
    const parts = conversation.workspacePath.split('/').filter(Boolean);
    if (parts.length > 0) {
      projectParts.push(parts[parts.length - 1]!);
    }
  }
  if (conversation.mode) {
    projectParts.push(conversation.mode);
  }
  if (conversation.model) {
    projectParts.push(conversation.model);
  }

  // Get unique file names (just the filename, not full path)
  const fileNames = files.slice(0, 5).map((f) => {
    const parts = f.filePath.split('/');
    return parts[parts.length - 1] || f.filePath;
  });

  const headerHeight = files.length > 0 ? 6 : 4;
  const availableHeight = height - headerHeight;
  const matchesPerPage = Math.max(1, Math.floor(availableHeight / 2));

  const visibleMatches = matches.slice(scrollOffset, scrollOffset + matchesPerPage);

  return (
    <Box flexDirection="column" height={height}>
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color="cyan">{conversation.title}</Text>
        {projectParts.length > 0 && (
          <Text color="yellow">{projectParts.join(' · ')}</Text>
        )}
        {conversation.workspacePath && (
          <Text color="magenta">
            {conversation.workspacePath.length > width - 4
              ? '…' + conversation.workspacePath.slice(-(width - 7))
              : conversation.workspacePath}
          </Text>
        )}
        {fileNames.length > 0 && (
          <Text dimColor>
            Files: {fileNames.join(', ')}{files.length > 5 ? ` (+${files.length - 5} more)` : ''}
          </Text>
        )}
        <Text dimColor>
          {matches.length} match{matches.length !== 1 ? 'es' : ''}
        </Text>
      </Box>

      <Box flexDirection="column" flexGrow={1}>
        {visibleMatches.map((match, idx) => {
          const actualIdx = scrollOffset + idx;
          const isSelected = actualIdx === selectedMatchIndex;

          // Get files for this message
          const msgFiles = messageFiles.filter((f) => f.messageId === match.messageId);
          const msgFileNames = msgFiles.map((f) => {
            const parts = f.filePath.split('/');
            return parts[parts.length - 1] || f.filePath;
          });

          const roleColor = match.role === 'user' ? 'green' : 'blue';

          return (
            <Box
              key={match.messageId}
              flexDirection="column"
              marginBottom={0}
            >
              <Box>
                <Text backgroundColor={isSelected ? 'cyan' : undefined} color={isSelected ? 'black' : roleColor} bold>
                  {isSelected ? ' ▸ ' : '   '}{match.role === 'user' ? 'You' : 'Assistant'}
                </Text>
                {msgFileNames.length > 0 && (
                  <Text dimColor={!isSelected}> ({msgFileNames.join(', ')})</Text>
                )}
                <Text dimColor={!isSelected}> · msg {match.messageIndex + 1}</Text>
              </Box>
              <Box marginLeft={5}>
                <HighlightedText
                  text={match.content.replace(/\n/g, ' ').slice(0, width - 8)}
                  query={query}
                  dimColor={!isSelected}
                />
              </Box>
            </Box>
          );
        })}
      </Box>

      {matches.length > matchesPerPage && (
        <Text dimColor>
          {scrollOffset + 1}-{Math.min(scrollOffset + matchesPerPage, matches.length)} of {matches.length}
        </Text>
      )}
    </Box>
  );
}

function ConversationView({
  conversation,
  messages,
  files,
  messageFiles,
  width,
  height,
  scrollOffset,
  highlightMessageIndex,
  selectedIndex,
}: {
  conversation: Conversation;
  messages: Message[];
  files: ConversationFile[];
  messageFiles: MessageFile[];
  width: number;
  height: number;
  scrollOffset: number;
  highlightMessageIndex?: number;
  selectedIndex: number;
}) {
  // Build project context info
  const projectParts: string[] = [];
  if (conversation.projectName) {
    projectParts.push(conversation.projectName);
  } else if (conversation.workspacePath) {
    const parts = conversation.workspacePath.split('/').filter(Boolean);
    if (parts.length > 0) {
      projectParts.push(parts[parts.length - 1]!);
    }
  }
  if (conversation.mode) {
    projectParts.push(conversation.mode);
  }
  if (conversation.model) {
    projectParts.push(conversation.model);
  }

  // Get file names
  const fileNames = files.slice(0, 5).map((f) => {
    const parts = f.filePath.split('/');
    return parts[parts.length - 1] || f.filePath;
  });

  // Header: title + project info + workspace path + files (optional) + message count
  const headerHeight = 4 + (files.length > 0 ? 1 : 0);
  const availableHeight = height - headerHeight;
  const messagesPerPage = Math.max(1, Math.floor(availableHeight / 3));

  const visibleMessages = messages.slice(scrollOffset, scrollOffset + messagesPerPage);

  return (
    <Box flexDirection="column" height={height}>
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color="cyan">{conversation.title}</Text>
        {projectParts.length > 0 && (
          <Text color="yellow">{projectParts.join(' · ')}</Text>
        )}
        {conversation.workspacePath && (
          <Text color="magenta">
            {conversation.workspacePath.length > width - 4
              ? '…' + conversation.workspacePath.slice(-(width - 7))
              : conversation.workspacePath}
          </Text>
        )}
        {fileNames.length > 0 && (
          <Text dimColor>
            Files: {fileNames.join(', ')}{files.length > 5 ? ` (+${files.length - 5} more)` : ''}
          </Text>
        )}
        <Text dimColor>
          {messages.length} message{messages.length !== 1 ? 's' : ''}
          {messages.length > messagesPerPage && ` · ${scrollOffset + 1}-${Math.min(scrollOffset + messagesPerPage, messages.length)} of ${messages.length}`}
        </Text>
      </Box>

      <Box flexDirection="column" flexGrow={1}>
        {visibleMessages.map((msg, idx) => {
          const actualIdx = scrollOffset + idx;
          const isHighlighted = actualIdx === highlightMessageIndex;
          const isSelected = actualIdx === selectedIndex;
          const roleLabel = msg.role === 'user' ? 'You' : msg.role === 'assistant' ? 'Assistant' : 'System';
          const roleColor = msg.role === 'user' ? 'green' : msg.role === 'assistant' ? 'blue' : 'yellow';

          // Get files for this message
          const msgFiles = messageFiles.filter((f) => f.messageId === msg.id);
          const msgFileNames = msgFiles.map((f) => {
            const parts = f.filePath.split('/');
            return parts[parts.length - 1] || f.filePath;
          });

          // Truncate messages to ~2 lines for readable view
          const maxLen = (width - 8) * 2;
          const truncatedContent = msg.content.replace(/\n/g, ' ').slice(0, maxLen);
          const isTruncated = msg.content.length > maxLen;

          // Determine visual state
          const bgColor = isSelected ? 'cyan' : isHighlighted ? 'yellow' : undefined;
          const textColor = isSelected || isHighlighted ? 'black' : roleColor;

          return (
            <Box
              key={msg.id}
              flexDirection="column"
              marginBottom={1}
            >
              <Box>
                <Text backgroundColor={bgColor} color={textColor} bold>
                  {isSelected ? ' ▸ ' : isHighlighted ? ' ★ ' : '   '}[{roleLabel}]
                </Text>
                {msgFileNames.length > 0 && (
                  <Text dimColor={!isSelected && !isHighlighted}> ({msgFileNames.join(', ')})</Text>
                )}
                {isHighlighted && !isSelected && (
                  <Text color="yellow"> (matched)</Text>
                )}
                {isTruncated && isSelected && (
                  <Text color="cyan"> ↵</Text>
                )}
              </Box>
              <Box marginLeft={5}>
                <Text dimColor={!isSelected && !isHighlighted} wrap="wrap">{truncatedContent}{isTruncated ? '…' : ''}</Text>
              </Box>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}

function MessageDetailView({
  message,
  messageFiles,
  width,
  height,
  scrollOffset,
  query,
}: {
  message: Message;
  messageFiles: MessageFile[];
  width: number;
  height: number;
  scrollOffset: number;
  query: string;
}) {
  const roleLabel = message.role === 'user' ? 'You' : message.role === 'assistant' ? 'Assistant' : 'System';
  const roleColor = message.role === 'user' ? 'green' : message.role === 'assistant' ? 'blue' : 'yellow';

  // Get file names for this message
  const fileNames = messageFiles.map((f) => {
    const parts = f.filePath.split('/');
    return parts[parts.length - 1] || f.filePath;
  });

  // Split content into lines for scrolling
  const lines = message.content.split('\n');
  const headerHeight = 3;
  const footerHeight = 2;
  const availableHeight = height - headerHeight - footerHeight;
  const visibleLines = lines.slice(scrollOffset, scrollOffset + availableHeight);

  return (
    <Box flexDirection="column" height={height}>
      <Box flexDirection="column" marginBottom={1}>
        <Box>
          <Text color={roleColor} bold>[{roleLabel}]</Text>
          <Text dimColor> · Message {message.messageIndex + 1}</Text>
          {fileNames.length > 0 && (
            <Text dimColor> · Files: {fileNames.join(', ')}</Text>
          )}
        </Box>
        <Text dimColor>
          {lines.length} lines · {scrollOffset + 1}-{Math.min(scrollOffset + availableHeight, lines.length)} of {lines.length}
        </Text>
      </Box>

      <Box flexDirection="column" flexGrow={1}>
        <HighlightedText
          text={visibleLines.join('\n')}
          query={query}
        />
      </Box>
    </Box>
  );
}

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
  const [conversationMessages, setConversationMessages] = useState<Message[]>([]);
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

  // Load files when expanding a conversation
  useEffect(() => {
    if (expandedIndex !== null && response?.results[expandedIndex]) {
      const convId = response.results[expandedIndex]!.conversation.id;
      filesRepo.findByConversation(convId).then(setConversationFiles);
      messageFilesRepo.findByConversation(convId).then(setConversationMessageFiles);
    } else {
      setConversationFiles([]);
      setConversationMessageFiles([]);
    }
  }, [expandedIndex, response]);

  const headerHeight = 3;
  const footerHeight = 2;
  const rowHeight = 3;
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
    setConversationMessages(msgs);

    // Scroll to show the highlighted message and select it
    if (targetMessageIndex !== undefined) {
      const messagesPerPage = Math.max(1, Math.floor((height - 8) / 3));
      const targetScroll = Math.max(0, targetMessageIndex - Math.floor(messagesPerPage / 2));
      setConversationScrollOffset(Math.min(targetScroll, Math.max(0, msgs.length - messagesPerPage)));
      setHighlightMessageIndex(targetMessageIndex);
      setSelectedMessageIndex(targetMessageIndex); // Also select the matching message
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

    if (viewMode === 'message' && conversationMessages.length > 0) {
      // Message detail view navigation
      const currentMessage = conversationMessages[selectedMessageIndex];
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
        if (selectedMessageIndex < conversationMessages.length - 1) {
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
        setConversationMessages([]);
        setHighlightMessageIndex(undefined);
        setSelectedMessageIndex(0);
      } else if (input === 'j' || key.downArrow) {
        setSelectedMessageIndex((i) => Math.min(i + 1, conversationMessages.length - 1));
        // Adjust scroll to keep selected message visible
        const messagesPerPage = Math.max(1, Math.floor((height - 8) / 5));
        setConversationScrollOffset((o) => {
          const newIdx = Math.min(selectedMessageIndex + 1, conversationMessages.length - 1);
          if (newIdx >= o + messagesPerPage) {
            return Math.min(o + 1, Math.max(0, conversationMessages.length - messagesPerPage));
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
        const messagesPerPage = Math.max(1, Math.floor((height - 8) / 5));
        setConversationScrollOffset(Math.max(0, conversationMessages.length - messagesPerPage));
        setSelectedMessageIndex(conversationMessages.length - 1);
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
      <Box paddingX={1} marginBottom={1}>
        <Text bold>Search: </Text>
        <Text color="cyan">"{response.query}"</Text>
        <Text dimColor>
          {' '}— {response.totalConversations} conversation{response.totalConversations !== 1 ? 's' : ''}
          , {response.totalMessages} message{response.totalMessages !== 1 ? 's' : ''} ({response.searchTimeMs}ms)
        </Text>
      </Box>

      {/* Content */}
      <Box flexDirection="column" flexGrow={1} paddingX={1}>
        {response.results.length === 0 ? (
          <Text dimColor>No results found.</Text>
        ) : viewMode === 'message' && conversationMessages[selectedMessageIndex] ? (
          <MessageDetailView
            message={conversationMessages[selectedMessageIndex]!}
            messageFiles={conversationMessageFiles.filter((f) => f.messageId === conversationMessages[selectedMessageIndex]!.id)}
            width={width - 2}
            height={availableHeight}
            scrollOffset={messageScrollOffset}
            query={query}
          />
        ) : viewMode === 'conversation' && expandedResult ? (
          <ConversationView
            conversation={expandedResult.conversation}
            messages={conversationMessages}
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
          />
        ) : (
          visibleResults.map((result, idx) => {
            const actualIndex = scrollOffset + idx;
            return (
              <Box key={result.conversation.id} marginBottom={1}>
                <ResultRow
                  result={result}
                  isSelected={actualIndex === selectedIndex}
                  width={width - 2}
                  query={query}
                />
              </Box>
            );
          })
        )}
      </Box>

      {/* Scroll indicator for list view */}
      {viewMode === 'list' && response.results.length > visibleCount && (
        <Box paddingX={1}>
          <Text dimColor>
            {scrollOffset + 1}-{Math.min(scrollOffset + visibleCount, response.results.length)} of {response.results.length}
          </Text>
        </Box>
      )}

      {/* Footer */}
      <Box paddingX={1} marginTop={1}>
        <Text dimColor>{footerText}</Text>
      </Box>
    </Box>
  );
}

async function plainSearch(query: string, limit: number): Promise<void> {
  await connect();
  const result = await search(query, limit);

  console.log(`\nSearch: "${result.query}"`);
  console.log(
    `${result.totalConversations} conversation(s), ${result.totalMessages} message(s) (${result.searchTimeMs}ms)\n`
  );

  if (result.results.length === 0) {
    console.log('No results found.');
    return;
  }

  for (const r of result.results) {
    console.log(`${r.conversation.title} [${r.conversation.source}]`);
    const projectParts: string[] = [];
    if (r.conversation.projectName) projectParts.push(r.conversation.projectName);
    if (r.conversation.mode) projectParts.push(r.conversation.mode);
    if (projectParts.length > 0) {
      console.log(`   ${projectParts.join(' · ')}`);
    }
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
