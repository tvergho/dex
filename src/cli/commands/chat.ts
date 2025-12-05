/**
 * Chat command - launches OpenCode with dex MCP tools available
 *
 * Ensures the dex MCP server is configured in OpenCode's config,
 * then spawns OpenCode TUI for an interactive chat session.
 */

import { spawn, execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';

interface OpenCodeConfig {
  $schema?: string;
  mcp?: Record<string, McpServerConfig>;
  [key: string]: unknown;
}

interface McpServerConfig {
  type: 'local' | 'remote';
  command?: string[];
  url?: string;
  environment?: Record<string, string>;
  headers?: Record<string, string>;
  enabled?: boolean;
  timeout?: number;
}

// OpenCode config locations
// Note: OpenCode ignores XDG_DATA_HOME for session storage, so we can't fully isolate
// dex chat sessions. They'll appear alongside regular OpenCode sessions.
const OPENCODE_CONFIG = path.join(homedir(), '.config', 'opencode', 'opencode.json');
const OPENCODE_AGENT_DIR = path.join(homedir(), '.config', 'opencode', 'agent');

const DEX_AGENT_PROMPT = `You are a coding assistant with access to the user's historical coding conversations via dex tools.

## Available Tools

You have access to these dex MCP tools for retrieving context from past conversations:

- **dex_stats**: Get overview statistics (total conversations, sources, projects, date range)
- **dex_list**: Browse conversations by filters (project, source, date range)
- **dex_search**: Search conversation content with semantic + full-text hybrid search
- **dex_get**: Retrieve full conversation content in various formats

## When to Use dex Tools

Use these tools proactively when:
- The user asks about previous work ("how did I implement X before?", "what was that bug fix?")
- You need context about the codebase from past conversations
- The user references something they discussed with another AI assistant
- You want to find relevant examples or patterns from past sessions

## Best Practices

1. Start with dex_search to find relevant conversations
2. Use dex_get to retrieve content (tool outputs stripped by default)
3. Use dex_get with format="outline" for quick overviews of long conversations
4. Use dex_get with format="full" only if you need actual tool output content
5. Filter by project path when working in a specific codebase
`;

const DEX_AGENT_MD = `---
description: Coding assistant with access to your past AI conversations via dex
mode: primary
---

${DEX_AGENT_PROMPT}
`;

function ensureDexAgent(): void {
  // Create agent directory if needed
  if (!fs.existsSync(OPENCODE_AGENT_DIR)) {
    fs.mkdirSync(OPENCODE_AGENT_DIR, { recursive: true });
  }

  // Write/update the dex agent file
  const agentPath = path.join(OPENCODE_AGENT_DIR, 'dex.md');
  fs.writeFileSync(agentPath, DEX_AGENT_MD);
}

function getDexCommand(): string[] {
  // Check if dex is in PATH
  try {
    const which = execSync('which dex', { encoding: 'utf-8' }).trim();
    if (which) {
      return [which, 'serve'];
    }
  } catch {
    // Not in PATH
  }

  // Check common global install locations
  const globalLocations = [
    path.join(homedir(), '.bun', 'bin', 'dex'),
    path.join(homedir(), '.npm-global', 'bin', 'dex'),
    '/usr/local/bin/dex',
  ];

  for (const location of globalLocations) {
    if (fs.existsSync(location)) {
      return [location, 'serve'];
    }
  }

  // Fallback to just 'dex' and let the shell find it
  return ['dex', 'serve'];
}

function ensureDexMcpConfig(): boolean {
  const configDir = path.dirname(OPENCODE_CONFIG);

  // Ensure config directory exists
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  let config: OpenCodeConfig = {};

  // Read existing config if it exists
  if (fs.existsSync(OPENCODE_CONFIG)) {
    try {
      const content = fs.readFileSync(OPENCODE_CONFIG, 'utf-8');
      config = JSON.parse(content) as OpenCodeConfig;
    } catch {
      // Start fresh if config is invalid
      config = {};
    }
  }

  // Check if dex is already configured
  if (config.mcp?.dex) {
    return true;
  }

  // Add dex MCP configuration
  const dexCommand = getDexCommand();

  if (!config.mcp) {
    config.mcp = {};
  }

  config.mcp.dex = {
    type: 'local',
    command: dexCommand,
    enabled: true,
    timeout: 10000,
  };

  // Write updated config
  try {
    fs.writeFileSync(OPENCODE_CONFIG, JSON.stringify(config, null, 2));
    console.log('Added dex MCP server to OpenCode config');
    return true;
  } catch (err) {
    console.error('Failed to write OpenCode config:', err);
    return false;
  }
}

function findOpenCode(): string | null {
  // Check if opencode is in PATH
  try {
    const which = execSync('which opencode', { encoding: 'utf-8' }).trim();
    if (which) {
      return which;
    }
  } catch {
    // Not in PATH
  }

  // Check common locations
  const candidates = [
    path.join(homedir(), '.opencode', 'bin', 'opencode'),
    path.join(homedir(), '.local', 'share', 'opencode', 'bin', 'opencode'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

export interface ChatOptions {
  model?: string;
  continue?: boolean;
  session?: string;
}

export async function chatCommand(options: ChatOptions = {}): Promise<void> {
  // Ensure OpenCode is installed
  const opencodePath = findOpenCode();
  if (!opencodePath) {
    console.error('OpenCode not found. Please install it first:');
    console.error('  curl -fsSL https://opencode.ai/install.sh | bash');
    process.exit(1);
  }

  // Ensure dex MCP is configured
  if (!ensureDexMcpConfig()) {
    console.error('Failed to configure dex MCP server');
    process.exit(1);
  }

  // Ensure dex agent is available for custom system prompt
  ensureDexAgent();

  // Build OpenCode command arguments
  const args: string[] = [];

  if (options.model) {
    args.push('--model', options.model);
  }

  if (options.continue) {
    args.push('--continue');
  }

  if (options.session) {
    args.push('--session', options.session);
  }

  // Add current directory as project path
  args.push(process.cwd());

  // Use the dex agent for custom system prompt about dex tools
  args.push('--agent', 'dex');

  console.log('Starting OpenCode with dex tools...');
  console.log('Available tools: dex_stats, dex_list, dex_search, dex_get\n');

  // Spawn OpenCode TUI
  const child = spawn(opencodePath, args, {
    stdio: 'inherit',
    env: process.env,
  });

  // Handle exit
  child.on('close', (code) => {
    process.exit(code ?? 0);
  });

  child.on('error', (err) => {
    console.error('Failed to start OpenCode:', err);
    process.exit(1);
  });
}
