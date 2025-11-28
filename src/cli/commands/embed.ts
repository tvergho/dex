#!/usr/bin/env bun
/**
 * Background embedding worker - runs embeddings in background after sync
 * Can be spawned with: bun run src/cli/commands/embed.ts
 */

import { connect, rebuildVectorIndex, rebuildFtsIndex, getMessagesTable } from '../../db/index.js';
import {
  downloadModel,
  initEmbeddings,
  embed,
  disposeEmbeddings,
  getModelPath,
  setEmbeddingProgress,
  getEmbeddingProgress,
  isEmbeddingInProgress,
} from '../../embeddings/index.js';
import { existsSync } from 'fs';

const BATCH_SIZE = 100; // Increased from 32 as requested

interface MessageRow {
  id: string;
  conversationId: string;
  role: string;
  content: string;
  timestamp: string;
  messageIndex: number;
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
      await downloadModel((downloaded, total) => {
        // Update progress during download
        const progress = getEmbeddingProgress();
        setEmbeddingProgress({
          ...progress,
          status: 'downloading',
        });
      });
    }

    // Initialize embeddings
    setEmbeddingProgress({
      status: 'embedding',
      total: messages.length,
      completed: 0,
      startedAt: getEmbeddingProgress().startedAt,
    });

    await initEmbeddings();

    const table = await getMessagesTable();

    // Process in batches
    for (let i = 0; i < messages.length; i += BATCH_SIZE) {
      const batch = messages.slice(i, i + BATCH_SIZE);
      const texts = batch.map((m) => m.content);
      const vectors = await embed(texts);

      // Build full rows with updated vectors for batch mergeInsert
      const updatedRows = batch.map((msg, j) => {
        const vec = vectors[j];
        return {
          id: msg.id,
          conversationId: msg.conversationId,
          role: msg.role,
          content: msg.content,
          timestamp: msg.timestamp,
          messageIndex: msg.messageIndex,
          vector: vec ? Array.from(vec) : Array.from(msg.vector),
        };
      }).filter((row) => row.vector && row.vector.length > 0);

      // Use mergeInsert for batch update - much more efficient than individual updates
      // This also handles concurrent reads better
      if (updatedRows.length > 0) {
        let retries = 3;
        while (retries > 0) {
          try {
            await table.mergeInsert('id')
              .whenMatchedUpdateAll()
              .execute(updatedRows);
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
        completed: Math.min(i + BATCH_SIZE, messages.length),
        startedAt: getEmbeddingProgress().startedAt,
      });
    }

    // Rebuild both FTS and vector indexes after all updates
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

    await disposeEmbeddings();
  } catch (error) {
    setEmbeddingProgress({
      status: 'error',
      total: getEmbeddingProgress().total,
      completed: getEmbeddingProgress().completed,
      error: error instanceof Error ? error.message : String(error),
    });
    await disposeEmbeddings();
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
