/**
 * Analytics query functions for the stats dashboard
 */

import { connect, getConversationsTable, getFilesTable, getFileEditsTable } from './index';
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

export interface ProjectStats {
  projectName: string;
  workspacePath: string;
  conversations: number;
  messages: number;
  inputTokens: number;
  outputTokens: number;
  linesAdded: number;
  linesRemoved: number;
  lastActivity: string;
}

export interface FileStats {
  filePath: string;
  relativePath: string;     // Path relative to workspace root (more readable)
  projectName: string;      // Project this file belongs to
  editCount: number;
  mentionCount: number;
  linesAdded: number;
  linesRemoved: number;
  conversationCount: number;
}

export interface EditTypeBreakdown {
  create: number;
  modify: number;
  delete: number;
}

export interface FileTypeStats {
  extension: string;
  editCount: number;
  linesAdded: number;
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
    // Include cache tokens in input for consistency with other stats functions
    totalInputTokens += (conv.totalInputTokens || 0) +
      (conv.totalCacheCreationTokens || 0) + (conv.totalCacheReadTokens || 0);
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

// --- Project Analytics ---

function extractProjectName(workspacePath: string | undefined): string {
  if (!workspacePath) return '(no project)';
  // Extract the last segment of the path as the project name
  const segments = workspacePath.split('/').filter(s => s.length > 0);
  return segments[segments.length - 1] || '(no project)';
}

/** Project names that indicate we should try to infer from file edits */
const UNHELPFUL_PROJECT_NAMES = ['(cursor)', '(no project)', '(codex)', '(claude-code)'];

/**
 * Determine the best project name for a conversation.
 * Tries: projectName -> workspacePath -> file edits -> fallback
 */
function resolveProjectName(
  conv: { projectName?: string; workspacePath?: string; id: string },
  editsByConvId: Map<string, Array<{ filePath: string }>>
): string {
  // If conversation has a useful project name, use it
  if (conv.projectName && !UNHELPFUL_PROJECT_NAMES.includes(conv.projectName)) {
    return conv.projectName;
  }

  // Try extracting from workspace path
  if (conv.workspacePath) {
    const extracted = extractProjectName(conv.workspacePath);
    if (!UNHELPFUL_PROJECT_NAMES.includes(extracted)) {
      return extracted;
    }
  }

  // Try to infer from file edits
  const edits = editsByConvId.get(conv.id);
  if (edits && edits.length > 0) {
    // Try to extract project from the first file path
    for (const edit of edits) {
      const extracted = extractProjectFromPath(edit.filePath);
      if (extracted) {
        return extracted.projectName;
      }
    }
  }

  // Fallback to unhelpful name or generic
  return conv.projectName || '(no project)';
}

export async function getProjectStats(period: PeriodFilter): Promise<ProjectStats[]> {
  await connect();
  const table = await getConversationsTable();
  const rows = await table.query().toArray();

  // Load file edits for project inference
  const editsTable = await getFileEditsTable();
  const allEdits = await editsTable.query().toArray();

  // Group edits by conversation ID
  const editsByConvId = new Map<string, Array<{ filePath: string }>>();
  for (const edit of allEdits) {
    const existing = editsByConvId.get(edit.conversationId) || [];
    existing.push({ filePath: edit.filePath });
    editsByConvId.set(edit.conversationId, existing);
  }

  const filtered = rows.filter(r => isInPeriod(r.createdAt, period));

  // Group by project name (use projectName if available, otherwise extract from workspacePath or file edits)
  const byProject = new Map<string, ProjectStats>();

  for (const conv of filtered) {
    const projectName = resolveProjectName(conv, editsByConvId);
    const existing = byProject.get(projectName) || {
      projectName,
      workspacePath: conv.workspacePath || '',
      conversations: 0,
      messages: 0,
      inputTokens: 0,
      outputTokens: 0,
      linesAdded: 0,
      linesRemoved: 0,
      lastActivity: '',
    };

    existing.conversations += 1;
    existing.messages += conv.messageCount || 0;
    existing.inputTokens += (conv.totalInputTokens || 0) +
      (conv.totalCacheCreationTokens || 0) + (conv.totalCacheReadTokens || 0);
    existing.outputTokens += conv.totalOutputTokens || 0;
    existing.linesAdded += conv.totalLinesAdded || 0;
    existing.linesRemoved += conv.totalLinesRemoved || 0;

    // Track most recent activity
    if (conv.createdAt && (!existing.lastActivity || conv.createdAt > existing.lastActivity)) {
      existing.lastActivity = conv.createdAt;
      existing.workspacePath = conv.workspacePath || existing.workspacePath;
    }

    byProject.set(projectName, existing);
  }

  // Sort by total tokens descending
  return Array.from(byProject.values()).sort(
    (a, b) => (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens)
  );
}

export async function getConversationsByProject(
  projectName: string,
  period: PeriodFilter
): Promise<Conversation[]> {
  await connect();
  const table = await getConversationsTable();
  const rows = await table.query().toArray();

  // Load file edits for project inference
  const editsTable = await getFileEditsTable();
  const allEdits = await editsTable.query().toArray();

  // Group edits by conversation ID
  const editsByConvId = new Map<string, Array<{ filePath: string }>>();
  for (const edit of allEdits) {
    const existing = editsByConvId.get(edit.conversationId) || [];
    existing.push({ filePath: edit.filePath });
    editsByConvId.set(edit.conversationId, existing);
  }

  const filtered = rows.filter(r => {
    if (!isInPeriod(r.createdAt, period)) return false;
    const convProjectName = resolveProjectName(r, editsByConvId);
    return convProjectName === projectName;
  });

  // Sort by createdAt descending
  filtered.sort((a, b) => {
    const aDate = a.createdAt || '';
    const bDate = b.createdAt || '';
    return bDate.localeCompare(aDate);
  });

  return filtered as Conversation[];
}

// --- File Analytics ---

/**
 * Extract relative path from a full file path given a workspace root.
 * Falls back to the full path if workspace doesn't match.
 */
function getRelativePath(filePath: string, workspacePath?: string): string {
  if (!workspacePath) return filePath;
  if (filePath.startsWith(workspacePath)) {
    const relative = filePath.slice(workspacePath.length);
    // Remove leading slash if present
    return relative.startsWith('/') ? relative.slice(1) : relative;
  }
  return filePath;
}

/**
 * Extract project name from an absolute file path.
 * Looks for common project directory patterns like:
 * - /Users/.../Documents/GitHub/PROJECT/...
 * - /Users/.../projects/PROJECT/...
 * - /home/user/PROJECT/...
 * - /Users/.../.cursor/worktrees/PROJECT/ID/...
 */
function extractProjectFromPath(filePath: string): { projectName: string; relativePath: string } | null {
  const parts = filePath.split('/');

  // Special case: .cursor/worktrees/PROJECT/ID/...
  // Pattern: /.cursor/worktrees/{project}/{hash}/...
  const cursorIdx = parts.findIndex(p => p === '.cursor');
  const cursorProjectName = parts[cursorIdx + 2];
  if (cursorIdx >= 0 && parts[cursorIdx + 1] === 'worktrees' && cursorProjectName) {
    // Skip the hash directory (cursorIdx + 3) and take rest as relative path
    const relativePath = parts.slice(cursorIdx + 4).join('/');
    return { projectName: cursorProjectName, relativePath };
  }

  // Look for common project root indicators
  const projectRootIndicators = ['GitHub', 'projects', 'repos', 'code', 'dev', 'workspace'];

  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (part && projectRootIndicators.includes(part)) {
      const projectName = parts[i + 1];
      if (projectName && projectName.length > 0) {
        return {
          projectName,
          relativePath: parts.slice(i + 2).join('/'),
        };
      }
    }
  }

  // Look for common source directories (src, lib, etc.) and use parent as project
  // But skip if parent is a hidden dir, user home, or project root indicator
  const srcIndicators = ['src', 'lib', 'app', 'pages', 'components', 'packages'];
  const srcIdx = parts.findIndex(p => srcIndicators.includes(p));
  if (srcIdx > 1) {
    const projectName = parts[srcIdx - 1];
    const skipAsProject = [...projectRootIndicators, 'Users', 'home'];
    if (projectName && projectName.length > 0 &&
        !projectName.startsWith('.') &&
        !skipAsProject.includes(projectName)) {
      return {
        projectName,
        relativePath: parts.slice(srcIdx).join('/'),
      };
    }
  }

  // For paths like /home/user/project/..., try the third segment after root
  // Skip: /, home, user -> take next as project
  if (parts.length > 4 && parts[1] === 'home') {
    const projectName = parts[3]; // /home/user/PROJECT/...
    if (projectName && projectName.length > 0 && !projectName.startsWith('.')) {
      return {
        projectName,
        relativePath: parts.slice(4).join('/'),
      };
    }
  }

  // For /Users/name/..., skip common directories and hidden dirs
  if (parts.length > 4 && parts[1] === 'Users') {
    const skipDirs = ['Documents', 'Desktop', 'Downloads', 'Library', 'Applications'];
    let startIdx = 3; // After /Users/name/

    // Skip Documents and similar if present
    while (startIdx < parts.length && skipDirs.includes(parts[startIdx] || '')) {
      startIdx++;
    }

    // Skip hidden directories (like .cursor, .vscode)
    while (startIdx < parts.length && (parts[startIdx] || '').startsWith('.')) {
      startIdx++;
    }

    if (startIdx < parts.length) {
      const projectName = parts[startIdx];
      if (projectName && projectName.length > 0 && !projectName.startsWith('.')) {
        return {
          projectName,
          relativePath: parts.slice(startIdx + 1).join('/'),
        };
      }
    }
  }

  return null;
}

/**
 * Extract project name from a file path by finding the best matching workspace.
 */
function findProjectForFile(filePath: string, workspaceMap: Map<string, string>): { projectName: string; relativePath: string } {
  // Try to find a workspace that contains this file
  let bestMatch = '';
  let bestProject = '';

  for (const [workspace, project] of workspaceMap) {
    if (filePath.startsWith(workspace) && workspace.length > bestMatch.length) {
      bestMatch = workspace;
      bestProject = project;
    }
  }

  if (bestMatch) {
    return {
      projectName: bestProject,
      relativePath: getRelativePath(filePath, bestMatch),
    };
  }

  // Fall back to extracting project from the file path itself
  const extracted = extractProjectFromPath(filePath);
  if (extracted) {
    return extracted;
  }

  // Last resort: use last 3 segments
  const parts = filePath.split('/');
  return {
    projectName: '(unknown)',
    relativePath: parts.slice(-3).join('/'),
  };
}

export async function getCombinedFileStats(
  period: PeriodFilter,
  limit: number = 10
): Promise<FileStats[]> {
  await connect();
  const [conversationsTable, filesTable, fileEditsTable] = await Promise.all([
    getConversationsTable(),
    getFilesTable(),
    getFileEditsTable(),
  ]);

  // Get conversations in period to filter files
  const convRows = await conversationsTable.query().toArray();
  const convsInPeriod = convRows.filter(r => isInPeriod(r.createdAt, period));
  const convInPeriodSet = new Set(convsInPeriod.map(r => r.id));

  // Build workspace -> project mapping from conversations
  const workspaceMap = new Map<string, string>();
  for (const conv of convsInPeriod) {
    if (conv.workspacePath) {
      const projectName = conv.projectName || extractProjectName(conv.workspacePath);
      workspaceMap.set(conv.workspacePath, projectName);
    }
  }

  // Aggregate file edits
  const editsRows = await fileEditsTable.query().toArray();
  const editsByFile = new Map<string, { editCount: number; linesAdded: number; linesRemoved: number; conversations: Set<string> }>();

  for (const edit of editsRows) {
    if (!convInPeriodSet.has(edit.conversationId)) continue;

    const existing = editsByFile.get(edit.filePath) || {
      editCount: 0,
      linesAdded: 0,
      linesRemoved: 0,
      conversations: new Set<string>(),
    };

    existing.editCount += 1;
    existing.linesAdded += edit.linesAdded || 0;
    existing.linesRemoved += edit.linesRemoved || 0;
    existing.conversations.add(edit.conversationId);

    editsByFile.set(edit.filePath, existing);
  }

  // Aggregate file mentions (from conversation_files)
  const filesRows = await filesTable.query().toArray();
  const mentionsByFile = new Map<string, { mentionCount: number; conversations: Set<string> }>();

  for (const file of filesRows) {
    if (!convInPeriodSet.has(file.conversationId)) continue;

    const existing = mentionsByFile.get(file.filePath) || {
      mentionCount: 0,
      conversations: new Set<string>(),
    };

    existing.mentionCount += 1;
    existing.conversations.add(file.conversationId);

    mentionsByFile.set(file.filePath, existing);
  }

  // Combine into FileStats
  const allFiles = new Set([...editsByFile.keys(), ...mentionsByFile.keys()]);
  const combined: FileStats[] = [];

  for (const filePath of allFiles) {
    const edits = editsByFile.get(filePath);
    const mentions = mentionsByFile.get(filePath);
    const allConversations = new Set([
      ...(edits?.conversations || []),
      ...(mentions?.conversations || []),
    ]);

    // Get project and relative path
    const { projectName, relativePath } = findProjectForFile(filePath, workspaceMap);

    combined.push({
      filePath,
      relativePath,
      projectName,
      editCount: edits?.editCount || 0,
      mentionCount: mentions?.mentionCount || 0,
      linesAdded: edits?.linesAdded || 0,
      linesRemoved: edits?.linesRemoved || 0,
      conversationCount: allConversations.size,
    });
  }

  // Sort by total activity (edits + mentions) descending
  combined.sort((a, b) => (b.editCount + b.mentionCount) - (a.editCount + a.mentionCount));

  return combined.slice(0, limit);
}

export async function getEditTypeBreakdown(period: PeriodFilter): Promise<EditTypeBreakdown> {
  await connect();
  const [conversationsTable, fileEditsTable] = await Promise.all([
    getConversationsTable(),
    getFileEditsTable(),
  ]);

  // Get conversations in period
  const convRows = await conversationsTable.query().toArray();
  const convInPeriod = new Set(
    convRows
      .filter(r => isInPeriod(r.createdAt, period))
      .map(r => r.id)
  );

  const editsRows = await fileEditsTable.query().toArray();

  let create = 0;
  let modify = 0;
  let deleteCount = 0;

  for (const edit of editsRows) {
    if (!convInPeriod.has(edit.conversationId)) continue;

    if (edit.editType === 'create') create++;
    else if (edit.editType === 'modify') modify++;
    else if (edit.editType === 'delete') deleteCount++;
  }

  return { create, modify, delete: deleteCount };
}

export async function getFileTypeStats(
  period: PeriodFilter,
  limit: number = 5
): Promise<FileTypeStats[]> {
  await connect();
  const [conversationsTable, fileEditsTable] = await Promise.all([
    getConversationsTable(),
    getFileEditsTable(),
  ]);

  // Get conversations in period
  const convRows = await conversationsTable.query().toArray();
  const convInPeriod = new Set(
    convRows
      .filter(r => isInPeriod(r.createdAt, period))
      .map(r => r.id)
  );

  const editsRows = await fileEditsTable.query().toArray();
  const byExtension = new Map<string, FileTypeStats>();

  for (const edit of editsRows) {
    if (!convInPeriod.has(edit.conversationId)) continue;

    // Extract file extension
    const parts = edit.filePath.split('.');
    let extension = parts.length > 1 ? `.${parts[parts.length - 1]}` : '(no ext)';

    // Group .ts and .tsx together
    if (extension === '.ts' || extension === '.tsx') {
      extension = '.ts/.tsx';
    }

    const existing = byExtension.get(extension) || {
      extension,
      editCount: 0,
      linesAdded: 0,
    };

    existing.editCount += 1;
    existing.linesAdded += edit.linesAdded || 0;

    byExtension.set(extension, existing);
  }

  // Sort by edit count descending
  return Array.from(byExtension.values())
    .sort((a, b) => b.editCount - a.editCount)
    .slice(0, limit);
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
