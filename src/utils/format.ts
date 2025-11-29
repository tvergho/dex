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
