import * as lancedb from '@lancedb/lancedb';
import { getLanceDBPath } from '../utils/config.js';
import type { Table } from '@lancedb/lancedb';

let db: lancedb.Connection | null = null;

// Table references
let conversationsTable: Table | null = null;
let messagesTable: Table | null = null;
let toolCallsTable: Table | null = null;
let syncStateTable: Table | null = null;
let filesTable: Table | null = null;
let messageFilesTable: Table | null = null;

export async function connect(): Promise<lancedb.Connection> {
  if (db) return db;

  const dbPath = getLanceDBPath();
  db = await lancedb.connect(dbPath);

  await ensureTables();

  return db;
}

export async function getConversationsTable(): Promise<Table> {
  if (!conversationsTable) {
    await connect();
  }
  return conversationsTable!;
}

export async function getMessagesTable(): Promise<Table> {
  if (!messagesTable) {
    await connect();
  }
  return messagesTable!;
}

export async function getToolCallsTable(): Promise<Table> {
  if (!toolCallsTable) {
    await connect();
  }
  return toolCallsTable!;
}

export async function getSyncStateTable(): Promise<Table> {
  if (!syncStateTable) {
    await connect();
  }
  return syncStateTable!;
}

export async function getFilesTable(): Promise<Table> {
  if (!filesTable) {
    await connect();
  }
  return filesTable!;
}

export async function getMessageFilesTable(): Promise<Table> {
  if (!messageFilesTable) {
    await connect();
  }
  return messageFilesTable!;
}

async function ensureTables(): Promise<void> {
  if (!db) throw new Error('Database not connected');

  const existingTables = await db.tableNames();

  // Conversations table
  // Use empty strings for nullable fields to establish schema types
  if (!existingTables.includes('conversations')) {
    conversationsTable = await db.createTable('conversations', [
      {
        id: '_placeholder_',
        source: 'cursor',
        title: '',
        subtitle: '',           // Empty string instead of null
        workspacePath: '',      // Empty string instead of null
        projectName: '',        // Empty string instead of null
        model: '',              // Empty string instead of null
        mode: '',               // Empty string instead of null
        createdAt: '',          // Empty string instead of null
        updatedAt: '',          // Empty string instead of null
        messageCount: 0,
        sourceRefJson: '{}',
      },
    ]);
    // Delete placeholder row
    await conversationsTable.delete("id = '_placeholder_'");
  } else {
    conversationsTable = await db.openTable('conversations');
  }

  // Messages table - primary search target
  if (!existingTables.includes('messages')) {
    messagesTable = await db.createTable('messages', [
      {
        id: '_placeholder_',
        conversationId: '',
        role: 'user',
        content: '',
        timestamp: '',          // Empty string instead of null
        messageIndex: 0,
      },
    ]);
    await messagesTable.delete("id = '_placeholder_'");
    // Note: FTS index will be created/rebuilt after sync when data exists
  } else {
    messagesTable = await db.openTable('messages');
  }

  // Tool calls table
  if (!existingTables.includes('tool_calls')) {
    toolCallsTable = await db.createTable('tool_calls', [
      {
        id: '_placeholder_',
        messageId: '',
        conversationId: '',
        type: '',
        input: '',
        output: '',             // Empty string instead of null
        filePath: '',           // Empty string instead of null
      },
    ]);
    await toolCallsTable.delete("id = '_placeholder_'");
  } else {
    toolCallsTable = await db.openTable('tool_calls');
  }

  // Sync state table
  if (!existingTables.includes('sync_state')) {
    syncStateTable = await db.createTable('sync_state', [
      {
        source: 'cursor',
        workspacePath: '_placeholder_',
        dbPath: '',
        lastSyncedAt: new Date().toISOString(),
        lastMtime: 0,
      },
    ]);
    await syncStateTable.delete(`"workspacePath" = '_placeholder_'`);
  } else {
    syncStateTable = await db.openTable('sync_state');
  }

  // Conversation files table
  if (!existingTables.includes('conversation_files')) {
    filesTable = await db.createTable('conversation_files', [
      {
        id: '_placeholder_',
        conversationId: '',
        filePath: '',
        role: 'context',
      },
    ]);
    await filesTable.delete("id = '_placeholder_'");
  } else {
    filesTable = await db.openTable('conversation_files');
  }

  // Message files table (per-message file associations)
  if (!existingTables.includes('message_files')) {
    messageFilesTable = await db.createTable('message_files', [
      {
        id: '_placeholder_',
        messageId: '',
        conversationId: '',
        filePath: '',
        role: 'context',
      },
    ]);
    await messageFilesTable.delete("id = '_placeholder_'");
  } else {
    messageFilesTable = await db.openTable('message_files');
  }
}

export async function closeConnection(): Promise<void> {
  db = null;
  conversationsTable = null;
  messagesTable = null;
  toolCallsTable = null;
  syncStateTable = null;
  filesTable = null;
  messageFilesTable = null;
}

export async function rebuildFtsIndex(): Promise<void> {
  const table = await getMessagesTable();

  // LanceDB will update existing index when createIndex is called again
  // with replace: true option
  await table.createIndex('content', {
    config: lancedb.Index.fts(),
    replace: true,
  });
}
