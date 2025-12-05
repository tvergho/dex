/**
 * Chat command - launches OpenCode TUI attached to a dex-managed server
 *
 * Starts an OpenCode server with Claude Code credentials injected,
 * then attaches the OpenCode TUI to it. This provides a unified
 * authentication experience through dex.
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import {
  startServer,
  apiRequest,
  type OpenCodeServerState,
} from '../../providers/claude-code/client.js';
import { getClaudeCodeCredentials } from '../../providers/claude-code/credentials.js';
import { getOpencodeBinPath } from '../../utils/paths.js';

// OpenCode config locations
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

export async function chatCommand(): Promise<void> {
  // Check for Claude Code credentials
  const creds = getClaudeCodeCredentials();
  if (!creds) {
    console.error('No Claude Code credentials found.');
    console.error('Please authenticate with Claude Code first:');
    console.error('  claude login');
    process.exit(1);
  }

  // Ensure dex agent is available
  ensureDexAgent();

  console.log('Starting dex chat server...');

  // Start OpenCode server
  let serverState: OpenCodeServerState;
  try {
    serverState = await startServer();
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }

  // Inject Claude Code credentials
  try {
    await apiRequest(serverState.url, '/auth/anthropic', 'PUT', {
      type: 'oauth',
      access: creds.accessToken,
      refresh: creds.refreshToken,
      expires: creds.expiresAt,
    });
  } catch (error) {
    serverState.process.kill();
    console.error('Failed to inject credentials:', error);
    process.exit(1);
  }

  console.log(`Server ready at ${serverState.url}`);
  console.log('Attaching TUI...\n');

  // Build attach command arguments
  // Note: attach only supports --dir, --print-logs, --log-level
  // Agent selection happens through the dex.md file we created
  const opencodePath = getOpencodeBinPath();
  const args = ['attach', serverState.url];

  // Spawn OpenCode TUI attached to our server
  const child = spawn(opencodePath, args, {
    stdio: 'inherit',
    env: process.env,
  });

  // Handle exit - clean up server
  child.on('close', (code) => {
    serverState.process.kill();
    process.exit(code ?? 0);
  });

  child.on('error', (err) => {
    serverState.process.kill();
    console.error('Failed to attach TUI:', err);
    process.exit(1);
  });

  // Handle signals to clean up server
  const cleanup = () => {
    serverState.process.kill();
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}
