/**
 * Title Enrichment Feature
 *
 * Generates titles for untitled conversations using connected AI providers.
 * Supports Claude Code and Codex (ChatGPT), with Claude Code taking priority.
 * Uses parallel processing for faster bulk generation.
 */

import {
  createClaudeCodeClient,
  createCodexClient,
  type ClaudeCodeClient,
  type CodexClient,
} from '../../providers/index.js';
import { loadConfig } from '../../config/index.js';
import { conversationRepo, messageRepo } from '../../db/repository.js';

// Common interface for AI clients that can generate titles
type PromptClient = ClaudeCodeClient | CodexClient;

export interface EnrichmentResult {
  enriched: number;
  failed: number;
  skipped: number;
}

export interface EnrichmentProgress {
  completed: number;
  total: number;
  inFlight: number;
  recentTitles: Array<{ id: string; title: string }>;
}

export interface EnrichmentCallbacks {
  onProgress?: (progress: EnrichmentProgress) => void;
  onTitleGenerated?: (convId: string, title: string) => void;
  onError?: (convId: string, error: Error) => void;
}

const CONCURRENCY = 4; // Number of parallel requests

export type ProviderId = 'claudeCode' | 'codex';

/**
 * Create a client for a specific provider
 */
async function createClientForProvider(
  providerId: ProviderId
): Promise<{ client: PromptClient; provider: string } | null> {
  if (providerId === 'claudeCode') {
    const client = await createClaudeCodeClient();
    if (client) {
      return { client, provider: 'Claude Code' };
    }
  } else if (providerId === 'codex') {
    const client = await createCodexClient();
    if (client) {
      return { client, provider: 'Codex' };
    }
  }
  return null;
}

/**
 * Create an enrichment client using the highest-priority available provider
 *
 * Priority: Claude Code > Codex (ChatGPT)
 *
 * @returns Client and provider name, or null if none available
 */
async function createEnrichmentClient(): Promise<{ client: PromptClient; provider: string } | null> {
  const config = loadConfig();

  // Priority 1: Claude Code (if connected)
  if (config.providers.claudeCode.enabled) {
    const result = await createClientForProvider('claudeCode');
    if (result) return result;
  }

  // Priority 2: Codex/ChatGPT (if connected)
  if (config.providers.codex.enabled) {
    const result = await createClientForProvider('codex');
    if (result) return result;
  }

  return null;
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
 * Process a single conversation - get messages and generate title
 */
async function processConversation(
  client: PromptClient,
  convId: string
): Promise<{ title: string } | { error: Error } | { skipped: true }> {
  // Get messages for this conversation
  const messages = await messageRepo.findByConversation(convId);

  if (messages.length === 0) {
    return { skipped: true };
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
    return { title };
  } catch (error) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }
}

/**
 * Enrich untitled conversations with AI-generated titles (parallel processing)
 *
 * Uses the highest-priority available provider (Claude Code > Codex).
 *
 * @param callbacks - Progress and completion callbacks
 * @returns Enrichment result with counts and provider used
 */
export async function enrichUntitledConversations(
  callbacks?: EnrichmentCallbacks | ((current: number, total: number) => void)
): Promise<EnrichmentResult & { provider?: string }> {
  const config = loadConfig();

  // Check if any provider is connected
  const hasProvider = config.providers.claudeCode.enabled || config.providers.codex.enabled;
  if (!hasProvider) {
    return { enriched: 0, failed: 0, skipped: 0 };
  }

  // Get untitled conversations
  const untitled = await conversationRepo.findUntitled(100);

  if (untitled.length === 0) {
    return { enriched: 0, failed: 0, skipped: 0 };
  }

  // Normalize callbacks
  const cb: EnrichmentCallbacks = typeof callbacks === 'function'
    ? { onProgress: (p) => callbacks(p.completed, p.total) }
    : callbacks ?? {};

  // Create client using priority-based selection
  const clientInfo = await createEnrichmentClient();
  if (!clientInfo) {
    return { enriched: 0, failed: untitled.length, skipped: 0 };
  }

  const { client, provider } = clientInfo;

  const result: EnrichmentResult = {
    enriched: 0,
    failed: 0,
    skipped: 0,
  };

  const recentTitles: Array<{ id: string; title: string }> = [];
  let inFlight = 0;

  const reportProgress = () => {
    cb.onProgress?.({
      completed: result.enriched + result.failed + result.skipped,
      total: untitled.length,
      inFlight,
      recentTitles: recentTitles.slice(-6), // Keep last 6
    });
  };

  try {
    // Process in parallel batches
    const queue = [...untitled];
    const processing: Promise<void>[] = [];

    const processNext = async (): Promise<void> => {
      const conv = queue.shift();
      if (!conv) return;

      inFlight++;
      reportProgress();

      const outcome = await processConversation(client, conv.id);

      inFlight--;

      if ('skipped' in outcome) {
        result.skipped++;
      } else if ('error' in outcome) {
        result.failed++;
        cb.onError?.(conv.id, outcome.error);
      } else {
        result.enriched++;
        recentTitles.push({ id: conv.id, title: outcome.title });
        cb.onTitleGenerated?.(conv.id, outcome.title);
      }

      reportProgress();

      // Process next item if queue not empty
      if (queue.length > 0) {
        await processNext();
      }
    };

    // Start initial batch of concurrent workers
    for (let i = 0; i < Math.min(CONCURRENCY, untitled.length); i++) {
      processing.push(processNext());
    }

    // Wait for all to complete
    await Promise.all(processing);
  } finally {
    await client.close();
  }

  return { ...result, provider };
}

/**
 * Count how many untitled conversations exist
 */
export async function countUntitledConversations(): Promise<number> {
  return conversationRepo.countUntitled();
}

/**
 * Enrich a specific list of conversations (for manual trigger from config UI)
 *
 * Uses the highest-priority available provider (Claude Code > Codex).
 */
export async function enrichConversations(
  conversationIds: string[],
  callbacks?: EnrichmentCallbacks | ((current: number, total: number) => void)
): Promise<EnrichmentResult & { provider?: string }> {
  if (conversationIds.length === 0) {
    return { enriched: 0, failed: 0, skipped: 0 };
  }

  // Normalize callbacks
  const cb: EnrichmentCallbacks = typeof callbacks === 'function'
    ? { onProgress: (p) => callbacks(p.completed, p.total) }
    : callbacks ?? {};

  // Create client using priority-based selection
  const clientInfo = await createEnrichmentClient();
  if (!clientInfo) {
    return { enriched: 0, failed: conversationIds.length, skipped: 0 };
  }

  const { client, provider } = clientInfo;

  const result: EnrichmentResult = {
    enriched: 0,
    failed: 0,
    skipped: 0,
  };

  const recentTitles: Array<{ id: string; title: string }> = [];
  let inFlight = 0;

  const reportProgress = () => {
    cb.onProgress?.({
      completed: result.enriched + result.failed + result.skipped,
      total: conversationIds.length,
      inFlight,
      recentTitles: recentTitles.slice(-6),
    });
  };

  try {
    // Process in parallel batches
    const queue = [...conversationIds];
    const processing: Promise<void>[] = [];

    const processNext = async (): Promise<void> => {
      const convId = queue.shift();
      if (!convId) return;

      inFlight++;
      reportProgress();

      const outcome = await processConversation(client, convId);

      inFlight--;

      if ('skipped' in outcome) {
        result.skipped++;
      } else if ('error' in outcome) {
        result.failed++;
        cb.onError?.(convId, outcome.error);
      } else {
        result.enriched++;
        recentTitles.push({ id: convId, title: outcome.title });
        cb.onTitleGenerated?.(convId, outcome.title);
      }

      reportProgress();

      // Process next item if queue not empty
      if (queue.length > 0) {
        await processNext();
      }
    };

    // Start initial batch of concurrent workers
    for (let i = 0; i < Math.min(CONCURRENCY, conversationIds.length); i++) {
      processing.push(processNext());
    }

    // Wait for all to complete
    await Promise.all(processing);
  } finally {
    await client.close();
  }

  return { ...result, provider };
}

/**
 * Get which provider will be used for enrichment (for UI display)
 */
export function getActiveEnrichmentProvider(): string | null {
  const config = loadConfig();

  if (config.providers.claudeCode.enabled) {
    return 'Claude Code';
  }

  if (config.providers.codex.enabled) {
    return 'Codex';
  }

  return null;
}

/**
 * Enrich untitled conversations using a specific provider
 *
 * @param providerId - Which provider to use ('claudeCode' or 'codex')
 * @param callbacks - Progress and completion callbacks
 * @returns Enrichment result with counts and provider used
 */
export async function enrichWithProvider(
  providerId: ProviderId,
  callbacks?: EnrichmentCallbacks | ((current: number, total: number) => void)
): Promise<EnrichmentResult & { provider?: string }> {
  // Get untitled conversations
  const untitled = await conversationRepo.findUntitled(100);

  if (untitled.length === 0) {
    return { enriched: 0, failed: 0, skipped: 0 };
  }

  // Normalize callbacks
  const cb: EnrichmentCallbacks = typeof callbacks === 'function'
    ? { onProgress: (p) => callbacks(p.completed, p.total) }
    : callbacks ?? {};

  // Create client for the specific provider
  const clientInfo = await createClientForProvider(providerId);
  if (!clientInfo) {
    return { enriched: 0, failed: untitled.length, skipped: 0 };
  }

  const { client, provider } = clientInfo;

  const result: EnrichmentResult = {
    enriched: 0,
    failed: 0,
    skipped: 0,
  };

  const recentTitles: Array<{ id: string; title: string }> = [];
  let inFlight = 0;

  const reportProgress = () => {
    cb.onProgress?.({
      completed: result.enriched + result.failed + result.skipped,
      total: untitled.length,
      inFlight,
      recentTitles: recentTitles.slice(-6),
    });
  };

  try {
    // Process in parallel batches
    const queue = [...untitled];
    const processing: Promise<void>[] = [];

    const processNext = async (): Promise<void> => {
      const conv = queue.shift();
      if (!conv) return;

      inFlight++;
      reportProgress();

      const outcome = await processConversation(client, conv.id);

      inFlight--;

      if ('skipped' in outcome) {
        result.skipped++;
      } else if ('error' in outcome) {
        result.failed++;
        cb.onError?.(conv.id, outcome.error);
      } else {
        result.enriched++;
        recentTitles.push({ id: conv.id, title: outcome.title });
        cb.onTitleGenerated?.(conv.id, outcome.title);
      }

      reportProgress();

      // Process next item if queue not empty
      if (queue.length > 0) {
        await processNext();
      }
    };

    // Start initial batch of concurrent workers
    for (let i = 0; i < Math.min(CONCURRENCY, untitled.length); i++) {
      processing.push(processNext());
    }

    // Wait for all to complete
    await Promise.all(processing);
  } finally {
    await client.close();
  }

  return { ...result, provider };
}
