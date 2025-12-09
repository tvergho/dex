import * as lancedb from '@lancedb/lancedb';
import { getLanceDBPath, getDataDir } from '../utils/config';
import type { Table } from '@lancedb/lancedb';
import { EMBEDDING_DIMENSIONS } from '../embeddings/index';
import { Source } from '../schema/index';
import { existsSync, writeFileSync, unlinkSync, readFileSync, rmSync, readdirSync } from 'fs';
import { join } from 'path';
import { spawn } from 'child_process';

let db: lancedb.Connection | null = null;

// ============ Retry Logic for LanceDB Commit Conflicts ============

/**
 * Check if an error is a LanceDB commit conflict
 */
function isCommitConflict(error: unknown): boolean {
  if (error instanceof Error) {
    return error.message.includes('Commit conflict') ||
           error.message.includes('concurrent commit');
  }
  return false;
}

/**
 * Check if an error is a transient LanceDB error that can be retried.
 * This includes commit conflicts and race conditions during concurrent read/write.
 * Note: Does NOT include .lance file errors as those may be permanent corruption.
 */
export function isTransientError(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message;
    // Only retry commit conflicts and concurrent access issues
    // Don't retry missing file errors - those could be permanent corruption
    return isCommitConflict(error) ||
           (msg.includes('LanceError') && !msg.includes('Not found') && !msg.includes('.lance'));
  }
  return false;
}

/**
 * Check if an error indicates a corrupted database (missing .lance data files).
 * This happens when metadata references data files that no longer exist.
 */
export function isCorruptedDatabaseError(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message;
    // Missing .lance data file - permanent corruption
    return (msg.includes('Not found') && msg.includes('.lance')) ||
           (msg.includes('Failed to get next batch') && msg.includes('.lance'));
  }
  return false;
}

/**
 * Extract the table name from a corruption error message.
 * Error format: "...~/.dex/lancedb/TABLE_NAME.lance/data/..."
 */
export function extractCorruptedTableName(error: unknown): string | null {
  if (error instanceof Error) {
    // Pattern: /lancedb/TABLE_NAME.lance/
    const match = error.message.match(/lancedb\/([^/]+)\.lance\//);
    if (match && match[1]) {
      return match[1];
    }
  }
  return null;
}

/**
 * Reset connection and retry an operation when stale table references cause errors.
 * This handles the case where cleanup removed files that a cached table still references.
 */
export async function withConnectionRecovery<T>(
  operation: () => Promise<T>,
  maxRetries = 2
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      // If it's a stale reference error (missing .lance files), reset connection and retry
      if (isCorruptedDatabaseError(error) && attempt < maxRetries) {
        console.error(`[db] Stale table reference detected, resetting connection (attempt ${attempt + 1}/${maxRetries})...`);
        resetConnection();
        // Small delay to let any pending operations complete
        await new Promise(resolve => setTimeout(resolve, 100));
        continue;
      }

      // For transient errors, use standard retry logic
      if (isTransientError(error) && attempt < maxRetries) {
        const delay = 100 * Math.pow(2, attempt) + Math.random() * 50;
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }

      throw error;
    }
  }

  throw lastError;
}

/**
 * Check if an error indicates a corrupted FTS index (fragment not found).
 * This happens when the FTS index references data that was deleted or compacted.
 */
export function isFragmentNotFoundError(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message;
    return msg.includes('fragment id') && msg.includes('does not exist');
  }
  return false;
}

/**
 * Retry a LanceDB operation with exponential backoff on transient errors.
 * This handles commit conflicts and race conditions during concurrent read/write operations.
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  maxRetries = 3,
  baseDelayMs = 100
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      if (!isTransientError(error) || attempt === maxRetries) {
        throw error;
      }

      // Exponential backoff with jitter
      const delay = baseDelayMs * Math.pow(2, attempt) + Math.random() * 50;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

// ============ Sync Lock to Prevent Concurrent Operations ============

const LOCK_FILE = 'sync.lock';
const LOCK_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes - stale lock threshold

interface LockInfo {
  pid: number;
  startedAt: number;
}

/**
 * Acquire a lock for sync operations.
 * Returns true if lock acquired, false if another sync is running.
 */
export function acquireSyncLock(): boolean {
  const lockPath = join(getDataDir(), LOCK_FILE);

  // Check for existing lock
  if (existsSync(lockPath)) {
    try {
      const lockData = JSON.parse(readFileSync(lockPath, 'utf-8')) as LockInfo;
      const lockAge = Date.now() - lockData.startedAt;

      // Check if lock is stale (process died without cleanup)
      if (lockAge < LOCK_TIMEOUT_MS) {
        // Check if process is still running
        try {
          process.kill(lockData.pid, 0); // Signal 0 = check if process exists
          return false; // Process still running, lock is valid
        } catch {
          // Process is dead, lock is stale - fall through to acquire
        }
      }
      // Lock is stale, remove it
      unlinkSync(lockPath);
    } catch {
      // Corrupted lock file, remove it
      try { unlinkSync(lockPath); } catch { /* ignore */ }
    }
  }

  // Acquire lock
  const lockInfo: LockInfo = {
    pid: process.pid,
    startedAt: Date.now(),
  };

  try {
    writeFileSync(lockPath, JSON.stringify(lockInfo), { flag: 'wx' }); // wx = fail if exists
    return true;
  } catch {
    return false; // Another process beat us to it
  }
}

/**
 * Release the sync lock.
 */
export function releaseSyncLock(): void {
  const lockPath = join(getDataDir(), LOCK_FILE);
  try {
    if (existsSync(lockPath)) {
      const lockData = JSON.parse(readFileSync(lockPath, 'utf-8')) as LockInfo;
      // Only release if we own the lock
      if (lockData.pid === process.pid) {
        unlinkSync(lockPath);
      }
    }
  } catch {
    // Ignore errors during cleanup
  }
}

// Table references
let conversationsTable: Table | null = null;
let messagesTable: Table | null = null;
let toolCallsTable: Table | null = null;
let syncStateTable: Table | null = null;
let filesTable: Table | null = null;
let messageFilesTable: Table | null = null;
let fileEditsTable: Table | null = null;

/**
 * Check if the database can be connected to by spawning a child process.
 * This avoids blocking the main event loop if LanceDB hangs during connect.
 * Returns true if connection succeeds, false if it times out or fails.
 */
async function preflightDatabaseCheck(dbPath: string, timeoutMs = 5000): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    // Spawn a quick bun/node process to test the connection
    const runtime = process.execPath; // Use same runtime (bun or node)

    const testScript = `
      const lancedb = require('@lancedb/lancedb');
      (async () => {
        try {
          const db = await lancedb.connect('${dbPath.replace(/'/g, "\\'")}');
          const tables = await db.tableNames();
          console.log('OK:' + tables.length);
          process.exit(0);
        } catch (e) {
          console.error('ERR:' + e.message);
          process.exit(1);
        }
      })();
    `;

    const child = spawn(runtime, ['-e', testScript], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
      env: { ...process.env },
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (data) => { stdout += data.toString(); });
    child.stderr?.on('data', (data) => { stderr += data.toString(); });

    const killTimeout = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ ok: false, error: 'Connection check timed out - database may be locked or corrupted' });
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(killTimeout);
      if (code === 0 && stdout.includes('OK:')) {
        resolve({ ok: true });
      } else {
        const errMsg = stderr.includes('ERR:') ? stderr.split('ERR:')[1]?.trim() : stderr.trim();
        resolve({ ok: false, error: errMsg || `Connection check failed with code ${code}` });
      }
    });

    child.on('error', (err) => {
      clearTimeout(killTimeout);
      resolve({ ok: false, error: err.message });
    });
  });
}

/**
 * Clean up stale application lock files.
 * These locks are used to prevent concurrent sync/embed operations.
 */
function cleanupStaleAppLocks(): void {
  const dataDir = getDataDir();
  const lockFiles = ['sync.lock', 'embed.lock'];

  for (const lockFile of lockFiles) {
    const lockPath = join(dataDir, lockFile);
    if (existsSync(lockPath)) {
      try {
        const lockData = JSON.parse(readFileSync(lockPath, 'utf-8')) as { pid: number; startedAt: number };
        // Check if process is still running
        try {
          process.kill(lockData.pid, 0);
          // Process is running, leave lock alone
        } catch {
          // Process is dead, remove stale lock
          console.error(`[db] Removing stale ${lockFile} (pid ${lockData.pid} no longer running)`);
          unlinkSync(lockPath);
        }
      } catch {
        // Corrupted lock file, remove it
        try {
          unlinkSync(lockPath);
        } catch {
          // Ignore
        }
      }
    }
  }
}

/**
 * Clean up potential lock/stale state from LanceDB.
 * This removes transaction logs that might be causing hangs.
 */
function cleanupStaleLanceDBState(dbPath: string): void {
  if (!existsSync(dbPath)) return;

  try {
    const entries = readdirSync(dbPath);
    for (const entry of entries) {
      if (entry.endsWith('.lance')) {
        const tablePath = join(dbPath, entry);
        const transactionsPath = join(tablePath, '_transactions');

        // Check for very old or many transaction files that might indicate issues
        if (existsSync(transactionsPath)) {
          try {
            const txFiles = readdirSync(transactionsPath);
            // If there are a huge number of transaction files, something is wrong
            if (txFiles.length > 100) {
              console.error(`[db] Cleaning up ${txFiles.length} stale transaction files in ${entry}...`);
              // Don't delete, just log for now - LanceDB should handle cleanup
            }
          } catch {
            // Ignore
          }
        }
      }
    }
  } catch {
    // Ignore cleanup errors
  }
}

/**
 * Safely connect to LanceDB with timeout protection.
 * If the database is corrupted and hangs, this will timeout and allow recovery.
 */
async function safeConnect(dbPath: string, timeoutMs = 10000): Promise<lancedb.Connection> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timeout connecting to LanceDB at "${dbPath}" - database may be corrupted`));
    }, timeoutMs);

    lancedb.connect(dbPath)
      .then((connection) => {
        clearTimeout(timeout);
        resolve(connection);
      })
      .catch((err) => {
        clearTimeout(timeout);
        reject(err);
      });
  });
}

export async function connect(): Promise<lancedb.Connection> {
  if (db) return db;

  const dbPath = getLanceDBPath();
  console.error('[db] Connecting to LanceDB at', dbPath);

  // Step 0: Clean up any stale application locks from crashed processes
  cleanupStaleAppLocks();

  // Step 1: Preflight check using child process to avoid blocking main thread
  // This catches cases where LanceDB hangs due to locks or corruption
  const preflight = await preflightDatabaseCheck(dbPath);
  if (!preflight.ok) {
    // Only log on failure - successful preflight is silent
    console.error(`[db] Preflight check failed: ${preflight.error}`);
    console.error('[db] Attempting recovery...');

    // Clean up stale state first
    cleanupStaleLanceDBState(dbPath);

    // Try dropping all tables
    if (existsSync(dbPath)) {
      const entries = readdirSync(dbPath);
      for (const entry of entries) {
        if (entry.endsWith('.lance')) {
          const tablePath = join(dbPath, entry);
          console.error(`[db] Removing potentially corrupted table: ${entry}`);
          try {
            rmSync(tablePath, { recursive: true, force: true });
          } catch {
            // Ignore
          }
        }
      }
    }

    // Try preflight again after cleanup
    const retryPreflight = await preflightDatabaseCheck(dbPath);
    if (!retryPreflight.ok) {
      console.error('[db] Recovery failed. Full database reset required...');
      try {
        rmSync(dbPath, { recursive: true, force: true });
      } catch {
        // Ignore
      }
    }
  }

  // Step 2: Now connect in main process (should be safe after preflight)
  try {
    db = await safeConnect(dbPath);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`[db] Connection issue: ${errorMsg}`);

    // Last resort: Full reset
    console.error('[db] Connection failed after preflight. Resetting database...');
    try {
      rmSync(dbPath, { recursive: true, force: true });
    } catch {
      // Ignore
    }
    db = await lancedb.connect(dbPath);
    console.error('[db] Database reset complete. Run "dex sync --force" to rebuild data.');
  }

  console.error('[db] LanceDB connected, ensuring tables...');

  try {
    await ensureTables();
  } catch (error) {
    // If table initialization fails due to corruption, try to recover
    if (isCorruptedDatabaseError(error)) {
      const tableName = extractCorruptedTableName(error);
      console.error(`[db] Detected corrupted table${tableName ? ` "${tableName}"` : ''}, attempting recovery...`);

      // Drop corrupted tables and recreate
      await recoverFromCorruption(tableName);

      // Retry table initialization
      await ensureTables();
      console.error('[db] Recovery successful. Run "dex sync --force" to rebuild data.');
    } else {
      throw error;
    }
  }
  console.error('[db] Tables ready');

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

/**
 * Get a fresh messages table reference, bypassing the cache.
 * Use this when you need to ensure you have the latest table version,
 * such as during searches while embedding is running.
 */
export async function getFreshMessagesTable(): Promise<Table> {
  // Create a completely fresh connection to get the latest table state
  const dbPath = getLanceDBPath();
  const freshDb = await lancedb.connect(dbPath);
  return await freshDb.openTable('messages');
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

/**
 * Safely open a table with timeout protection.
 * If the table is corrupted and hangs, this will timeout and throw.
 */
async function safeOpenTable(tableName: string, timeoutMs = 10000): Promise<Table> {
  if (!db) throw new Error('Database not connected');

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timeout opening table "${tableName}" - table may be corrupted. Not found: ~/.dex/lancedb/${tableName}.lance`));
    }, timeoutMs);

    db!.openTable(tableName)
      .then((table) => {
        clearTimeout(timeout);
        resolve(table);
      })
      .catch((err) => {
        clearTimeout(timeout);
        reject(err);
      });
  });
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
        source: Source.Cursor,
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
        compact_count: 0, // Claude Code: number of context compactions
      },
    ]);
    // Delete placeholder row
    await conversationsTable.delete("id = '_placeholder_'");
  } else {
    conversationsTable = await safeOpenTable('conversations');
  }

  // Messages table - primary search target with vector embeddings
  if (!existingTables.includes('messages')) {
    messagesTable = await db.createTable('messages', [
      {
        id: '_placeholder_',
        conversation_id: '',
        role: 'user',
        content: '',
        indexed_content: '', // Content with tool outputs stripped, used for FTS
        timestamp: '',
        message_index: 0,
        vector: new Array(EMBEDDING_DIMENSIONS).fill(0),
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_tokens: 0,
        cache_read_tokens: 0,
        total_lines_added: 0,
        total_lines_removed: 0,
        is_compact_summary: false, // Claude Code: marks context restoration summaries
      },
    ]);
    await messagesTable.delete("id = '_placeholder_'");
    // Note: FTS and vector indexes will be created/rebuilt after sync when data exists
  } else {
    messagesTable = await safeOpenTable('messages');
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
    toolCallsTable = await safeOpenTable('tool_calls');
  }

  // Sync state table
  if (!existingTables.includes('sync_state')) {
    syncStateTable = await db.createTable('sync_state', [
      {
        source: Source.Cursor,
        workspace_path: '_placeholder_',
        db_path: '',
        last_synced_at: new Date().toISOString(),
        last_mtime: 0,
      },
    ]);
    await syncStateTable.delete("workspace_path = '_placeholder_'");
  } else {
    syncStateTable = await safeOpenTable('sync_state');
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
    filesTable = await safeOpenTable('conversation_files');
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
    messageFilesTable = await safeOpenTable('message_files');
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
        new_content: '',
      },
    ]);
    await fileEditsTable.delete("id = '_placeholder_'");
  } else {
    fileEditsTable = await safeOpenTable('file_edits');
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
  // Index indexed_content (tool outputs stripped) to avoid noise from
  // tool results like file listings, bash output, etc.
  await table.createIndex('indexed_content', {
    config: lancedb.Index.fts(),
    replace: true,
  });
}

/**
 * Repair FTS index by compacting, cleaning up old versions, and rebuilding.
 * Call this when you encounter a fragment-not-found error during search.
 * This is safe to call at any time and will fix index corruption issues.
 */
export async function repairFtsIndex(): Promise<void> {
  console.error('[db] Repairing FTS index...');

  // Step 1: Compact the table to materialize any deletions
  await compactMessagesTable();

  // Step 2: Clean up old versions that the index might be referencing
  await cleanupOldVersions();

  // Step 3: Rebuild the FTS index from current data
  await rebuildFtsIndex();

  console.error('[db] FTS index repair complete');
}

/**
 * Strip tool output blocks from text.
 * Tool outputs (bash results, file contents, etc.) add noise to search.
 * Format: ---\n**ToolName**...\n```...```\n---
 */
export function stripToolOutputs(text: string): string {
  // Match tool blocks with 3 or 4 backticks (4 is used when content may contain code blocks)
  const toolBlockPattern = /\n---\n\*\*[^*]+\*\*[^\n]*\n(`{3,4})[\s\S]*?\1\n---\n?/g;
  return text.replace(toolBlockPattern, '\n').trim();
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

/**
 * Create scalar indexes on frequently filtered columns.
 * This speeds up .where() queries on conversation_id, file_path, etc.
 */
export async function rebuildScalarIndexes(): Promise<void> {
  // Messages table: conversation_id is used to fetch all messages for a conversation
  const messages = await getMessagesTable();
  await messages.createIndex('conversation_id', {
    config: lancedb.Index.btree(),
    replace: true,
  });

  // Tool calls: filter by conversation_id and message_id
  const toolCalls = await getToolCallsTable();
  await toolCalls.createIndex('conversation_id', {
    config: lancedb.Index.btree(),
    replace: true,
  });

  // Conversation files: filter by conversation_id and file_path
  const files = await getFilesTable();
  await files.createIndex('conversation_id', {
    config: lancedb.Index.btree(),
    replace: true,
  });
  await files.createIndex('file_path', {
    config: lancedb.Index.btree(),
    replace: true,
  });

  // Message files: filter by conversation_id and file_path
  const messageFiles = await getMessageFilesTable();
  await messageFiles.createIndex('conversation_id', {
    config: lancedb.Index.btree(),
    replace: true,
  });
  await messageFiles.createIndex('file_path', {
    config: lancedb.Index.btree(),
    replace: true,
  });

  // File edits: filter by conversation_id and file_path
  const fileEdits = await getFileEditsTable();
  await fileEdits.createIndex('conversation_id', {
    config: lancedb.Index.btree(),
    replace: true,
  });
  await fileEdits.createIndex('file_path', {
    config: lancedb.Index.btree(),
    replace: true,
  });
}

/**
 * Compact the messages table to materialize deletions.
 * This must be called after force sync (which deletes many rows) before
 * mergeInsert operations can work on the table.
 */
export async function compactMessagesTable(): Promise<void> {
  const table = await getMessagesTable();
  await table.optimize();
}

/**
 * Clean up old versions from all tables to reclaim disk space.
 * LanceDB is append-only and keeps historical versions. After many mergeInsert
 * operations (like during embedding), this can cause massive storage bloat.
 *
 * IMPORTANT: We keep versions for 5 minutes to allow in-flight queries to complete.
 * Deleting versions immediately (cleanupOlderThan: new Date()) causes race conditions
 * where queries started before cleanup try to read deleted files → "Not found" errors.
 */
export async function cleanupOldVersions(): Promise<{ bytesRemoved: number; versionsRemoved: number }> {
  if (!db) {
    await connect();
  }

  let totalBytesRemoved = 0;
  let totalVersionsRemoved = 0;

  const tables = [
    messagesTable,
    conversationsTable,
    toolCallsTable,
    filesTable,
    messageFilesTable,
    fileEditsTable,
  ];

  // Keep versions for 5 minutes to allow in-flight queries to complete
  // This prevents race conditions where a query references files that get deleted
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);

  for (const table of tables) {
    if (table) {
      try {
        const stats = await table.optimize({
          cleanupOlderThan: fiveMinutesAgo, // Keep recent versions for in-flight queries
          deleteUnverified: false,          // Don't force delete - be conservative
        });
        if (stats.prune) {
          totalBytesRemoved += stats.prune.bytesRemoved;
          totalVersionsRemoved += stats.prune.oldVersionsRemoved;
        }
      } catch {
        // Ignore errors for individual tables
      }
    }
  }

  return { bytesRemoved: totalBytesRemoved, versionsRemoved: totalVersionsRemoved };
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
      is_compact_summary: false,
    },
  ]);
  await messagesTable.delete("id = '_placeholder_'");
}

/**
 * Recover from database corruption by dropping and recreating corrupted tables.
 * If tableName is provided, only that table is dropped. Otherwise, all tables are dropped.
 */
async function recoverFromCorruption(tableName: string | null): Promise<void> {
  if (!db) return;

  const allTables = ['conversations', 'messages', 'tool_calls', 'sync_state', 'conversation_files', 'message_files', 'file_edits'];
  const tablesToDrop = tableName ? [tableName] : allTables;

  const existingTables = await db.tableNames();

  for (const table of tablesToDrop) {
    if (existingTables.includes(table)) {
      try {
        console.error(`[db] Dropping corrupted table "${table}"...`);
        await db.dropTable(table);
      } catch (dropError) {
        // If drop fails, try to force remove the table directory
        console.error(`[db] Standard drop failed for "${table}", attempting force cleanup...`);
        const tablePath = join(getLanceDBPath(), `${table}.lance`);
        try {
          const { rmSync } = await import('fs');
          rmSync(tablePath, { recursive: true, force: true });
          console.error(`[db] Force removed "${table}" directory`);
        } catch {
          console.error(`[db] Could not remove "${table}" - manual cleanup may be needed`);
        }
      }
    }
  }

  // Clear cached table references
  conversationsTable = null;
  messagesTable = null;
  toolCallsTable = null;
  syncStateTable = null;
  filesTable = null;
  messageFilesTable = null;
  fileEditsTable = null;
}
