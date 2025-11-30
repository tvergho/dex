/**
 * Export utilities for formatting conversations as markdown
 */

import type { Conversation, Message, ConversationFile, ToolCall, FileEdit } from '../schema/index';
import { combineConsecutiveMessages, getFileName } from './format';

/**
 * Generate a safe filename from conversation title and date
 */
export function generateFilename(conv: Conversation): string {
  // Start with date if available
  let prefix = '';
  if (conv.createdAt) {
    const date = new Date(conv.createdAt);
    prefix = date.toISOString().split('T')[0] + '_'; // YYYY-MM-DD_
  }

  // Sanitize title for filename
  let title = conv.title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '') // Remove special chars
    .replace(/\s+/g, '-') // Spaces to hyphens
    .replace(/-+/g, '-') // Collapse multiple hyphens
    .slice(0, 50) // Limit length
    .replace(/-$/, ''); // Remove trailing hyphen

  // Fallback if title is empty after sanitization
  if (!title) {
    title = conv.id.slice(0, 8);
  }

  return `${prefix}${title}.md`;
}

/**
 * Get project name from workspace path
 */
export function getProjectName(workspacePath: string | undefined): string {
  if (!workspacePath) return '';
  // Remove trailing slashes before splitting
  const normalized = workspacePath.replace(/\/+$/, '');
  const parts = normalized.split('/');
  return parts[parts.length - 1] || workspacePath;
}

/**
 * Format a conversation as markdown
 */
export function conversationToMarkdown(
  conv: Conversation,
  messages: Message[],
  files: ConversationFile[],
  toolCalls: ToolCall[] = [],
  fileEdits: FileEdit[] = []
): string {
  const lines: string[] = [];

  // Title
  lines.push(`# ${conv.title}`);
  lines.push('');

  // Metadata
  const sourceName = conv.source.charAt(0).toUpperCase() + conv.source.slice(1);
  lines.push(`**Source:** ${sourceName}`);

  if (conv.workspacePath) {
    lines.push(`**Project:** ${conv.workspacePath}`);
  }

  if (conv.model) {
    lines.push(`**Model:** ${conv.model}`);
  }

  if (conv.mode) {
    lines.push(`**Mode:** ${conv.mode}`);
  }

  if (conv.createdAt) {
    const date = new Date(conv.createdAt);
    lines.push(`**Created:** ${date.toLocaleString()}`);
  }

  lines.push(`**Messages:** ${conv.messageCount}`);

  // Token usage if available
  if (conv.totalInputTokens || conv.totalOutputTokens) {
    const input = conv.totalInputTokens?.toLocaleString() ?? '0';
    const output = conv.totalOutputTokens?.toLocaleString() ?? '0';
    lines.push(`**Tokens:** ${input} in / ${output} out`);
  }

  // Lines changed if available
  if (conv.totalLinesAdded || conv.totalLinesRemoved) {
    const added = conv.totalLinesAdded ?? 0;
    const removed = conv.totalLinesRemoved ?? 0;
    lines.push(`**Lines Changed:** +${added} / -${removed}`);
  }

  // Files involved
  if (files.length > 0) {
    const fileNames = files.slice(0, 10).map((f) => {
      const parts = f.filePath.split('/');
      return parts[parts.length - 1] || f.filePath;
    });
    const suffix = files.length > 10 ? ` (+${files.length - 10} more)` : '';
    lines.push(`**Files:** ${fileNames.join(', ')}${suffix}`);
  }

  lines.push('');
  lines.push('---');
  lines.push('');

  // Combine consecutive messages from the same role (matching UI display)
  const { messages: combinedMessages } = combineConsecutiveMessages(messages);

  // Messages
  for (const msg of combinedMessages) {
    const roleLabel =
      msg.role === 'user' ? 'You' : msg.role === 'assistant' ? 'Assistant' : 'System';

    lines.push(`## ${roleLabel}`);
    lines.push('');
    lines.push(msg.content);

    // Add tool outputs for assistant messages
    if (msg.role === 'assistant') {
      const msgToolCalls = toolCalls.filter(
        (tc) => msg.messageIds.includes(tc.messageId) && tc.output
      );
      const msgFileEdits = fileEdits.filter(
        (fe) => msg.messageIds.includes(fe.messageId) && fe.newContent
      );

      if (msgToolCalls.length > 0 || msgFileEdits.length > 0) {
        lines.push('');
        lines.push('### Tool Outputs');
        lines.push('');

        for (const tc of msgToolCalls) {
          const fileName = tc.filePath ? getFileName(tc.filePath) : '';
          lines.push(`**${tc.type}**${fileName ? ` \`${fileName}\`` : ''}`);
          lines.push('```');
          lines.push(tc.output!);
          lines.push('```');
          lines.push('');
        }

        for (const fe of msgFileEdits) {
          const fileName = getFileName(fe.filePath);
          lines.push(`**Edit** \`${fileName}\` (+${fe.linesAdded}/-${fe.linesRemoved})`);
          lines.push('```');
          lines.push(fe.newContent!);
          lines.push('```');
          lines.push('');
        }
      }
    }

    lines.push('');
    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Format date for display
 */
export function formatDate(dateStr: string | undefined): string {
  if (!dateStr) return 'Unknown';
  const date = new Date(dateStr);
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Parse a date string that could be ISO 8601 or YYYY-MM-DD
 */
export function parseDate(dateStr: string): Date {
  // If it's just a date (YYYY-MM-DD), treat as start of day
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return new Date(dateStr + 'T00:00:00');
  }
  return new Date(dateStr);
}

/**
 * Validate that a date string is parseable
 */
export function isValidDate(dateStr: string): boolean {
  const date = parseDate(dateStr);
  return !isNaN(date.getTime());
}
