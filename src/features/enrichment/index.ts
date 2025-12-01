/**
 * Title Enrichment Feature
 *
 * Generates titles for untitled conversations using the Claude Code provider.
 */

import { createClaudeCodeClient } from '../../providers/index.js';
import { loadConfig } from '../../config/index.js';
import { conversationRepo, messageRepo } from '../../db/repository.js';

export interface EnrichmentResult {
  enriched: number;
  failed: number;
  skipped: number;
}

/**
 * Generate a title for a conversation based on its messages
 */
function buildTitlePrompt(messages: { role: string; content: string }[]): string {
  // Take first few messages to understand the conversation
  const preview = messages
    .slice(0, 5)
    .map((m) => `${m.role}: ${m.content.slice(0, 300)}`)
    .join('\n\n');

  return `Based on this conversation excerpt, generate a brief, descriptive title (max 60 chars). Return ONLY the title, no quotes or explanation.

${preview}`;
}

/**
 * Extract title from model response
 */
function extractTitle(response: string): string {
  // Clean up the response - remove quotes, trim, take first line
  let title = response.trim();

  // Remove surrounding quotes
  if ((title.startsWith('"') && title.endsWith('"')) ||
      (title.startsWith("'") && title.endsWith("'"))) {
    title = title.slice(1, -1);
  }

  // Take first line only
  title = title.split('\n')[0]?.trim() || title;

  // Truncate if too long
  if (title.length > 60) {
    title = title.slice(0, 57) + '...';
  }

  return title || 'Untitled';
}

/**
 * Enrich untitled conversations with AI-generated titles
 *
 * @param onProgress - Progress callback (current, total)
 * @returns Enrichment result with counts
 */
export async function enrichUntitledConversations(
  onProgress?: (current: number, total: number) => void
): Promise<EnrichmentResult> {
  const config = loadConfig();

  // Check if Claude Code is connected and auto-enrich is enabled
  if (!config.providers.claudeCode.enabled) {
    return { enriched: 0, failed: 0, skipped: 0 };
  }

  // Get untitled conversations
  const untitled = await conversationRepo.findUntitled(100);

  if (untitled.length === 0) {
    return { enriched: 0, failed: 0, skipped: 0 };
  }

  // Create client
  const client = await createClaudeCodeClient();
  if (!client) {
    return { enriched: 0, failed: untitled.length, skipped: 0 };
  }

  const result: EnrichmentResult = {
    enriched: 0,
    failed: 0,
    skipped: 0,
  };

  try {
    for (let i = 0; i < untitled.length; i++) {
      const conv = untitled[i]!;

      onProgress?.(i + 1, untitled.length);

      // Get messages for this conversation
      const messages = await messageRepo.findByConversation(conv.id);

      if (messages.length === 0) {
        result.skipped++;
        continue;
      }

      try {
        // Generate title
        const prompt = buildTitlePrompt(messages);
        const response = await client.prompt(prompt, {
          system: 'You are a helpful assistant that generates brief, descriptive titles for conversations. Return only the title, nothing else.',
        });

        const title = extractTitle(response);

        // Update the conversation title
        await conversationRepo.updateTitle(conv.id, title);
        result.enriched++;
      } catch (error) {
        console.error(`Failed to generate title for ${conv.id}:`, error);
        result.failed++;
      }
    }
  } finally {
    await client.close();
  }

  return result;
}

/**
 * Count how many untitled conversations exist
 */
export async function countUntitledConversations(): Promise<number> {
  return conversationRepo.countUntitled();
}

/**
 * Enrich a specific list of conversations (for manual trigger from config UI)
 */
export async function enrichConversations(
  conversationIds: string[],
  onProgress?: (current: number, total: number) => void
): Promise<EnrichmentResult> {
  if (conversationIds.length === 0) {
    return { enriched: 0, failed: 0, skipped: 0 };
  }

  // Create client
  const client = await createClaudeCodeClient();
  if (!client) {
    return { enriched: 0, failed: conversationIds.length, skipped: 0 };
  }

  const result: EnrichmentResult = {
    enriched: 0,
    failed: 0,
    skipped: 0,
  };

  try {
    for (let i = 0; i < conversationIds.length; i++) {
      const convId = conversationIds[i]!;

      onProgress?.(i + 1, conversationIds.length);

      // Get messages for this conversation
      const messages = await messageRepo.findByConversation(convId);

      if (messages.length === 0) {
        result.skipped++;
        continue;
      }

      try {
        // Generate title
        const prompt = buildTitlePrompt(messages);
        const response = await client.prompt(prompt, {
          system: 'You are a helpful assistant that generates brief, descriptive titles for conversations. Return only the title, nothing else.',
        });

        const title = extractTitle(response);

        // Update the conversation title
        await conversationRepo.updateTitle(convId, title);
        result.enriched++;
      } catch (error) {
        console.error(`Failed to generate title for ${convId}:`, error);
        result.failed++;
      }
    }
  } finally {
    await client.close();
  }

  return result;
}

