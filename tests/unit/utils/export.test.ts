/**
 * Unit tests for export utility functions
 */

import { describe, it, expect } from 'bun:test';
import {
  generateFilename,
  getProjectName,
  conversationToMarkdown,
  isValidDate,
  parseDate,
} from '../../../src/utils/export';
import { createConversation, createMessage, createConversationFile } from '../../fixtures';

describe('generateFilename', () => {
  it('generates filename with date prefix and sanitized title', () => {
    const conv = createConversation({
      title: 'Fix authentication bug',
      createdAt: '2025-01-15T10:30:00.000Z',
    });

    const filename = generateFilename(conv);

    expect(filename).toBe('2025-01-15_fix-authentication-bug.md');
  });

  it('removes special characters from title', () => {
    const conv = createConversation({
      title: 'Fix: auth bug!! (urgent)',
      createdAt: '2025-01-15T10:30:00.000Z',
    });

    const filename = generateFilename(conv);

    expect(filename).toBe('2025-01-15_fix-auth-bug-urgent.md');
  });

  it('collapses multiple hyphens', () => {
    const conv = createConversation({
      title: 'Fix   multiple   spaces',
      createdAt: '2025-01-15T10:30:00.000Z',
    });

    const filename = generateFilename(conv);

    expect(filename).toBe('2025-01-15_fix-multiple-spaces.md');
  });

  it('truncates long titles to 50 characters', () => {
    const conv = createConversation({
      title: 'This is a very long conversation title that should be truncated to prevent filesystem issues',
      createdAt: '2025-01-15T10:30:00.000Z',
    });

    const filename = generateFilename(conv);
    const titlePart = filename.replace('2025-01-15_', '').replace('.md', '');

    expect(titlePart.length).toBeLessThanOrEqual(50);
  });

  it('removes trailing hyphens after truncation', () => {
    const conv = createConversation({
      title: 'This title ends with a hyphen after truncation -',
      createdAt: '2025-01-15T10:30:00.000Z',
    });

    const filename = generateFilename(conv);

    expect(filename).not.toMatch(/-\.md$/);
  });

  it('falls back to ID when title is empty after sanitization', () => {
    const conv = createConversation({
      id: 'abc12345678',
      title: '!!!@@@###',
      createdAt: '2025-01-15T10:30:00.000Z',
    });

    const filename = generateFilename(conv);

    expect(filename).toBe('2025-01-15_abc12345.md');
  });

  it('handles missing createdAt date', () => {
    const conv = createConversation({
      title: 'No date conversation',
      createdAt: undefined,
    });

    const filename = generateFilename(conv);

    expect(filename).toBe('no-date-conversation.md');
    expect(filename).not.toContain('undefined');
  });

  it('converts to lowercase', () => {
    const conv = createConversation({
      title: 'UPPERCASE Title Here',
      createdAt: '2025-01-15T10:30:00.000Z',
    });

    const filename = generateFilename(conv);

    expect(filename).toBe('2025-01-15_uppercase-title-here.md');
  });
});

describe('getProjectName', () => {
  it('extracts project name from full path', () => {
    expect(getProjectName('/home/user/projects/myapp')).toBe('myapp');
  });

  it('handles paths with trailing slash', () => {
    expect(getProjectName('/home/user/projects/myapp/')).toBe('myapp');
  });

  it('returns empty string for undefined path', () => {
    expect(getProjectName(undefined)).toBe('');
  });

  it('handles single directory name', () => {
    expect(getProjectName('myapp')).toBe('myapp');
  });

  it('handles Windows-style paths', () => {
    // The function uses '/' split, so Windows paths would need separate handling
    // This test documents current behavior
    expect(getProjectName('C:\\Users\\project')).toBe('C:\\Users\\project');
  });
});

describe('conversationToMarkdown', () => {
  it('includes conversation title as H1', () => {
    const conv = createConversation({ title: 'My Conversation Title' });
    const messages: never[] = [];
    const files: never[] = [];

    const markdown = conversationToMarkdown(conv, messages, files);

    expect(markdown).toContain('# My Conversation Title');
  });

  it('includes source metadata', () => {
    const conv = createConversation({ source: 'cursor' });

    const markdown = conversationToMarkdown(conv, [], []);

    expect(markdown).toContain('**Source:** Cursor');
  });

  it('includes project path when present', () => {
    const conv = createConversation({ workspacePath: '/home/user/myproject' });

    const markdown = conversationToMarkdown(conv, [], []);

    expect(markdown).toContain('**Project:** /home/user/myproject');
  });

  it('includes model when present', () => {
    const conv = createConversation({ model: 'gpt-4-turbo' });

    const markdown = conversationToMarkdown(conv, [], []);

    expect(markdown).toContain('**Model:** gpt-4-turbo');
  });

  it('includes mode when present', () => {
    const conv = createConversation({ mode: 'agent' });

    const markdown = conversationToMarkdown(conv, [], []);

    expect(markdown).toContain('**Mode:** agent');
  });

  it('includes message count', () => {
    const conv = createConversation({ messageCount: 42 });

    const markdown = conversationToMarkdown(conv, [], []);

    expect(markdown).toContain('**Messages:** 42');
  });

  it('includes token usage when present', () => {
    const conv = createConversation({
      totalInputTokens: 1500,
      totalOutputTokens: 3000,
    });

    const markdown = conversationToMarkdown(conv, [], []);

    expect(markdown).toContain('**Tokens:** 1,500 in / 3,000 out');
  });

  it('includes lines changed when present', () => {
    const conv = createConversation({
      totalLinesAdded: 100,
      totalLinesRemoved: 25,
    });

    const markdown = conversationToMarkdown(conv, [], []);

    expect(markdown).toContain('**Lines Changed:** +100 / -25');
  });

  it('includes associated files', () => {
    const conv = createConversation();
    const files = [
      createConversationFile(conv.id, { filePath: '/path/to/index.ts' }),
      createConversationFile(conv.id, { filePath: '/path/to/utils.ts' }),
    ];

    const markdown = conversationToMarkdown(conv, [], files);

    expect(markdown).toContain('**Files:** index.ts, utils.ts');
  });

  it('truncates file list with more than 10 files', () => {
    const conv = createConversation();
    const files = Array.from({ length: 15 }, (_, i) =>
      createConversationFile(conv.id, { filePath: `/path/to/file${i}.ts` })
    );

    const markdown = conversationToMarkdown(conv, [], files);

    expect(markdown).toContain('(+5 more)');
  });

  it('formats user messages with "You" header', () => {
    const conv = createConversation();
    const messages = [createMessage(conv.id, { role: 'user', content: 'Hello AI' })];

    const markdown = conversationToMarkdown(conv, messages, []);

    expect(markdown).toContain('## You');
    expect(markdown).toContain('Hello AI');
  });

  it('formats assistant messages with "Assistant" header', () => {
    const conv = createConversation();
    const messages = [createMessage(conv.id, { role: 'assistant', content: 'Hello human' })];

    const markdown = conversationToMarkdown(conv, messages, []);

    expect(markdown).toContain('## Assistant');
    expect(markdown).toContain('Hello human');
  });

  it('formats system messages with "System" header', () => {
    const conv = createConversation();
    const messages = [createMessage(conv.id, { role: 'system', content: 'System prompt' })];

    const markdown = conversationToMarkdown(conv, messages, []);

    expect(markdown).toContain('## System');
    expect(markdown).toContain('System prompt');
  });

  it('includes separator between messages', () => {
    const conv = createConversation();
    const messages = [
      createMessage(conv.id, { role: 'user', content: 'First' }),
      createMessage(conv.id, { role: 'assistant', content: 'Second' }),
    ];

    const markdown = conversationToMarkdown(conv, messages, []);

    expect(markdown).toContain('---');
  });
});

describe('isValidDate', () => {
  it('accepts YYYY-MM-DD format', () => {
    expect(isValidDate('2025-01-15')).toBe(true);
  });

  it('accepts ISO 8601 format', () => {
    expect(isValidDate('2025-01-15T10:30:00.000Z')).toBe(true);
  });

  it('rejects invalid date strings', () => {
    expect(isValidDate('not-a-date')).toBe(false);
    expect(isValidDate('2025-13-45')).toBe(false);
    expect(isValidDate('')).toBe(false);
  });

  it('accepts date with time', () => {
    expect(isValidDate('2025-01-15T10:30:00')).toBe(true);
  });
});

describe('parseDate', () => {
  it('parses YYYY-MM-DD as start of day', () => {
    const date = parseDate('2025-01-15');

    expect(date.getFullYear()).toBe(2025);
    expect(date.getMonth()).toBe(0); // January is 0
    expect(date.getDate()).toBe(15);
  });

  it('parses ISO 8601 format', () => {
    const date = parseDate('2025-01-15T10:30:00.000Z');

    expect(date.getFullYear()).toBe(2025);
    expect(date.getUTCHours()).toBe(10);
    expect(date.getUTCMinutes()).toBe(30);
  });

  it('returns Invalid Date for invalid strings', () => {
    const date = parseDate('not-a-date');

    expect(isNaN(date.getTime())).toBe(true);
  });
});


