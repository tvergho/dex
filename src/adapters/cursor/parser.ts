import Database, { type Database as BetterSqliteDatabase } from 'better-sqlite3';

export interface RawBubble {
  bubbleId: string;
  type: 'user' | 'assistant' | 'system';
  text: string;
  files: RawFile[]; // files associated with this specific bubble
  fileEdits: RawFileEdit[]; // edits made in this bubble
  inputTokens?: number;
  outputTokens?: number;
  totalLinesAdded?: number;
  totalLinesRemoved?: number;
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
  startLine?: number;
  endLine?: number;
  bubbleId?: string; // Associate edit with a specific bubble
  newContent?: string; // The new code content from the diff
}

export interface RawConversation {
  composerId: string;
  name: string;
  createdAt?: number;
  lastUpdatedAt?: number;
  bubbles: RawBubble[];
  workspacePath?: string;
  projectName?: string;
  mode?: string;
  model?: string;
  files: RawFile[];
  fileEdits: RawFileEdit[];
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalLinesAdded?: number;
  totalLinesRemoved?: number;
}

interface FileSelection {
  uri?: {
    fsPath?: string;
    path?: string;
  };
}

interface ContextData {
  fileSelections?: FileSelection[];
  folderSelections?: Array<{ uri?: { fsPath?: string; path?: string } }>;
}

interface BubbleData {
  bubbleId?: string;
  type?: number;
  text?: string;
  relevantFiles?: string[];
  context?: ContextData;
  tokenCount?: {
    inputTokens?: number;
    outputTokens?: number;
  };
}

interface ModelConfig {
  modelName?: string;
  maxMode?: boolean;
}

interface ComposerDataEntry {
  composerId: string;
  name?: string;
  createdAt?: number;
  lastUpdatedAt?: number;
  forceMode?: string; // 'chat', 'edit', 'agent'
  modelConfig?: ModelConfig; // Available in schema v9+ (April 2025+)
  context?: ContextData;
  conversation?: BubbleData[];
  conversationMap?: Record<string, BubbleData>;
  fullConversationHeadersOnly?: Array<{
    bubbleId?: string;
    type?: number;
  }>;
  codeBlockData?: Record<string, Record<string, CodeBlockEntry>>;
}

// Code block entry in composerData.codeBlockData[fileUri][blockId]
interface CodeBlockEntry {
  diffId?: string;
  uri?: { fsPath?: string; path?: string };
  bubbleId?: string;
  languageId?: string;
  status?: string;
}

// Mapping from diffId to file path and bubble
interface CodeBlockMapping {
  diffId: string;
  filePath: string;
  bubbleId: string;
  languageId?: string;
}

// Diff entry structure from codeBlockDiff entries
interface DiffEntry {
  original: {
    startLineNumber: number;
    endLineNumberExclusive: number;
  };
  modified: string[];
}

// Map numeric bubble type to role
function mapBubbleType(type: number | undefined): RawBubble['type'] {
  // Type 1 = user, Type 2 = assistant
  if (type === 1) return 'user';
  if (type === 2) return 'assistant';
  return 'user';
}

// Extract workspace path from file paths (handles outliers like stdlib paths)
function extractWorkspacePath(filePaths: string[]): string | undefined {
  if (filePaths.length === 0) return undefined;

  const absolutePaths = filePaths.filter((p) => p.startsWith('/'));
  if (absolutePaths.length === 0) return undefined;

  const projectIndicators = ['src', 'lib', 'app', 'packages', 'node_modules', 'dist', 'test', 'tests', 'scripts'];

  const deriveFromPaths = (paths: string[]): string | undefined => {
    const splitPaths = paths
      .map((p) => p.split('/').filter(Boolean))
      .filter((parts) => parts.length > 0);
    if (splitPaths.length === 0) return undefined;

    const firstPath = splitPaths[0];
    if (!firstPath || firstPath.length === 0) return undefined;

    const commonParts: string[] = [];
    for (let i = 0; i < firstPath.length; i++) {
      const part = firstPath[i];
      if (part && splitPaths.every((p) => p[i] === part)) {
        commonParts.push(part);
      } else {
        break;
      }
    }

    if (commonParts.length === 0) return undefined;

    const projectIdx = commonParts.findIndex((p) => projectIndicators.includes(p));
    if (projectIdx > 0) {
      return '/' + commonParts.slice(0, projectIdx).join('/');
    }

    if (commonParts.length > 1) {
      const lastPart = commonParts[commonParts.length - 1];
      if (lastPart && lastPart.includes('.')) {
        return '/' + commonParts.slice(0, -1).join('/');
      }
      return '/' + commonParts.join('/');
    }

    return undefined;
  };

  // First try to derive a workspace that fits all absolute paths
  const fromAll = deriveFromPaths(absolutePaths);
  if (fromAll) return fromAll;

  // Fallback: score workspaces per path and take the most common/longest
  const candidateCounts = new Map<string, number>();
  for (const absPath of absolutePaths) {
    const candidate = deriveFromPaths([absPath]);
    if (!candidate) continue;
    candidateCounts.set(candidate, (candidateCounts.get(candidate) ?? 0) + 1);
  }

  if (candidateCounts.size === 0) return undefined;

  const [bestWorkspace] = Array.from(candidateCounts.entries())
    .sort((a, b) => (b[1] - a[1]) || (b[0].length - a[0].length))[0]!;

  return bestWorkspace;
}

// Extract project name from workspace path
function extractProjectName(workspacePath: string | undefined): string | undefined {
  if (!workspacePath) return undefined;
  const parts = workspacePath.split('/').filter(Boolean);
  return parts[parts.length - 1];
}

// Extract files associated with a specific bubble
function extractBubbleFiles(bubble: BubbleData): RawFile[] {
  const filesMap = new Map<string, RawFile>();

  // Files from bubble-level context
  if (bubble.context?.fileSelections) {
    for (const selection of bubble.context.fileSelections) {
      const path = selection.uri?.fsPath || selection.uri?.path;
      if (path) {
        filesMap.set(path, { path, role: 'context' });
      }
    }
  }

  if (bubble.context?.folderSelections) {
    for (const selection of bubble.context.folderSelections) {
      const path = selection.uri?.fsPath || selection.uri?.path;
      if (path) {
        filesMap.set(path, { path, role: 'context' });
      }
    }
  }

  // Relevant files mentioned in this bubble
  if (bubble.relevantFiles) {
    for (const file of bubble.relevantFiles) {
      if (!filesMap.has(file)) {
        filesMap.set(file, { path: file, role: 'mentioned' });
      }
    }
  }

  return Array.from(filesMap.values());
}

// Collect all files from context and bubbles for conversation-level tracking
function collectFiles(
  context: ContextData | undefined,
  bubbles: BubbleData[]
): RawFile[] {
  const filesMap = new Map<string, RawFile>();

  // From conversation-level context (files added to context)
  if (context?.fileSelections) {
    for (const selection of context.fileSelections) {
      const path = selection.uri?.fsPath || selection.uri?.path;
      if (path) {
        filesMap.set(path, { path, role: 'context' });
      }
    }
  }

  if (context?.folderSelections) {
    for (const selection of context.folderSelections) {
      const path = selection.uri?.fsPath || selection.uri?.path;
      if (path) {
        filesMap.set(path, { path, role: 'context' });
      }
    }
  }

  // From bubbles (relevantFiles and per-bubble context)
  for (const bubble of bubbles) {
    // Relevant files mentioned in a bubble
    if (bubble.relevantFiles) {
      for (const file of bubble.relevantFiles) {
        if (!filesMap.has(file)) {
          filesMap.set(file, { path: file, role: 'mentioned' });
        }
      }
    }

    // Files from bubble-level context
    if (bubble.context?.fileSelections) {
      for (const selection of bubble.context.fileSelections) {
        const path = selection.uri?.fsPath || selection.uri?.path;
        if (path && !filesMap.has(path)) {
          filesMap.set(path, { path, role: 'context' });
        }
      }
    }

    if (bubble.context?.folderSelections) {
      for (const selection of bubble.context.folderSelections) {
        const path = selection.uri?.fsPath || selection.uri?.path;
        if (path && !filesMap.has(path)) {
          filesMap.set(path, { path, role: 'context' });
        }
      }
    }
  }

  return Array.from(filesMap.values());
}

// Build a mapping from diffId to file path and bubble info
function buildDiffToFileMapping(codeBlockData: Record<string, Record<string, CodeBlockEntry>> | undefined): Map<string, CodeBlockMapping> {
  const mapping = new Map<string, CodeBlockMapping>();

  if (!codeBlockData) return mapping;

  for (const [fileUri, blocks] of Object.entries(codeBlockData)) {
    // Extract file path from file:///path/to/file
    const filePath = fileUri.startsWith('file://')
      ? fileUri.replace('file://', '')
      : fileUri;

    for (const [, blockData] of Object.entries(blocks)) {
      if (blockData.diffId) {
        mapping.set(blockData.diffId, {
          diffId: blockData.diffId,
          filePath: blockData.uri?.fsPath || blockData.uri?.path || filePath,
          bubbleId: blockData.bubbleId || '',
          languageId: blockData.languageId,
        });
      }
    }
  }

  return mapping;
}

// Extract code block diffs from database and convert to file edits
function extractCodeBlockDiffs(
  db: BetterSqliteDatabase,
  composerId: string,
  diffMapping: Map<string, CodeBlockMapping>
): RawFileEdit[] {
  const edits: RawFileEdit[] = [];

  // Query all codeBlockDiff entries for this composer
  const diffRows = db
    .prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE ?")
    .all(`codeBlockDiff:${composerId}:%`) as Array<{ key: string; value: Buffer | string }>;

  for (const row of diffRows) {
    // Extract diffId from key: codeBlockDiff:{composerId}:{diffId}
    const keyParts = row.key.split(':');
    const diffId = keyParts[2];
    if (!diffId) continue;

    const mapping = diffMapping.get(diffId);
    if (!mapping) continue; // Skip orphaned diffs without file mapping

    // Parse the diff value
    let valueStr: string;
    if (Buffer.isBuffer(row.value)) {
      valueStr = row.value.toString('utf-8');
    } else {
      valueStr = row.value;
    }

    try {
      const parsed = JSON.parse(valueStr) as { newModelDiffWrtV0?: DiffEntry[] };

      // Extract individual diff hunks
      if (parsed.newModelDiffWrtV0 && Array.isArray(parsed.newModelDiffWrtV0)) {
        for (const diff of parsed.newModelDiffWrtV0) {
          const startLine = diff.original?.startLineNumber ?? 0;
          const endLine = diff.original?.endLineNumberExclusive ?? 0;
          const linesRemoved = endLine - startLine;
          const linesAdded = diff.modified?.length ?? 0;

          edits.push({
            filePath: mapping.filePath,
            editType: linesRemoved === 0 ? 'create' : 'modify',
            linesAdded,
            linesRemoved,
            startLine: startLine > 0 ? startLine : undefined,
            endLine: endLine > 0 ? endLine : undefined,
            bubbleId: mapping.bubbleId,
            newContent: diff.modified?.join('\n'),
          });
        }
      }
    } catch {
      // Skip malformed diff entries
    }
  }

  return edits;
}

export function extractConversations(dbPath: string): RawConversation[] {
  const db = new Database(dbPath, { readonly: true });
  const conversations: RawConversation[] = [];

  try {
    // Get all composerData entries from global cursorDiskKV
    const composerRows = db
      .prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'")
      .all() as Array<{ key: string; value: Buffer | string }>;

    for (const row of composerRows) {
      // Parse the value
      let valueStr: string;
      if (Buffer.isBuffer(row.value)) {
        valueStr = row.value.toString('utf-8');
      } else {
        valueStr = row.value;
      }

      let data: ComposerDataEntry;
      try {
        data = JSON.parse(valueStr);
        // Skip if parsed value is null or not an object
        if (!data || typeof data !== 'object') continue;
      } catch {
        continue;
      }

      const composerId = data.composerId || row.key.replace('composerData:', '');
      const bubbles: RawBubble[] = [];
      const bubbleDataList: BubbleData[] = [];

      // Try to get bubbles from conversation array (older format)
      if (data.conversation && Array.isArray(data.conversation)) {
        for (const item of data.conversation) {
          if (item.bubbleId && item.text) {
            // Extract per-bubble files
            const bubbleFiles = extractBubbleFiles(item);
            bubbles.push({
              bubbleId: item.bubbleId,
              type: mapBubbleType(item.type),
              text: item.text,
              files: bubbleFiles,
              fileEdits: [], // Will be populated after diff extraction
              inputTokens: item.tokenCount?.inputTokens,
              outputTokens: item.tokenCount?.outputTokens,
            });
            bubbleDataList.push(item);
          }
        }
      }

      // Try to get bubbles from conversationMap (newer format)
      if (bubbles.length === 0 && data.conversationMap && data.fullConversationHeadersOnly) {
        for (const header of data.fullConversationHeadersOnly) {
          if (header.bubbleId) {
            const bubbleData = data.conversationMap[header.bubbleId];
            if (bubbleData && bubbleData.text) {
              const bubbleFiles = extractBubbleFiles(bubbleData);
              bubbles.push({
                bubbleId: header.bubbleId,
                type: mapBubbleType(header.type ?? bubbleData.type),
                text: bubbleData.text,
                files: bubbleFiles,
                fileEdits: [], // Will be populated after diff extraction
                inputTokens: bubbleData.tokenCount?.inputTokens,
                outputTokens: bubbleData.tokenCount?.outputTokens,
              });
              bubbleDataList.push(bubbleData);
            }
          }
        }
      }

      // Try to get bubbles from separate bubbleId entries (newest format - v9+)
      // In this format, conversationMap is empty but bubbles are stored as separate entries
      if (bubbles.length === 0 && data.fullConversationHeadersOnly && data.fullConversationHeadersOnly.length > 0) {
        for (const header of data.fullConversationHeadersOnly) {
          if (header.bubbleId) {
            // Look up bubble from separate bubbleId entry
            const bubbleKey = `bubbleId:${composerId}:${header.bubbleId}`;
            try {
              const bubbleRow = db
                .prepare('SELECT value FROM cursorDiskKV WHERE key = ?')
                .get(bubbleKey) as { value: Buffer | string } | undefined;

              if (bubbleRow) {
                let bubbleStr: string;
                if (Buffer.isBuffer(bubbleRow.value)) {
                  bubbleStr = bubbleRow.value.toString('utf-8');
                } else {
                  bubbleStr = bubbleRow.value;
                }

                const bubbleData = JSON.parse(bubbleStr) as BubbleData;
                if (bubbleData && bubbleData.text) {
                  const bubbleFiles = extractBubbleFiles(bubbleData);
                  bubbles.push({
                    bubbleId: header.bubbleId,
                    type: mapBubbleType(header.type ?? bubbleData.type),
                    text: bubbleData.text,
                    files: bubbleFiles,
                    fileEdits: [], // Will be populated after diff extraction
                    inputTokens: bubbleData.tokenCount?.inputTokens,
                    outputTokens: bubbleData.tokenCount?.outputTokens,
                  });
                  bubbleDataList.push(bubbleData);
                }
              }
            } catch {
              // Skip invalid bubble entries
            }
          }
        }
      }

      // Skip empty conversations
      if (bubbles.length === 0) continue;

      // Extract file edits from codeBlockDiff entries
      const diffMapping = buildDiffToFileMapping(data.codeBlockData);
      const allFileEdits = extractCodeBlockDiffs(db, composerId, diffMapping);

      // Associate edits with bubbles by bubbleId
      const bubbleIdToIndex = new Map<string, number>();
      for (let i = 0; i < bubbles.length; i++) {
        bubbleIdToIndex.set(bubbles[i]!.bubbleId, i);
      }

      // Find the last assistant bubble index for orphaned edits
      let lastAssistantIndex = -1;
      for (let i = bubbles.length - 1; i >= 0; i--) {
        if (bubbles[i]!.type === 'assistant') {
          lastAssistantIndex = i;
          break;
        }
      }

      for (const edit of allFileEdits) {
        if (edit.bubbleId) {
          const bubbleIndex = bubbleIdToIndex.get(edit.bubbleId);
          if (bubbleIndex !== undefined) {
            bubbles[bubbleIndex]!.fileEdits.push(edit);
          } else if (lastAssistantIndex >= 0) {
            // bubbleId exists but not found in our bubbles - associate with last assistant
            bubbles[lastAssistantIndex]!.fileEdits.push(edit);
          }
        } else if (lastAssistantIndex >= 0) {
          // No bubbleId - associate with last assistant bubble
          bubbles[lastAssistantIndex]!.fileEdits.push(edit);
        }
      }

      // Calculate per-bubble line totals
      for (const bubble of bubbles) {
        const totalAdded = bubble.fileEdits.reduce((sum, e) => sum + e.linesAdded, 0);
        const totalRemoved = bubble.fileEdits.reduce((sum, e) => sum + e.linesRemoved, 0);
        bubble.totalLinesAdded = totalAdded > 0 ? totalAdded : undefined;
        bubble.totalLinesRemoved = totalRemoved > 0 ? totalRemoved : undefined;
      }

      // Calculate conversation-level totals
      const totalLinesAdded = allFileEdits.reduce((sum, e) => sum + e.linesAdded, 0);
      const totalLinesRemoved = allFileEdits.reduce((sum, e) => sum + e.linesRemoved, 0);

      // Collect files from context and bubbles
      const files = collectFiles(data.context, bubbleDataList);

      // Extract workspace path from files and edits (ignoring outlier stdlib paths)
      const filePaths = [
        ...files.map((f) => f.path),
        ...allFileEdits.map((edit) => edit.filePath),
      ];
      const workspacePath = extractWorkspacePath(filePaths);
      const projectName = extractProjectName(workspacePath);

      // Calculate token usage
      // For input tokens, use MAX instead of SUM because input_tokens represents the full context
      // sent in each API call (including all prior history). Summing would count the same context
      // multiple times. MAX shows the peak context window used.
      // For output tokens, SUM is correct since each output is new content generated.
      const totalInputTokens = Math.max(0, ...bubbles.map((b) => b.inputTokens || 0));
      const totalOutputTokens = bubbles.reduce((sum, b) => sum + (b.outputTokens || 0), 0);

      conversations.push({
        composerId,
        name: data.name || 'Untitled',
        createdAt: data.createdAt,
        lastUpdatedAt: data.lastUpdatedAt,
        bubbles,
        workspacePath,
        projectName,
        mode: data.forceMode,
        model: data.modelConfig?.modelName,
        files,
        fileEdits: allFileEdits,
        totalInputTokens: totalInputTokens > 0 ? totalInputTokens : undefined,
        totalOutputTokens: totalOutputTokens > 0 ? totalOutputTokens : undefined,
        totalLinesAdded: totalLinesAdded > 0 ? totalLinesAdded : undefined,
        totalLinesRemoved: totalLinesRemoved > 0 ? totalLinesRemoved : undefined,
      });
    }
  } finally {
    db.close();
  }

  return conversations;
}
