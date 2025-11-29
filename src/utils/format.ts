/**
 * Shared formatting utilities for consistent display across the CLI
 */

/**
 * Format a date as a human-readable relative time string
 */
export function formatRelativeTime(isoDate: string | undefined): string {
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

/**
 * Capitalize the first letter of a source name (e.g., "cursor" -> "Cursor")
 */
export function formatSourceName(source: string): string {
  return source.charAt(0).toUpperCase() + source.slice(1);
}

/**
 * Truncate a path from the left, preserving the end with an ellipsis prefix
 */
export function truncatePath(path: string, maxLen: number): string {
  if (path.length <= maxLen) return path;
  return '…' + path.slice(-(maxLen - 1));
}

/**
 * Extract the filename from a full file path
 */
export function getFileName(filePath: string): string {
  const parts = filePath.split('/');
  return parts[parts.length - 1] || filePath;
}

/**
 * Format pagination info as "start-end of total"
 */
export function formatPaginationInfo(
  offset: number,
  pageSize: number,
  total: number
): string {
  const start = offset + 1;
  const end = Math.min(offset + pageSize, total);
  return `${start}-${end} of ${total}`;
}

/**
 * Format match count as "N match(es)"
 */
export function formatMatchCount(count: number): string {
  return `${count} match${count !== 1 ? 'es' : ''}`;
}

/**
 * Format message count as "N message(s)"
 */
export function formatMessageCount(count: number): string {
  return `${count} message${count !== 1 ? 's' : ''}`;
}

/**
 * Format conversation count as "N conversation(s)"
 */
export function formatConversationCount(count: number): string {
  return `${count} conversation${count !== 1 ? 's' : ''}`;
}

/**
 * Get role label for display
 */
export function getRoleLabel(role: string): string {
  if (role === 'user') return 'You';
  if (role === 'assistant') return 'Assistant';
  return 'System';
}

/**
 * Get role color for Ink components
 */
export function getRoleColor(role: string): string {
  if (role === 'user') return 'green';
  if (role === 'assistant') return 'blue';
  return 'yellow';
}

/**
 * Format source info with optional model (e.g., "Cursor · gpt-4")
 */
export function formatSourceInfo(source: string, model?: string | null): string {
  const sourceName = formatSourceName(source);
  return model ? `${sourceName} · ${model}` : sourceName;
}

/**
 * Format a token count as a human-readable string (e.g., "1.2K", "42.5K", "1.2M")
 */
export function formatTokenCount(count: number | undefined): string {
  if (count === undefined || count === 0) return '';
  if (count < 1000) return count.toString();
  if (count < 1000000) {
    const k = count / 1000;
    return k >= 10 ? `${Math.round(k)}K` : `${k.toFixed(1)}K`;
  }
  const m = count / 1000000;
  return m >= 10 ? `${Math.round(m)}M` : `${m.toFixed(1)}M`;
}

/**
 * Format input/output token pair (e.g., "42K in / 2.3K out")
 * For Claude Code, input includes cache tokens (cache_creation + cache_read + input)
 */
export function formatTokenPair(
  inputTokens: number | undefined,
  outputTokens: number | undefined,
  cacheCreationTokens?: number,
  cacheReadTokens?: number
): string {
  // Total input = regular input + cache tokens (for Claude Code)
  const input = (inputTokens || 0) + (cacheCreationTokens || 0) + (cacheReadTokens || 0);
  const output = outputTokens || 0;
  if (input === 0 && output === 0) return '';
  return `${formatTokenCount(input) || '0'} in / ${formatTokenCount(output) || '0'} out`;
}

/**
 * Format line counts as "+N / -M" for display
 * Only shows if there are actual changes
 */
export function formatLineCounts(
  linesAdded: number | undefined,
  linesRemoved: number | undefined
): string {
  const added = linesAdded || 0;
  const removed = linesRemoved || 0;
  if (added === 0 && removed === 0) return '';
  return `+${added} / -${removed}`;
}

/**
 * Truncate a list of file names for display
 */
export function formatFileList(
  fileNames: string[],
  maxShow: number = 2
): string {
  if (fileNames.length === 0) return '';
  const shown = fileNames.slice(0, maxShow).join(', ');
  const remaining = fileNames.length - maxShow;
  return remaining > 0 ? `${shown} +${remaining}` : shown;
}

/**
 * Format files display with optional "more" indicator
 */
export function formatFilesDisplay(
  fileNames: string[],
  totalCount: number,
  maxShow: number = 5
): string {
  if (fileNames.length === 0) return 'No files';
  const shown = fileNames.slice(0, maxShow).join(', ');
  const remaining = totalCount - maxShow;
  return remaining > 0 ? `Files: ${shown} (+${remaining} more)` : `Files: ${shown}`;
}

/**
 * Combined message that groups consecutive messages from the same role
 */
export interface CombinedMessage {
  /** IDs of all original messages in this group */
  messageIds: string[];
  /** Combined content from all messages */
  content: string;
  /** Role (user, assistant, system) */
  role: 'user' | 'assistant' | 'system';
  /** Index of this combined message (0-based) */
  combinedIndex: number;
  /** Original message indices included in this group */
  originalIndices: number[];
  /** Timestamp from first message */
  timestamp?: string;
  /** Total input tokens for this message group */
  inputTokens?: number;
  /** Total output tokens for this message group */
  outputTokens?: number;
  /** Total cache creation tokens for this message group */
  cacheCreationTokens?: number;
  /** Total cache read tokens for this message group */
  cacheReadTokens?: number;
  /** Total lines added for this message group */
  totalLinesAdded?: number;
  /** Total lines removed for this message group */
  totalLinesRemoved?: number;
}

/**
 * Result of combining messages
 */
export interface CombinedMessagesResult {
  /** Combined messages */
  messages: CombinedMessage[];
  /** Map from original messageIndex to combined index */
  indexMap: Map<number, number>;
}

/**
 * Combine consecutive messages from the same role (especially assistant messages
 * that are split by tool calls) into single logical messages.
 */
export function combineConsecutiveMessages<T extends {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  messageIndex: number;
  timestamp?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  totalLinesAdded?: number;
  totalLinesRemoved?: number;
}>(messages: T[]): CombinedMessagesResult {
  if (messages.length === 0) {
    return { messages: [], indexMap: new Map() };
  }

  const combined: CombinedMessage[] = [];
  const indexMap = new Map<number, number>();

  let currentGroup: T[] = [];
  let currentRole: string | null = null;

  for (const msg of messages) {
    if (msg.role === currentRole && (currentRole === 'assistant' || currentRole === 'user')) {
      // Continue grouping consecutive messages from the same role
      currentGroup.push(msg);
    } else {
      // Flush current group if any
      if (currentGroup.length > 0) {
        const combinedIdx = combined.length;
        // Sum up tokens and line counts from all messages in the group
        const totalInputTokens = currentGroup.reduce((sum, m) => sum + (m.inputTokens || 0), 0);
        const totalOutputTokens = currentGroup.reduce((sum, m) => sum + (m.outputTokens || 0), 0);
        const totalCacheCreationTokens = currentGroup.reduce((sum, m) => sum + (m.cacheCreationTokens || 0), 0);
        const totalCacheReadTokens = currentGroup.reduce((sum, m) => sum + (m.cacheReadTokens || 0), 0);
        const totalLinesAdded = currentGroup.reduce((sum, m) => sum + (m.totalLinesAdded || 0), 0);
        const totalLinesRemoved = currentGroup.reduce((sum, m) => sum + (m.totalLinesRemoved || 0), 0);
        combined.push({
          messageIds: currentGroup.map(m => m.id),
          content: currentGroup.map(m => m.content).join('\n\n'),
          role: currentGroup[0]!.role,
          combinedIndex: combinedIdx,
          originalIndices: currentGroup.map(m => m.messageIndex),
          timestamp: currentGroup[0]!.timestamp,
          inputTokens: totalInputTokens > 0 ? totalInputTokens : undefined,
          outputTokens: totalOutputTokens > 0 ? totalOutputTokens : undefined,
          cacheCreationTokens: totalCacheCreationTokens > 0 ? totalCacheCreationTokens : undefined,
          cacheReadTokens: totalCacheReadTokens > 0 ? totalCacheReadTokens : undefined,
          totalLinesAdded: totalLinesAdded > 0 ? totalLinesAdded : undefined,
          totalLinesRemoved: totalLinesRemoved > 0 ? totalLinesRemoved : undefined,
        });
        // Map all original indices to this combined index
        for (const m of currentGroup) {
          indexMap.set(m.messageIndex, combinedIdx);
        }
      }
      // Start new group
      currentGroup = [msg];
      currentRole = msg.role;
    }
  }

  // Flush final group
  if (currentGroup.length > 0) {
    const combinedIdx = combined.length;
    // Sum up tokens and line counts from all messages in the group
    const totalInputTokens = currentGroup.reduce((sum, m) => sum + (m.inputTokens || 0), 0);
    const totalOutputTokens = currentGroup.reduce((sum, m) => sum + (m.outputTokens || 0), 0);
    const totalCacheCreationTokens = currentGroup.reduce((sum, m) => sum + (m.cacheCreationTokens || 0), 0);
    const totalCacheReadTokens = currentGroup.reduce((sum, m) => sum + (m.cacheReadTokens || 0), 0);
    const totalLinesAdded = currentGroup.reduce((sum, m) => sum + (m.totalLinesAdded || 0), 0);
    const totalLinesRemoved = currentGroup.reduce((sum, m) => sum + (m.totalLinesRemoved || 0), 0);
    combined.push({
      messageIds: currentGroup.map(m => m.id),
      content: currentGroup.map(m => m.content).join('\n\n'),
      role: currentGroup[0]!.role,
      combinedIndex: combinedIdx,
      originalIndices: currentGroup.map(m => m.messageIndex),
      timestamp: currentGroup[0]!.timestamp,
      inputTokens: totalInputTokens > 0 ? totalInputTokens : undefined,
      outputTokens: totalOutputTokens > 0 ? totalOutputTokens : undefined,
      cacheCreationTokens: totalCacheCreationTokens > 0 ? totalCacheCreationTokens : undefined,
      cacheReadTokens: totalCacheReadTokens > 0 ? totalCacheReadTokens : undefined,
      totalLinesAdded: totalLinesAdded > 0 ? totalLinesAdded : undefined,
      totalLinesRemoved: totalLinesRemoved > 0 ? totalLinesRemoved : undefined,
    });
    for (const m of currentGroup) {
      indexMap.set(m.messageIndex, combinedIdx);
    }
  }

  return { messages: combined, indexMap };
}
