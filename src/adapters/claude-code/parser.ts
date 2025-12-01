import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import type { ClaudeCodeProject } from './paths.js';

// Raw types matching the JSONL structure
interface ClaudeMessageContent {
  type: 'text' | 'tool_use' | 'tool_result';
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string;
}

interface ClaudeMessageUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface ClaudeMessage {
  role: 'user' | 'assistant';
  content: string | ClaudeMessageContent[];
  model?: string;
  usage?: ClaudeMessageUsage;
}

interface ToolUseResult {
  type?: string; // 'text', 'create', etc.
  filePath?: string;
  content?: string;
  stdout?: string;
  stderr?: string;
  file?: {
    filePath?: string;
    content?: string;
  };
  // Edit tool result fields
  oldString?: string;
  newString?: string;
  originalFile?: string;
  // Grep tool result fields
  mode?: string;
  numFiles?: number;
  filenames?: string[];
  numLines?: number;
}

interface ClaudeEntry {
  type?: 'user' | 'assistant' | 'summary' | 'file-history-snapshot';
  sessionId?: string;
  uuid?: string;
  parentUuid?: string | null;
  timestamp?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  isSidechain?: boolean;
  agentId?: string;
  message?: ClaudeMessage;
  summary?: string;
  toolUseResult?: ToolUseResult;
}

// Parsed/normalized types
export interface RawMessage {
  uuid: string;
  parentUuid: string | null;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string | undefined;
  toolCalls: RawToolCall[];
  files: RawFile[];
  fileEdits: RawFileEdit[];
  isSidechain: boolean;
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
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
  newContent?: string; // The new code content (for Edit: new_string, for Write: content)
}

export interface RawConversation {
  sessionId: string;
  title: string;
  workspacePath: string;
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
  totalCacheCreationTokens?: number;
  totalCacheReadTokens?: number;
  totalLinesAdded?: number;
  totalLinesRemoved?: number;
}

/**
 * Parse a single JSONL file and return entries.
 */
function parseJsonlFile(filePath: string): ClaudeEntry[] {
  const entries: ClaudeEntry[] = [];

  try {
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as ClaudeEntry;
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
 * Extract text content from a message's content array or string.
 * For assistant messages with tool_use blocks, interleaves tool outputs at their correct positions.
 */
function extractTextContent(
  content: string | ClaudeMessageContent[],
  toolResults?: Map<string, ToolUseResult>,
  isAssistant?: boolean
): string {
  if (typeof content === 'string') {
    return content;
  }

  // For non-assistant messages or if no tool results, just extract text
  if (!isAssistant || !toolResults) {
    return content
      .filter((c) => c.type === 'text' && c.text)
      .map((c) => c.text!)
      .join('\n');
  }

  // For assistant messages, interleave tool outputs at their positions
  const parts: string[] = [];
  
  for (const c of content) {
    if (c.type === 'text' && c.text) {
      parts.push(c.text);
    } else if (c.type === 'tool_use' && c.id && c.name) {
      const result = toolResults.get(c.id);
      if (result) {
        // Build output string
        const output = result.stdout || 
                       result.file?.content || 
                       result.newString ||
                       result.content;
        
        if (output) {
          const filePath = result.filePath || result.file?.filePath;
          const fileName = filePath ? filePath.split('/').pop() : '';
          
          // Format as inline tool output block
          parts.push('');
          parts.push(`---`);
          parts.push(`**${c.name}**${fileName ? ` \`${fileName}\`` : ''}`);
          parts.push('```');
          parts.push(output);
          parts.push('```');
          parts.push('---');
          parts.push('');
        }
      }
    }
  }

  return parts.join('\n');
}

/**
 * Extract tool calls from a message's content array.
 */
function extractToolCalls(
  content: string | ClaudeMessageContent[],
  toolResults: Map<string, ToolUseResult>
): RawToolCall[] {
  if (typeof content === 'string') {
    return [];
  }

  const toolCalls: RawToolCall[] = [];

  for (const c of content) {
    if (c.type === 'tool_use' && c.id && c.name) {
      const result = toolResults.get(c.id);
      // Build output from various result types:
      // - Bash: stdout
      // - Read: file.content
      // - Edit: newString (the new content that was written)
      // - Grep: content (the search results)
      // - Write: content or file.content
      let output: string | undefined;
      if (result) {
        output = result.stdout || 
                 result.file?.content || 
                 result.newString ||
                 result.content;
      }
      toolCalls.push({
        id: c.id,
        name: c.name,
        input: typeof c.input === 'string' ? c.input : JSON.stringify(c.input),
        output,
        filePath: result?.filePath || result?.file?.filePath,
      });
    }
  }

  return toolCalls;
}

/**
 * Extract file references from tool calls and results.
 */
function extractFilesFromToolCalls(toolCalls: RawToolCall[]): RawFile[] {
  const files: RawFile[] = [];
  const seenPaths = new Set<string>();

  for (const tc of toolCalls) {
    if (tc.filePath && !seenPaths.has(tc.filePath)) {
      seenPaths.add(tc.filePath);
      // Determine role based on tool name
      const role: RawFile['role'] =
        tc.name === 'Read' || tc.name === 'Glob' || tc.name === 'Grep'
          ? 'context'
          : tc.name === 'Write' || tc.name === 'Edit'
            ? 'edited'
            : 'mentioned';
      files.push({ path: tc.filePath, role });
    }
  }

  return files;
}

/**
 * Count lines in a string, handling edge cases.
 */
function countLines(str: string): number {
  if (!str) return 0;
  // A string with no newlines is still 1 line
  return str.split('\n').length;
}

/**
 * Extract file edits from tool calls (Edit and Write tools).
 */
function extractFileEditsFromToolCalls(toolCalls: RawToolCall[]): RawFileEdit[] {
  const edits: RawFileEdit[] = [];

  for (const tc of toolCalls) {
    if (tc.name === 'Edit') {
      try {
        const input = typeof tc.input === 'string' ? JSON.parse(tc.input) : tc.input;
        const filePath = input?.file_path;
        const oldString = input?.old_string ?? '';
        const newString = input?.new_string ?? '';

        if (filePath) {
          edits.push({
            filePath,
            editType: 'modify',
            linesRemoved: countLines(oldString),
            linesAdded: countLines(newString),
            // Note: newContent not stored here - tool outputs are interleaved in message content
          });
        }
      } catch {
        // Skip malformed Edit tool input
      }
    } else if (tc.name === 'Write') {
      try {
        const input = typeof tc.input === 'string' ? JSON.parse(tc.input) : tc.input;
        const filePath = input?.file_path;
        const content = input?.content ?? '';

        if (filePath) {
          edits.push({
            filePath,
            editType: 'create',
            linesRemoved: 0,
            linesAdded: countLines(content),
            // Note: newContent not stored here - tool outputs are interleaved in message content
          });
        }
      } catch {
        // Skip malformed Write tool input
      }
    }
  }

  return edits;
}

/**
 * Extract all conversations from a project's sessions directory.
 */
export function extractConversations(project: ClaudeCodeProject): RawConversation[] {
  const { sessionsDir, workspacePath } = project;
  const conversations: RawConversation[] = [];

  // Find all main session files (exclude agent-* sidecars)
  const sessionFiles = readdirSync(sessionsDir).filter(
    (f) => f.endsWith('.jsonl') && !f.startsWith('agent-')
  );

  for (const sessionFile of sessionFiles) {
    const sessionId = sessionFile.replace('.jsonl', '');
    const mainFilePath = join(sessionsDir, sessionFile);

    // Parse main session file
    const entries = parseJsonlFile(mainFilePath);

    // Also parse any agent sidecar files for this session
    const agentFiles = readdirSync(sessionsDir).filter(
      (f) => f.startsWith('agent-') && f.endsWith('.jsonl')
    );

    for (const agentFile of agentFiles) {
      const agentEntries = parseJsonlFile(join(sessionsDir, agentFile));
      // Only include entries from the same session
      for (const entry of agentEntries) {
        if (entry.sessionId === sessionId) {
          entries.push(entry);
        }
      }
    }

    if (entries.length === 0) continue;

    // Build a map of tool_use_id -> toolUseResult for output matching
    const toolResults = new Map<string, ToolUseResult>();
    for (const entry of entries) {
      if (entry.type === 'user' && entry.message?.content) {
        const content = entry.message.content;
        if (Array.isArray(content)) {
          for (const c of content) {
            if (c.type === 'tool_result' && c.tool_use_id && entry.toolUseResult) {
              toolResults.set(c.tool_use_id, entry.toolUseResult);
            }
          }
        }
      }
    }

    // Extract summary/title
    const summaryEntry = entries.find((e) => e.type === 'summary');
    const title = summaryEntry?.summary || 'Untitled';

    // Extract metadata from first entry
    const firstEntry = entries.find((e) => e.type === 'user' || e.type === 'assistant');
    const cwd = firstEntry?.cwd;
    const gitBranch = firstEntry?.gitBranch;

    // Extract model from first assistant message
    const firstAssistant = entries.find((e) => e.type === 'assistant' && e.message?.model);
    const model = firstAssistant?.message?.model;

    // Sort entries by timestamp to get correct ordering
    // Deduplicate by UUID to avoid duplicates from main + agent files
    const seenUuids = new Set<string>();
    const sortedEntries = entries
      .filter((e) => (e.type === 'user' || e.type === 'assistant') && e.message)
      .filter((e) => {
        if (!e.uuid) return true; // Keep entries without UUID
        if (seenUuids.has(e.uuid)) return false;
        seenUuids.add(e.uuid);
        return true;
      })
      .sort((a, b) => {
        if (!a.timestamp || !b.timestamp) return 0;
        return new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
      });

    // Convert entries to messages
    const messages: RawMessage[] = [];
    const allFiles: RawFile[] = [];
    const allEdits: RawFileEdit[] = [];
    const seenPaths = new Set<string>();
    let createdAt: string | undefined;
    let updatedAt: string | undefined;

    for (const entry of sortedEntries) {
      if (!entry.message || !entry.uuid) continue;

      // Track timestamps
      if (entry.timestamp) {
        if (!createdAt || entry.timestamp < createdAt) {
          createdAt = entry.timestamp;
        }
        if (!updatedAt || entry.timestamp > updatedAt) {
          updatedAt = entry.timestamp;
        }
      }

      const isAssistant = entry.message.role === 'assistant';
      const content = extractTextContent(entry.message.content, toolResults, isAssistant);
      const toolCalls = extractToolCalls(entry.message.content, toolResults);
      const files = extractFilesFromToolCalls(toolCalls);
      const fileEdits = extractFileEditsFromToolCalls(toolCalls);

      // Add files to conversation-level list
      for (const file of files) {
        if (!seenPaths.has(file.path)) {
          seenPaths.add(file.path);
          allFiles.push(file);
        }
      }

      // Add edits to conversation-level list
      allEdits.push(...fileEdits);

      // Calculate per-message line totals
      const totalLinesAdded = fileEdits.reduce((sum, e) => sum + e.linesAdded, 0);
      const totalLinesRemoved = fileEdits.reduce((sum, e) => sum + e.linesRemoved, 0);

      // Extract token usage from message
      const usage = entry.message.usage;

      messages.push({
        uuid: entry.uuid,
        parentUuid: entry.parentUuid ?? null,
        role: entry.message.role,
        content,
        timestamp: entry.timestamp,
        toolCalls,
        files,
        fileEdits,
        isSidechain: entry.isSidechain ?? false,
        inputTokens: usage?.input_tokens,
        outputTokens: usage?.output_tokens,
        cacheCreationTokens: usage?.cache_creation_input_tokens,
        cacheReadTokens: usage?.cache_read_input_tokens,
        totalLinesAdded: totalLinesAdded > 0 ? totalLinesAdded : undefined,
        totalLinesRemoved: totalLinesRemoved > 0 ? totalLinesRemoved : undefined,
      });
    }

    if (messages.length === 0) continue;

    // Calculate token usage
    // For input context, find the message with the peak TOTAL context
    // (input + cache_creation + cache_read). This shows peak context window used.
    // We can't take max of each component separately as they'd come from different messages.
    // For output tokens, SUM is correct since each output is new content generated.
    let peakMessage: RawMessage | undefined;
    let peakContext = 0;
    for (const m of messages) {
      const totalContext = (m.inputTokens || 0) + (m.cacheCreationTokens || 0) + (m.cacheReadTokens || 0);
      if (totalContext > peakContext) {
        peakContext = totalContext;
        peakMessage = m;
      }
    }
    const totalInputTokens = peakMessage?.inputTokens || 0;
    const totalCacheCreationTokens = peakMessage?.cacheCreationTokens || 0;
    const totalCacheReadTokens = peakMessage?.cacheReadTokens || 0;
    const totalOutputTokens = messages.reduce((sum, m) => sum + (m.outputTokens || 0), 0);

    // Calculate total line changes
    const totalLinesAdded = allEdits.reduce((sum, e) => sum + e.linesAdded, 0);
    const totalLinesRemoved = allEdits.reduce((sum, e) => sum + e.linesRemoved, 0);

    conversations.push({
      sessionId,
      title,
      workspacePath,
      cwd,
      gitBranch,
      model,
      createdAt,
      updatedAt,
      messages,
      files: allFiles,
      fileEdits: allEdits,
      totalInputTokens: totalInputTokens > 0 ? totalInputTokens : undefined,
      totalOutputTokens: totalOutputTokens > 0 ? totalOutputTokens : undefined,
      totalCacheCreationTokens: totalCacheCreationTokens > 0 ? totalCacheCreationTokens : undefined,
      totalCacheReadTokens: totalCacheReadTokens > 0 ? totalCacheReadTokens : undefined,
      totalLinesAdded: totalLinesAdded > 0 ? totalLinesAdded : undefined,
      totalLinesRemoved: totalLinesRemoved > 0 ? totalLinesRemoved : undefined,
    });
  }

  return conversations;
}
