import React, { useState, useEffect, useMemo } from 'react';
import { render, Box, Text, useInput, useApp } from 'ink';
import { withFullScreen, useScreenSize } from 'fullscreen-ink';
import { connect } from '../../db/index.js';
import { conversationRepo, messageRepo, filesRepo, messageFilesRepo } from '../../db/repository.js';
import type { Conversation, Message, ConversationFile, MessageFile } from '../../schema/index.js';

function MessageView({
  message,
  messageFiles,
  width,
}: {
  message: Message;
  messageFiles: MessageFile[];
  width: number;
}) {
  const roleLabel = message.role === 'user' ? 'You' : message.role === 'assistant' ? 'Assistant' : 'System';
  const roleColor = message.role === 'user' ? 'green' : message.role === 'assistant' ? 'blue' : 'yellow';

  // Truncate very long messages for display
  const maxContentLength = width * 20; // ~20 lines worth
  const content = message.content.length > maxContentLength
    ? message.content.slice(0, maxContentLength) + '\n… (truncated)'
    : message.content;

  // Get file names for this message
  const fileNames = messageFiles.map((f) => {
    const parts = f.filePath.split('/');
    return parts[parts.length - 1] || f.filePath;
  });

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color={roleColor} bold>[{roleLabel}]</Text>
        {fileNames.length > 0 && (
          <Text dimColor> ({fileNames.join(', ')})</Text>
        )}
      </Box>
      <Box marginLeft={2}>
        <Text wrap="wrap">{content}</Text>
      </Box>
    </Box>
  );
}

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

  const headerHeight = 4;
  const footerHeight = 2;
  const availableHeight = height - headerHeight - footerHeight;

  // Simple line-based scrolling
  const maxOffset = Math.max(0, messages.length - 1);

  useInput((input, key) => {
    if (input === 'q' || key.escape) {
      exit();
      return;
    }

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

  // Build project context info
  const projectParts: string[] = [];
  if (conversation.projectName) {
    projectParts.push(conversation.projectName);
  } else if (conversation.workspacePath) {
    const parts = conversation.workspacePath.split('/').filter(Boolean);
    if (parts.length > 0) {
      projectParts.push(parts[parts.length - 1]!);
    }
  }
  if (conversation.mode) {
    projectParts.push(conversation.mode);
  }
  if (conversation.model) {
    projectParts.push(conversation.model);
  }

  // Get file names
  const fileNames = files.slice(0, 5).map((f) => {
    const parts = f.filePath.split('/');
    return parts[parts.length - 1] || f.filePath;
  });

  // Adjust header height based on content
  const dynamicHeaderHeight = 4 + (projectParts.length > 0 ? 1 : 0) + (fileNames.length > 0 ? 1 : 0);

  // Show messages starting from scrollOffset
  const visibleMessages = messages.slice(scrollOffset, scrollOffset + Math.max(1, Math.floor((height - dynamicHeaderHeight - footerHeight) / 4)));

  return (
    <Box width={width} height={height} flexDirection="column">
      {/* Header */}
      <Box flexDirection="column" paddingX={1} marginBottom={1}>
        <Text bold color="cyan">{conversation.title}</Text>
        {projectParts.length > 0 && (
          <Text color="yellow">{projectParts.join(' · ')}</Text>
        )}
        {conversation.workspacePath && (
          <Text color="magenta">
            {conversation.workspacePath.length > width - 4
              ? '…' + conversation.workspacePath.slice(-(width - 7))
              : conversation.workspacePath}
          </Text>
        )}
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

      {/* Messages */}
      <Box flexDirection="column" flexGrow={1} paddingX={1} overflowY="hidden">
        {visibleMessages.map((msg) => {
          const msgFiles = messageFiles.filter((f) => f.messageId === msg.id);
          return (
            <MessageView key={msg.id} message={msg} messageFiles={msgFiles} width={width - 4} />
          );
        })}
      </Box>

      {/* Footer */}
      <Box paddingX={1} marginTop={1}>
        <Text dimColor>j/k: scroll · g/G: top/bottom · q: quit</Text>
      </Box>
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
  const projectParts: string[] = [];
  if (conversation.projectName) projectParts.push(conversation.projectName);
  if (conversation.mode) projectParts.push(conversation.mode);
  if (conversation.model) projectParts.push(conversation.model);
  if (projectParts.length > 0) {
    console.log(projectParts.join(' · '));
  }

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
