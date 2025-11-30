/**
 * Unit tests for schema validation
 *
 * Tests that Zod schemas accept valid data and reject invalid data.
 */

import { describe, it, expect } from 'bun:test';
import {
  Source,
  SourceTypeSchema,
  ALL_SOURCES,
  SOURCE_INFO,
  getSourceInfo,
  SourceRef,
  Message,
  ToolCall,
  Conversation,
  ConversationFile,
  MessageFile,
  FileEdit,
  SyncState,
  MessageMatch,
  ConversationResult,
  SearchResponse,
  ExportedConversation,
  ExportArchive,
} from '../../../src/schema/index';

describe('Source constants', () => {
  it('defines all source IDs', () => {
    expect(Source.Cursor).toBe('cursor');
    expect(Source.ClaudeCode).toBe('claude-code');
    expect(Source.Codex).toBe('codex');
    expect(Source.OpenCode).toBe('opencode');
  });

  it('ALL_SOURCES contains all source values', () => {
    expect(ALL_SOURCES).toContain('cursor');
    expect(ALL_SOURCES).toContain('claude-code');
    expect(ALL_SOURCES).toContain('codex');
    expect(ALL_SOURCES).toContain('opencode');
    expect(ALL_SOURCES).toHaveLength(4);
  });

  it('SOURCE_INFO has entry for each source', () => {
    expect(Object.keys(SOURCE_INFO)).toHaveLength(4);
    expect(SOURCE_INFO[Source.Cursor]).toBeDefined();
    expect(SOURCE_INFO[Source.ClaudeCode]).toBeDefined();
    expect(SOURCE_INFO[Source.Codex]).toBeDefined();
    expect(SOURCE_INFO[Source.OpenCode]).toBeDefined();
  });

  it('SOURCE_INFO contains display properties', () => {
    const cursor = SOURCE_INFO[Source.Cursor];
    expect(cursor.id).toBe('cursor');
    expect(cursor.name).toBe('Cursor');
    expect(cursor.color).toBe('cyan');

    const claude = SOURCE_INFO[Source.ClaudeCode];
    expect(claude.id).toBe('claude-code');
    expect(claude.name).toBe('Claude Code');
    expect(claude.color).toBe('magenta');
  });
});

describe('getSourceInfo', () => {
  it('returns info for known sources', () => {
    expect(getSourceInfo('cursor')).toEqual({
      id: 'cursor',
      name: 'Cursor',
      color: 'cyan',
    });
    expect(getSourceInfo('claude-code')).toEqual({
      id: 'claude-code',
      name: 'Claude Code',
      color: 'magenta',
    });
  });

  it('handles case-insensitive lookup', () => {
    expect(getSourceInfo('CURSOR').name).toBe('Cursor');
    expect(getSourceInfo('Claude-Code').name).toBe('Claude Code');
    expect(getSourceInfo('CODEX').name).toBe('Codex');
  });

  it('returns fallback for unknown sources', () => {
    const info = getSourceInfo('unknown-source');
    expect(info.id).toBe('unknown-source');
    expect(info.name).toBe('Unknown-source');
    expect(info.color).toBe('white');
  });

  it('capitalizes first letter for unknown sources', () => {
    expect(getSourceInfo('custom').name).toBe('Custom');
    expect(getSourceInfo('myTool').name).toBe('MyTool'); // preserves rest of string
  });
});

describe('SourceTypeSchema', () => {
  it('accepts valid sources', () => {
    expect(SourceTypeSchema.parse('cursor')).toBe('cursor');
    expect(SourceTypeSchema.parse('claude-code')).toBe('claude-code');
    expect(SourceTypeSchema.parse('codex')).toBe('codex');
    expect(SourceTypeSchema.parse('opencode')).toBe('opencode');
  });

  it('rejects invalid sources', () => {
    expect(() => SourceTypeSchema.parse('invalid')).toThrow();
    expect(() => SourceTypeSchema.parse('')).toThrow();
    expect(() => SourceTypeSchema.parse(null)).toThrow();
    expect(() => SourceTypeSchema.parse(123)).toThrow();
  });
});

describe('SourceRef schema', () => {
  const validRef = {
    source: 'cursor',
    originalId: 'abc123',
    dbPath: '/path/to/db',
  };

  it('accepts valid source ref', () => {
    const result = SourceRef.parse(validRef);
    expect(result.source).toBe('cursor');
    expect(result.originalId).toBe('abc123');
  });

  it('accepts optional workspacePath', () => {
    const result = SourceRef.parse({ ...validRef, workspacePath: '/my/project' });
    expect(result.workspacePath).toBe('/my/project');
  });

  it('rejects missing required fields', () => {
    expect(() => SourceRef.parse({ source: 'cursor' })).toThrow();
    expect(() => SourceRef.parse({ originalId: 'abc' })).toThrow();
  });

  it('rejects invalid source', () => {
    expect(() => SourceRef.parse({ ...validRef, source: 'invalid' })).toThrow();
  });
});

describe('Message schema', () => {
  const validMessage = {
    id: 'msg-1',
    conversationId: 'conv-1',
    role: 'user',
    content: 'Hello world',
    messageIndex: 0,
  };

  it('accepts valid message', () => {
    const result = Message.parse(validMessage);
    expect(result.id).toBe('msg-1');
    expect(result.role).toBe('user');
  });

  it('accepts all valid roles', () => {
    expect(Message.parse({ ...validMessage, role: 'user' }).role).toBe('user');
    expect(Message.parse({ ...validMessage, role: 'assistant' }).role).toBe('assistant');
    expect(Message.parse({ ...validMessage, role: 'system' }).role).toBe('system');
  });

  it('accepts optional fields', () => {
    const full = Message.parse({
      ...validMessage,
      timestamp: '2025-01-15T10:00:00Z',
      inputTokens: 100,
      outputTokens: 200,
      cacheCreationTokens: 50,
      cacheReadTokens: 25,
      totalLinesAdded: 10,
      totalLinesRemoved: 5,
    });
    expect(full.inputTokens).toBe(100);
    expect(full.totalLinesAdded).toBe(10);
  });

  it('rejects invalid role', () => {
    expect(() => Message.parse({ ...validMessage, role: 'admin' })).toThrow();
  });

  it('rejects missing required fields', () => {
    expect(() => Message.parse({ id: 'msg-1' })).toThrow();
  });
});

describe('ToolCall schema', () => {
  const validToolCall = {
    id: 'tool-1',
    messageId: 'msg-1',
    conversationId: 'conv-1',
    type: 'read_file',
    input: '{"path": "/src/app.ts"}',
  };

  it('accepts valid tool call', () => {
    const result = ToolCall.parse(validToolCall);
    expect(result.type).toBe('read_file');
  });

  it('accepts optional fields', () => {
    const result = ToolCall.parse({
      ...validToolCall,
      output: 'file contents here',
      filePath: '/src/app.ts',
    });
    expect(result.output).toBe('file contents here');
    expect(result.filePath).toBe('/src/app.ts');
  });
});

describe('Conversation schema', () => {
  const validConversation = {
    id: 'conv-1',
    source: 'cursor',
    title: 'My Conversation',
    messageCount: 5,
    sourceRef: {
      source: 'cursor',
      originalId: 'orig-1',
      dbPath: '/path/to/db',
    },
  };

  it('accepts valid conversation', () => {
    const result = Conversation.parse(validConversation);
    expect(result.title).toBe('My Conversation');
    expect(result.messageCount).toBe(5);
  });

  it('accepts all optional fields', () => {
    const full = Conversation.parse({
      ...validConversation,
      subtitle: 'A subtitle',
      workspacePath: '/my/project',
      projectName: 'my-project',
      model: 'gpt-4',
      mode: 'agent',
      createdAt: '2025-01-15T10:00:00Z',
      updatedAt: '2025-01-15T11:00:00Z',
      totalInputTokens: 1000,
      totalOutputTokens: 2000,
      totalCacheCreationTokens: 100,
      totalCacheReadTokens: 50,
      totalLinesAdded: 100,
      totalLinesRemoved: 25,
    });
    expect(full.model).toBe('gpt-4');
    expect(full.totalInputTokens).toBe(1000);
  });

  it('rejects invalid source', () => {
    expect(() => Conversation.parse({ ...validConversation, source: 'invalid' })).toThrow();
  });
});

describe('ConversationFile schema', () => {
  const validFile = {
    id: 'file-1',
    conversationId: 'conv-1',
    filePath: '/src/app.ts',
    role: 'context',
  };

  it('accepts valid file', () => {
    const result = ConversationFile.parse(validFile);
    expect(result.filePath).toBe('/src/app.ts');
  });

  it('accepts all valid roles', () => {
    expect(ConversationFile.parse({ ...validFile, role: 'context' }).role).toBe('context');
    expect(ConversationFile.parse({ ...validFile, role: 'edited' }).role).toBe('edited');
    expect(ConversationFile.parse({ ...validFile, role: 'mentioned' }).role).toBe('mentioned');
  });

  it('rejects invalid role', () => {
    expect(() => ConversationFile.parse({ ...validFile, role: 'unknown' })).toThrow();
  });
});

describe('MessageFile schema', () => {
  const validMessageFile = {
    id: 'mf-1',
    messageId: 'msg-1',
    conversationId: 'conv-1',
    filePath: '/src/utils.ts',
    role: 'edited',
  };

  it('accepts valid message file', () => {
    const result = MessageFile.parse(validMessageFile);
    expect(result.messageId).toBe('msg-1');
    expect(result.role).toBe('edited');
  });
});

describe('FileEdit schema', () => {
  const validEdit = {
    id: 'edit-1',
    messageId: 'msg-1',
    conversationId: 'conv-1',
    filePath: '/src/app.ts',
    editType: 'modify',
    linesAdded: 10,
    linesRemoved: 5,
  };

  it('accepts valid file edit', () => {
    const result = FileEdit.parse(validEdit);
    expect(result.editType).toBe('modify');
    expect(result.linesAdded).toBe(10);
  });

  it('accepts all edit types', () => {
    expect(FileEdit.parse({ ...validEdit, editType: 'create' }).editType).toBe('create');
    expect(FileEdit.parse({ ...validEdit, editType: 'modify' }).editType).toBe('modify');
    expect(FileEdit.parse({ ...validEdit, editType: 'delete' }).editType).toBe('delete');
  });

  it('accepts optional line range', () => {
    const result = FileEdit.parse({ ...validEdit, startLine: 10, endLine: 25 });
    expect(result.startLine).toBe(10);
    expect(result.endLine).toBe(25);
  });

  it('rejects invalid edit type', () => {
    expect(() => FileEdit.parse({ ...validEdit, editType: 'rename' })).toThrow();
  });
});

describe('SyncState schema', () => {
  const validState = {
    source: 'cursor',
    workspacePath: '/my/project',
    dbPath: '/path/to/db',
    lastSyncedAt: '2025-01-15T10:00:00Z',
    lastMtime: 1705312800000,
  };

  it('accepts valid sync state', () => {
    const result = SyncState.parse(validState);
    expect(result.source).toBe('cursor');
    expect(result.lastMtime).toBe(1705312800000);
  });

  it('rejects invalid datetime format', () => {
    expect(() => SyncState.parse({ ...validState, lastSyncedAt: 'not-a-date' })).toThrow();
  });
});

describe('MessageMatch schema', () => {
  const validMatch = {
    messageId: 'msg-1',
    conversationId: 'conv-1',
    role: 'assistant',
    content: 'Full message content',
    snippet: 'message content',
    highlightRanges: [[0, 7]],
    score: 0.95,
    messageIndex: 2,
  };

  it('accepts valid match', () => {
    const result = MessageMatch.parse(validMatch);
    expect(result.score).toBe(0.95);
    expect(result.highlightRanges).toEqual([[0, 7]]);
  });

  it('accepts multiple highlight ranges', () => {
    const result = MessageMatch.parse({
      ...validMatch,
      highlightRanges: [[0, 5], [10, 15], [20, 25]],
    });
    expect(result.highlightRanges).toHaveLength(3);
  });
});

describe('ConversationResult schema', () => {
  const validMatch = {
    messageId: 'msg-1',
    conversationId: 'conv-1',
    role: 'assistant',
    content: 'Content',
    snippet: 'Content',
    highlightRanges: [],
    score: 0.9,
    messageIndex: 0,
  };

  const validResult = {
    conversation: {
      id: 'conv-1',
      source: 'cursor',
      title: 'Test',
      messageCount: 1,
      sourceRef: { source: 'cursor', originalId: 'orig', dbPath: '/db' },
    },
    matches: [validMatch],
    bestMatch: validMatch,
    totalMatches: 1,
  };

  it('accepts valid conversation result', () => {
    const result = ConversationResult.parse(validResult);
    expect(result.totalMatches).toBe(1);
    expect(result.matches).toHaveLength(1);
  });
});

describe('SearchResponse schema', () => {
  it('accepts valid search response', () => {
    const result = SearchResponse.parse({
      query: 'test query',
      results: [],
      totalConversations: 0,
      totalMessages: 0,
      searchTimeMs: 42,
    });
    expect(result.query).toBe('test query');
    expect(result.searchTimeMs).toBe(42);
  });
});

describe('ExportedConversation schema', () => {
  const validExported = {
    conversation: {
      id: 'conv-1',
      source: 'cursor',
      title: 'Test',
      messageCount: 0,
      sourceRef: { source: 'cursor', originalId: 'orig', dbPath: '/db' },
    },
    messages: [],
    toolCalls: [],
    files: [],
    messageFiles: [],
    fileEdits: [],
  };

  it('accepts valid exported conversation', () => {
    const result = ExportedConversation.parse(validExported);
    expect(result.conversation.id).toBe('conv-1');
  });
});

describe('ExportArchive schema', () => {
  it('accepts valid export archive', () => {
    const result = ExportArchive.parse({
      version: '1.0.0',
      exportedAt: '2025-01-15T10:00:00Z',
      conversations: [],
    });
    expect(result.version).toBe('1.0.0');
  });

  it('accepts optional machine field', () => {
    const result = ExportArchive.parse({
      version: '1.0.0',
      exportedAt: '2025-01-15T10:00:00Z',
      machine: 'my-laptop',
      conversations: [],
    });
    expect(result.machine).toBe('my-laptop');
  });
});

