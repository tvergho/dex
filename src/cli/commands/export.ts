/**
 * Export command - exports conversations as readable markdown files
 *
 * Usage: dex export [options]
 *
 * Options:
 *   -o, --output <dir>     Output directory (default: ./dex-export)
 *   -p, --project <path>   Filter by project/workspace path
 *   -s, --source <source>  Filter by source (cursor, claude-code, codex, opencode)
 *   --from <date>          Start date (ISO 8601 or YYYY-MM-DD)
 *   --to <date>            End date (ISO 8601 or YYYY-MM-DD)
 *   --id <id>              Export a single conversation by ID
 */

import { mkdir, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { connect } from '../../db/index';
import { conversationRepo, messageRepo, filesRepo, toolCallRepo, fileEditsRepo } from '../../db/repository';
import {
  generateFilename,
  getProjectName,
  conversationToMarkdown,
  isValidDate,
} from '../../utils/export';
import { ALL_SOURCES } from '../../schema/index';


interface ExportOptions {
  output?: string;
  project?: string;
  source?: string;
  from?: string;
  to?: string;
  id?: string;
}

export async function exportCommand(options: ExportOptions): Promise<void> {
  // Validate date options if provided
  if (options.from && !isValidDate(options.from)) {
    console.error(`Invalid --from date: ${options.from}`);
    console.error('Use ISO 8601 format (e.g., 2024-01-15) or YYYY-MM-DD');
    process.exit(1);
  }
  if (options.to && !isValidDate(options.to)) {
    console.error(`Invalid --to date: ${options.to}`);
    console.error('Use ISO 8601 format (e.g., 2024-01-15) or YYYY-MM-DD');
    process.exit(1);
  }

  // Validate source option if provided
  if (options.source && !ALL_SOURCES.includes(options.source as any)) {
    console.error(`Invalid --source: ${options.source}`);
    console.error(`Valid sources: ${ALL_SOURCES.join(', ')}`);
    process.exit(1);
  }

  await connect();

  // Fetch conversations based on filters
  console.log('Finding conversations...');

  const conversations = await conversationRepo.findByFilters({
    source: options.source,
    workspacePath: options.project,
    fromDate: options.from,
    toDate: options.to,
    ids: options.id ? [options.id] : undefined,
  });

  if (conversations.length === 0) {
    console.log('No conversations found matching the specified filters.');
    return;
  }

  console.log(`Found ${conversations.length} conversation(s) to export.`);

  // Determine output directory
  const outputDir = options.output || './dex-export';

  // Create output directory structure
  await mkdir(outputDir, { recursive: true });

  let exported = 0;
  let errors = 0;

  for (const conv of conversations) {
    try {
      // Create subdirectory structure: source/project/
      const sourceName = conv.source;
      const projectName = getProjectName(conv.workspacePath) || 'unknown-project';

      const subDir = join(outputDir, sourceName, projectName);
      await mkdir(subDir, { recursive: true });

      // Generate filename and ensure uniqueness
      let filename = generateFilename(conv);
      let filePath = join(subDir, filename);

      // Handle filename collisions by appending conversation ID suffix
      if (existsSync(filePath)) {
        const baseName = filename.replace('.md', '');
        filename = `${baseName}-${conv.id.slice(0, 8)}.md`;
        filePath = join(subDir, filename);
      }

      // Fetch messages, files, tool calls, and file edits for this conversation
      const messages = await messageRepo.findByConversation(conv.id);
      const files = await filesRepo.findByConversation(conv.id);
      const toolCalls = await toolCallRepo.findByConversation(conv.id);
      const fileEdits = await fileEditsRepo.findByConversation(conv.id);

      // Generate markdown content
      const markdown = conversationToMarkdown(conv, messages, files, toolCalls, fileEdits);

      // Write file
      await writeFile(filePath, markdown, 'utf-8');

      exported++;

      // Progress indicator
      if (exported % 10 === 0 || exported === conversations.length) {
        console.log(`Exported ${exported}/${conversations.length} conversations...`);
      }
    } catch (err) {
      errors++;
      console.error(`Error exporting conversation ${conv.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Summary
  console.log('');
  console.log(`Export complete!`);
  console.log(`  Exported: ${exported} conversation(s)`);
  if (errors > 0) {
    console.log(`  Errors: ${errors}`);
  }
  console.log(`  Output: ${outputDir}`);

  // Show directory structure hint
  if (exported > 0) {
    console.log('');
    console.log('Directory structure:');
    console.log(`  ${outputDir}/`);
    console.log('    <source>/');
    console.log('      <project>/');
    console.log('        YYYY-MM-DD_conversation-title.md');
  }
}
