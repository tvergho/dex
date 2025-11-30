import { readFileSync } from 'fs';

// Raw types matching the JSONL structure

interface CodexMessageContent {
  type: 'input_text' | 'output_text';
  text?: string;
}

interface CodexMessage {
  type: 'message';
  role: 'user' | 'assistant';
  content: CodexMessageContent[];
}

interface CodexFunctionCall {
  type: 'function_call';
  name: string;
  arguments: string;
  call_id: string;
}

interface CodexCustomToolCall {
  type: 'custom_tool_call';
  name: string;
  input: string;
  call_id: string;
  status?: string;
}

interface CodexFunctionCallOutput {
  type: 'function_call_output';
  call_id: string;
  output: string;
}

interface CodexSessionMeta {
  type: 'session_meta';
  id: string;
  timestamp?: string;
  cwd?: string;
  originator?: string;
  cli_version?: string;
  instructions?: string;
  source?: string;
  model_provider?: string;
  git?: {
    commit_hash?: string;
    branch?: string;
  };
}

interface CodexTokenCount {
  type: 'token_count';
  info?: {
    total_token_usage?: {
      input_tokens?: number;
      cached_input_tokens?: number;
      output_tokens?: number;
      reasoning_output_tokens?: number;
    };
    last_token_usage?: {
      input_tokens?: number;
      cached_input_tokens?: number;
      output_tokens?: number;
    };
  };
}

type CodexPayload =
  | CodexSessionMeta
  | CodexMessage
  | CodexFunctionCall
  | CodexCustomToolCall
  | CodexFunctionCallOutput
  | CodexTokenCount
  | { type: string }; // Catch-all for other types

interface CodexEntry {
  timestamp: string;
  type: 'session_meta' | 'response_item' | 'event_msg' | 'turn_context';
  payload: CodexPayload;
}

// Parsed/normalized types
export interface RawMessage {
  index: number;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string | undefined;
  toolCalls: RawToolCall[];
  files: RawFile[];
  fileEdits: RawFileEdit[];
  totalLinesAdded?: number;
  totalLinesRemoved?: number;
}

export interface RawToolCall {
  id: string;
  name: string;
  input: string;
  output?: string;
  filePath?: string;
}

export interface RawFile {
  path: string;
  role: 'context' | 'edited' | 'mentioned';
}

export interface RawFileEdit {
  filePath: string;
  editType: 'create' | 'modify' | 'delete';
  linesAdded: number;
  linesRemoved: number;
}

export interface RawConversation {
  sessionId: string;
  title: string;
  workspacePath?: string;
  cwd?: string;
  gitBranch?: string;
  model?: string;
  createdAt?: string;
  updatedAt?: string;
  messages: RawMessage[];
  files: RawFile[];
  fileEdits: RawFileEdit[];
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalCacheReadTokens?: number;
  totalLinesAdded?: number;
  totalLinesRemoved?: number;
}

/**
 * Parse a single JSONL file and return entries.
 */
function parseJsonlFile(filePath: string): CodexEntry[] {
  const entries: CodexEntry[] = [];

  try {
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as CodexEntry;
        entries.push(entry);
      } catch {
        // Skip malformed JSON lines
      }
    }
  } catch {
    // Skip files we can't read
  }

  return entries;
}

/**
 * Extract text content from a message's content array.
 */
function extractTextContent(content: CodexMessageContent[]): string {
  return content
    .filter((c) => (c.type === 'input_text' || c.type === 'output_text') && c.text)
    .map((c) => c.text!)
    .join('\n');
}

/**
 * Check if content contains system/environment context that should be filtered.
 */
function isSystemContent(text: string): boolean {
  // Filter out environment context and instruction blocks
  return (
    text.includes('<environment_context>') ||
    text.includes('<INSTRUCTIONS>') ||
    text.includes('# AGENTS.md instructions') ||
    text.includes('# CLAUDE.md')
  );
}

/**
 * Extract file path from tool call arguments.
 */
function extractFilePath(toolName: string, argsJson: string): string | undefined {
  try {
    const args = JSON.parse(argsJson);
    // Common field names for file paths
    return args.filePath || args.path || args.file || args.target;
  } catch {
    return undefined;
  }
}

/**
 * Determine file role based on tool name.
 */
function getFileRole(toolName: string): RawFile['role'] {
  const readTools = ['read_file', 'list_directory', 'glob', 'grep', 'search'];
  const writeTools = ['write_file', 'apply_diff', 'apply_patch', 'create_file', 'edit_file'];

  const lowerName = toolName.toLowerCase();

  if (readTools.some((t) => lowerName.includes(t))) {
    return 'context';
  }
  if (writeTools.some((t) => lowerName.includes(t))) {
    return 'edited';
  }
  return 'mentioned';
}

/**
 * Count lines in a string, handling edge cases.
 */
function countLines(str: string): number {
  if (!str) return 0;
  return str.split('\n').length;
}

/**
 * Parse apply_patch unified diff format to extract file edits.
 * Format:
 * *** Begin Patch
 * *** Add File: path/to/new-file.ts
 * +line 1
 * +line 2
 * *** End Patch
 * *** Begin Patch
 * *** Update File: path/to/existing.ts
 * @@
 * -old line
 * +new line
 * @@
 * *** End Patch
 */
function parseApplyPatch(patchInput: string): RawFileEdit[] {
  const edits: RawFileEdit[] = [];
  const lines = patchInput.split('\n');
  let currentFile: RawFileEdit | null = null;

  for (const line of lines) {
    if (line.startsWith('*** Add File:')) {
      currentFile = {
        filePath: line.replace('*** Add File:', '').trim(),
        editType: 'create',
        linesAdded: 0,
        linesRemoved: 0,
      };
      edits.push(currentFile);
    } else if (line.startsWith('*** Update File:')) {
      currentFile = {
        filePath: line.replace('*** Update File:', '').trim(),
        editType: 'modify',
        linesAdded: 0,
        linesRemoved: 0,
      };
      edits.push(currentFile);
    } else if (line.startsWith('*** Delete File:')) {
      currentFile = {
        filePath: line.replace('*** Delete File:', '').trim(),
        editType: 'delete',
        linesAdded: 0,
        linesRemoved: 0,
      };
      edits.push(currentFile);
    } else if (currentFile) {
      // Count line additions and removals
      if (line.startsWith('+') && !line.startsWith('+++')) {
        currentFile.linesAdded++;
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        currentFile.linesRemoved++;
      }
    }
  }

  return edits;
}

/**
 * Extract file edits from tool calls (apply_patch and write_file).
 */
function extractFileEditsFromToolCalls(toolCalls: RawToolCall[]): RawFileEdit[] {
  const edits: RawFileEdit[] = [];

  for (const tc of toolCalls) {
    const lowerName = tc.name.toLowerCase();

    if (lowerName === 'apply_patch') {
      // The input is the patch content directly
      const patchEdits = parseApplyPatch(tc.input);
      edits.push(...patchEdits);
    } else if (lowerName === 'write_file' || lowerName === 'create_file') {
      try {
        const args = JSON.parse(tc.input);
        const filePath = args.path || args.filePath || args.file;
        const content = args.content || '';

        if (filePath) {
          edits.push({
            filePath,
            editType: 'create',
            linesAdded: countLines(content),
            linesRemoved: 0,
          });
        }
      } catch {
        // Skip malformed input
      }
    }
  }

  return edits;
}

/**
 * Extract conversation from a Codex session JSONL file.
 */
export function extractConversation(sessionId: string, filePath: string): RawConversation | null {
  const entries = parseJsonlFile(filePath);

  if (entries.length === 0) {
    return null;
  }

  // Extract session metadata
  const sessionMetaEntry = entries.find(
    (e) => e.type === 'session_meta' && (e.payload as CodexSessionMeta).type === 'session_meta'
  );
  const sessionMeta = sessionMetaEntry?.payload as CodexSessionMeta | undefined;

  // Extract model from turn_context if available
  let model: string | undefined;
  const turnContextEntry = entries.find((e) => e.type === 'turn_context');
  if (turnContextEntry) {
    const payload = turnContextEntry.payload as { model?: string };
    model = payload.model;
  }

  // Build a map of call_id -> output for function call results
  const toolOutputs = new Map<string, string>();
  for (const entry of entries) {
    if (entry.type === 'response_item') {
      const payload = entry.payload as CodexFunctionCallOutput;
      if (payload.type === 'function_call_output' && payload.call_id) {
        toolOutputs.set(payload.call_id, payload.output || '');
      }
    }
  }

  // Extract messages and tool calls
  const messages: RawMessage[] = [];
  const allFiles: RawFile[] = [];
  const allEdits: RawFileEdit[] = [];
  const seenPaths = new Set<string>();
  let messageIndex = 0;
  let createdAt: string | undefined;
  let updatedAt: string | undefined;
  let title = 'Untitled';

  // Track current message's tool calls and edits
  let currentToolCalls: RawToolCall[] = [];
  let currentFiles: RawFile[] = [];
  let currentEdits: RawFileEdit[] = [];

  for (const entry of entries) {
    // Track timestamps
    if (entry.timestamp) {
      if (!createdAt || entry.timestamp < createdAt) {
        createdAt = entry.timestamp;
      }
      if (!updatedAt || entry.timestamp > updatedAt) {
        updatedAt = entry.timestamp;
      }
    }

    if (entry.type === 'response_item') {
      const payload = entry.payload;

      if (payload.type === 'message') {
        const msg = payload as CodexMessage;
        const content = extractTextContent(msg.content);

        // Skip empty or system content
        if (!content.trim() || isSystemContent(content)) {
          continue;
        }

        // Use first user message as title
        if (msg.role === 'user' && title === 'Untitled') {
          title = content.slice(0, 100).split('\n')[0] || 'Untitled';
        }

        // If this is an assistant message, attach any pending tool calls and edits
        const toolCalls = msg.role === 'assistant' ? currentToolCalls : [];
        const files = msg.role === 'assistant' ? currentFiles : [];
        const fileEdits = msg.role === 'assistant' ? currentEdits : [];

        // Calculate per-message line totals
        const totalLinesAdded = fileEdits.reduce((sum, e) => sum + e.linesAdded, 0);
        const totalLinesRemoved = fileEdits.reduce((sum, e) => sum + e.linesRemoved, 0);

        messages.push({
          index: messageIndex++,
          role: msg.role,
          content,
          timestamp: entry.timestamp,
          toolCalls,
          files,
          fileEdits,
          totalLinesAdded: totalLinesAdded > 0 ? totalLinesAdded : undefined,
          totalLinesRemoved: totalLinesRemoved > 0 ? totalLinesRemoved : undefined,
        });

        // Add edits to conversation-level list
        allEdits.push(...fileEdits);

        // Reset tool call and edit tracking after attaching to assistant message
        if (msg.role === 'assistant') {
          currentToolCalls = [];
          currentFiles = [];
          currentEdits = [];
        }
      } else if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
        // Handle both function_call (older) and custom_tool_call (newer) formats
        const isCustom = payload.type === 'custom_tool_call';
        const fc = payload as CodexFunctionCall | CodexCustomToolCall;
        const output = toolOutputs.get(fc.call_id);
        // custom_tool_call uses 'input', function_call uses 'arguments'
        const inputStr = isCustom ? (fc as CodexCustomToolCall).input : (fc as CodexFunctionCall).arguments;
        const filePath = extractFilePath(fc.name, inputStr);

        const toolCall: RawToolCall = {
          id: fc.call_id,
          name: fc.name,
          input: inputStr,
          output,
          filePath,
        };
        currentToolCalls.push(toolCall);

        // Extract file edits from this tool call
        const editsFromCall = extractFileEditsFromToolCalls([toolCall]);
        currentEdits.push(...editsFromCall);

        // Track files
        if (filePath && !seenPaths.has(filePath)) {
          seenPaths.add(filePath);
          const file: RawFile = { path: filePath, role: getFileRole(fc.name) };
          currentFiles.push(file);
          allFiles.push(file);
        }
      }
    }
  }

  // Extract token usage from token_count events
  // For input: use PEAK of last_token_usage (each API call's context, find max)
  // For output: use cumulative total_token_usage (each output is new content)
  let peakInputTokens = 0;
  let peakCacheReadTokens = 0;
  let totalOutputTokens: number | undefined;

  const tokenCountEntries = entries.filter(
    (e) => e.type === 'event_msg' && (e.payload as CodexTokenCount).type === 'token_count'
  );

  for (const entry of tokenCountEntries) {
    const tokenPayload = entry.payload as CodexTokenCount;
    const lastUsage = tokenPayload?.info?.last_token_usage;

    if (lastUsage) {
      // Track peak input context
      const inputTokens = lastUsage.input_tokens ?? 0;
      const cacheTokens = lastUsage.cached_input_tokens ?? 0;
      const totalContext = inputTokens + cacheTokens;

      if (totalContext > peakInputTokens + peakCacheReadTokens) {
        peakInputTokens = inputTokens;
        peakCacheReadTokens = cacheTokens;
      }
    }
  }

  // Get cumulative output from last event
  if (tokenCountEntries.length > 0) {
    const lastTokenEntry = tokenCountEntries[tokenCountEntries.length - 1];
    const tokenPayload = lastTokenEntry?.payload as CodexTokenCount;
    const totalUsage = tokenPayload?.info?.total_token_usage;

    if (totalUsage) {
      totalOutputTokens = totalUsage.output_tokens;
    }
  }

  const totalInputTokens = peakInputTokens > 0 ? peakInputTokens : undefined;
  const totalCacheReadTokens = peakCacheReadTokens > 0 ? peakCacheReadTokens : undefined;

  if (messages.length === 0) {
    return null;
  }

  // Calculate total line changes
  const totalLinesAdded = allEdits.reduce((sum, e) => sum + e.linesAdded, 0);
  const totalLinesRemoved = allEdits.reduce((sum, e) => sum + e.linesRemoved, 0);

  return {
    sessionId,
    title,
    workspacePath: sessionMeta?.cwd,
    cwd: sessionMeta?.cwd,
    gitBranch: sessionMeta?.git?.branch,
    model,
    createdAt,
    updatedAt,
    messages,
    files: allFiles,
    fileEdits: allEdits,
    totalInputTokens,
    totalOutputTokens,
    totalCacheReadTokens,
    totalLinesAdded: totalLinesAdded > 0 ? totalLinesAdded : undefined,
    totalLinesRemoved: totalLinesRemoved > 0 ? totalLinesRemoved : undefined,
  };
}
