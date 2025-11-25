import Database from 'better-sqlite3';

export interface RawBubble {
  bubbleId: string;
  type: 'user' | 'assistant' | 'system';
  text: string;
  files: RawFile[]; // files associated with this specific bubble
}

export interface RawFile {
  path: string;
  role: 'context' | 'edited' | 'mentioned';
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
}

interface ComposerDataEntry {
  composerId: string;
  name?: string;
  createdAt?: number;
  lastUpdatedAt?: number;
  forceMode?: string; // 'chat', 'edit', 'agent'
  context?: ContextData;
  conversation?: BubbleData[];
  conversationMap?: Record<string, BubbleData>;
  fullConversationHeadersOnly?: Array<{
    bubbleId?: string;
    type?: number;
  }>;
}

// Map numeric bubble type to role
function mapBubbleType(type: number | undefined): RawBubble['type'] {
  // Type 1 = user, Type 2 = assistant
  if (type === 1) return 'user';
  if (type === 2) return 'assistant';
  return 'user';
}

// Extract workspace path from file paths
function extractWorkspacePath(filePaths: string[]): string | undefined {
  if (filePaths.length === 0) return undefined;

  // Only use absolute paths (starting with /) for workspace extraction
  const absolutePaths = filePaths.filter((p) => p.startsWith('/'));
  if (absolutePaths.length === 0) return undefined;

  // Split paths and filter out empty parts (from leading /)
  const paths = absolutePaths.map((p) => p.split('/').filter(Boolean));
  const firstPath = paths[0];
  if (!firstPath || firstPath.length === 0) return undefined;

  const commonParts: string[] = [];
  for (let i = 0; i < firstPath.length; i++) {
    const part = firstPath[i];
    if (part && paths.every((p) => p[i] === part)) {
      commonParts.push(part);
    } else {
      break;
    }
  }

  // Try to find a project root (before src, lib, app, etc.)
  const projectIndicators = ['src', 'lib', 'app', 'packages', 'node_modules', 'dist', 'test', 'tests', 'scripts'];
  const projectIdx = commonParts.findIndex((p) => projectIndicators.includes(p));
  if (projectIdx > 0) {
    return '/' + commonParts.slice(0, projectIdx).join('/');
  }

  // Otherwise return the directory of the file (excluding filename)
  if (commonParts.length > 1) {
    const lastPart = commonParts[commonParts.length - 1];
    if (lastPart && lastPart.includes('.')) {
      return '/' + commonParts.slice(0, -1).join('/');
    }
    return '/' + commonParts.join('/');
  }

  return undefined;
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
  }

  return Array.from(filesMap.values());
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
              });
              bubbleDataList.push(bubbleData);
            }
          }
        }
      }

      // Skip empty conversations
      if (bubbles.length === 0) continue;

      // Collect files from context and bubbles
      const files = collectFiles(data.context, bubbleDataList);

      // Extract workspace path from files
      const filePaths = files.map((f) => f.path);
      const workspacePath = extractWorkspacePath(filePaths);
      const projectName = extractProjectName(workspacePath);

      conversations.push({
        composerId,
        name: data.name || 'Untitled',
        createdAt: data.createdAt,
        lastUpdatedAt: data.lastUpdatedAt,
        bubbles,
        workspacePath,
        projectName,
        mode: data.forceMode,
        files,
      });
    }
  } finally {
    db.close();
  }

  return conversations;
}
