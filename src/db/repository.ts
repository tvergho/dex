import {
  getConversationsTable,
  getMessagesTable,
  getToolCallsTable,
  getSyncStateTable,
  getFilesTable,
  getMessageFilesTable,
} from './index.js';
import type {
  Conversation,
  Message,
  ToolCall,
  SyncState,
  SourceRef,
  MessageMatch,
  ConversationResult,
  SearchResponse,
  ConversationFile,
  MessageFile,
} from '../schema/index.js';
import { EMBEDDING_DIMENSIONS, embedQuery } from '../embeddings/index.js';

// Helper to group array by key
function groupBy<T>(array: T[], keyFn: (item: T) => string): Record<string, T[]> {
  return array.reduce(
    (acc, item) => {
      const key = keyFn(item);
      if (!acc[key]) {
        acc[key] = [];
      }
      acc[key]!.push(item);
      return acc;
    },
    {} as Record<string, T[]>
  );
}

// Extract snippet around match positions
function extractSnippet(
  content: string,
  query: string,
  contextChars = 200
): { snippet: string; highlightRanges: [number, number][] } {
  const lowerContent = content.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const terms = lowerQuery.split(/\s+/).filter((t) => t.length > 0);

  // Find all match positions
  const positions: number[] = [];
  for (const term of terms) {
    let pos = 0;
    while ((pos = lowerContent.indexOf(term, pos)) !== -1) {
      positions.push(pos);
      pos += 1;
    }
  }

  if (positions.length === 0) {
    // No matches found, return start of content
    const snippet = content.slice(0, contextChars * 2);
    return {
      snippet: snippet + (content.length > contextChars * 2 ? '...' : ''),
      highlightRanges: [],
    };
  }

  // Find the best position (first match)
  positions.sort((a, b) => a - b);
  const firstMatch = positions[0]!;

  // Calculate snippet bounds
  const start = Math.max(0, firstMatch - contextChars);
  const end = Math.min(content.length, firstMatch + contextChars);

  const snippet = content.slice(start, end);
  const prefix = start > 0 ? '...' : '';
  const suffix = end < content.length ? '...' : '';

  // Adjust highlight ranges for snippet offset
  const highlightRanges: [number, number][] = [];
  for (const term of terms) {
    let pos = 0;
    const snippetLower = snippet.toLowerCase();
    while ((pos = snippetLower.indexOf(term, pos)) !== -1) {
      highlightRanges.push([pos + prefix.length, pos + prefix.length + term.length]);
      pos += 1;
    }
  }

  return {
    snippet: prefix + snippet + suffix,
    highlightRanges,
  };
}

// ============ Conversation Repository ============

export const conversationRepo = {
  async exists(id: string): Promise<boolean> {
    const table = await getConversationsTable();
    const results = await table.query().where(`id = '${id}'`).limit(1).toArray();
    return results.length > 0;
  },

  async upsert(conv: Conversation): Promise<void> {
    const table = await getConversationsTable();
    const existing = await table
      .query()
      .where(`id = '${conv.id}'`)
      .limit(1)
      .toArray();

    const row = {
      id: conv.id,
      source: conv.source,
      title: conv.title,
      subtitle: conv.subtitle ?? '',
      workspacePath: conv.workspacePath ?? '',
      projectName: conv.projectName ?? '',
      model: conv.model ?? '',
      mode: conv.mode ?? '',
      createdAt: conv.createdAt ?? '',
      updatedAt: conv.updatedAt ?? '',
      messageCount: conv.messageCount,
      sourceRefJson: JSON.stringify(conv.sourceRef),
    };

    if (existing.length > 0) {
      await table.delete(`id = '${conv.id}'`);
    }
    await table.add([row]);
  },

  async findById(id: string): Promise<Conversation | null> {
    const table = await getConversationsTable();
    const results = await table.query().where(`id = '${id}'`).limit(1).toArray();

    if (results.length === 0) return null;

    const row = results[0]!;
    return {
      id: row.id as string,
      source: row.source as Conversation['source'],
      title: row.title as string,
      subtitle: (row.subtitle as string) || undefined,
      workspacePath: (row.workspacePath as string) || undefined,
      projectName: (row.projectName as string) || undefined,
      model: (row.model as string) || undefined,
      mode: (row.mode as string) || undefined,
      createdAt: (row.createdAt as string) || undefined,
      updatedAt: (row.updatedAt as string) || undefined,
      messageCount: row.messageCount as number,
      sourceRef: JSON.parse(row.sourceRefJson as string) as SourceRef,
    };
  },

  async list(opts: {
    limit?: number;
    offset?: number;
    source?: string;
  } = {}): Promise<Conversation[]> {
    const table = await getConversationsTable();
    let query = table.query();

    if (opts.source) {
      query = query.where(`source = '${opts.source}'`);
    }

    const results = await query.limit(opts.limit ?? 50).toArray();

    return results.map((row) => ({
      id: row.id as string,
      source: row.source as Conversation['source'],
      title: row.title as string,
      subtitle: (row.subtitle as string) || undefined,
      workspacePath: (row.workspacePath as string) || undefined,
      projectName: (row.projectName as string) || undefined,
      model: (row.model as string) || undefined,
      mode: (row.mode as string) || undefined,
      createdAt: (row.createdAt as string) || undefined,
      updatedAt: (row.updatedAt as string) || undefined,
      messageCount: row.messageCount as number,
      sourceRef: JSON.parse(row.sourceRefJson as string) as SourceRef,
    }));
  },

  async delete(id: string): Promise<void> {
    const table = await getConversationsTable();
    await table.delete(`id = '${id}'`);
  },

  async deleteBySource(source: string, workspacePath?: string): Promise<void> {
    const table = await getConversationsTable();
    if (workspacePath) {
      await table.delete(`source = '${source}' AND "workspacePath" = '${workspacePath}'`);
    } else {
      await table.delete(`source = '${source}'`);
    }
  },
};

// ============ Message Repository ============

export const messageRepo = {
  async getExistingIds(conversationId: string): Promise<Set<string>> {
    const table = await getMessagesTable();
    const allResults = await table.query().toArray();
    const ids = allResults
      .filter((row) => (row.conversationId as string) === conversationId)
      .map((row) => row.id as string);
    return new Set(ids);
  },

  async bulkInsert(messages: Message[]): Promise<void> {
    if (messages.length === 0) return;

    const table = await getMessagesTable();
    const rows = messages.map((msg) => ({
      id: msg.id,
      conversationId: msg.conversationId,
      role: msg.role,
      content: msg.content,
      timestamp: msg.timestamp ?? '',
      messageIndex: msg.messageIndex,
      vector: new Array(EMBEDDING_DIMENSIONS).fill(0), // Placeholder, will be updated with embeddings
    }));

    await table.add(rows);
  },

  async bulkInsertNew(messages: Message[], existingIds: Set<string>): Promise<number> {
    const newMessages = messages.filter((msg) => !existingIds.has(msg.id));
    if (newMessages.length === 0) return 0;

    const table = await getMessagesTable();
    const rows = newMessages.map((msg) => ({
      id: msg.id,
      conversationId: msg.conversationId,
      role: msg.role,
      content: msg.content,
      timestamp: msg.timestamp ?? '',
      messageIndex: msg.messageIndex,
      vector: new Array(EMBEDDING_DIMENSIONS).fill(0), // Placeholder, will be updated with embeddings
    }));

    await table.add(rows);
    return newMessages.length;
  },

  async updateVector(messageId: string, vector: number[]): Promise<void> {
    const table = await getMessagesTable();
    // Use LanceDB's update() to preserve FTS index
    await table.update({
      where: `id = '${messageId}'`,
      values: { vector },
    });
  },

  async findByConversation(conversationId: string): Promise<Message[]> {
    const table = await getMessagesTable();
    // Note: LanceDB has issues with camelCase column filtering
    // Using post-query filter as workaround
    const allResults = await table.query().toArray();
    const results = allResults.filter(
      (row) => (row.conversationId as string) === conversationId
    );

    return results
      .map((row) => ({
        id: row.id as string,
        conversationId: row.conversationId as string,
        role: row.role as Message['role'],
        content: row.content as string,
        timestamp: (row.timestamp as string) || undefined,
        messageIndex: row.messageIndex as number,
      }))
      .sort((a, b) => a.messageIndex - b.messageIndex);
  },

  async deleteByConversation(conversationId: string): Promise<void> {
    const table = await getMessagesTable();
    await table.delete(`"conversationId" = '${conversationId}'`);
  },

  async search(query: string, limit = 50): Promise<MessageMatch[]> {
    const table = await getMessagesTable();

    // Manual hybrid search: run FTS and vector separately, then combine with RRF
    try {
      // Get vector for semantic search
      const queryVector = await embedQuery(query);

      // Run both searches in parallel
      const [ftsResults, vectorResults] = await Promise.all([
        table
          .search(query, 'fts')
          .select(['id', 'conversationId', 'role', 'content', 'messageIndex'])
          .limit(limit * 2)
          .toArray(),
        table
          .query()
          .nearestTo(queryVector)
          .select(['id', 'conversationId', 'role', 'content', 'messageIndex'])
          .limit(limit * 2)
          .toArray(),
      ]);

      // Reciprocal Rank Fusion (RRF) to combine results
      const k = 60; // RRF constant
      const scores = new Map<string, { score: number; row: Record<string, unknown> }>();

      // Score FTS results
      ftsResults.forEach((row, rank) => {
        const id = row.id as string;
        const rrfScore = 1 / (k + rank + 1);
        const existing = scores.get(id);
        if (existing) {
          existing.score += rrfScore;
        } else {
          scores.set(id, { score: rrfScore, row });
        }
      });

      // Score vector results
      vectorResults.forEach((row, rank) => {
        const id = row.id as string;
        const rrfScore = 1 / (k + rank + 1);
        const existing = scores.get(id);
        if (existing) {
          existing.score += rrfScore;
        } else {
          scores.set(id, { score: rrfScore, row });
        }
      });

      // Sort by combined score and take top results
      const combined = Array.from(scores.values())
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

      return combined
        .filter(({ row }) => {
          // Filter out messages with empty/whitespace-only content
          const content = row.content as string;
          return content && content.trim().length > 0;
        })
        .map(({ score, row }) => {
          const content = row.content as string;
          const { snippet, highlightRanges } = extractSnippet(content, query);

          return {
            messageId: row.id as string,
            conversationId: row.conversationId as string,
            role: row.role as MessageMatch['role'],
            content,
            snippet,
            highlightRanges,
            score,
            messageIndex: row.messageIndex as number,
          };
        });
    } catch {
      // Fallback to FTS-only if embedding model not available
      const results = await table
        .search(query, 'fts')
        .select(['id', 'conversationId', 'role', 'content', 'messageIndex'])
        .limit(limit)
        .toArray();

      return results
        .filter((row) => {
          // Filter out messages with empty/whitespace-only content
          const content = row.content as string;
          return content && content.trim().length > 0;
        })
        .map((row) => {
          const content = row.content as string;
          const { snippet, highlightRanges } = extractSnippet(content, query);

          return {
            messageId: row.id as string,
            conversationId: row.conversationId as string,
            role: row.role as MessageMatch['role'],
            content,
            snippet,
            highlightRanges,
            score: (row._score as number) ?? 0,
            messageIndex: row.messageIndex as number,
          };
        });
    }
  },
};

// ============ Tool Call Repository ============

export const toolCallRepo = {
  async bulkInsert(toolCalls: ToolCall[]): Promise<void> {
    if (toolCalls.length === 0) return;

    const table = await getToolCallsTable();
    const rows = toolCalls.map((tc) => ({
      id: tc.id,
      messageId: tc.messageId,
      conversationId: tc.conversationId,
      type: tc.type,
      input: tc.input,
      output: tc.output ?? '',
      filePath: tc.filePath ?? '',
    }));

    await table.add(rows);
  },

  async findByFile(filePath: string): Promise<ToolCall[]> {
    const table = await getToolCallsTable();
    const results = await table
      .query()
      .where(`"filePath" = '${filePath}'`)
      .toArray();

    return results.map((row) => ({
      id: row.id as string,
      messageId: row.messageId as string,
      conversationId: row.conversationId as string,
      type: row.type as string,
      input: row.input as string,
      output: (row.output as string) || undefined,
      filePath: (row.filePath as string) || undefined,
    }));
  },

  async deleteByConversation(conversationId: string): Promise<void> {
    const table = await getToolCallsTable();
    await table.delete(`"conversationId" = '${conversationId}'`);
  },
};

// ============ Sync State Repository ============

export const syncStateRepo = {
  async get(source: string, dbPath: string): Promise<SyncState | null> {
    const table = await getSyncStateTable();
    const results = await table
      .query()
      .where(`source = '${source}' AND "dbPath" = '${dbPath}'`)
      .limit(1)
      .toArray();

    if (results.length === 0) return null;

    const row = results[0]!;
    return {
      source: row.source as SyncState['source'],
      workspacePath: row.workspacePath as string,
      dbPath: row.dbPath as string,
      lastSyncedAt: row.lastSyncedAt as string,
      lastMtime: row.lastMtime as number,
    };
  },

  async set(state: SyncState): Promise<void> {
    const table = await getSyncStateTable();

    // Delete existing if any
    await table.delete(`source = '${state.source}' AND "dbPath" = '${state.dbPath}'`);

    await table.add([
      {
        source: state.source,
        workspacePath: state.workspacePath,
        dbPath: state.dbPath,
        lastSyncedAt: state.lastSyncedAt,
        lastMtime: state.lastMtime,
      },
    ]);
  },
};

// ============ Conversation Files Repository ============

export const filesRepo = {
  async bulkInsert(files: ConversationFile[]): Promise<void> {
    if (files.length === 0) return;

    const table = await getFilesTable();
    const rows = files.map((f) => ({
      id: f.id,
      conversationId: f.conversationId,
      filePath: f.filePath,
      role: f.role,
    }));

    await table.add(rows);
  },

  async findByConversation(conversationId: string): Promise<ConversationFile[]> {
    const table = await getFilesTable();
    const allResults = await table.query().toArray();
    const results = allResults.filter(
      (row) => (row.conversationId as string) === conversationId
    );

    return results.map((row) => ({
      id: row.id as string,
      conversationId: row.conversationId as string,
      filePath: row.filePath as string,
      role: row.role as ConversationFile['role'],
    }));
  },

  async deleteByConversation(conversationId: string): Promise<void> {
    const table = await getFilesTable();
    await table.delete(`"conversationId" = '${conversationId}'`);
  },
};

// ============ Message Files Repository ============

export const messageFilesRepo = {
  async bulkInsert(files: MessageFile[]): Promise<void> {
    if (files.length === 0) return;

    const table = await getMessageFilesTable();
    const rows = files.map((f) => ({
      id: f.id,
      messageId: f.messageId,
      conversationId: f.conversationId,
      filePath: f.filePath,
      role: f.role,
    }));

    await table.add(rows);
  },

  async findByMessage(messageId: string): Promise<MessageFile[]> {
    const table = await getMessageFilesTable();
    const allResults = await table.query().toArray();
    const results = allResults.filter(
      (row) => (row.messageId as string) === messageId
    );

    return results.map((row) => ({
      id: row.id as string,
      messageId: row.messageId as string,
      conversationId: row.conversationId as string,
      filePath: row.filePath as string,
      role: row.role as MessageFile['role'],
    }));
  },

  async findByConversation(conversationId: string): Promise<MessageFile[]> {
    const table = await getMessageFilesTable();
    const allResults = await table.query().toArray();
    const results = allResults.filter(
      (row) => (row.conversationId as string) === conversationId
    );

    return results.map((row) => ({
      id: row.id as string,
      messageId: row.messageId as string,
      conversationId: row.conversationId as string,
      filePath: row.filePath as string,
      role: row.role as MessageFile['role'],
    }));
  },

  async deleteByConversation(conversationId: string): Promise<void> {
    const table = await getMessageFilesTable();
    await table.delete(`"conversationId" = '${conversationId}'`);
  },
};

// ============ Search Service ============

export async function search(query: string, limit = 50): Promise<SearchResponse> {
  const startTime = Date.now();

  // 1. Search messages
  const messageMatches = await messageRepo.search(query, limit);

  if (messageMatches.length === 0) {
    return {
      query,
      results: [],
      totalConversations: 0,
      totalMessages: 0,
      searchTimeMs: Date.now() - startTime,
    };
  }

  // 2. Group by conversation
  const grouped = groupBy(messageMatches, (m) => m.conversationId);

  // 3. Fetch conversation metadata for each group
  const conversationIds = Object.keys(grouped);
  const conversations: Conversation[] = [];

  for (const id of conversationIds) {
    const conv = await conversationRepo.findById(id);
    if (conv) {
      conversations.push(conv);
    }
  }

  // 4. Build ConversationResult objects
  const results: ConversationResult[] = conversations
    .map((conv) => {
      const matches = grouped[conv.id] ?? [];
      const sortedMatches = [...matches].sort((a, b) => b.score - a.score);
      const bestMatch = sortedMatches[0];

      if (!bestMatch) return null;

      return {
        conversation: conv,
        matches: sortedMatches,
        bestMatch,
        totalMatches: matches.length,
      };
    })
    .filter((r): r is ConversationResult => r !== null);

  // 5. Sort by best match score
  results.sort((a, b) => b.bestMatch.score - a.bestMatch.score);

  return {
    query,
    results,
    totalConversations: results.length,
    totalMessages: messageMatches.length,
    searchTimeMs: Date.now() - startTime,
  };
}
