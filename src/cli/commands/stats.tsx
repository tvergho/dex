/**
 * Stats command - analytics dashboard for conversation data
 *
 * Usage: dex stats [--period <days>] [--summary]
 *
 * Interactive TUI with tabs for Overview, Tokens, and Activity
 * Or use --summary for quick non-interactive output
 */

import React, { useState, useEffect } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import { withFullScreen, useScreenSize } from 'fullscreen-ink';
import { connect } from '../../db/index';
import { messageRepo, filesRepo, messageFilesRepo, conversationRepo } from '../../db/repository';
import {
  createPeriodFilter,
  getOverviewStats,
  getDailyActivity,
  getStatsBySource,
  getStatsByModel,
  getTopConversationsByTokens,
  getLinesGeneratedStats,
  getCacheStats,
  getActivityByHour,
  getActivityByDayOfWeek,
  getStreakInfo,
  getSummaryStats,
  getRecentConversations,
  type OverviewStats,
  type DayActivity,
  type SourceStats,
  type ModelStats,
  type LinesGeneratedStats,
  type CacheStats,
  type StreakInfo,
  type PeriodFilter,
  type RecentConversation,
} from '../../db/analytics';
import { formatLargeNumber } from '../components/MetricCard';
import { Sparkline } from '../components/Sparkline';
import { ProgressBar } from '../components/HorizontalBar';
import { ActivityHeatmap, HourlyActivity, WeeklyActivity } from '../components/ActivityHeatmap';
import { ConversationView } from '../components/ConversationView';
import { MessageDetailView } from '../components/MessageDetailView';
import { formatSourceLabel, combineConsecutiveMessages, type CombinedMessage } from '../../utils/format';
import type { Conversation, ConversationFile, MessageFile } from '../../schema/index';

interface StatsOptions {
  period?: string;
  summary?: boolean;
}

type TabId = 'overview' | 'tokens' | 'activity';

interface AllData {
  overview: OverviewStats;
  daily: DayActivity[];
  sources: SourceStats[];
  models: ModelStats[];
  topConversations: Conversation[];
  lines: LinesGeneratedStats;
  cache: CacheStats;
  hourly: number[];
  weekly: number[];
  streak: StreakInfo;
  recentConversations: RecentConversation[];
}

// --- Tab Components ---

/**
 * Format relative time for display (e.g., "2h ago", "1d ago")
 */
function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return `${Math.floor(diffDays / 7)}w ago`;
}

/**
 * Get source color for display
 */
function getSourceColor(source: string): string {
  if (source === 'cursor') return 'cyan';
  if (source === 'claude-code') return 'magenta';
  return 'yellow'; // codex and others
}

type FocusSection = 'recent' | 'top' | null;

function OverviewTab({
  data,
  width,
  period,
  focusSection,
  selectedIndex,
}: {
  data: AllData;
  width: number;
  height: number;
  period: number;
  focusSection: FocusSection;
  selectedIndex: number;
}) {
  const { overview, daily, sources, streak, lines, recentConversations } = data;

  // Prepare sparkline data
  const convTrend = daily.map(d => d.conversations);
  const msgTrend = daily.map(d => d.messages);
  const inputTrend = daily.map(d => d.tokens);
  const outputTrend = daily.map(d => {
    // Approximate output as 10% of total if not tracked separately
    return Math.floor(d.tokens * 0.1);
  });

  // Calculate widths for two-column layout
  const halfWidth = Math.floor((width - 4) / 2);

  // Max token value for source bars
  const maxSourceTokens = sources.length > 0 ? sources[0]!.tokens : 1;

  return (
    <Box flexDirection="column">
      {/* Streak header line */}
      <Box marginBottom={1}>
        {streak.current > 0 ? (
          <Text color="yellow" bold>{streak.current} day streak</Text>
        ) : (
          <Text color="gray">No current streak</Text>
        )}
        <Text color="gray"> · </Text>
        <Text color="gray">Longest: </Text>
        <Text color="green" bold>{streak.longest} days</Text>
        {streak.longestStart && (
          <Text color="gray"> ({streak.longestStart} – {streak.longestEnd})</Text>
        )}
      </Box>

      {/* Two-column layout: ACTIVITY + TOKENS */}
      <Box flexDirection="column" marginBottom={1}>
        <Box>
          <Box width={halfWidth} marginRight={4}>
            <Text bold color="white">ACTIVITY</Text>
          </Box>
          <Box width={halfWidth}>
            <Text bold color="white">TOKENS</Text>
          </Box>
        </Box>
        <Box>
          <Box width={halfWidth} marginRight={4}>
            <Text color="gray">{'─'.repeat(Math.max(0, halfWidth - 4))}</Text>
          </Box>
          <Box width={halfWidth}>
            <Text color="gray">{'─'.repeat(Math.max(0, halfWidth - 2))}</Text>
          </Box>
        </Box>
        {/* Labels row */}
        <Box>
          <Box width={halfWidth} marginRight={4}>
            <Text color="gray">{'Conversations'.padEnd(22)}</Text>
            <Text color="gray">Messages</Text>
          </Box>
          <Box width={halfWidth}>
            <Text color="gray">{'Input'.padEnd(22)}</Text>
            <Text color="gray">Output</Text>
          </Box>
        </Box>
        {/* Values row */}
        <Box>
          <Box width={halfWidth} marginRight={4}>
            <Text color="cyan" bold>{formatLargeNumber(overview.conversations).padEnd(22)}</Text>
            <Text color="green" bold>{formatLargeNumber(overview.messages)}</Text>
          </Box>
          <Box width={halfWidth}>
            <Text color="yellow" bold>{formatLargeNumber(overview.totalInputTokens).padEnd(22)}</Text>
            <Text color="magenta" bold>{formatLargeNumber(overview.totalOutputTokens)}</Text>
          </Box>
        </Box>
        {/* Sparklines row */}
        <Box>
          <Box width={halfWidth} marginRight={4}>
            <Box width={22}><Sparkline data={convTrend} width={12} showTrend /></Box>
            <Sparkline data={msgTrend} width={12} color="green" showTrend />
          </Box>
          <Box width={halfWidth}>
            <Box width={22}><Sparkline data={inputTrend} width={12} color="yellow" showTrend /></Box>
            <Sparkline data={outputTrend} width={12} color="magenta" showTrend />
          </Box>
        </Box>
      </Box>

      {/* LINES GENERATED section */}
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color="white">LINES GENERATED</Text>
        <Box><Text color="gray">{'─'.repeat(Math.max(0, halfWidth - 2))}</Text></Box>
        <Box>
          <Text color="green">+{formatLargeNumber(lines.totalLinesAdded)}</Text>
          <Text color="gray"> added    </Text>
          <Text color="red">−{formatLargeNumber(lines.totalLinesRemoved)}</Text>
          <Text color="gray"> removed    </Text>
          <Text color={lines.netLines >= 0 ? 'green' : 'red'} bold>
            {lines.netLines >= 0 ? '+' : ''}{formatLargeNumber(lines.netLines)}
          </Text>
          <Text color="gray"> net</Text>
        </Box>
      </Box>

      {/* By Source table */}
      {sources.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold color="white">By Source</Text>
          <Box><Text color="gray">{'─'.repeat(Math.max(0, width - 2))}</Text></Box>
          {/* Header row */}
          <Box>
            <Text color="gray">{''.padEnd(14)}</Text>
            <Text color="gray">{'Convos'.padStart(8)}</Text>
            <Text color="gray">{'Messages'.padStart(10)}</Text>
            <Text color="gray">{'Tokens'.padStart(10)}</Text>
          </Box>
          {/* Data rows */}
          {sources.slice(0, 3).map((s, idx) => {
            const barWidth = Math.max(20, width - 50);
            const proportion = s.tokens / maxSourceTokens;
            const filledWidth = Math.max(1, Math.round(proportion * barWidth));
            const emptyWidth = barWidth - filledWidth;
            const sourceColor = getSourceColor(s.source);
            const label = formatSourceLabel(s.source).padEnd(12);

            return (
              <Box key={idx}>
                <Text color={sourceColor}>■ </Text>
                <Text>{label}</Text>
                <Text color="gray">{String(s.conversations).padStart(8)}</Text>
                <Text color="gray">{formatLargeNumber(s.messages).padStart(10)}</Text>
                <Text color="gray">{formatLargeNumber(s.tokens).padStart(10)}</Text>
                <Text>  </Text>
                <Text color={sourceColor}>{'█'.repeat(filledWidth)}</Text>
                <Text color="gray">{'░'.repeat(emptyWidth)}</Text>
              </Box>
            );
          })}
        </Box>
      )}

      {/* Recent Conversations */}
      {recentConversations.length > 0 && (
        <Box flexDirection="column">
          <Text bold color="white">Recent Conversations</Text>
          <Box><Text color="gray">{'─'.repeat(Math.max(0, width - 2))}</Text></Box>
          {recentConversations.slice(0, 5).map((conv, idx) => {
            const isSelected = focusSection === 'recent' && idx === selectedIndex;
            const timeAgo = formatRelativeTime(conv.createdAt).padEnd(8);
            const source = formatSourceLabel(conv.source).padEnd(13);
            const tokenStr = formatLargeNumber(conv.totalTokens).padStart(7);
            const titleWidth = width - 8 - 13 - 9 - 5;
            const title = conv.title.length > titleWidth
              ? conv.title.slice(0, titleWidth - 1) + '…'
              : conv.title;

            return (
              <Box key={idx}>
                <Text backgroundColor={isSelected ? 'cyan' : undefined} color={isSelected ? 'black' : undefined}>
                  {isSelected ? ' ▸ ' : '   '}
                </Text>
                <Text color="gray">{timeAgo}</Text>
                <Text color={getSourceColor(conv.source)}>{source}</Text>
                <Text bold={isSelected}>{title.padEnd(titleWidth)}</Text>
                <Text color="cyan">{tokenStr}</Text>
              </Box>
            );
          })}
        </Box>
      )}
    </Box>
  );
}

function TokensTab({
  data,
  width,
  height,
  focusSection,
  selectedIndex,
}: {
  data: AllData;
  width: number;
  height: number;
  focusSection: FocusSection;
  selectedIndex: number;
}) {
  const { overview, daily, models, topConversations, lines, cache, sources } = data;

  // Calculate totals
  const totalTokens = overview.totalInputTokens + overview.totalOutputTokens;
  const inputPercent = totalTokens > 0 ? Math.round((overview.totalInputTokens / totalTokens) * 100) : 0;
  const outputPercent = totalTokens > 0 ? 100 - inputPercent : 0;

  // Token trend data
  const tokenTrend = daily.map(d => d.tokens);

  // Check if we have any Claude Code/Codex sources for cache stats
  const hasCacheData = sources.some(s => s.source === 'claude-code' || s.source === 'codex');

  // Calculate widths for two-column layout
  const halfWidth = Math.floor((width - 4) / 2);

  // Max token value for top conversations bars (including cache tokens)
  const maxConvTokens = topConversations.length > 0
    ? (topConversations[0]!.totalInputTokens || 0) + (topConversations[0]!.totalOutputTokens || 0) +
      (topConversations[0]!.totalCacheCreationTokens || 0) + (topConversations[0]!.totalCacheReadTokens || 0)
    : 0;

  return (
    <Box flexDirection="column">
      {/* Summary line */}
      <Box marginBottom={1}>
        <Text bold color="white">Total: {formatLargeNumber(totalTokens)} tokens</Text>
        <Text color="gray">    </Text>
        <Text color="cyan">Input: {formatLargeNumber(overview.totalInputTokens)}</Text>
        <Text color="gray">    </Text>
        <Text color="magenta">Output: {formatLargeNumber(overview.totalOutputTokens)}</Text>
        <Text color="gray">    </Text>
        <Text color="gray">Trend: </Text>
        <Sparkline data={tokenTrend} width={20} color="cyan" showTrend />
      </Box>

      {/* Models breakdown */}
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color="white">Token Usage by Model</Text>
        <Box paddingX={0}>
          <Text color="gray">{'─'.repeat(Math.max(0, width - 2))}</Text>
        </Box>
        {models.length > 0 ? (
          <Box flexDirection="column">
            {models.slice(0, 5).map((m, idx) => {
              const total = m.inputTokens + m.outputTokens;
              const maxModelTokens = (models[0]!.inputTokens || 0) + (models[0]!.outputTokens || 0);
              const proportion = maxModelTokens > 0 ? total / maxModelTokens : 0;
              const labelWidth = 38;
              const barWidth = Math.max(20, width - labelWidth - 10);
              const filledWidth = Math.max(1, Math.round(proportion * barWidth));
              const emptyWidth = barWidth - filledWidth;
              const sourceLabel = formatSourceLabel(m.source);
              const modelLabel = `${m.model} (${sourceLabel})`;
              const displayLabel = modelLabel.length > labelWidth ? modelLabel.slice(0, labelWidth - 1) + '…' : modelLabel.padEnd(labelWidth);

              return (
                <Box key={idx}>
                  <Text>{displayLabel} </Text>
                  <Text color="cyan">{'█'.repeat(filledWidth)}</Text>
                  <Text color="gray">{'░'.repeat(emptyWidth)}</Text>
                  <Text color="gray"> {formatLargeNumber(total).padStart(6)}</Text>
                </Box>
              );
            })}
          </Box>
        ) : (
          <Text color="gray">No model data available</Text>
        )}
      </Box>

      {/* Two-column layout: Token Breakdown + Cache Efficiency */}
      <Box marginBottom={1}>
        {/* Token Breakdown */}
        <Box flexDirection="column" width={halfWidth} marginRight={2}>
          <Text bold color="white">Token Breakdown</Text>
          <Box paddingX={0}>
            <Text color="gray">{'─'.repeat(Math.max(0, halfWidth - 2))}</Text>
          </Box>
          <Box flexDirection="column">
            <Box>
              <Text>Input    </Text>
              <ProgressBar value={inputPercent / 100} width={halfWidth - 20} color="cyan" showPercent={false} />
            </Box>
            <Box>
              <Text color="cyan">{formatLargeNumber(overview.totalInputTokens).padStart(9)}</Text>
              <Text color="gray"> ({inputPercent}%)</Text>
            </Box>
            <Box marginTop={1}>
              <Text>Output   </Text>
              <ProgressBar value={outputPercent / 100} width={halfWidth - 20} color="magenta" showPercent={false} />
            </Box>
            <Box>
              <Text color="magenta">{formatLargeNumber(overview.totalOutputTokens).padStart(9)}</Text>
              <Text color="gray"> ({outputPercent}%)</Text>
            </Box>
          </Box>
        </Box>

        {/* Cache Efficiency - Claude Code/Codex only */}
        {hasCacheData && (
          <Box flexDirection="column" width={halfWidth}>
            <Text bold color="white">Cache Efficiency <Text color="gray">(Claude Code/Codex)</Text></Text>
            <Box paddingX={0}>
              <Text color="gray">{'─'.repeat(Math.max(0, halfWidth - 2))}</Text>
            </Box>
            <Box>
              <Text>Hit Rate </Text>
              <ProgressBar value={cache.hitRate} width={halfWidth - 18} color="green" />
            </Box>
            <Box marginTop={1}>
              <Text color="gray">Read: </Text>
              <Text color="green">{formatLargeNumber(cache.cacheRead)}</Text>
              <Text color="gray">    Created: </Text>
              <Text color="yellow">{formatLargeNumber(cache.cacheCreation)}</Text>
            </Box>
          </Box>
        )}
      </Box>

      {/* Top conversations with visual bars */}
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color="white">Top Conversations by Tokens</Text>
        <Box paddingX={0}>
          <Text color="gray">{'─'.repeat(Math.max(0, width - 2))}</Text>
        </Box>
        {topConversations.length > 0 ? (
          <Box flexDirection="column">
            {topConversations.slice(0, 5).map((conv, idx) => {
              const isSelected = focusSection === 'top' && idx === selectedIndex;
              const total = (conv.totalInputTokens || 0) + (conv.totalOutputTokens || 0) +
                (conv.totalCacheCreationTokens || 0) + (conv.totalCacheReadTokens || 0);
              const proportion = maxConvTokens > 0 ? total / maxConvTokens : 0;
              const barWidth = Math.max(15, Math.floor(width * 0.35));
              const filledWidth = Math.max(1, Math.round(proportion * barWidth));
              const emptyWidth = barWidth - filledWidth;
              const titleWidth = width - barWidth - 15;
              const title = conv.title.length > titleWidth
                ? conv.title.slice(0, titleWidth - 1) + '…'
                : conv.title;

              return (
                <Box key={idx}>
                  <Text backgroundColor={isSelected ? 'cyan' : undefined} color={isSelected ? 'black' : undefined}>
                    {isSelected ? ' ▸ ' : '   '}
                  </Text>
                  <Text color="cyan">{formatLargeNumber(total).padStart(6)}  </Text>
                  <Text color="cyan">{'█'.repeat(filledWidth)}</Text>
                  <Text color="gray">{'░'.repeat(emptyWidth)}</Text>
                  <Text bold={isSelected}>  {title}</Text>
                </Box>
              );
            })}
          </Box>
        ) : (
          <Text color="gray">No conversation data</Text>
        )}
      </Box>

      {/* Lines Generated - compact footer */}
      <Box paddingX={0}>
        <Text color="gray">{'─'.repeat(Math.max(0, width - 2))}</Text>
      </Box>
      <Box>
        <Text color="gray">Lines Generated    </Text>
        <Text color="green">+{formatLargeNumber(lines.totalLinesAdded)}</Text>
        <Text color="gray"> added    </Text>
        <Text color="red">−{formatLargeNumber(lines.totalLinesRemoved)}</Text>
        <Text color="gray"> removed    </Text>
        <Text color={lines.netLines >= 0 ? 'green' : 'red'}>
          {lines.netLines >= 0 ? '+' : ''}{formatLargeNumber(lines.netLines)}
        </Text>
        <Text color="gray"> net</Text>
      </Box>
    </Box>
  );
}

function ActivityTab({
  data,
  width,
  height,
  period,
}: {
  data: AllData;
  width: number;
  height: number;
  period: number;
}) {
  const { daily, hourly, weekly, streak } = data;
  const weeks = Math.ceil(period / 7);

  // Calculate widths for side-by-side layout
  const halfWidth = Math.floor((width - 4) / 2);

  return (
    <Box flexDirection="column">
      {/* Compact streak summary line */}
      <Box marginBottom={1}>
        <Text color="yellow" bold>{streak.current} day streak</Text>
        <Text color="gray"> · </Text>
        <Text color="gray">Longest: </Text>
        <Text color="green" bold>{streak.longest} days</Text>
        {streak.longestStart && (
          <Text color="gray"> ({streak.longestStart} – {streak.longestEnd})</Text>
        )}
      </Box>

      {/* Activity heatmap - hero visual */}
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color="white">Activity Heatmap</Text>
        <ActivityHeatmap data={daily} weeks={weeks} width={width} metric="conversations" />
      </Box>

      {/* Hour and Day charts side-by-side */}
      <Box>
        {/* Hourly distribution */}
        <Box flexDirection="column" width={halfWidth} marginRight={2}>
          <Text bold color="white">By Hour</Text>
          <HourlyActivity data={hourly} width={halfWidth} />
        </Box>

        {/* Weekly distribution */}
        <Box flexDirection="column" width={halfWidth}>
          <Text bold color="white">By Day of Week</Text>
          <WeeklyActivity data={weekly} width={halfWidth} />
        </Box>
      </Box>
    </Box>
  );
}

// --- Main Stats App ---

type ViewMode = 'dashboard' | 'conversation' | 'message';

function StatsApp({ period }: { period: number }) {
  const { exit } = useApp();
  const { width, height } = useScreenSize();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>('overview');
  const [data, setData] = useState<AllData | null>(null);

  // Navigation state
  const [viewMode, setViewMode] = useState<ViewMode>('dashboard');
  const [focusSection, setFocusSection] = useState<FocusSection>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Conversation view state
  const [selectedConversation, setSelectedConversation] = useState<Conversation | null>(null);
  const [combinedMessages, setCombinedMessages] = useState<CombinedMessage[]>([]);
  const [conversationFiles, setConversationFiles] = useState<ConversationFile[]>([]);
  const [conversationMessageFiles, setConversationMessageFiles] = useState<MessageFile[]>([]);
  const [conversationScrollOffset, setConversationScrollOffset] = useState(0);
  const [selectedMessageIndex, setSelectedMessageIndex] = useState(0);

  // Message detail view state
  const [messageScrollOffset, setMessageScrollOffset] = useState(0);

  useEffect(() => {
    async function loadData() {
      try {
        await connect();
        const periodFilter = createPeriodFilter(period);

        // Load all data in parallel
        const [overview, daily, sources, models, topConversations, lines, cache, hourly, weekly, streak, recentConversations] = await Promise.all([
          getOverviewStats(periodFilter),
          getDailyActivity(periodFilter),
          getStatsBySource(periodFilter),
          getStatsByModel(periodFilter),
          getTopConversationsByTokens(periodFilter, 5),
          getLinesGeneratedStats(periodFilter, 5),
          getCacheStats(periodFilter),
          getActivityByHour(periodFilter),
          getActivityByDayOfWeek(periodFilter),
          getStreakInfo(),
          getRecentConversations(periodFilter, 5),
        ]);

        setData({
          overview,
          daily,
          sources,
          models,
          topConversations,
          lines,
          cache,
          hourly,
          weekly,
          streak,
          recentConversations,
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    }
    loadData();
  }, [period]);

  // Get max index for current section
  const getMaxIndex = () => {
    if (!data) return 0;
    if (focusSection === 'recent') return Math.min(4, data.recentConversations.length - 1);
    if (focusSection === 'top') return Math.min(4, data.topConversations.length - 1);
    return 0;
  };

  // Load conversation data when entering conversation view
  async function loadConversation(conv: Conversation) {
    setSelectedConversation(conv);
    setViewMode('conversation');
    setConversationScrollOffset(0);
    setSelectedMessageIndex(0);

    // Load messages and files
    const [msgs, files, msgFiles] = await Promise.all([
      messageRepo.findByConversation(conv.id),
      filesRepo.findByConversation(conv.id),
      messageFilesRepo.findByConversation(conv.id),
    ]);

    const { messages: combined } = combineConsecutiveMessages(msgs);
    setCombinedMessages(combined);
    setConversationFiles(files);
    setConversationMessageFiles(msgFiles);
  }

  // Handle Enter key to view selected conversation
  async function handleEnterKey() {
    if (!data) return;

    let conversationId: string | null = null;

    if (focusSection === 'recent' && data.recentConversations[selectedIndex]) {
      conversationId = data.recentConversations[selectedIndex]!.id;
    } else if (focusSection === 'top' && data.topConversations[selectedIndex]) {
      conversationId = data.topConversations[selectedIndex]!.id;
    }

    if (conversationId) {
      // Fetch full conversation from database
      const fullConv = await conversationRepo.findById(conversationId);
      if (fullConv) {
        await loadConversation(fullConv);
      }
    }
  }

  useInput((input, key) => {
    // Handle message detail view mode
    if (viewMode === 'message' && combinedMessages.length > 0) {
      const currentMessage = combinedMessages[selectedMessageIndex];
      if (key.escape || key.backspace || key.delete || input === 'b') {
        setViewMode('conversation');
        setMessageScrollOffset(0);
        return;
      }

      if (input === 'q') {
        exit();
        return;
      }

      if (input === 'j' || key.downArrow) {
        const lines = currentMessage?.content.split('\n') || [];
        const maxOffset = Math.max(0, lines.length - (height - 8));
        setMessageScrollOffset(o => Math.min(o + 1, maxOffset));
      } else if (input === 'k' || key.upArrow) {
        setMessageScrollOffset(o => Math.max(o - 1, 0));
      } else if (input === 'g') {
        setMessageScrollOffset(0);
      } else if (input === 'G') {
        const lines = currentMessage?.content.split('\n') || [];
        setMessageScrollOffset(Math.max(0, lines.length - (height - 8)));
      } else if (input === 'n') {
        // Next message
        if (selectedMessageIndex < combinedMessages.length - 1) {
          setSelectedMessageIndex(i => i + 1);
          setMessageScrollOffset(0);
        }
      } else if (input === 'p') {
        // Previous message
        if (selectedMessageIndex > 0) {
          setSelectedMessageIndex(i => i - 1);
          setMessageScrollOffset(0);
        }
      }
      return;
    }

    // Handle conversation view mode
    if (viewMode === 'conversation') {
      if (key.escape || key.backspace || key.delete || input === 'b') {
        setViewMode('dashboard');
        setSelectedConversation(null);
        setCombinedMessages([]);
        setConversationFiles([]);
        setConversationMessageFiles([]);
        return;
      }

      if (input === 'q') {
        exit();
        return;
      }

      // Scroll in conversation view
      const headerHeight = 6;
      const footerHeight = 2;
      const messagesPerPage = Math.max(1, Math.floor((height - headerHeight - footerHeight) / 3));
      const maxOffset = Math.max(0, combinedMessages.length - messagesPerPage);

      if (input === 'j' || key.downArrow) {
        const newIdx = Math.min(selectedMessageIndex + 1, combinedMessages.length - 1);
        setSelectedMessageIndex(newIdx);
        // Adjust scroll to keep selected message visible
        if (newIdx >= conversationScrollOffset + messagesPerPage) {
          setConversationScrollOffset(Math.min(newIdx - messagesPerPage + 1, maxOffset));
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
        setConversationScrollOffset(maxOffset);
        setSelectedMessageIndex(combinedMessages.length - 1);
      } else if (key.return) {
        // Open message detail view
        setViewMode('message');
        setMessageScrollOffset(0);
      }
      return;
    }

    // Dashboard mode
    if (input === 'q') {
      exit();
      return;
    }

    // If in a focused section, handle navigation
    if (focusSection !== null) {
      if (key.escape || key.backspace || key.delete) {
        setFocusSection(null);
        setSelectedIndex(0);
        return;
      }

      if (input === 'j' || key.downArrow) {
        setSelectedIndex(i => Math.min(i + 1, getMaxIndex()));
        return;
      }
      if (input === 'k' || key.upArrow) {
        setSelectedIndex(i => Math.max(i - 1, 0));
        return;
      }
      if (key.return) {
        handleEnterKey();
        return;
      }
    }

    // Tab switching (only when not in a section)
    if (focusSection === null) {
      if (input === '1') {
        setActiveTab('overview');
        return;
      }
      if (input === '2') {
        setActiveTab('tokens');
        return;
      }
      if (input === '3') {
        setActiveTab('activity');
        return;
      }

      // Arrow key tab navigation
      if (key.leftArrow || input === 'h') {
        const tabs: TabId[] = ['overview', 'tokens', 'activity'];
        const idx = tabs.indexOf(activeTab);
        setActiveTab(tabs[(idx - 1 + tabs.length) % tabs.length]!);
        return;
      }
      if (key.rightArrow || input === 'l') {
        const tabs: TabId[] = ['overview', 'tokens', 'activity'];
        const idx = tabs.indexOf(activeTab);
        setActiveTab(tabs[(idx + 1) % tabs.length]!);
        return;
      }

      // Enter to focus on the relevant section
      if (key.return || input === 'j' || key.downArrow) {
        if (activeTab === 'overview' && data?.recentConversations.length) {
          setFocusSection('recent');
          setSelectedIndex(0);
        } else if (activeTab === 'tokens' && data?.topConversations.length) {
          setFocusSection('top');
          setSelectedIndex(0);
        }
        return;
      }
    }
  });

  if (loading) {
    return (
      <Box width={width} height={height} alignItems="center" justifyContent="center">
        <Text color="cyan">Loading analytics...</Text>
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

  if (!data) {
    return (
      <Box width={width} height={height} flexDirection="column" padding={1}>
        <Text dimColor>No data available</Text>
        <Text dimColor>Press q to exit</Text>
      </Box>
    );
  }

  const tabs: { id: TabId; label: string }[] = [
    { id: 'overview', label: '1:Overview' },
    { id: 'tokens', label: '2:Tokens' },
    { id: 'activity', label: '3:Activity' },
  ];

  const headerHeight = 4;
  const footerHeight = 2;
  const contentHeight = height - headerHeight - footerHeight;

  // Render message detail view
  if (viewMode === 'message' && selectedConversation && combinedMessages[selectedMessageIndex]) {
    return (
      <Box width={width} height={height} flexDirection="column">
        {/* Header */}
        <Box flexDirection="column">
          <Box paddingX={1}>
            <Text bold color="white">Stats Dashboard</Text>
            <Text dimColor> · Last {period} days</Text>
            <Text dimColor> › </Text>
            <Text color="cyan">Message</Text>
          </Box>
          <Box paddingX={1}>
            <Text color="gray">{'─'.repeat(Math.max(0, width - 2))}</Text>
          </Box>
        </Box>

        {/* Message Content */}
        <Box flexDirection="column" flexGrow={1} paddingX={1} height={contentHeight + 2}>
          <MessageDetailView
            message={combinedMessages[selectedMessageIndex]!}
            messageFiles={conversationMessageFiles}
            width={width - 2}
            height={contentHeight + 2}
            scrollOffset={messageScrollOffset}
            query=""
          />
        </Box>

        {/* Footer */}
        <Box flexDirection="column">
          <Box paddingX={1}>
            <Text color="gray">{'─'.repeat(Math.max(0, width - 2))}</Text>
          </Box>
          <Box paddingX={1}>
            <Text>
              <Text color="white">j/k</Text><Text dimColor>: scroll · </Text>
              <Text color="white">n/p</Text><Text dimColor>: next/prev · </Text>
              <Text color="white">g/G</Text><Text dimColor>: top/bottom · </Text>
              <Text color="white">esc/b</Text><Text dimColor>: back · </Text>
              <Text color="white">q</Text><Text dimColor>: quit</Text>
            </Text>
          </Box>
        </Box>
      </Box>
    );
  }

  // Render conversation view
  if (viewMode === 'conversation' && selectedConversation) {
    return (
      <Box width={width} height={height} flexDirection="column">
        {/* Header */}
        <Box flexDirection="column">
          <Box paddingX={1}>
            <Text bold color="white">Stats Dashboard</Text>
            <Text dimColor> · Last {period} days</Text>
            <Text dimColor> › </Text>
            <Text color="cyan">Conversation</Text>
          </Box>
          <Box paddingX={1}>
            <Text color="gray">{'─'.repeat(Math.max(0, width - 2))}</Text>
          </Box>
        </Box>

        {/* Conversation Content */}
        <Box flexDirection="column" flexGrow={1} paddingX={1} height={contentHeight + 2}>
          <ConversationView
            conversation={selectedConversation}
            messages={combinedMessages}
            files={conversationFiles}
            messageFiles={conversationMessageFiles}
            width={width - 2}
            height={contentHeight + 2}
            scrollOffset={conversationScrollOffset}
            selectedIndex={selectedMessageIndex}
          />
        </Box>

        {/* Footer */}
        <Box flexDirection="column">
          <Box paddingX={1}>
            <Text color="gray">{'─'.repeat(Math.max(0, width - 2))}</Text>
          </Box>
          <Box paddingX={1}>
            <Text>
              <Text color="white">j/k</Text><Text dimColor>: select · </Text>
              <Text color="white">Enter</Text><Text dimColor>: view full · </Text>
              <Text color="white">g/G</Text><Text dimColor>: top/bottom · </Text>
              <Text color="white">esc/b</Text><Text dimColor>: back · </Text>
              <Text color="white">q</Text><Text dimColor>: quit</Text>
            </Text>
          </Box>
        </Box>
      </Box>
    );
  }

  // Dashboard footer text based on state
  const getFooterText = () => {
    if (focusSection !== null) {
      return (
        <Text>
          <Text color="white">j/k</Text><Text dimColor>: select · </Text>
          <Text color="white">Enter</Text><Text dimColor>: view · </Text>
          <Text color="white">esc</Text><Text dimColor>: back · </Text>
          <Text color="white">q</Text><Text dimColor>: quit</Text>
        </Text>
      );
    }
    const hasConversations = (activeTab === 'overview' && data.recentConversations.length > 0) ||
                            (activeTab === 'tokens' && data.topConversations.length > 0);
    return (
      <Text>
        <Text color="white">1-3</Text><Text dimColor>: tabs · </Text>
        <Text color="white">h/l</Text><Text dimColor>: navigate · </Text>
        {hasConversations && <><Text color="white">Enter/j</Text><Text dimColor>: browse conversations · </Text></>}
        <Text color="white">q</Text><Text dimColor>: quit</Text>
      </Text>
    );
  };

  return (
    <Box width={width} height={height} flexDirection="column">
      {/* Header */}
      <Box flexDirection="column">
        <Box paddingX={1}>
          <Text bold color="white">Stats Dashboard</Text>
          <Text dimColor> · Last {period} days</Text>
        </Box>
        {/* Tab bar */}
        <Box paddingX={1}>
          {tabs.map((tab) => (
            <Box key={tab.id} marginRight={2}>
              <Text
                bold={activeTab === tab.id}
                color={activeTab === tab.id ? 'cyan' : 'white'}
                underline={activeTab === tab.id}
              >
                {tab.label}
              </Text>
            </Box>
          ))}
        </Box>
        <Box paddingX={1}>
          <Text color="gray">{'─'.repeat(Math.max(0, width - 2))}</Text>
        </Box>
      </Box>

      {/* Content */}
      <Box flexDirection="column" flexGrow={1} paddingX={1} height={contentHeight}>
        {activeTab === 'overview' && (
          <OverviewTab
            data={data}
            width={width - 2}
            height={contentHeight}
            period={period}
            focusSection={focusSection}
            selectedIndex={selectedIndex}
          />
        )}
        {activeTab === 'tokens' && (
          <TokensTab
            data={data}
            width={width - 2}
            height={contentHeight}
            focusSection={focusSection}
            selectedIndex={selectedIndex}
          />
        )}
        {activeTab === 'activity' && (
          <ActivityTab data={data} width={width - 2} height={contentHeight} period={period} />
        )}
      </Box>

      {/* Footer */}
      <Box flexDirection="column">
        <Box paddingX={1}>
          <Text color="gray">{'─'.repeat(Math.max(0, width - 2))}</Text>
        </Box>
        <Box paddingX={1}>
          {getFooterText()}
        </Box>
      </Box>
    </Box>
  );
}

// --- Non-interactive Summary ---

async function printSummary(period: number): Promise<void> {
  await connect();
  const stats = await getSummaryStats(period);
  const streak = await getStreakInfo();

  console.log('');
  console.log(`Stats (last ${period} days)`);
  console.log('');
  console.log(`  Conversations: ${stats.conversations}`);
  console.log(`  Messages:      ${stats.messages}`);
  console.log(`  Tokens:        ${formatLargeNumber(stats.inputTokens)} in / ${formatLargeNumber(stats.outputTokens)} out`);
  console.log(`  Lines:         +${formatLargeNumber(stats.linesAdded)} / -${formatLargeNumber(stats.linesRemoved)}`);

  if (streak.current > 0) {
    console.log(`  Streak:        ${streak.current} days`);
  }

  console.log('');
}

// --- Rich Summary for Post-Sync ---

export async function printRichSummary(period: number = 7): Promise<void> {
  await connect();
  const stats = await getSummaryStats(period);
  const streak = await getStreakInfo();

  const parts: string[] = [];

  // Conversations and messages
  parts.push(`${stats.conversations} conversations`);
  parts.push(`${stats.messages} messages`);

  // Tokens
  if (stats.inputTokens > 0 || stats.outputTokens > 0) {
    parts.push(`${formatLargeNumber(stats.inputTokens)} in / ${formatLargeNumber(stats.outputTokens)} out`);
  }

  // Lines
  if (stats.linesAdded > 0 || stats.linesRemoved > 0) {
    parts.push(`+${formatLargeNumber(stats.linesAdded)} / -${formatLargeNumber(stats.linesRemoved)} lines`);
  }

  // Streak with emoji
  if (streak.current > 0) {
    parts.push(`${streak.current} day streak`);
  }

  console.log('');
  console.log(`Last ${period} days: ${parts.join(' · ')}`);
  console.log('');
}

// --- Entry Point ---

export async function statsCommand(options: StatsOptions): Promise<void> {
  const period = parseInt(options.period ?? '30', 10);

  if (options.summary || !process.stdin.isTTY) {
    await printSummary(period);
    return;
  }

  const app = withFullScreen(<StatsApp period={period} />);
  await app.start();
  await app.waitUntilExit();
}
