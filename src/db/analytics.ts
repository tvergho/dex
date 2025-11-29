/**
 * Analytics query functions for the stats dashboard
 */

import { connect, getConversationsTable } from './index';
import type { Conversation } from '../schema/index';

// --- Types ---

export interface PeriodFilter {
  startDate: Date;
  endDate: Date;
}

export interface DayActivity {
  date: string;     // YYYY-MM-DD
  conversations: number;
  messages: number;
  tokens: number;
  linesAdded: number;
  linesRemoved: number;
}

export interface SourceStats {
  source: string;
  conversations: number;
  messages: number;
  tokens: number;
}

export interface ModelStats {
  model: string;
  source: string;
  conversations: number;
  inputTokens: number;
  outputTokens: number;
}

export interface LinesGeneratedStats {
  totalLinesAdded: number;
  totalLinesRemoved: number;
  netLines: number;
  topConversationsByLines: Array<{
    id: string;
    title: string;
    linesAdded: number;
    linesRemoved: number;
  }>;
}

export interface CacheStats {
  totalInput: number;
  totalOutput: number;
  cacheCreation: number;
  cacheRead: number;
  hitRate: number;
}

export interface OverviewStats {
  conversations: number;
  messages: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalLinesAdded: number;
  totalLinesRemoved: number;
}

export interface StreakInfo {
  current: number;
  longest: number;
  longestStart: string;
  longestEnd: string;
}

// --- Helper Functions ---

function formatDate(date: Date): string {
  return date.toISOString().split('T')[0]!;
}

function isInPeriod(dateStr: string | undefined, period: PeriodFilter): boolean {
  if (!dateStr) return false;
  const date = new Date(dateStr);
  return date >= period.startDate && date < period.endDate;
}

export function createPeriodFilter(days: number): PeriodFilter {
  const endDate = new Date();
  endDate.setHours(23, 59, 59, 999);
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);
  startDate.setHours(0, 0, 0, 0);
  return { startDate, endDate };
}

// --- Query Functions ---

export async function getOverviewStats(period: PeriodFilter): Promise<OverviewStats> {
  await connect();
  const table = await getConversationsTable();
  const rows = await table.query().toArray();

  const filtered = rows.filter(r => isInPeriod(r.createdAt, period));

  let messages = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalLinesAdded = 0;
  let totalLinesRemoved = 0;

  for (const conv of filtered) {
    messages += conv.messageCount || 0;
    totalInputTokens += conv.totalInputTokens || 0;
    totalOutputTokens += conv.totalOutputTokens || 0;
    totalLinesAdded += conv.totalLinesAdded || 0;
    totalLinesRemoved += conv.totalLinesRemoved || 0;
  }

  return {
    conversations: filtered.length,
    messages,
    totalInputTokens,
    totalOutputTokens,
    totalLinesAdded,
    totalLinesRemoved,
  };
}

export async function getDailyActivity(period: PeriodFilter): Promise<DayActivity[]> {
  await connect();
  const table = await getConversationsTable();
  const rows = await table.query().toArray();

  const filtered = rows.filter(r => isInPeriod(r.createdAt, period));

  // Group by date
  const byDate = new Map<string, DayActivity>();

  for (const conv of filtered) {
    const date = conv.createdAt?.split('T')[0];
    if (!date) continue;

    const existing = byDate.get(date) || {
      date,
      conversations: 0,
      messages: 0,
      tokens: 0,
      linesAdded: 0,
      linesRemoved: 0,
    };

    existing.conversations += 1;
    existing.messages += conv.messageCount || 0;
    // Include cache tokens for total context processed
    existing.tokens += (conv.totalInputTokens || 0) + (conv.totalOutputTokens || 0) +
      (conv.totalCacheCreationTokens || 0) + (conv.totalCacheReadTokens || 0);
    existing.linesAdded += conv.totalLinesAdded || 0;
    existing.linesRemoved += conv.totalLinesRemoved || 0;

    byDate.set(date, existing);
  }

  // Sort by date
  return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
}

export async function getStatsBySource(period: PeriodFilter): Promise<SourceStats[]> {
  await connect();
  const table = await getConversationsTable();
  const rows = await table.query().toArray();

  const filtered = rows.filter(r => isInPeriod(r.createdAt, period));

  const bySource = new Map<string, SourceStats>();

  for (const conv of filtered) {
    const source = conv.source || 'unknown';
    const existing = bySource.get(source) || {
      source,
      conversations: 0,
      messages: 0,
      tokens: 0,
    };

    existing.conversations += 1;
    existing.messages += conv.messageCount || 0;
    // Include cache tokens for total context processed
    existing.tokens += (conv.totalInputTokens || 0) + (conv.totalOutputTokens || 0) +
      (conv.totalCacheCreationTokens || 0) + (conv.totalCacheReadTokens || 0);

    bySource.set(source, existing);
  }

  // Sort by token count descending
  return Array.from(bySource.values()).sort((a, b) => b.tokens - a.tokens);
}

export async function getStatsByModel(period: PeriodFilter): Promise<ModelStats[]> {
  await connect();
  const table = await getConversationsTable();
  const rows = await table.query().toArray();

  const filtered = rows.filter(r => isInPeriod(r.createdAt, period));

  // Group by model+source combination
  const byModelSource = new Map<string, ModelStats>();

  for (const conv of filtered) {
    const model = conv.model || '(unknown)';
    const source = conv.source || 'unknown';
    const key = `${model}::${source}`;
    const existing = byModelSource.get(key) || {
      model,
      source,
      conversations: 0,
      inputTokens: 0,
      outputTokens: 0,
    };

    existing.conversations += 1;
    // Include cache tokens in input for total context processed
    existing.inputTokens += (conv.totalInputTokens || 0) +
      (conv.totalCacheCreationTokens || 0) + (conv.totalCacheReadTokens || 0);
    existing.outputTokens += conv.totalOutputTokens || 0;

    byModelSource.set(key, existing);
  }

  // Sort by total tokens descending
  return Array.from(byModelSource.values()).sort(
    (a, b) => (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens)
  );
}

export async function getTopConversationsByTokens(
  period: PeriodFilter,
  limit: number = 5
): Promise<Conversation[]> {
  await connect();
  const table = await getConversationsTable();
  const rows = await table.query().toArray();

  const filtered = rows.filter(r => isInPeriod(r.createdAt, period));

  // Sort by total tokens descending (including cache tokens)
  filtered.sort((a, b) => {
    const aTokens = (a.totalInputTokens || 0) + (a.totalOutputTokens || 0) +
      (a.totalCacheCreationTokens || 0) + (a.totalCacheReadTokens || 0);
    const bTokens = (b.totalInputTokens || 0) + (b.totalOutputTokens || 0) +
      (b.totalCacheCreationTokens || 0) + (b.totalCacheReadTokens || 0);
    return bTokens - aTokens;
  });

  return filtered.slice(0, limit) as Conversation[];
}

export async function getLinesGeneratedStats(
  period: PeriodFilter,
  limit: number = 5
): Promise<LinesGeneratedStats> {
  await connect();
  const table = await getConversationsTable();
  const rows = await table.query().toArray();

  const filtered = rows.filter(r => isInPeriod(r.createdAt, period));

  let totalLinesAdded = 0;
  let totalLinesRemoved = 0;

  for (const conv of filtered) {
    totalLinesAdded += conv.totalLinesAdded || 0;
    totalLinesRemoved += conv.totalLinesRemoved || 0;
  }

  // Sort by lines added descending
  const sorted = [...filtered].sort(
    (a, b) => (b.totalLinesAdded || 0) - (a.totalLinesAdded || 0)
  );

  const topConversationsByLines = sorted.slice(0, limit).map(conv => ({
    id: conv.id,
    title: conv.title || '(untitled)',
    linesAdded: conv.totalLinesAdded || 0,
    linesRemoved: conv.totalLinesRemoved || 0,
  }));

  return {
    totalLinesAdded,
    totalLinesRemoved,
    netLines: totalLinesAdded - totalLinesRemoved,
    topConversationsByLines,
  };
}

export async function getCacheStats(period: PeriodFilter): Promise<CacheStats> {
  await connect();
  const table = await getConversationsTable();
  const rows = await table.query().toArray();

  // Only include Claude Code and Codex sources (which have cache data)
  const filtered = rows.filter(
    r => isInPeriod(r.createdAt, period) &&
         (r.source === 'claude-code' || r.source === 'codex')
  );

  let totalInput = 0;
  let totalOutput = 0;
  let cacheCreation = 0;
  let cacheRead = 0;

  for (const conv of filtered) {
    totalInput += conv.totalInputTokens || 0;
    totalOutput += conv.totalOutputTokens || 0;
    cacheCreation += conv.totalCacheCreationTokens || 0;
    cacheRead += conv.totalCacheReadTokens || 0;
  }

  // Hit rate = cache_read / (cache_read + cache_creation + regular_input)
  const totalContext = cacheRead + cacheCreation + totalInput;
  const hitRate = totalContext > 0 ? cacheRead / totalContext : 0;

  return {
    totalInput,
    totalOutput,
    cacheCreation,
    cacheRead,
    hitRate,
  };
}

export async function getActivityByHour(period: PeriodFilter): Promise<number[]> {
  await connect();
  const table = await getConversationsTable();
  const rows = await table.query().toArray();

  const filtered = rows.filter(r => isInPeriod(r.createdAt, period));

  // Initialize 24-hour array
  const byHour = new Array(24).fill(0);

  for (const conv of filtered) {
    if (!conv.createdAt) continue;
    const hour = new Date(conv.createdAt).getHours();
    byHour[hour] += 1;
  }

  return byHour;
}

export async function getActivityByDayOfWeek(period: PeriodFilter): Promise<number[]> {
  await connect();
  const table = await getConversationsTable();
  const rows = await table.query().toArray();

  const filtered = rows.filter(r => isInPeriod(r.createdAt, period));

  // Initialize 7-day array (0 = Sunday, 6 = Saturday)
  const byDay = new Array(7).fill(0);

  for (const conv of filtered) {
    if (!conv.createdAt) continue;
    const day = new Date(conv.createdAt).getDay();
    byDay[day] += 1;
  }

  return byDay;
}

export async function getStreakInfo(): Promise<StreakInfo> {
  await connect();
  const table = await getConversationsTable();
  const rows = await table.query().toArray();

  // Get all unique dates with activity
  const datesSet = new Set<string>();
  for (const conv of rows) {
    if (conv.createdAt) {
      datesSet.add(conv.createdAt.split('T')[0]!);
    }
  }

  const dates = Array.from(datesSet).sort();

  if (dates.length === 0) {
    return { current: 0, longest: 0, longestStart: '', longestEnd: '' };
  }

  // Calculate streaks
  let currentStreak = 0;
  let longestStreak = 0;
  let longestStart = '';
  let longestEnd = '';
  let streakStart = dates[0]!;
  let streakLength = 1;

  // Check if today or yesterday has activity for current streak
  const today = formatDate(new Date());
  const yesterday = formatDate(new Date(Date.now() - 86400000));
  const hasToday = datesSet.has(today);
  const hasYesterday = datesSet.has(yesterday);

  for (let i = 1; i < dates.length; i++) {
    const prevDate = new Date(dates[i - 1]!);
    const currDate = new Date(dates[i]!);
    const diffDays = Math.round((currDate.getTime() - prevDate.getTime()) / 86400000);

    if (diffDays === 1) {
      // Consecutive day
      streakLength++;
    } else {
      // Gap in streak
      if (streakLength > longestStreak) {
        longestStreak = streakLength;
        longestStart = streakStart;
        longestEnd = dates[i - 1]!;
      }
      streakStart = dates[i]!;
      streakLength = 1;
    }
  }

  // Check final streak
  if (streakLength > longestStreak) {
    longestStreak = streakLength;
    longestStart = streakStart;
    longestEnd = dates[dates.length - 1]!;
  }

  // Calculate current streak (from today backwards)
  if (hasToday || hasYesterday) {
    const checkDate = hasToday ? today : yesterday;
    currentStreak = 1;
    let checkDateObj = new Date(checkDate);

    while (true) {
      checkDateObj.setDate(checkDateObj.getDate() - 1);
      const prevDateStr = formatDate(checkDateObj);
      if (datesSet.has(prevDateStr)) {
        currentStreak++;
      } else {
        break;
      }
    }
  }

  return {
    current: currentStreak,
    longest: longestStreak,
    longestStart,
    longestEnd,
  };
}

// --- Summary Functions ---

export interface SummaryStats {
  conversations: number;
  messages: number;
  inputTokens: number;
  outputTokens: number;
  linesAdded: number;
  linesRemoved: number;
  currentStreak: number;
}

export async function getSummaryStats(days: number): Promise<SummaryStats> {
  const period = createPeriodFilter(days);
  const [overview, streak] = await Promise.all([
    getOverviewStats(period),
    getStreakInfo(),
  ]);

  return {
    conversations: overview.conversations,
    messages: overview.messages,
    inputTokens: overview.totalInputTokens,
    outputTokens: overview.totalOutputTokens,
    linesAdded: overview.totalLinesAdded,
    linesRemoved: overview.totalLinesRemoved,
    currentStreak: streak.current,
  };
}

export interface RecentConversation {
  id: string;
  title: string;
  source: string;
  createdAt: string;
  totalTokens: number;
}

export async function getRecentConversations(
  period: PeriodFilter,
  limit: number = 5
): Promise<RecentConversation[]> {
  await connect();
  const table = await getConversationsTable();
  const rows = await table.query().toArray();

  const filtered = rows.filter(r => isInPeriod(r.createdAt, period));

  // Sort by createdAt descending (most recent first)
  filtered.sort((a, b) => {
    const aDate = a.createdAt || '';
    const bDate = b.createdAt || '';
    return bDate.localeCompare(aDate);
  });

  return filtered.slice(0, limit).map(conv => ({
    id: conv.id,
    title: conv.title || '(untitled)',
    source: conv.source || 'unknown',
    createdAt: conv.createdAt || '',
    totalTokens: (conv.totalInputTokens || 0) + (conv.totalOutputTokens || 0) +
      (conv.totalCacheCreationTokens || 0) + (conv.totalCacheReadTokens || 0),
  }));
}
