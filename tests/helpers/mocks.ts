/**
 * Mock helpers for testing
 */

import { mock } from 'bun:test';
import { Source } from '../../src/schema/index';
import { createConversation, createMessage } from '../fixtures';
import type { NormalizedConversation, SourceLocation } from '../../src/adapters/types';

// ============ Adapter Mocking ============

export interface MockAdapterConfig {
  name: string;
  available?: boolean;
  locations?: Partial<SourceLocation>[];
  conversations?: Array<{ id: string; workspacePath?: string }>;
  error?: { phase: 'detect' | 'discover' | 'extract'; message: string };
}

/**
 * Create a mock normalized conversation with messages
 */
export function createMockNormalized(
  id: string,
  source: string = Source.Cursor,
  workspacePath: string = '/test/project',
  messageCount: number = 2
): NormalizedConversation {
  const conv = createConversation({
    id,
    source: source as any,
    workspacePath,
    messageCount,
  });

  const messages = Array.from({ length: messageCount }, (_, i) =>
    createMessage(id, {
      messageIndex: i,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `Message ${i + 1}`,
    })
  );

  return {
    conversation: conv,
    messages,
    toolCalls: [],
    files: [],
    messageFiles: [],
    fileEdits: [],
  };
}

/**
 * Create a mock adapter from config
 */
function createMockAdapter(config: MockAdapterConfig) {
  const {
    name,
    available = true,
    locations = [],
    conversations = [],
    error,
  } = config;

  const fullLocations: SourceLocation[] = locations.map((loc, i) => ({
    source: name as any,
    workspacePath: loc.workspacePath || `/project-${i}`,
    dbPath: loc.dbPath || `/path/to/db-${i}`,
    mtime: loc.mtime || Date.now(),
  }));

  return {
    name,
    detect: async () => {
      if (error?.phase === 'detect') throw new Error(error.message);
      return available;
    },
    discover: async () => {
      if (error?.phase === 'discover') throw new Error(error.message);
      return fullLocations;
    },
    extract: async () => {
      if (error?.phase === 'extract') throw new Error(error.message);
      return conversations.map(c => ({ composerId: c.id, sessionId: c.id }));
    },
    normalize: (raw: { composerId?: string; sessionId?: string }) => {
      const id = raw.composerId || raw.sessionId || 'unknown';
      const convConfig = conversations.find(c => c.id === id);
      return createMockNormalized(
        id,
        name,
        convConfig?.workspacePath || fullLocations[0]?.workspacePath || '/test/project'
      );
    },
  };
}

/**
 * Setup mock adapters for sync testing
 */
export function mockAdapters(configs: MockAdapterConfig[]) {
  const adapters = configs.map(createMockAdapter);
  
  mock.module('../../src/adapters/index', () => ({ adapters }));
  mock.module('../../../src/adapters/index', () => ({ adapters }));
}

/**
 * Setup a single mock adapter (convenience function)
 */
export function mockSingleAdapter(config: Omit<MockAdapterConfig, 'name'> & { name?: string }) {
  mockAdapters([{ name: Source.Cursor, ...config }]);
}

/**
 * Setup adapter that returns no sources
 */
export function mockNoSources() {
  mockAdapters([{
    name: Source.Cursor,
    available: false,
  }]);
}

// ============ Embedding Mocking ============

/**
 * Mock embedding module to prevent background processes
 */
export function mockEmbeddings() {
  const mockModule = {
    setEmbeddingProgress: () => {},
    clearEmbeddingProgress: () => {},
    EMBEDDING_DIMENSIONS: 1024,
  };
  
  mock.module('../../src/embeddings/index', () => mockModule);
  mock.module('../../../src/embeddings/index', () => mockModule);
}

// ============ Combined Setup ============

/**
 * Standard test setup for sync command tests
 */
export function setupSyncMocks(adapterConfigs: MockAdapterConfig[]) {
  mockEmbeddings();
  mockAdapters(adapterConfigs);
}


