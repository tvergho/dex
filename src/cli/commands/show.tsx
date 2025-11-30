/**
 * Show command - displays a single conversation with full message content
 *
 * Usage: dex show <conversation-id>
 *
 * Interactive TUI with scrolling, or plain text output when piped
 * Navigate with j/k, view full messages with Enter
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import { withFullScreen, useScreenSize } from 'fullscreen-ink';
import { connect } from '../../db/index';
import { conversationRepo, messageRepo, filesRepo, messageFilesRepo } from '../../db/repository';
import type { Conversation, Message, ConversationFile, MessageFile } from '../../schema/index';
import { ExportActionMenu, ExportPreviewModal, StatusToast, getPreviewMaxOffset } from '../components/index';
import {
  exportConversationsToFile,
  exportConversationsToClipboard,
  generatePreviewContent,
} from '../../utils/export-actions';

function MessageView({
  message,
  messageFiles,
  width,
  isSelected,
}: {
  message: Message;
  messageFiles: MessageFile[];
  width: number;
  isSelected?: boolean;
}) {
  const roleLabel = message.role === 'user' ? 'You' : message.role === 'assistant' ? 'Assistant' : 'System';
  const roleColor = message.role === 'user' ? 'green' : message.role === 'assistant' ? 'blue' : 'yellow';

  // Truncate very long messages for display
  const maxContentLength = width * 20; // ~20 lines worth
  const content = message.content.length > maxContentLength
    ? message.content.slice(0, maxContentLength)
    : message.content;
  const isTruncated = message.content.length > maxContentLength;
  const totalLines = message.content.split('\n').length;

  // Get file names for this message
  const fileNames = messageFiles.map((f) => {
    const parts = f.filePath.split('/');
    return parts[parts.length - 1] || f.filePath;
  });

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text backgroundColor={isSelected ? 'cyan' : undefined} color={isSelected ? 'black' : 'gray'}>
          {isSelected ? ' ▸ ' : '   '}
        </Text>
        <Box width={9}>
          <Text color={roleColor} bold={isSelected}>{roleLabel}</Text>
        </Box>
        {fileNames.length > 0 && (
          <Text dimColor> ({fileNames.join(', ')})</Text>
        )}
      </Box>
      <Box marginLeft={12}>
        <Text wrap="wrap" dimColor={!isSelected}>{content}</Text>
        {isTruncated && <Text dimColor> ({totalLines} lines)</Text>}
      </Box>
    </Box>
  );
}

type ExportMode = 'none' | 'action-menu' | 'preview';

function ShowApp({ conversationId }: { conversationId: string }) {
  const { exit } = useApp();
  const { width, height } = useScreenSize();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [files, setFiles] = useState<ConversationFile[]>([]);
  const [messageFiles, setMessageFiles] = useState<MessageFile[]>([]);
  const [scrollOffset, setScrollOffset] = useState(0);

  // Export state
  const [exportMode, setExportMode] = useState<ExportMode>('none');
  const [exportActionIndex, setExportActionIndex] = useState(0);
  const [previewContent, setPreviewContent] = useState('');
  const [previewScrollOffset, setPreviewScrollOffset] = useState(0);

  // Status toast
  const [statusMessage, setStatusMessage] = useState('');
  const [statusType, setStatusType] = useState<'success' | 'error'>('success');
  const [statusVisible, setStatusVisible] = useState(false);

  useEffect(() => {
    async function loadConversation() {
      try {
        await connect();
        const conv = await conversationRepo.findById(conversationId);
        if (!conv) {
          setError(`Conversation not found: ${conversationId}`);
          return;
        }
        setConversation(conv);

        const msgs = await messageRepo.findByConversation(conversationId);
        setMessages(msgs);

        const convFiles = await filesRepo.findByConversation(conversationId);
        setFiles(convFiles);

        const msgFiles = await messageFilesRepo.findByConversation(conversationId);
        setMessageFiles(msgFiles);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    }
    loadConversation();
  }, [conversationId]);

  const footerHeight = 2;
  const dynamicHeaderHeight = 6 + (files.length > 0 ? 1 : 0);
  const messagesPerPage = Math.max(1, Math.floor((height - dynamicHeaderHeight - footerHeight) / 4));

  // Scroll offset should stop when last message is visible at bottom
  const maxOffset = Math.max(0, messages.length - messagesPerPage);

  // Show status toast with auto-dismiss
  const showStatus = useCallback((message: string, type: 'success' | 'error') => {
    setStatusMessage(message);
    setStatusType(type);
    setStatusVisible(true);
    setTimeout(() => setStatusVisible(false), 3000);
  }, []);

  // Execute the selected export action
  const executeExportAction = useCallback(async () => {
    if (!conversation) return;

    try {
      if (exportActionIndex === 0) {
        // Export to file
        const outputDir = await exportConversationsToFile([conversation]);
        showStatus(`Exported to ${outputDir}`, 'success');
        setExportMode('none');
        setExportActionIndex(0);
      } else if (exportActionIndex === 1) {
        // Copy to clipboard
        await exportConversationsToClipboard([conversation]);
        showStatus('Copied to clipboard', 'success');
        setExportMode('none');
        setExportActionIndex(0);
      } else if (exportActionIndex === 2) {
        // Show preview
        const content = await generatePreviewContent(conversation);
        setPreviewContent(content);
        setPreviewScrollOffset(0);
        setExportMode('preview');
      }
    } catch (err) {
      showStatus(`Export failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
      setExportMode('none');
    }
  }, [conversation, exportActionIndex, showStatus]);

  // Preview content height for scrolling
  const previewContentHeight = height - 5; // header + footer
  const previewMaxOffset = getPreviewMaxOffset(previewContent, previewContentHeight);

  useInput((input, key) => {
    // Priority 1: Quit
    if (input === 'q') {
      exit();
      return;
    }

    // Priority 2: Export preview mode
    if (exportMode === 'preview') {
      if (input === 'j' || key.downArrow) {
        setPreviewScrollOffset((o) => Math.min(o + 1, previewMaxOffset));
      } else if (input === 'k' || key.upArrow) {
        setPreviewScrollOffset((o) => Math.max(o - 1, 0));
      } else if (input === 'g') {
        setPreviewScrollOffset(0);
      } else if (input === 'G') {
        setPreviewScrollOffset(previewMaxOffset);
      } else if (key.escape) {
        setExportMode('action-menu');
      }
      return;
    }

    // Priority 3: Export action menu
    if (exportMode === 'action-menu') {
      if (input === 'j' || key.downArrow) {
        setExportActionIndex((i) => Math.min(i + 1, 2));
      } else if (input === 'k' || key.upArrow) {
        setExportActionIndex((i) => Math.max(i - 1, 0));
      } else if (key.return) {
        executeExportAction();
      } else if (key.escape) {
        setExportMode('none');
        setExportActionIndex(0);
      }
      return;
    }

    // Priority 4: Normal mode - export trigger
    if (input === 'e' && conversation) {
      setExportMode('action-menu');
      return;
    }

    // Priority 5: Escape exits in normal mode
    if (key.escape) {
      exit();
      return;
    }

    // Priority 6: Normal scrolling
    if (messages.length === 0) return;

    if (input === 'j' || key.downArrow) {
      setScrollOffset((o) => Math.min(o + 1, maxOffset));
    } else if (input === 'k' || key.upArrow) {
      setScrollOffset((o) => Math.max(o - 1, 0));
    } else if (input === 'g') {
      setScrollOffset(0);
    } else if (input === 'G') {
      setScrollOffset(maxOffset);
    }
  });

  if (loading) {
    return (
      <Box width={width} height={height} alignItems="center" justifyContent="center">
        <Text color="cyan">Loading conversation...</Text>
      </Box>
    );
  }

  if (error) {
    return (
      <Box width={width} height={height} flexDirection="column" padding={1}>
        <Text color="red">Error: {error}</Text>
        <Text dimColor>Press q to exit</Text>
      </Box>
    );
  }

  if (!conversation) {
    return (
      <Box width={width} height={height} flexDirection="column" padding={1}>
        <Text color="red">Conversation not found</Text>
        <Text dimColor>Press q to exit</Text>
      </Box>
    );
  }

  // Capitalize source name (e.g., "Cursor")
  const sourceName = conversation.source.charAt(0).toUpperCase() + conversation.source.slice(1);

  // Get file names
  const fileNames = files.slice(0, 5).map((f) => {
    const parts = f.filePath.split('/');
    return parts[parts.length - 1] || f.filePath;
  });

  // Show messages starting from scrollOffset
  const visibleMessages = messages.slice(scrollOffset, scrollOffset + messagesPerPage);

  return (
    <Box width={width} height={height} flexDirection="column">
      {/* Header */}
      <Box flexDirection="column" marginBottom={1}>
        <Box paddingX={1} flexDirection="column">
          <Text bold color="cyan">{conversation.title}</Text>
          <Box>
            <Text color="yellow" dimColor>{sourceName}</Text>
            {conversation.workspacePath && (
              <>
                <Text dimColor> · </Text>
                <Text color="magenta" dimColor>
                  {conversation.workspacePath.length > width - sourceName.length - 7
                    ? '…' + conversation.workspacePath.slice(-(width - sourceName.length - 10))
                    : conversation.workspacePath}
                </Text>
              </>
            )}
          </Box>
          {fileNames.length > 0 && (
            <Text dimColor>
              Files: {fileNames.join(', ')}{files.length > 5 ? ` (+${files.length - 5} more)` : ''}
            </Text>
          )}
          <Text dimColor>
            {conversation.messageCount} messages
            {messages.length > 0 && ` · Viewing ${scrollOffset + 1}-${Math.min(scrollOffset + visibleMessages.length, messages.length)} of ${messages.length}`}
          </Text>
        </Box>
        <Box paddingX={1}>
          <Text dimColor>{'─'.repeat(Math.max(0, width - 2))}</Text>
        </Box>
      </Box>

      {/* Messages */}
      <Box flexDirection="column" flexGrow={1} paddingX={1} overflowY="hidden">
        {visibleMessages.map((msg, idx) => {
          const msgFiles = messageFiles.filter((f) => f.messageId === msg.id);
          const isSelected = idx === 0; // First visible message is "selected" for visual focus
          return (
            <MessageView key={msg.id} message={msg} messageFiles={msgFiles} width={width - 4} isSelected={isSelected} />
          );
        })}
      </Box>

      {/* Footer */}
      <Box flexDirection="column">
        <Box paddingX={1}>
          <Text color="gray">{'─'.repeat(Math.max(0, width - 2))}</Text>
        </Box>
        <Box paddingX={1}>
          <Text color="gray">
            <Text bold color="white">e</Text> export · <Text bold color="white">j/k</Text> scroll · <Text bold color="white">g/G</Text> top/bottom · <Text bold color="white">q</Text> quit
          </Text>
        </Box>
      </Box>

      {/* Export action menu overlay */}
      {exportMode === 'action-menu' && (
        <ExportActionMenu
          selectedIndex={exportActionIndex}
          conversationCount={1}
          width={width}
          height={height}
        />
      )}

      {/* Export preview overlay */}
      {exportMode === 'preview' && (
        <ExportPreviewModal
          content={previewContent}
          title={conversation.title}
          scrollOffset={previewScrollOffset}
          width={width}
          height={height}
        />
      )}

      {/* Status toast */}
      {statusVisible && (
        <StatusToast
          message={statusMessage}
          type={statusType}
          width={width}
          height={height}
        />
      )}
    </Box>
  );
}

async function plainShow(conversationId: string): Promise<void> {
  await connect();

  const conversation = await conversationRepo.findById(conversationId);
  if (!conversation) {
    console.error(`Conversation not found: ${conversationId}`);
    process.exit(1);
  }

  const messages = await messageRepo.findByConversation(conversationId);
  const files = await filesRepo.findByConversation(conversationId);
  const msgFiles = await messageFilesRepo.findByConversation(conversationId);

  console.log(`\n${'─'.repeat(60)}`);
  console.log(conversation.title);

  // Project context
  // Build source info line (e.g., "Cursor · gpt-4")
  const sourceName = conversation.source.charAt(0).toUpperCase() + conversation.source.slice(1);
  const sourceInfo = conversation.model ? `${sourceName} · ${conversation.model}` : sourceName;
  console.log(sourceInfo);

  if (conversation.workspacePath) {
    console.log(conversation.workspacePath);
  }

  if (files.length > 0) {
    const fileNames = files.slice(0, 5).map((f) => {
      const parts = f.filePath.split('/');
      return parts[parts.length - 1] || f.filePath;
    });
    console.log(`Files: ${fileNames.join(', ')}${files.length > 5 ? ` (+${files.length - 5} more)` : ''}`);
  }

  console.log(`${conversation.messageCount} messages`);
  console.log(`${'─'.repeat(60)}\n`);

  for (const msg of messages) {
    const roleLabel = msg.role === 'user' ? 'You' : msg.role === 'assistant' ? 'Assistant' : 'System';

    // Get files for this message
    const filesForMsg = msgFiles.filter((f) => f.messageId === msg.id);
    const fileNames = filesForMsg.map((f) => {
      const parts = f.filePath.split('/');
      return parts[parts.length - 1] || f.filePath;
    });

    if (fileNames.length > 0) {
      console.log(`[${roleLabel}] (${fileNames.join(', ')})`);
    } else {
      console.log(`[${roleLabel}]`);
    }

    const content = msg.content.length > 4000 ? msg.content.slice(0, 4000) + '\n… (truncated)' : msg.content;
    console.log(content);
    console.log('');
  }
}

export async function showCommand(conversationId: string): Promise<void> {
  if (!process.stdin.isTTY) {
    await plainShow(conversationId);
    return;
  }

  const app = withFullScreen(<ShowApp conversationId={conversationId} />);
  await app.start();
  await app.waitUntilExit();
}
