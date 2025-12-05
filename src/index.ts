#!/usr/bin/env node
import { Command } from 'commander';
import { createRequire } from 'module';
import { syncCommand } from './cli/commands/sync';
import { searchCommand } from './cli/commands/search';
import { listCommand } from './cli/commands/list';
import { showCommand } from './cli/commands/show';
import { statusCommand } from './cli/commands/status';
import { statsCommand } from './cli/commands/stats';
import { exportCommand } from './cli/commands/export';
import { backupCommand } from './cli/commands/backup';
import { importCommand } from './cli/commands/import';
import { unifiedCommand } from './cli/commands/unified';
import { configCommand } from './cli/commands/config';
import { embedCommand } from './cli/commands/embed';
import { chatCommand } from './cli/commands/chat';

const require = createRequire(import.meta.url);
const packageJson = require('../package.json') as { version: string };

const program = new Command()
  .name('dex')
  .description('Universal search for your coding agent conversations')
  .version(packageJson.version);

program
  .command('sync')
  .description('Index conversations from all sources')
  .option('-f, --force', 'Force re-index all conversations')
  .action(syncCommand);

program
  .command('search [query...]')
  .description('Full-text search across conversations')
  .option('-l, --limit <number>', 'Maximum number of results', '20')
  .option('-f, --file <pattern>', 'Filter by file path (e.g., auth.ts, src/components)')
  .option('-s, --source <source>', 'Filter by source (cursor, claude-code, codex, opencode)')
  .option('-m, --model <model>', 'Filter by model (opus, sonnet, gpt-4, etc.)')
  .option('-p, --project <path>', 'Filter by project/workspace path (substring match)')
  .option('--from <date>', 'Start date (YYYY-MM-DD)')
  .option('--to <date>', 'End date (YYYY-MM-DD)')
  .option('--offset <number>', 'Skip first N results (for pagination)')
  .option('-j, --json', 'Output as JSON (for MCP/agent use)')
  .action((queryParts: string[], options) => searchCommand(queryParts.join(' '), options));

program
  .command('list')
  .description('Browse recent conversations')
  .option('-l, --limit <number>', 'Maximum number of conversations', '20')
  .option('-s, --source <source>', 'Filter by source (cursor, claude-code, codex, opencode)')
  .option('-p, --project <path>', 'Filter by project/workspace path (substring match)')
  .option('--from <date>', 'Start date (YYYY-MM-DD)')
  .option('--to <date>', 'End date (YYYY-MM-DD)')
  .option('--offset <number>', 'Skip first N results (for pagination)')
  .option('-j, --json', 'Output as JSON (for MCP/agent use)')
  .action(listCommand);

program
  .command('show <id...>')
  .description('View a conversation')
  .option('-j, --json', 'Output as JSON (for MCP/agent use)')
  .option('--format <format>', 'Content format: full, stripped, user_only, outline', 'full')
  .option('--expand <index>', 'Expand around message index (use with --before/--after)')
  .option('--before <n>', 'Messages before expand point', '2')
  .option('--after <n>', 'Messages after expand point', '2')
  .option('--max-tokens <n>', 'Truncate if total tokens exceed this limit')
  .action(showCommand);

program
  .command('status')
  .description('Check embedding generation progress')
  .action(statusCommand);

program
  .command('stats')
  .description('View usage analytics and statistics')
  .option('-p, --period <days>', 'Time period in days', '30')
  .option('-s, --summary', 'Print quick summary (non-interactive)')
  .option('-j, --json', 'Output as JSON (for MCP/agent use)')
  .action(statsCommand);

program
  .command('export')
  .description('Export conversations as markdown files')
  .option('-o, --output <dir>', 'Output directory', './agentdex-export')
  .option('-p, --project <path>', 'Filter by project/workspace path')
  .option('-s, --source <source>', 'Filter by source (cursor, claude-code, codex, opencode)')
  .option('--from <date>', 'Start date (YYYY-MM-DD)')
  .option('--to <date>', 'End date (YYYY-MM-DD)')
  .option('--id <id>', 'Export a single conversation by ID')
  .action(exportCommand);

program
  .command('backup')
  .description('Export full database for backup/migration')
  .option('-o, --output <file>', 'Output file (default: dex-backup-TIMESTAMP.json)')
  .option('-p, --project <path>', 'Filter by project/workspace path')
  .option('-s, --source <source>', 'Filter by source (cursor, claude-code, codex, opencode)')
  .option('--from <date>', 'Start date (YYYY-MM-DD)')
  .option('--to <date>', 'End date (YYYY-MM-DD)')
  .action(backupCommand);

program
  .command('import <file>')
  .description('Import conversations from a backup archive')
  .option('--dry-run', 'Preview what would be imported without writing')
  .option('--force', 'Overwrite existing conversations')
  .action(importCommand);

program
  .command('config')
  .description('Open settings')
  .action(configCommand);

program
  .command('chat')
  .description('Start an AI chat session with dex tools (requires OpenCode)')
  .option('-m, --model <model>', 'Model to use (e.g., anthropic/claude-sonnet)')
  .option('-c, --continue', 'Continue the last session')
  .option('-s, --session <id>', 'Continue a specific session')
  .action(chatCommand);

// MCP server command
program
  .command('serve')
  .description('Start MCP server for agent integration (stdio transport)')
  .action(async () => {
    const { startMcpServer } = await import('./mcp/server');
    await startMcpServer();
  });

// Internal command for background embedding (hidden from help)
program
  .command('embed', { hidden: true })
  .option('--benchmark', 'Run benchmark to find optimal settings')
  .action(embedCommand);

// Internal command for getting counts (used by unified.tsx background checks)
program
  .command('count', { hidden: true })
  .option('--messages', 'Count messages')
  .option('--conversations', 'Count conversations')
  .action(async (options: { messages?: boolean; conversations?: boolean }) => {
    const { connect } = await import('./db/index');
    const { conversationRepo, messageRepo } = await import('./db/repository');
    await connect();
    if (options.messages) {
      const count = await messageRepo.count();
      console.log(count);
    } else {
      // Default to conversation count
      const count = await conversationRepo.count();
      console.log(count);
    }
    process.exit(0);
  });

// Default action when no subcommand is provided
program.action(async () => {
  await unifiedCommand();
});

program.parse();
