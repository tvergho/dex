#!/usr/bin/env bun
import { Command } from 'commander';
import { syncCommand } from './cli/commands/sync';
import { searchCommand } from './cli/commands/search';
import { listCommand } from './cli/commands/list';
import { showCommand } from './cli/commands/show';
import { statusCommand } from './cli/commands/status';

const program = new Command()
  .name('dex')
  .description('Universal search for your coding agent conversations')
  .version('0.1.0');

program
  .command('sync')
  .description('Index conversations from all sources')
  .option('-f, --force', 'Force re-index all conversations')
  .action(syncCommand);

program
  .command('search <query...>')
  .description('Full-text search across conversations')
  .option('-l, --limit <number>', 'Maximum number of results', '20')
  .action((queryParts: string[], options) => searchCommand(queryParts.join(' '), options));

program
  .command('list')
  .description('Browse recent conversations')
  .option('-l, --limit <number>', 'Maximum number of conversations', '20')
  .option('-s, --source <source>', 'Filter by source (cursor, claude-code, codex)')
  .action(listCommand);

program
  .command('show <id>')
  .description('View a conversation')
  .action(showCommand);

program
  .command('status')
  .description('Check embedding generation progress')
  .action(statusCommand);

program.parse();
