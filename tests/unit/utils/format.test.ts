/**
 * Unit tests for format utilities
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  formatRelativeTime,
  formatSourceName,
  formatSourceLabel,
  truncatePath,
  getFileName,
  formatPaginationInfo,
  formatMatchCount,
  formatMessageCount,
  formatConversationCount,
  getRoleLabel,
  getRoleColor,
  formatSourceInfo,
  formatTokenCount,
  formatTokenPair,
  formatLineCounts,
  getLineCountParts,
  formatFileList,
  formatFilesDisplay,
  combineConsecutiveMessages,
} from '../../../src/utils/format';

describe('formatRelativeTime', () => {
  // Store real Date for restoration
  const RealDate = global.Date;

  beforeEach(() => {
    // Mock Date to return a fixed time
    const mockDate = new Date('2025-01-15T12:00:00.000Z');
    global.Date = class extends RealDate {
      constructor(...args: Parameters<typeof RealDate>) {
        if (args.length === 0) {
          return mockDate;
        }
        // @ts-expect-error - super call with spread args
        return new RealDate(...args);
      }
      static now() {
        return mockDate.getTime();
      }
    } as DateConstructor;
  });

  afterEach(() => {
    global.Date = RealDate;
  });

  it('returns empty string for undefined', () => {
    expect(formatRelativeTime(undefined)).toBe('');
  });

  it('returns "today" for same day', () => {
    expect(formatRelativeTime('2025-01-15T10:00:00.000Z')).toBe('today');
  });

  it('returns "yesterday" for previous day', () => {
    expect(formatRelativeTime('2025-01-14T12:00:00.000Z')).toBe('yesterday');
  });

  it('returns "Nd ago" for days within a week', () => {
    expect(formatRelativeTime('2025-01-12T12:00:00.000Z')).toBe('3d ago');
    expect(formatRelativeTime('2025-01-10T12:00:00.000Z')).toBe('5d ago');
  });

  it('returns "Nw ago" for weeks within a month', () => {
    expect(formatRelativeTime('2025-01-01T12:00:00.000Z')).toBe('2w ago');
    expect(formatRelativeTime('2024-12-25T12:00:00.000Z')).toBe('3w ago');
  });

  it('returns "Nmo ago" for months within a year', () => {
    expect(formatRelativeTime('2024-11-15T12:00:00.000Z')).toBe('2mo ago');
    expect(formatRelativeTime('2024-07-15T12:00:00.000Z')).toBe('6mo ago');
  });

  it('returns "Ny ago" for years', () => {
    expect(formatRelativeTime('2024-01-15T12:00:00.000Z')).toBe('1y ago');
    expect(formatRelativeTime('2023-01-15T12:00:00.000Z')).toBe('2y ago');
  });
});

describe('formatSourceName', () => {
  it('capitalizes first letter', () => {
    expect(formatSourceName('cursor')).toBe('Cursor');
    expect(formatSourceName('codex')).toBe('Codex');
  });

  it('handles already capitalized input', () => {
    expect(formatSourceName('Cursor')).toBe('Cursor');
  });

  it('handles hyphenated names', () => {
    expect(formatSourceName('claude-code')).toBe('Claude-code');
  });
});

describe('formatSourceLabel', () => {
  it('formats claude-code with proper spacing', () => {
    expect(formatSourceLabel('claude-code')).toBe('Claude Code');
  });

  it('formats other sources correctly', () => {
    expect(formatSourceLabel('codex')).toBe('Codex');
    expect(formatSourceLabel('cursor')).toBe('Cursor');
    expect(formatSourceLabel('opencode')).toBe('OpenCode');
  });

  it('falls back to capitalize for unknown sources', () => {
    expect(formatSourceLabel('unknown')).toBe('Unknown');
  });
});

describe('truncatePath', () => {
  it('returns path unchanged if shorter than max', () => {
    expect(truncatePath('/short/path', 20)).toBe('/short/path');
  });

  it('returns path unchanged if equal to max', () => {
    expect(truncatePath('/exact', 6)).toBe('/exact');
  });

  it('truncates from left with ellipsis', () => {
    expect(truncatePath('/very/long/path/to/file.ts', 15)).toBe('…ath/to/file.ts');
  });

  it('handles very short max length', () => {
    expect(truncatePath('/path/to/file.ts', 5)).toBe('…e.ts');
  });
});

describe('getFileName', () => {
  it('extracts filename from full path', () => {
    expect(getFileName('/path/to/file.ts')).toBe('file.ts');
  });

  it('handles path with single component', () => {
    expect(getFileName('file.ts')).toBe('file.ts');
  });

  it('handles trailing slash by returning full path', () => {
    // When path ends with /, the last segment is empty, so fallback returns full path
    expect(getFileName('/path/to/dir/')).toBe('/path/to/dir/');
  });

  it('handles Windows-style paths', () => {
    // Since we split by /, Windows paths are returned as-is
    expect(getFileName('C:\\path\\to\\file.ts')).toBe('C:\\path\\to\\file.ts');
  });
});

describe('formatPaginationInfo', () => {
  it('formats basic pagination', () => {
    expect(formatPaginationInfo(0, 10, 50)).toBe('1-10 of 50');
  });

  it('handles last page with fewer items', () => {
    expect(formatPaginationInfo(40, 10, 45)).toBe('41-45 of 45');
  });

  it('handles single page', () => {
    expect(formatPaginationInfo(0, 10, 5)).toBe('1-5 of 5');
  });

  it('handles offset in middle', () => {
    expect(formatPaginationInfo(20, 10, 100)).toBe('21-30 of 100');
  });
});

describe('formatMatchCount', () => {
  it('uses singular for 1', () => {
    expect(formatMatchCount(1)).toBe('1 match');
  });

  it('uses plural for 0', () => {
    expect(formatMatchCount(0)).toBe('0 matches');
  });

  it('uses plural for multiple', () => {
    expect(formatMatchCount(5)).toBe('5 matches');
    expect(formatMatchCount(100)).toBe('100 matches');
  });
});

describe('formatMessageCount', () => {
  it('uses singular for 1', () => {
    expect(formatMessageCount(1)).toBe('1 message');
  });

  it('uses plural for other counts', () => {
    expect(formatMessageCount(0)).toBe('0 messages');
    expect(formatMessageCount(42)).toBe('42 messages');
  });
});

describe('formatConversationCount', () => {
  it('uses singular for 1', () => {
    expect(formatConversationCount(1)).toBe('1 conversation');
  });

  it('uses plural for other counts', () => {
    expect(formatConversationCount(0)).toBe('0 conversations');
    expect(formatConversationCount(10)).toBe('10 conversations');
  });
});

describe('getRoleLabel', () => {
  it('returns "You" for user', () => {
    expect(getRoleLabel('user')).toBe('You');
  });

  it('returns "Assistant" for assistant', () => {
    expect(getRoleLabel('assistant')).toBe('Assistant');
  });

  it('returns "System" for system and unknown', () => {
    expect(getRoleLabel('system')).toBe('System');
    expect(getRoleLabel('unknown')).toBe('System');
  });
});

describe('getRoleColor', () => {
  it('returns green for user', () => {
    expect(getRoleColor('user')).toBe('green');
  });

  it('returns blue for assistant', () => {
    expect(getRoleColor('assistant')).toBe('blue');
  });

  it('returns yellow for system and unknown', () => {
    expect(getRoleColor('system')).toBe('yellow');
    expect(getRoleColor('other')).toBe('yellow');
  });
});

describe('formatSourceInfo', () => {
  it('formats source without model', () => {
    expect(formatSourceInfo('cursor')).toBe('Cursor');
    expect(formatSourceInfo('cursor', null)).toBe('Cursor');
    expect(formatSourceInfo('cursor', undefined)).toBe('Cursor');
  });

  it('formats source with model', () => {
    expect(formatSourceInfo('cursor', 'gpt-4')).toBe('Cursor · gpt-4');
    expect(formatSourceInfo('claude-code', 'claude-3-opus')).toBe('Claude Code · claude-3-opus');
  });
});

describe('formatTokenCount', () => {
  it('returns empty string for undefined or 0', () => {
    expect(formatTokenCount(undefined)).toBe('');
    expect(formatTokenCount(0)).toBe('');
  });

  it('returns plain number for < 1000', () => {
    expect(formatTokenCount(1)).toBe('1');
    expect(formatTokenCount(999)).toBe('999');
  });

  it('formats thousands with K suffix', () => {
    expect(formatTokenCount(1000)).toBe('1.0K');
    expect(formatTokenCount(1500)).toBe('1.5K');
    expect(formatTokenCount(9999)).toBe('10.0K');
    expect(formatTokenCount(10000)).toBe('10K');
    expect(formatTokenCount(42500)).toBe('43K');
  });

  it('formats millions with M suffix', () => {
    expect(formatTokenCount(1000000)).toBe('1.0M');
    expect(formatTokenCount(1500000)).toBe('1.5M');
    expect(formatTokenCount(10000000)).toBe('10M');
  });
});

describe('formatTokenPair', () => {
  it('returns empty string for no tokens', () => {
    expect(formatTokenPair(undefined, undefined)).toBe('');
    expect(formatTokenPair(0, 0)).toBe('');
  });

  it('formats basic input/output pair', () => {
    expect(formatTokenPair(1000, 500)).toBe('1.0K in / 500 out');
  });

  it('includes cache tokens in input', () => {
    expect(formatTokenPair(1000, 500, 200, 300)).toBe('1.5K in / 500 out');
  });

  it('handles missing values', () => {
    expect(formatTokenPair(1000, undefined)).toBe('1.0K in / 0 out');
    expect(formatTokenPair(undefined, 500)).toBe('0 in / 500 out');
  });
});

describe('formatLineCounts', () => {
  it('returns empty string for no changes', () => {
    expect(formatLineCounts(undefined, undefined)).toBe('');
    expect(formatLineCounts(0, 0)).toBe('');
  });

  it('formats line changes', () => {
    expect(formatLineCounts(10, 5)).toBe('+10 / -5');
    expect(formatLineCounts(100, 0)).toBe('+100 / -0');
    expect(formatLineCounts(0, 50)).toBe('+0 / -50');
  });
});

describe('getLineCountParts', () => {
  it('returns null for no changes', () => {
    expect(getLineCountParts(undefined, undefined)).toBeNull();
    expect(getLineCountParts(0, 0)).toBeNull();
  });

  it('returns separate parts', () => {
    expect(getLineCountParts(10, 5)).toEqual({ added: '+10', removed: '-5' });
    expect(getLineCountParts(0, 5)).toEqual({ added: '+0', removed: '-5' });
  });
});

describe('formatFileList', () => {
  it('returns empty string for empty list', () => {
    expect(formatFileList([])).toBe('');
  });

  it('shows all files when within limit', () => {
    expect(formatFileList(['a.ts', 'b.ts'])).toBe('a.ts, b.ts');
  });

  it('truncates with count when over limit', () => {
    expect(formatFileList(['a.ts', 'b.ts', 'c.ts', 'd.ts'], 2)).toBe('a.ts, b.ts +2');
  });

  it('respects custom maxShow', () => {
    expect(formatFileList(['a.ts', 'b.ts', 'c.ts'], 1)).toBe('a.ts +2');
    expect(formatFileList(['a.ts', 'b.ts', 'c.ts'], 3)).toBe('a.ts, b.ts, c.ts');
  });
});

describe('formatFilesDisplay', () => {
  it('returns "No files" for empty list', () => {
    expect(formatFilesDisplay([], 0)).toBe('No files');
  });

  it('formats files without more indicator', () => {
    expect(formatFilesDisplay(['a.ts', 'b.ts'], 2)).toBe('Files: a.ts, b.ts');
  });

  it('formats files with more indicator', () => {
    expect(formatFilesDisplay(['a.ts', 'b.ts'], 5, 2)).toBe('Files: a.ts, b.ts (+3 more)');
  });
});

describe('combineConsecutiveMessages', () => {
  it('returns empty result for empty input', () => {
    const result = combineConsecutiveMessages([]);
    expect(result.messages).toEqual([]);
    expect(result.indexMap.size).toBe(0);
  });

  it('keeps single message unchanged', () => {
    const messages = [
      { id: '1', role: 'user' as const, content: 'Hello', messageIndex: 0 },
    ];
    const result = combineConsecutiveMessages(messages);
    expect(result.messages.length).toBe(1);
    expect(result.messages[0]!.content).toBe('Hello');
    expect(result.messages[0]!.role).toBe('user');
  });

  it('combines consecutive assistant messages', () => {
    const messages = [
      { id: '1', role: 'assistant' as const, content: 'Part 1', messageIndex: 0 },
      { id: '2', role: 'assistant' as const, content: 'Part 2', messageIndex: 1 },
    ];
    const result = combineConsecutiveMessages(messages);
    expect(result.messages.length).toBe(1);
    expect(result.messages[0]!.content).toBe('Part 1\n\nPart 2');
    expect(result.messages[0]!.messageIds).toEqual(['1', '2']);
  });

  it('combines consecutive user messages', () => {
    const messages = [
      { id: '1', role: 'user' as const, content: 'Q1', messageIndex: 0 },
      { id: '2', role: 'user' as const, content: 'Q2', messageIndex: 1 },
    ];
    const result = combineConsecutiveMessages(messages);
    expect(result.messages.length).toBe(1);
    expect(result.messages[0]!.content).toBe('Q1\n\nQ2');
  });

  it('does not combine system messages', () => {
    const messages = [
      { id: '1', role: 'system' as const, content: 'S1', messageIndex: 0 },
      { id: '2', role: 'system' as const, content: 'S2', messageIndex: 1 },
    ];
    const result = combineConsecutiveMessages(messages);
    expect(result.messages.length).toBe(2);
  });

  it('separates messages of different roles', () => {
    const messages = [
      { id: '1', role: 'user' as const, content: 'Hello', messageIndex: 0 },
      { id: '2', role: 'assistant' as const, content: 'Hi', messageIndex: 1 },
      { id: '3', role: 'user' as const, content: 'Question', messageIndex: 2 },
    ];
    const result = combineConsecutiveMessages(messages);
    expect(result.messages.length).toBe(3);
    expect(result.messages[0]!.role).toBe('user');
    expect(result.messages[1]!.role).toBe('assistant');
    expect(result.messages[2]!.role).toBe('user');
  });

  it('builds correct index map', () => {
    const messages = [
      { id: '1', role: 'user' as const, content: 'Q1', messageIndex: 0 },
      { id: '2', role: 'assistant' as const, content: 'A1', messageIndex: 1 },
      { id: '3', role: 'assistant' as const, content: 'A2', messageIndex: 2 },
    ];
    const result = combineConsecutiveMessages(messages);
    expect(result.indexMap.get(0)).toBe(0); // user -> combined 0
    expect(result.indexMap.get(1)).toBe(1); // assistant 1 -> combined 1
    expect(result.indexMap.get(2)).toBe(1); // assistant 2 -> combined 1 (same group)
  });

  it('sums output tokens and line counts', () => {
    const messages = [
      { id: '1', role: 'assistant' as const, content: 'A', messageIndex: 0, outputTokens: 100, totalLinesAdded: 5 },
      { id: '2', role: 'assistant' as const, content: 'B', messageIndex: 1, outputTokens: 200, totalLinesAdded: 10 },
    ];
    const result = combineConsecutiveMessages(messages);
    expect(result.messages[0]!.outputTokens).toBe(300);
    expect(result.messages[0]!.totalLinesAdded).toBe(15);
  });

  it('uses peak input tokens from message with highest context', () => {
    const messages = [
      { id: '1', role: 'assistant' as const, content: 'A', messageIndex: 0, inputTokens: 100, cacheReadTokens: 50 },
      { id: '2', role: 'assistant' as const, content: 'B', messageIndex: 1, inputTokens: 200, cacheReadTokens: 100 },
    ];
    const result = combineConsecutiveMessages(messages);
    // Message 2 has higher total context (200+100=300 vs 100+50=150)
    expect(result.messages[0]!.inputTokens).toBe(200);
    expect(result.messages[0]!.cacheReadTokens).toBe(100);
  });

  it('preserves timestamp from first message in group', () => {
    const messages = [
      { id: '1', role: 'assistant' as const, content: 'A', messageIndex: 0, timestamp: '2025-01-01T10:00:00Z' },
      { id: '2', role: 'assistant' as const, content: 'B', messageIndex: 1, timestamp: '2025-01-01T10:05:00Z' },
    ];
    const result = combineConsecutiveMessages(messages);
    expect(result.messages[0]!.timestamp).toBe('2025-01-01T10:00:00Z');
  });
});

