import * as lancedb from '@lancedb/lancedb';
import { getLanceDBPath } from '../utils/config';
import type { Table } from '@lancedb/lancedb';
import { EMBEDDING_DIMENSIONS } from '../embeddings/index';

let db: lancedb.Connection | null = null;

// Table references
let conversationsTable: Table | null = null;
let messagesTable: Table | null = null;
let toolCallsTable: Table | null = null;
let syncStateTable: Table | null = null;
let filesTable: Table | null = null;
let messageFilesTable: Table | null = null;
let fileEditsTable: Table | null = null;

export async function connect(): Promise<lancedb.Connection> {
  if (db) return db;

  const dbPath = getLanceDBPath();
  db = await lancedb.connect(dbPath);

  await ensureTables();

  return db;
}

/**
 * Reset the database connection (for testing)
 * This clears all cached table references so a fresh connection will be created
 */
export function resetConnection(): void {
  db = null;
  conversationsTable = null;
  messagesTable = null;
  toolCallsTable = null;
  syncStateTable = null;
  filesTable = null;
  messageFilesTable = null;
  fileEditsTable = null;
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

export async function getFileEditsTable(): Promise<Table> {
  if (!fileEditsTable) {
    await connect();
  }
  return fileEditsTable!;
}

async function ensureTables(): Promise<void> {
  if (!db) throw new Error('Database not connected');

  const existingTables = await db.tableNames();

  // Conversations table
  // Note: All column names use snake_case to ensure LanceDB SQL compatibility
  if (!existingTables.includes('conversations')) {
    conversationsTable = await db.createTable('conversations', [
      {
        id: '_placeholder_',
        source: 'cursor',
        title: '',
        subtitle: '',
        workspace_path: '',
        project_name: '',
        model: '',
        mode: '',
        created_at: '',
        updated_at: '',
        message_count: 0,
        source_ref_json: '{}',
        total_input_tokens: 0,
        total_output_tokens: 0,
        total_cache_creation_tokens: 0,
        total_cache_read_tokens: 0,
        total_lines_added: 0,
        total_lines_removed: 0,
      },
    ]);
    // Delete placeholder row
    await conversationsTable.delete("id = '_placeholder_'");
  } else {
    conversationsTable = await db.openTable('conversations');
  }

  // Messages table - primary search target with vector embeddings
  if (!existingTables.includes('messages')) {
    messagesTable = await db.createTable('messages', [
      {
        id: '_placeholder_',
        conversation_id: '',
        role: 'user',
        content: '',
        timestamp: '',
        message_index: 0,
        vector: new Array(EMBEDDING_DIMENSIONS).fill(0),
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_tokens: 0,
        cache_read_tokens: 0,
        total_lines_added: 0,
        total_lines_removed: 0,
      },
    ]);
    await messagesTable.delete("id = '_placeholder_'");
    // Note: FTS and vector indexes will be created/rebuilt after sync when data exists
  } else {
    messagesTable = await db.openTable('messages');
  }

  // Tool calls table
  if (!existingTables.includes('tool_calls')) {
    toolCallsTable = await db.createTable('tool_calls', [
      {
        id: '_placeholder_',
        message_id: '',
        conversation_id: '',
        type: '',
        input: '',
        output: '',
        file_path: '',
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
        workspace_path: '_placeholder_',
        db_path: '',
        last_synced_at: new Date().toISOString(),
        last_mtime: 0,
      },
    ]);
    await syncStateTable.delete("workspace_path = '_placeholder_'");
  } else {
    syncStateTable = await db.openTable('sync_state');
  }

  // Conversation files table
  if (!existingTables.includes('conversation_files')) {
    filesTable = await db.createTable('conversation_files', [
      {
        id: '_placeholder_',
        conversation_id: '',
        file_path: '',
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
        message_id: '',
        conversation_id: '',
        file_path: '',
        role: 'context',
      },
    ]);
    await messageFilesTable.delete("id = '_placeholder_'");
  } else {
    messageFilesTable = await db.openTable('message_files');
  }

  // File edits table (individual line-level edits)
  if (!existingTables.includes('file_edits')) {
    fileEditsTable = await db.createTable('file_edits', [
      {
        id: '_placeholder_',
        message_id: '',
        conversation_id: '',
        file_path: '',
        edit_type: 'modify',
        lines_added: 0,
        lines_removed: 0,
        start_line: 0,
        end_line: 0,
      },
    ]);
    await fileEditsTable.delete("id = '_placeholder_'");
  } else {
    fileEditsTable = await db.openTable('file_edits');
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
  fileEditsTable = null;
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

export async function rebuildVectorIndex(): Promise<void> {
  const table = await getMessagesTable();

  // Create IVF-PQ vector index for efficient similarity search
  await table.createIndex('vector', {
    config: lancedb.Index.ivfPq({
      numPartitions: 256,
      numSubVectors: 16,
    }),
    replace: true,
  });
}

export async function needsVectorMigration(): Promise<boolean> {
  const table = await getMessagesTable();

  // Check if the table has a vector column by trying to get schema
  try {
    const schema = await table.schema();
    const hasVector = schema.fields.some((f) => f.name === 'vector');
    return !hasVector;
  } catch {
    return true;
  }
}

export async function dropMessagesTable(): Promise<void> {
  if (!db) {
    await connect();
  }
  await db!.dropTable('messages');
  messagesTable = null;
}

export async function recreateMessagesTable(): Promise<void> {
  if (!db) {
    await connect();
  }

  // Drop and recreate with vector column
  const existingTables = await db!.tableNames();
  if (existingTables.includes('messages')) {
    await db!.dropTable('messages');
  }

  messagesTable = await db!.createTable('messages', [
    {
      id: '_placeholder_',
      conversation_id: '',
      role: 'user',
      content: '',
      timestamp: '',
      message_index: 0,
      vector: new Array(EMBEDDING_DIMENSIONS).fill(0),
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
      total_lines_added: 0,
      total_lines_removed: 0,
    },
  ]);
  await messagesTable.delete("id = '_placeholder_'");
}
