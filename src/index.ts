#!/usr/bin/env node
import { Command } from 'commander';
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

const program = new Command()
  .name('dex')
  .description('Universal search for your coding agent conversations')
  .version('0.1.3');

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
  .action((queryParts: string[], options) => searchCommand(queryParts.join(' '), options));

program
  .command('list')
  .description('Browse recent conversations')
  .option('-l, --limit <number>', 'Maximum number of conversations', '20')
  .option('-s, --source <source>', 'Filter by source (cursor, claude-code, codex, opencode)')
  .action(listCommand);

program
  .command('show <id>')
  .description('View a conversation')
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

// Internal command for background embedding (hidden from help)
program
  .command('embed', { hidden: true })
  .option('--benchmark', 'Run benchmark to find optimal settings')
  .action(embedCommand);

// Default action when no subcommand is provided
program.action(async () => {
  await unifiedCommand();
});

program.parse();
