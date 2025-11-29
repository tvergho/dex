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
  isSidechain: boolean;
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
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
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalCacheCreationTokens?: number;
  totalCacheReadTokens?: number;
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
 */
function extractTextContent(content: string | ClaudeMessageContent[]): string {
  if (typeof content === 'string') {
    return content;
  }

  return content
    .filter((c) => c.type === 'text' && c.text)
    .map((c) => c.text!)
    .join('\n');
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
      toolCalls.push({
        id: c.id,
        name: c.name,
        input: typeof c.input === 'string' ? c.input : JSON.stringify(c.input),
        output: result?.stdout || result?.content || result?.file?.content,
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
    const sortedEntries = entries
      .filter((e) => (e.type === 'user' || e.type === 'assistant') && e.message)
      .sort((a, b) => {
        if (!a.timestamp || !b.timestamp) return 0;
        return new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
      });

    // Convert entries to messages
    const messages: RawMessage[] = [];
    const allFiles: RawFile[] = [];
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

      const content = extractTextContent(entry.message.content);
      const toolCalls = extractToolCalls(entry.message.content, toolResults);
      const files = extractFilesFromToolCalls(toolCalls);

      // Add files to conversation-level list
      for (const file of files) {
        if (!seenPaths.has(file.path)) {
          seenPaths.add(file.path);
          allFiles.push(file);
        }
      }

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
        isSidechain: entry.isSidechain ?? false,
        inputTokens: usage?.input_tokens,
        outputTokens: usage?.output_tokens,
        cacheCreationTokens: usage?.cache_creation_input_tokens,
        cacheReadTokens: usage?.cache_read_input_tokens,
      });
    }

    if (messages.length === 0) continue;

    // Calculate total token usage
    const totalInputTokens = messages.reduce((sum, m) => sum + (m.inputTokens || 0), 0);
    const totalOutputTokens = messages.reduce((sum, m) => sum + (m.outputTokens || 0), 0);
    const totalCacheCreationTokens = messages.reduce((sum, m) => sum + (m.cacheCreationTokens || 0), 0);
    const totalCacheReadTokens = messages.reduce((sum, m) => sum + (m.cacheReadTokens || 0), 0);

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
      totalInputTokens: totalInputTokens > 0 ? totalInputTokens : undefined,
      totalOutputTokens: totalOutputTokens > 0 ? totalOutputTokens : undefined,
      totalCacheCreationTokens: totalCacheCreationTokens > 0 ? totalCacheCreationTokens : undefined,
      totalCacheReadTokens: totalCacheReadTokens > 0 ? totalCacheReadTokens : undefined,
    });
  }

  return conversations;
}
