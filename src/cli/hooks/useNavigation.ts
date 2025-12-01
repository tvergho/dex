/**
 * useNavigation - Shared hook for 4-level navigation (list → matches → conversation → message)
 *
 * Extracts duplicated navigation logic from unified.tsx and search.tsx:
 * - View mode state machine
 * - Scroll offset management
 * - Combined messages and index mapping
 * - Match navigation helpers
 * - Keyboard handling for navigation
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { messageRepo, filesRepo, messageFilesRepo, toolCallRepo, fileEditsRepo } from '../../db/repository';
import {
  combineConsecutiveMessages,
  getRenderedLineCount,
  formatToolOutputs,
  type CombinedMessage,
} from '../../utils/format';
import type {
  Conversation,
  ConversationFile,
  MessageFile,
  ConversationResult,
  MessageMatch,
  ToolCall,
  FileEdit,
} from '../../schema/index';

export type NavigationViewMode = 'list' | 'matches' | 'conversation' | 'message';

export interface NavigationState {
  // View mode
  viewMode: NavigationViewMode;

  // List view
  selectedIndex: number;

  // Matches view
  expandedIndex: number | null;
  expandedScrollOffset: number;
  expandedSelectedMatch: number;

  // Conversation view
  combinedMessages: CombinedMessage[];
  messageIndexMap: Map<number, number>;
  conversationFiles: ConversationFile[];
  conversationMessageFiles: MessageFile[];
  conversationToolCalls: ToolCall[];
  conversationFileEdits: FileEdit[];
  conversationScrollOffset: number;
  highlightMessageIndex: number | undefined;
  selectedMessageIndex: number;

  // Message detail view
  messageScrollOffset: number;
}

export interface NavigationActions {
  // View transitions
  goToList: () => void;
  goToMatches: (index: number) => void;
  goToConversation: (conversationId: string, targetMessageIndex?: number) => Promise<void>;
  goToMessage: () => void;
  goBack: () => void;

  // List navigation
  selectNext: () => void;
  selectPrev: () => void;
  expandSelected: () => Promise<void>;

  // Matches navigation
  selectNextMatch: () => void;
  selectPrevMatch: () => void;
  expandMatch: () => Promise<void>;

  // Conversation navigation
  selectNextMessage: () => void;
  selectPrevMessage: () => void;
  scrollToTop: () => void;
  scrollToBottom: () => void;
  openMessageDetail: () => void;

  // Message detail navigation
  scrollMessageUp: () => void;
  scrollMessageDown: () => void;
  nextMessage: () => void;
  prevMessage: () => void;
  scrollMessageToTop: () => void;
  scrollMessageToBottom: () => void;

  // State setters for external control
  setViewMode: (mode: NavigationViewMode) => void;
  setSelectedIndex: (index: number) => void;
  resetNavigation: () => void;
}

export interface UseNavigationOptions {
  /** Display items (search results or conversation list) */
  displayItems: ConversationResult[];

  /** Available height for content */
  availableHeight: number;

  /** Terminal width for line count calculations */
  width: number;

  /** Whether we're in search mode (affects back navigation from conversation) */
  hasSearchResults: boolean;

  /** Callback when going back from list view (e.g., return to home) */
  onExitList?: () => void;
}

export interface UseNavigationResult {
  state: NavigationState;
  actions: NavigationActions;

  /** The currently expanded result (for matches/conversation views) */
  expandedResult: ConversationResult | null;

  /** Handle keyboard input, returns true if handled */
  handleNavigationInput: (input: string, key: {
    escape?: boolean;
    backspace?: boolean;
    delete?: boolean;
    return?: boolean;
    downArrow?: boolean;
    upArrow?: boolean;
  }) => boolean;
}

export function useNavigation({
  displayItems,
  availableHeight,
  width,
  hasSearchResults,
  onExitList,
}: UseNavigationOptions): UseNavigationResult {
  // View mode
  const [viewMode, setViewMode] = useState<NavigationViewMode>('list');

  // List view state
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Refs for stable callback access (avoids callback recreation on every state change)
  const selectedIndexRef = useRef(selectedIndex);
  const displayItemsRef = useRef(displayItems);
  const hasSearchResultsRef = useRef(hasSearchResults);

  // Keep refs in sync with state
  useEffect(() => {
    selectedIndexRef.current = selectedIndex;
  }, [selectedIndex]);
  useEffect(() => {
    displayItemsRef.current = displayItems;
  }, [displayItems]);
  useEffect(() => {
    hasSearchResultsRef.current = hasSearchResults;
  }, [hasSearchResults]);

  // Matches view state
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);
  const [expandedScrollOffset, setExpandedScrollOffset] = useState(0);
  const [expandedSelectedMatch, setExpandedSelectedMatch] = useState(0);

  // Conversation view state
  const [combinedMessages, setCombinedMessages] = useState<CombinedMessage[]>([]);
  const [messageIndexMap, setMessageIndexMap] = useState<Map<number, number>>(new Map());
  const [conversationFiles, setConversationFiles] = useState<ConversationFile[]>([]);
  const [conversationMessageFiles, setConversationMessageFiles] = useState<MessageFile[]>([]);
  const [conversationToolCalls, setConversationToolCalls] = useState<ToolCall[]>([]);
  const [conversationFileEdits, setConversationFileEdits] = useState<FileEdit[]>([]);
  const [conversationScrollOffset, setConversationScrollOffset] = useState(0);
  const [highlightMessageIndex, setHighlightMessageIndex] = useState<number | undefined>(undefined);
  const [selectedMessageIndex, setSelectedMessageIndex] = useState(0);

  // Message detail view state
  const [messageScrollOffset, setMessageScrollOffset] = useState(0);

  // Derived state
  const expandedResult = expandedIndex !== null ? displayItems[expandedIndex] ?? null : null;

  // Load files and messages when expanding a conversation
  useEffect(() => {
    if (expandedIndex !== null) {
      const conv = displayItems[expandedIndex]?.conversation;
      if (conv) {
        filesRepo.findByConversation(conv.id).then(setConversationFiles);
        messageFilesRepo.findByConversation(conv.id).then(setConversationMessageFiles);
        toolCallRepo.findByConversation(conv.id).then(setConversationToolCalls);
        fileEditsRepo.findByConversation(conv.id).then(setConversationFileEdits);
        messageRepo.findByConversation(conv.id).then((msgs) => {
          const { messages: combined, indexMap } = combineConsecutiveMessages(msgs);
          setCombinedMessages(combined);
          setMessageIndexMap(indexMap);
        });
      }
    } else {
      setConversationFiles([]);
      setConversationMessageFiles([]);
      setConversationToolCalls([]);
      setConversationFileEdits([]);
      setCombinedMessages([]);
      setMessageIndexMap(new Map());
    }
  }, [expandedIndex, displayItems]);

  // Layout calculations
  const headerHeight = 5 + (conversationFiles.length > 0 ? 1 : 0);
  const messagesPerPage = Math.max(1, Math.floor((availableHeight - headerHeight) / 3));
  const maxConversationScrollOffset = Math.max(0, combinedMessages.length - messagesPerPage);

  // Match navigation helpers
  const getCombinedIndexForMatch = useCallback((match: { messageIndex: number } | undefined): number | null => {
    if (!match) return null;
    return messageIndexMap.get(match.messageIndex) ?? match.messageIndex;
  }, [messageIndexMap]);

  const findNextDistinctMatch = useCallback((startIdx: number, direction: 1 | -1): number => {
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
  }, [expandedResult, getCombinedIndexForMatch]);

  // Actions
  const goToList = useCallback(() => {
    setViewMode('list');
    setExpandedIndex(null);
    setExpandedScrollOffset(0);
    setExpandedSelectedMatch(0);
    setCombinedMessages([]);
    setMessageIndexMap(new Map());
    setHighlightMessageIndex(undefined);
    setSelectedMessageIndex(0);
  }, []);

  const goToMatches = useCallback((index: number) => {
    setViewMode('matches');
    setExpandedIndex(index);
    setExpandedScrollOffset(0);
    setExpandedSelectedMatch(0);
  }, []);

  const goToConversation = useCallback(async (conversationId: string, targetMessageIndex?: number) => {
    const msgs = await messageRepo.findByConversation(conversationId);
    const { messages: combined, indexMap } = combineConsecutiveMessages(msgs);
    setCombinedMessages(combined);
    setMessageIndexMap(indexMap);

    const headerH = 6; // Safe estimate
    const perPage = Math.max(1, Math.floor((availableHeight - headerH) / 3));

    if (targetMessageIndex !== undefined) {
      const combinedIdx = indexMap.get(targetMessageIndex) ?? 0;
      const targetScroll = Math.max(0, combinedIdx - Math.floor(perPage / 2));
      const maxOffset = Math.max(0, combined.length - perPage);
      setConversationScrollOffset(Math.min(targetScroll, maxOffset));
      setHighlightMessageIndex(combinedIdx);
      setSelectedMessageIndex(combinedIdx);
    } else {
      setConversationScrollOffset(0);
      setHighlightMessageIndex(undefined);
      setSelectedMessageIndex(0);
    }

    setViewMode('conversation');
  }, [availableHeight]);

  const goToMessage = useCallback(() => {
    setViewMode('message');
    setMessageScrollOffset(0);
  }, []);

  const goBack = useCallback(() => {
    switch (viewMode) {
      case 'message':
        setViewMode('conversation');
        setMessageScrollOffset(0);
        break;
      case 'conversation':
        if (hasSearchResults && expandedResult && expandedResult.matches.length > 0) {
          setViewMode('matches');
        } else {
          goToList();
        }
        setCombinedMessages([]);
        setMessageIndexMap(new Map());
        setHighlightMessageIndex(undefined);
        setSelectedMessageIndex(0);
        break;
      case 'matches':
        goToList();
        break;
      case 'list':
        onExitList?.();
        break;
    }
  }, [viewMode, hasSearchResults, expandedResult, goToList, onExitList]);

  // List navigation - use refs for stable callbacks
  const selectNext = useCallback(() => {
    setSelectedIndex((i) => Math.min(i + 1, displayItemsRef.current.length - 1));
  }, []);

  const selectPrev = useCallback(() => {
    setSelectedIndex((i) => Math.max(i - 1, 0));
  }, []);

  const expandSelected = useCallback(async () => {
    // Use refs for stable callback - avoids recreation on every selectedIndex change
    const idx = selectedIndexRef.current;
    const items = displayItemsRef.current;
    const hasResults = hasSearchResultsRef.current;

    const item = items[idx];
    if (!item) return;

    if (hasResults && item.matches.length > 0) {
      goToMatches(idx);
    } else {
      setExpandedIndex(idx);
      await goToConversation(item.conversation.id);
    }
  }, [goToMatches, goToConversation]);

  // Matches navigation
  const selectNextMatch = useCallback(() => {
    if (!expandedResult) return;
    const maxIdx = expandedResult.matches.length - 1;
    setExpandedSelectedMatch((i) => {
      const newIdx = Math.min(findNextDistinctMatch(i, 1), maxIdx);
      const matchesPerPage = Math.max(1, Math.floor((availableHeight - 8) / 4));
      const maxOffset = Math.max(0, expandedResult.matches.length - matchesPerPage);
      let offset = expandedScrollOffset;
      if (newIdx >= offset + matchesPerPage) {
        offset = newIdx - matchesPerPage + 1;
      }
      setExpandedScrollOffset(Math.min(Math.max(offset, 0), maxOffset));
      return newIdx;
    });
  }, [expandedResult, findNextDistinctMatch, expandedScrollOffset, availableHeight]);

  const selectPrevMatch = useCallback(() => {
    if (!expandedResult) return;
    setExpandedSelectedMatch((i) => {
      const newIdx = Math.max(findNextDistinctMatch(i, -1), 0);
      const matchesPerPage = Math.max(1, Math.floor((availableHeight - 8) / 4));
      let offset = expandedScrollOffset;
      if (newIdx < offset) {
        offset = newIdx;
      }
      setExpandedScrollOffset(Math.max(offset, 0));
      return newIdx;
    });
  }, [expandedResult, findNextDistinctMatch, expandedScrollOffset, availableHeight]);

  const expandMatch = useCallback(async () => {
    if (!expandedResult) return;
    const selectedMatch = expandedResult.matches[expandedSelectedMatch];
    if (selectedMatch) {
      await goToConversation(expandedResult.conversation.id, selectedMatch.messageIndex);
    }
  }, [expandedResult, expandedSelectedMatch, goToConversation]);

  // Conversation navigation
  const selectNextMessage = useCallback(() => {
    const newIdx = Math.min(selectedMessageIndex + 1, combinedMessages.length - 1);
    setSelectedMessageIndex(newIdx);
    if (newIdx >= conversationScrollOffset + messagesPerPage) {
      setConversationScrollOffset(Math.min(newIdx - messagesPerPage + 1, maxConversationScrollOffset));
    }
  }, [selectedMessageIndex, combinedMessages.length, conversationScrollOffset, messagesPerPage, maxConversationScrollOffset]);

  const selectPrevMessage = useCallback(() => {
    const newIdx = Math.max(selectedMessageIndex - 1, 0);
    setSelectedMessageIndex(newIdx);
    if (newIdx < conversationScrollOffset) {
      setConversationScrollOffset(newIdx);
    }
  }, [selectedMessageIndex, conversationScrollOffset]);

  const scrollToTop = useCallback(() => {
    setConversationScrollOffset(0);
    setSelectedMessageIndex(0);
  }, []);

  const scrollToBottom = useCallback(() => {
    setConversationScrollOffset(maxConversationScrollOffset);
    setSelectedMessageIndex(combinedMessages.length - 1);
  }, [maxConversationScrollOffset, combinedMessages.length]);

  const openMessageDetail = useCallback(() => {
    goToMessage();
  }, [goToMessage]);

  // Message detail navigation - calculate line count including tool outputs
  const currentMessage = combinedMessages[selectedMessageIndex];
  const fullContent = useMemo(() => {
    if (!currentMessage) return '';
    let content = currentMessage.content;
    if (currentMessage.role === 'assistant') {
      content += formatToolOutputs(conversationToolCalls, conversationFileEdits, currentMessage.messageIds);
    }
    return content;
  }, [currentMessage, conversationToolCalls, conversationFileEdits]);
  
  // Memoize line count calculation - markdown rendering is expensive
  const lineCount = useMemo(() => {
    return fullContent ? getRenderedLineCount(fullContent, width) : 0;
  }, [fullContent, width]);
  
  const visibleLines = availableHeight - 3;
  const maxMessageScrollOffset = Math.max(0, lineCount - visibleLines);

  const scrollMessageUp = useCallback(() => {
    setMessageScrollOffset((o) => Math.max(o - 1, 0));
  }, []);

  const scrollMessageDown = useCallback(() => {
    setMessageScrollOffset((o) => Math.min(o + 1, maxMessageScrollOffset));
  }, [maxMessageScrollOffset]);

  const nextMessage = useCallback(() => {
    if (selectedMessageIndex < combinedMessages.length - 1) {
      setSelectedMessageIndex((i) => i + 1);
      setMessageScrollOffset(0);
    }
  }, [selectedMessageIndex, combinedMessages.length]);

  const prevMessage = useCallback(() => {
    if (selectedMessageIndex > 0) {
      setSelectedMessageIndex((i) => i - 1);
      setMessageScrollOffset(0);
    }
  }, [selectedMessageIndex]);

  const scrollMessageToTop = useCallback(() => {
    setMessageScrollOffset(0);
  }, []);

  const scrollMessageToBottom = useCallback(() => {
    setMessageScrollOffset(maxMessageScrollOffset);
  }, [maxMessageScrollOffset]);

  const resetNavigation = useCallback(() => {
    setViewMode('list');
    setSelectedIndex(0);
    setExpandedIndex(null);
    setExpandedScrollOffset(0);
    setExpandedSelectedMatch(0);
    setCombinedMessages([]);
    setMessageIndexMap(new Map());
    setConversationFiles([]);
    setConversationMessageFiles([]);
    setConversationToolCalls([]);
    setConversationFileEdits([]);
    setConversationScrollOffset(0);
    setHighlightMessageIndex(undefined);
    setSelectedMessageIndex(0);
    setMessageScrollOffset(0);
  }, []);

  // Unified keyboard handler
  const handleNavigationInput = useCallback((input: string, key: {
    escape?: boolean;
    backspace?: boolean;
    delete?: boolean;
    return?: boolean;
    downArrow?: boolean;
    upArrow?: boolean;
  }): boolean => {
    // Use ref to avoid callback recreation when displayItems changes
    if (displayItemsRef.current.length === 0) return false;

    // Back navigation (works in all views)
    if (key.escape || key.backspace || key.delete) {
      goBack();
      return true;
    }

    switch (viewMode) {
      case 'message':
        if (input === 'j' || key.downArrow) {
          scrollMessageDown();
          return true;
        }
        if (input === 'k' || key.upArrow) {
          scrollMessageUp();
          return true;
        }
        if (input === 'n') {
          nextMessage();
          return true;
        }
        if (input === 'p') {
          prevMessage();
          return true;
        }
        if (input === 'g') {
          scrollMessageToTop();
          return true;
        }
        if (input === 'G') {
          scrollMessageToBottom();
          return true;
        }
        break;

      case 'conversation':
        if (input === 'j' || key.downArrow) {
          selectNextMessage();
          return true;
        }
        if (input === 'k' || key.upArrow) {
          selectPrevMessage();
          return true;
        }
        if (input === 'g') {
          scrollToTop();
          return true;
        }
        if (input === 'G') {
          scrollToBottom();
          return true;
        }
        if (key.return) {
          openMessageDetail();
          return true;
        }
        break;

      case 'matches':
        if (input === 'j' || key.downArrow) {
          selectNextMatch();
          return true;
        }
        if (input === 'k' || key.upArrow) {
          selectPrevMatch();
          return true;
        }
        if (key.return) {
          expandMatch();
          return true;
        }
        break;

      case 'list':
        if (input === 'j' || key.downArrow) {
          selectNext();
          return true;
        }
        if (input === 'k' || key.upArrow) {
          selectPrev();
          return true;
        }
        if (key.return) {
          expandSelected();
          return true;
        }
        break;
    }

    return false;
  }, [
    // List navigation callbacks are now stable via refs
    viewMode,
    goBack,
    scrollMessageDown,
    scrollMessageUp,
    nextMessage,
    prevMessage,
    scrollMessageToTop,
    scrollMessageToBottom,
    selectNextMessage,
    selectPrevMessage,
    scrollToTop,
    scrollToBottom,
    openMessageDetail,
    selectNextMatch,
    selectPrevMatch,
    expandMatch,
    selectNext,
    selectPrev,
    expandSelected,
  ]);

  return {
    state: {
      viewMode,
      selectedIndex,
      expandedIndex,
      expandedScrollOffset,
      expandedSelectedMatch,
      combinedMessages,
      messageIndexMap,
      conversationFiles,
      conversationMessageFiles,
      conversationToolCalls,
      conversationFileEdits,
      conversationScrollOffset,
      highlightMessageIndex,
      selectedMessageIndex,
      messageScrollOffset,
    },
    actions: {
      goToList,
      goToMatches,
      goToConversation,
      goToMessage,
      goBack,
      selectNext,
      selectPrev,
      expandSelected,
      selectNextMatch,
      selectPrevMatch,
      expandMatch,
      selectNextMessage,
      selectPrevMessage,
      scrollToTop,
      scrollToBottom,
      openMessageDetail,
      scrollMessageUp,
      scrollMessageDown,
      nextMessage,
      prevMessage,
      scrollMessageToTop,
      scrollMessageToBottom,
      setViewMode,
      setSelectedIndex,
      resetNavigation,
    },
    expandedResult,
    handleNavigationInput,
  };
}
