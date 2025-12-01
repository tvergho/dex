#!/usr/bin/env bun
/**
 * Background embedding worker - runs embeddings in background after sync
 * Can be spawned with: bun run src/cli/commands/embed.ts
 *
 * Uses llama-server for fast batch embedding with fallback to node-llama-cpp
 */

import { connect, rebuildVectorIndex, rebuildFtsIndex, getMessagesTable } from '../../db/index';
import {
  downloadModel,
  initEmbeddings,
  embed,
  disposeEmbeddings,
  getModelPath,
  setEmbeddingProgress,
  getEmbeddingProgress,
  isEmbeddingInProgress,
  EMBEDDING_DIMENSIONS,
} from '../../embeddings/index';
import {
  isLlamaServerInstalled,
  downloadLlamaServer,
  startLlamaServer,
  stopLlamaServer,
  embedBatchViaServer,
} from '../../embeddings/llama-server';
import { existsSync } from 'fs';

// Small batch sizes to minimize CPU heat
const SERVER_BATCH_SIZE = 8;     // Small batches
const FALLBACK_BATCH_SIZE = 4;   // Tiny batches for fallback

// Long pause between batches - lets CPU cool down
const BATCH_DELAY_MS = 1000;     // 1 second pause between batches
// Instruction prefix for query embeddings
const INSTRUCTION_PREFIX = 'Instruct: Retrieve relevant code conversations\nQuery: ';
// Max characters per text (8192 tokens ~ 32K chars, but be conservative)
const MAX_TEXT_CHARS = 8000;

// Database row structure (snake_case column names)
interface MessageRow {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  timestamp: string;
  message_index: number;
  vector: number[] | Float32Array;
}

async function getAllMessagesNeedingEmbedding(): Promise<MessageRow[]> {
  const table = await getMessagesTable();
  const allMessages = await table.query().toArray();

  // Filter messages that have zero vectors (not yet embedded)
  return allMessages.filter((row) => {
    const vector = row.vector;
    if (!vector) return true;
    // Convert to array if it's a Float32Array
    const arr = Array.isArray(vector) ? vector : Array.from(vector as Float32Array);
    // Check if vector is all zeros (placeholder)
    return arr.every((v) => v === 0);
  }) as MessageRow[];
}

function truncateText(text: string): string {
  if (text.length <= MAX_TEXT_CHARS) {
    return text;
  }
  return text.slice(0, MAX_TEXT_CHARS) + '...';
}

/**
 * Strip interleaved tool output blocks from content before embedding.
 * Tool outputs are formatted as:
 *   ---
 *   **ToolName** `filename`
 *   ```
 *   ... code ...
 *   ```
 *   ---
 * We want to embed only the conversational text, not the code.
 */
function stripToolOutputs(text: string): string {
  // Match tool output blocks: ---\n**ToolName**...\n```...```\n---
  // Use a regex to match these blocks and remove them
  const toolBlockPattern = /\n---\n\*\*[^*]+\*\*[^\n]*\n```[\s\S]*?```\n---\n?/g;
  return text.replace(toolBlockPattern, '\n').trim();
}

function prepareTexts(texts: string[]): string[] {
  return texts.map((text) => {
    // Strip tool outputs before embedding to avoid embedding code
    const stripped = stripToolOutputs(text);
    return INSTRUCTION_PREFIX + truncateText(stripped);
  });
}

async function runWithServer(
  messages: MessageRow[],
  table: Awaited<ReturnType<typeof getMessagesTable>>
): Promise<boolean> {
  const modelPath = getModelPath();

  try {
    // Download llama-server if needed
    if (!isLlamaServerInstalled()) {
      console.log('Downloading llama-server...');
      await downloadLlamaServer((downloaded, total) => {
        const pct = Math.round((downloaded / total) * 100);
        process.stdout.write(`\rDownloading llama-server: ${pct}%`);
      });
      console.log('\nllama-server downloaded.');
    }

    // Start server with default low-priority thread count
    console.log('Starting llama-server...');
    const port = await startLlamaServer(modelPath);
    console.log(`llama-server started on port ${port}`);

    // Process in batches
    for (let i = 0; i < messages.length; i += SERVER_BATCH_SIZE) {
      const batch = messages.slice(i, i + SERVER_BATCH_SIZE);
      const texts = prepareTexts(batch.map((m) => m.content));

      const vectors = await embedBatchViaServer(texts, port);

      // Validate vector dimensions
      const validVectors = vectors.filter((v) => v && v.length === EMBEDDING_DIMENSIONS);
      if (validVectors.length !== vectors.length) {
        console.warn(`Warning: ${vectors.length - validVectors.length} invalid vectors in batch`);
      }

      // Build full rows with updated vectors for batch mergeInsert
      const updatedRows = batch
        .map((msg, j) => {
          const vec = vectors[j];
          if (!vec || vec.length !== EMBEDDING_DIMENSIONS) return null;
          return {
            id: msg.id,
            conversation_id: msg.conversation_id,
            role: msg.role,
            content: msg.content,
            timestamp: msg.timestamp,
            message_index: msg.message_index,
            vector: vec,
          };
        })
        .filter((row): row is NonNullable<typeof row> => row !== null);

      // Use mergeInsert for batch update
      if (updatedRows.length > 0) {
        let retries = 3;
        while (retries > 0) {
          try {
            await table.mergeInsert('id').whenMatchedUpdateAll().execute(updatedRows);
            break;
          } catch (err) {
            retries--;
            if (retries === 0) throw err;
            await new Promise((r) => setTimeout(r, 200));
          }
        }
      }

      // Update progress
      setEmbeddingProgress({
        status: 'embedding',
        total: messages.length,
        completed: Math.min(i + SERVER_BATCH_SIZE, messages.length),
        startedAt: getEmbeddingProgress().startedAt,
      });

      // Brief pause between batches
      if (i + SERVER_BATCH_SIZE < messages.length) {
        await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
      }
    }

    await stopLlamaServer();
    return true;
  } catch (error) {
    console.error('Server embedding failed:', error);
    await stopLlamaServer();
    return false;
  }
}

async function runWithNodeLlamaCpp(
  messages: MessageRow[],
  table: Awaited<ReturnType<typeof getMessagesTable>>
): Promise<void> {
  console.log('Using node-llama-cpp fallback...');

  // Use low priority mode
  await initEmbeddings(true);

  // Process in batches
  for (let i = 0; i < messages.length; i += FALLBACK_BATCH_SIZE) {
    const batch = messages.slice(i, i + FALLBACK_BATCH_SIZE);
    // Strip tool outputs before embedding to avoid embedding code
    const texts = batch.map((m) => stripToolOutputs(m.content));
    const vectors = await embed(texts);

    // Build full rows with updated vectors for batch mergeInsert
    const updatedRows = batch
      .map((msg, j) => {
        const vec = vectors[j];
        return {
          id: msg.id,
          conversation_id: msg.conversation_id,
          role: msg.role,
          content: msg.content,
          timestamp: msg.timestamp,
          message_index: msg.message_index,
          vector: vec ? Array.from(vec) : Array.from(msg.vector),
        };
      })
      .filter((row) => row.vector && row.vector.length > 0);

    // Use mergeInsert for batch update
    if (updatedRows.length > 0) {
      let retries = 3;
      while (retries > 0) {
        try {
          await table.mergeInsert('id').whenMatchedUpdateAll().execute(updatedRows);
          break;
        } catch (err) {
          retries--;
          if (retries === 0) throw err;
          await new Promise((r) => setTimeout(r, 200));
        }
      }
    }

    // Update progress
    setEmbeddingProgress({
      status: 'embedding',
      total: messages.length,
      completed: Math.min(i + FALLBACK_BATCH_SIZE, messages.length),
      startedAt: getEmbeddingProgress().startedAt,
    });

    // Same pause as server path to keep CPU cool
    if (i + FALLBACK_BATCH_SIZE < messages.length) {
      await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
    }
  }

  await disposeEmbeddings();
}

async function runBackgroundEmbedding(): Promise<void> {
  // Check if already in progress (prevent duplicate runs)
  if (isEmbeddingInProgress()) {
    console.log('Embedding already in progress, exiting');
    return;
  }

  try {
    await connect();

    // Get messages that need embedding
    const messages = await getAllMessagesNeedingEmbedding();

    if (messages.length === 0) {
      setEmbeddingProgress({
        status: 'done',
        total: 0,
        completed: 0,
        completedAt: new Date().toISOString(),
      });
      return;
    }

    console.log(`Found ${messages.length} messages to embed`);

    // Update progress: starting
    setEmbeddingProgress({
      status: 'downloading',
      total: messages.length,
      completed: 0,
      startedAt: new Date().toISOString(),
    });

    // Download model if needed
    const modelPath = getModelPath();
    if (!existsSync(modelPath)) {
      console.log('Downloading embedding model...');
      await downloadModel((downloaded, total) => {
        const pct = Math.round((downloaded / total) * 100);
        process.stdout.write(`\rDownloading model: ${pct}%`);
      });
      console.log('\nModel downloaded.');
    }

    // Update progress: embedding
    setEmbeddingProgress({
      status: 'embedding',
      total: messages.length,
      completed: 0,
      startedAt: getEmbeddingProgress().startedAt,
    });

    const table = await getMessagesTable();

    // Try server-based embedding first (faster)
    const serverSuccess = await runWithServer(messages, table);

    // Fall back to node-llama-cpp if server fails
    if (!serverSuccess) {
      await runWithNodeLlamaCpp(messages, table);
    }

    // Rebuild both FTS and vector indexes after all updates
    console.log('Rebuilding indexes...');
    await rebuildFtsIndex();
    await rebuildVectorIndex();

    // Mark as done
    setEmbeddingProgress({
      status: 'done',
      total: messages.length,
      completed: messages.length,
      startedAt: getEmbeddingProgress().startedAt,
      completedAt: new Date().toISOString(),
    });

    console.log('Embedding complete!');
  } catch (error) {
    console.error('Embedding failed:', error);
    setEmbeddingProgress({
      status: 'error',
      total: getEmbeddingProgress().total,
      completed: getEmbeddingProgress().completed,
      error: error instanceof Error ? error.message : String(error),
    });
    await disposeEmbeddings();
    await stopLlamaServer();
    process.exit(1);
  }
}

// Run if called directly
runBackgroundEmbedding()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error('Embedding failed:', err);
    process.exit(1);
  });
