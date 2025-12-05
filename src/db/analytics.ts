/**
 * Analytics query functions for the stats dashboard
 */

import { connect, getConversationsTable, getFilesTable, getFileEditsTable, withRetry, isTransientError } from './index';
import type { Table } from '@lancedb/lancedb';
import { Source, type Conversation } from '../schema/index';

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

// --- Query Helper ---

/**
 * Execute a table query with retry logic for transient LanceDB errors.
 * Handles stale table references that occur during/after sync operations.
 */
async function queryTableWithRetry<T>(
  getTable: () => Promise<Table>,
  query: (table: Table) => Promise<T>
): Promise<T> {
  return withRetry(async () => {
    const table = await getTable();
    return query(table);
  });
}

// --- Query Functions ---

export async function getOverviewStats(period: PeriodFilter): Promise<OverviewStats> {
  await connect();
  const rows = await queryTableWithRetry(getConversationsTable, table => table.query().toArray());

  const filtered = rows.filter(r => isInPeriod(r.created_at as string, period));

  let messages = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalLinesAdded = 0;
  let totalLinesRemoved = 0;

  for (const conv of filtered) {
    messages += (conv.message_count as number) || 0;
    // Include cache tokens in input for consistency with other stats functions
    totalInputTokens += ((conv.total_input_tokens as number) || 0) +
      ((conv.total_cache_creation_tokens as number) || 0) + ((conv.total_cache_read_tokens as number) || 0);
    totalOutputTokens += (conv.total_output_tokens as number) || 0;
    totalLinesAdded += (conv.total_lines_added as number) || 0;
    totalLinesRemoved += (conv.total_lines_removed as number) || 0;
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
  const rows = await queryTableWithRetry(getConversationsTable, table => table.query().toArray());

  const filtered = rows.filter(r => isInPeriod(r.created_at as string, period));

  // Group by date
  const byDate = new Map<string, DayActivity>();

  for (const conv of filtered) {
    const createdAt = conv.created_at as string;
    const date = createdAt?.split('T')[0];
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
    existing.messages += (conv.message_count as number) || 0;
    // Include cache tokens for total context processed
    existing.tokens += ((conv.total_input_tokens as number) || 0) + ((conv.total_output_tokens as number) || 0) +
      ((conv.total_cache_creation_tokens as number) || 0) + ((conv.total_cache_read_tokens as number) || 0);
    existing.linesAdded += (conv.total_lines_added as number) || 0;
    existing.linesRemoved += (conv.total_lines_removed as number) || 0;

    byDate.set(date, existing);
  }

  // Sort by date
  return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
}

export async function getStatsBySource(period: PeriodFilter): Promise<SourceStats[]> {
  await connect();
  const rows = await queryTableWithRetry(getConversationsTable, table => table.query().toArray());

  const filtered = rows.filter(r => isInPeriod(r.created_at as string, period));

  const bySource = new Map<string, SourceStats>();

  for (const conv of filtered) {
    const source = (conv.source as string) || 'unknown';
    const existing = bySource.get(source) || {
      source,
      conversations: 0,
      messages: 0,
      tokens: 0,
    };

    existing.conversations += 1;
    existing.messages += (conv.message_count as number) || 0;
    // Include cache tokens for total context processed
    existing.tokens += ((conv.total_input_tokens as number) || 0) + ((conv.total_output_tokens as number) || 0) +
      ((conv.total_cache_creation_tokens as number) || 0) + ((conv.total_cache_read_tokens as number) || 0);

    bySource.set(source, existing);
  }

  // Sort by token count descending
  return Array.from(bySource.values()).sort((a, b) => b.tokens - a.tokens);
}

export async function getStatsByModel(period: PeriodFilter): Promise<ModelStats[]> {
  await connect();
  const rows = await queryTableWithRetry(getConversationsTable, table => table.query().toArray());

  const filtered = rows.filter(r => isInPeriod(r.created_at as string, period));

  // Group by model+source combination
  const byModelSource = new Map<string, ModelStats>();

  for (const conv of filtered) {
    const model = (conv.model as string) || '(unknown)';
    const source = (conv.source as string) || 'unknown';
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
    existing.inputTokens += ((conv.total_input_tokens as number) || 0) +
      ((conv.total_cache_creation_tokens as number) || 0) + ((conv.total_cache_read_tokens as number) || 0);
    existing.outputTokens += (conv.total_output_tokens as number) || 0;

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
  const rows = await queryTableWithRetry(getConversationsTable, table => table.query().toArray());

  const filtered = rows.filter(r => isInPeriod(r.created_at as string, period));

  // Sort by total tokens descending (including cache tokens)
  filtered.sort((a, b) => {
    const aTokens = ((a.total_input_tokens as number) || 0) + ((a.total_output_tokens as number) || 0) +
      ((a.total_cache_creation_tokens as number) || 0) + ((a.total_cache_read_tokens as number) || 0);
    const bTokens = ((b.total_input_tokens as number) || 0) + ((b.total_output_tokens as number) || 0) +
      ((b.total_cache_creation_tokens as number) || 0) + ((b.total_cache_read_tokens as number) || 0);
    return bTokens - aTokens;
  });

  return filtered.slice(0, limit) as Conversation[];
}

export async function getLinesGeneratedStats(
  period: PeriodFilter,
  limit: number = 5
): Promise<LinesGeneratedStats> {
  await connect();
  const rows = await queryTableWithRetry(getConversationsTable, table => table.query().toArray());

  const filtered = rows.filter(r => isInPeriod(r.created_at as string, period));

  let totalLinesAdded = 0;
  let totalLinesRemoved = 0;

  for (const conv of filtered) {
    totalLinesAdded += (conv.total_lines_added as number) || 0;
    totalLinesRemoved += (conv.total_lines_removed as number) || 0;
  }

  // Sort by lines added descending
  const sorted = [...filtered].sort(
    (a, b) => ((b.total_lines_added as number) || 0) - ((a.total_lines_added as number) || 0)
  );

  const topConversationsByLines = sorted.slice(0, limit).map(conv => ({
    id: conv.id as string,
    title: (conv.title as string) || '(untitled)',
    linesAdded: (conv.total_lines_added as number) || 0,
    linesRemoved: (conv.total_lines_removed as number) || 0,
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
  const rows = await queryTableWithRetry(getConversationsTable, table => table.query().toArray());

  // Only include Claude Code and Codex sources (which have cache data)
  const filtered = rows.filter(
    r => isInPeriod(r.created_at as string, period) &&
         (r.source === Source.ClaudeCode || r.source === Source.Codex)
  );

  let totalInput = 0;
  let totalOutput = 0;
  let cacheCreation = 0;
  let cacheRead = 0;

  for (const conv of filtered) {
    totalInput += (conv.total_input_tokens as number) || 0;
    totalOutput += (conv.total_output_tokens as number) || 0;
    cacheCreation += (conv.total_cache_creation_tokens as number) || 0;
    cacheRead += (conv.total_cache_read_tokens as number) || 0;
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
  const rows = await queryTableWithRetry(getConversationsTable, table => table.query().toArray());

  const filtered = rows.filter(r => isInPeriod(r.created_at as string, period));

  // Initialize 24-hour array
  const byHour = new Array(24).fill(0);

  for (const conv of filtered) {
    const createdAt = conv.created_at as string;
    if (!createdAt) continue;
    const hour = new Date(createdAt).getHours();
    byHour[hour] += 1;
  }

  return byHour;
}

export async function getActivityByDayOfWeek(period: PeriodFilter): Promise<number[]> {
  await connect();
  const rows = await queryTableWithRetry(getConversationsTable, table => table.query().toArray());

  const filtered = rows.filter(r => isInPeriod(r.created_at as string, period));

  // Initialize 7-day array (0 = Sunday, 6 = Saturday)
  const byDay = new Array(7).fill(0);

  for (const conv of filtered) {
    const createdAt = conv.created_at as string;
    if (!createdAt) continue;
    const day = new Date(createdAt).getDay();
    byDay[day] += 1;
  }

  return byDay;
}

export async function getStreakInfo(): Promise<StreakInfo> {
  await connect();
  const rows = await queryTableWithRetry(getConversationsTable, table => table.query().toArray());

  // Get all unique dates with activity
  const datesSet = new Set<string>();
  for (const conv of rows) {
    const createdAt = conv.created_at as string;
    if (createdAt) {
      datesSet.add(createdAt.split('T')[0]!);
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
 * Tries: project_name -> workspace_path -> file edits -> fallback
 */
function resolveProjectName(
  conv: { project_name?: string; workspace_path?: string; id: string },
  editsByConvId: Map<string, Array<{ file_path: string }>>
): string {
  // If conversation has a useful project name, use it
  if (conv.project_name && !UNHELPFUL_PROJECT_NAMES.includes(conv.project_name)) {
    return conv.project_name;
  }

  // Try extracting from workspace path
  if (conv.workspace_path) {
    const extracted = extractProjectName(conv.workspace_path);
    if (!UNHELPFUL_PROJECT_NAMES.includes(extracted)) {
      return extracted;
    }
  }

  // Try to infer from file edits
  const edits = editsByConvId.get(conv.id as string);
  if (edits && edits.length > 0) {
    // Try to extract project from the first file path
    for (const edit of edits) {
      const extracted = extractProjectFromPath(edit.file_path);
      if (extracted) {
        return extracted.projectName;
      }
    }
  }

  // Fallback to unhelpful name or generic
  return conv.project_name || '(no project)';
}

export async function getProjectStats(period: PeriodFilter): Promise<ProjectStats[]> {
  await connect();
  const rows = await queryTableWithRetry(getConversationsTable, table => table.query().toArray());

  // Load file edits for project inference
  const allEdits = await queryTableWithRetry(getFileEditsTable, table => table.query().toArray());

  // Group edits by conversation ID
  const editsByConvId = new Map<string, Array<{ file_path: string }>>();
  for (const edit of allEdits) {
    const existing = editsByConvId.get(edit.conversation_id as string) || [];
    existing.push({ file_path: edit.file_path as string });
    editsByConvId.set(edit.conversation_id as string, existing);
  }

  const filtered = rows.filter(r => isInPeriod(r.created_at as string, period));

  // Group by project name (use project_name if available, otherwise extract from workspace_path or file edits)
  const byProject = new Map<string, ProjectStats>();

  for (const conv of filtered) {
    const projectName = resolveProjectName(conv as any, editsByConvId);
    const existing = byProject.get(projectName) || {
      projectName,
      workspacePath: (conv.workspace_path as string) || '',
      conversations: 0,
      messages: 0,
      inputTokens: 0,
      outputTokens: 0,
      linesAdded: 0,
      linesRemoved: 0,
      lastActivity: '',
    };

    existing.conversations += 1;
    existing.messages += (conv.message_count as number) || 0;
    existing.inputTokens += ((conv.total_input_tokens as number) || 0) +
      ((conv.total_cache_creation_tokens as number) || 0) + ((conv.total_cache_read_tokens as number) || 0);
    existing.outputTokens += (conv.total_output_tokens as number) || 0;
    existing.linesAdded += (conv.total_lines_added as number) || 0;
    existing.linesRemoved += (conv.total_lines_removed as number) || 0;

    // Track most recent activity
    const createdAt = conv.created_at as string;
    if (createdAt && (!existing.lastActivity || createdAt > existing.lastActivity)) {
      existing.lastActivity = createdAt;
      existing.workspacePath = (conv.workspace_path as string) || existing.workspacePath;
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
  const rows = await queryTableWithRetry(getConversationsTable, table => table.query().toArray());

  // Load file edits for project inference
  const allEdits = await queryTableWithRetry(getFileEditsTable, table => table.query().toArray());

  // Group edits by conversation ID
  const editsByConvId = new Map<string, Array<{ file_path: string }>>();
  for (const edit of allEdits) {
    const existing = editsByConvId.get(edit.conversation_id as string) || [];
    existing.push({ file_path: edit.file_path as string });
    editsByConvId.set(edit.conversation_id as string, existing);
  }

  const filtered = rows.filter(r => {
    if (!isInPeriod(r.created_at as string, period)) return false;
    const convProjectName = resolveProjectName(r as any, editsByConvId);
    return convProjectName === projectName;
  });

  // Sort by created_at descending
  filtered.sort((a, b) => {
    const aDate = (a.created_at as string) || '';
    const bDate = (b.created_at as string) || '';
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

  // Get conversations in period to filter files
  const convRows = await queryTableWithRetry(getConversationsTable, table => table.query().toArray());
  const convsInPeriod = convRows.filter(r => isInPeriod(r.created_at as string, period));
  const convInPeriodSet = new Set(convsInPeriod.map(r => r.id as string));

  // Build workspace -> project mapping from conversations
  const workspaceMap = new Map<string, string>();
  for (const conv of convsInPeriod) {
    const workspacePath = conv.workspace_path as string;
    if (workspacePath) {
      const projectName = (conv.project_name as string) || extractProjectName(workspacePath);
      workspaceMap.set(workspacePath, projectName);
    }
  }

  // Aggregate file edits
  const editsRows = await queryTableWithRetry(getFileEditsTable, table => table.query().toArray());
  const editsByFile = new Map<string, { editCount: number; linesAdded: number; linesRemoved: number; conversations: Set<string> }>();

  for (const edit of editsRows) {
    const conversationId = edit.conversation_id as string;
    if (!convInPeriodSet.has(conversationId)) continue;

    const filePath = edit.file_path as string;
    const existing = editsByFile.get(filePath) || {
      editCount: 0,
      linesAdded: 0,
      linesRemoved: 0,
      conversations: new Set<string>(),
    };

    existing.editCount += 1;
    existing.linesAdded += (edit.lines_added as number) || 0;
    existing.linesRemoved += (edit.lines_removed as number) || 0;
    existing.conversations.add(conversationId);

    editsByFile.set(filePath, existing);
  }

  // Aggregate file mentions (from conversation_files)
  const filesRows = await queryTableWithRetry(getFilesTable, table => table.query().toArray());
  const mentionsByFile = new Map<string, { mentionCount: number; conversations: Set<string> }>();

  for (const file of filesRows) {
    const conversationId = file.conversation_id as string;
    if (!convInPeriodSet.has(conversationId)) continue;

    const filePath = file.file_path as string;
    const existing = mentionsByFile.get(filePath) || {
      mentionCount: 0,
      conversations: new Set<string>(),
    };

    existing.mentionCount += 1;
    existing.conversations.add(conversationId);

    mentionsByFile.set(filePath, existing);
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

  // Get conversations in period
  const convRows = await queryTableWithRetry(getConversationsTable, table => table.query().toArray());
  const convInPeriod = new Set(
    convRows
      .filter(r => isInPeriod(r.created_at as string, period))
      .map(r => r.id as string)
  );

  const editsRows = await queryTableWithRetry(getFileEditsTable, table => table.query().toArray());

  let create = 0;
  let modify = 0;
  let deleteCount = 0;

  for (const edit of editsRows) {
    if (!convInPeriod.has(edit.conversation_id as string)) continue;

    const editType = edit.edit_type as string;
    if (editType === 'create') create++;
    else if (editType === 'modify') modify++;
    else if (editType === 'delete') deleteCount++;
  }

  return { create, modify, delete: deleteCount };
}

export async function getFileTypeStats(
  period: PeriodFilter,
  limit: number = 5
): Promise<FileTypeStats[]> {
  await connect();

  // Get conversations in period
  const convRows = await queryTableWithRetry(getConversationsTable, table => table.query().toArray());
  const convInPeriod = new Set(
    convRows
      .filter(r => isInPeriod(r.created_at as string, period))
      .map(r => r.id as string)
  );

  const editsRows = await queryTableWithRetry(getFileEditsTable, table => table.query().toArray());
  const byExtension = new Map<string, FileTypeStats>();

  for (const edit of editsRows) {
    if (!convInPeriod.has(edit.conversation_id as string)) continue;

    // Extract file extension
    const filePath = edit.file_path as string;
    const parts = filePath.split('.');
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
    existing.linesAdded += (edit.lines_added as number) || 0;

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
  const rows = await queryTableWithRetry(getConversationsTable, table => table.query().toArray());

  const filtered = rows.filter(r => isInPeriod(r.created_at as string, period));

  // Sort by created_at descending (most recent first)
  filtered.sort((a, b) => {
    const aDate = (a.created_at as string) || '';
    const bDate = (b.created_at as string) || '';
    return bDate.localeCompare(aDate);
  });

  return filtered.slice(0, limit).map(conv => ({
    id: conv.id as string,
    title: (conv.title as string) || '(untitled)',
    source: (conv.source as string) || 'unknown',
    createdAt: (conv.created_at as string) || '',
    totalTokens: ((conv.total_input_tokens as number) || 0) + ((conv.total_output_tokens as number) || 0) +
      ((conv.total_cache_creation_tokens as number) || 0) + ((conv.total_cache_read_tokens as number) || 0),
  }));
}
