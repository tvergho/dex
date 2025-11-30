/**
 * Export action utilities for TUI integration
 * Reuses existing export utilities and provides high-level functions
 */

import { mkdir, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { connect } from '../db/index';
import { messageRepo, filesRepo } from '../db/repository';
import type { Conversation } from '../schema/index';
import { conversationToMarkdown, generateFilename, getProjectName } from './export';
import { copyToClipboard } from './clipboard';

/**
 * Export conversations to markdown files in ./dex-export/{source}/{project}/
 * Returns the output directory path
 */
export async function exportConversationsToFile(
  conversations: Conversation[]
): Promise<string> {
  await connect();

  const outputDir = './dex-export';

  // Track filenames used to handle collisions
  const usedFilenames = new Map<string, number>();
  let exported = 0;

  for (const conv of conversations) {
    // Build output path: outputDir/source/project/
    const projectName = getProjectName(conv.workspacePath) || 'unknown';
    const sourceDir = join(outputDir, conv.source, projectName);

    // Create directory if needed
    if (!existsSync(sourceDir)) {
      await mkdir(sourceDir, { recursive: true });
    }

    // Generate filename, handling collisions
    let filename = generateFilename(conv);
    const key = join(sourceDir, filename);
    const count = usedFilenames.get(key) ?? 0;
    if (count > 0) {
      // Add conversation ID suffix to avoid collision
      const base = filename.replace(/\.md$/, '');
      filename = `${base}-${conv.id.slice(0, 8)}.md`;
    }
    usedFilenames.set(key, count + 1);

    // Fetch messages and files
    const messages = await messageRepo.findByConversation(conv.id);
    const files = await filesRepo.findByConversation(conv.id);

    // Generate markdown content
    const content = conversationToMarkdown(conv, messages, files);

    // Write file
    const filePath = join(sourceDir, filename);
    await writeFile(filePath, content, 'utf-8');
    exported++;
  }

  return outputDir;
}

/**
 * Export conversations to clipboard as markdown
 * Multiple conversations are separated by horizontal rules
 */
export async function exportConversationsToClipboard(
  conversations: Conversation[]
): Promise<void> {
  await connect();

  const markdownParts: string[] = [];

  for (const conv of conversations) {
    const messages = await messageRepo.findByConversation(conv.id);
    const files = await filesRepo.findByConversation(conv.id);
    const content = conversationToMarkdown(conv, messages, files);
    markdownParts.push(content);
  }

  const fullContent = markdownParts.join('\n\n---\n\n');
  await copyToClipboard(fullContent);
}

/**
 * Generate markdown preview content for a single conversation
 */
export async function generatePreviewContent(
  conversation: Conversation
): Promise<string> {
  await connect();

  const messages = await messageRepo.findByConversation(conversation.id);
  const files = await filesRepo.findByConversation(conversation.id);

  return conversationToMarkdown(conversation, messages, files);
}
