/**
 * Config command - Settings TUI for managing provider connections and features
 *
 * Usage: dex config
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import { withFullScreen, useScreenSize } from 'fullscreen-ink';
import { connect } from '../../db/index.js';
import {
  loadConfig,
  updateProviderConfig,
  type DexConfig,
} from '../../config/index.js';
import {
  getClaudeCodeCredentialStatus,
  type CredentialStatus,
} from '../../providers/index.js';
import {
  countUntitledConversations,
  enrichUntitledConversations,
  type EnrichmentProgress,
} from '../../features/enrichment/index.js';
import { conversationRepo } from '../../db/repository.js';

// ============ Progress Bar Component ============

function ProgressBar({
  current,
  total,
  width,
}: {
  current: number;
  total: number;
  width: number;
}) {
  const percentage = total > 0 ? Math.round((current / total) * 100) : 0;
  const barWidth = Math.max(20, width - 16);
  const filled = Math.round((current / total) * barWidth);
  const empty = barWidth - filled;

  return (
    <Box>
      <Text color="green">{'█'.repeat(filled)}</Text>
      <Text color="gray">{'░'.repeat(empty)}</Text>
      <Text dimColor> {current}/{total} </Text>
      <Text color="cyan">{percentage}%</Text>
    </Box>
  );
}

// ============ Main Config App ============

type MenuItem = {
  id: string;
  label: string;
  type: 'toggle' | 'action' | 'button';
  value?: boolean;
  disabled?: boolean;
  section?: string;
};

function ConfigApp() {
  const { exit } = useApp();
  const { width, height } = useScreenSize();

  // State
  const [config, setConfig] = useState<DexConfig | null>(null);
  const [credentialStatus, setCredentialStatus] = useState<CredentialStatus | null>(null);
  const [untitledCount, setUntitledCount] = useState(0);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' | 'info' } | null>(null);
  const [generationProgress, setGenerationProgress] = useState<EnrichmentProgress | null>(null);
  const [recentlyGeneratedIds, setRecentlyGeneratedIds] = useState<string[]>([]);
  const [frame, setFrame] = useState(0);
  const spinner = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

  // Load initial state
  useEffect(() => {
    async function load() {
      try {
        await connect();
        const cfg = loadConfig();
        setConfig(cfg);

        const status = getClaudeCodeCredentialStatus();
        setCredentialStatus(status);

        const count = await countUntitledConversations();
        setUntitledCount(count);
      } catch (err) {
        setToast({
          message: `Failed to load: ${err instanceof Error ? err.message : String(err)}`,
          type: 'error',
        });
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  // Build menu items
  const menuItems: MenuItem[] = [];
  const claudeCodeConnected = config?.providers.claudeCode.enabled ?? false;

  if (config && claudeCodeConnected) {
    // Order matches visual layout: auto-enrich, disconnect, then generate
    menuItems.push({
      id: 'auto-enrich',
      label: 'Auto-enrich titles on sync',
      type: 'toggle',
      value: config.providers.claudeCode.autoEnrichSummaries,
      section: 'claude-code',
    });

    menuItems.push({
      id: 'disconnect',
      label: 'Disconnect',
      type: 'button',
      section: 'claude-code',
    });

    if (untitledCount > 0) {
      menuItems.push({
        id: 'generate',
        label: `Generate titles for ${untitledCount} untitled`,
        type: 'action',
        section: 'titles',
      });
    }

    if (recentlyGeneratedIds.length > 0) {
      menuItems.push({
        id: 'reset',
        label: `Reset ${recentlyGeneratedIds.length} generated title${recentlyGeneratedIds.length === 1 ? '' : 's'}`,
        type: 'action',
        section: 'titles',
      });
    }
  } else if (config && credentialStatus?.isAuthenticated) {
    menuItems.push({
      id: 'connect',
      label: 'Connect',
      type: 'button',
      section: 'claude-code',
    });
  }

  const selectableItems = menuItems.filter((item) => !item.disabled);

  // Handle navigation
  const moveSelection = useCallback((delta: number) => {
    if (selectableItems.length === 0) return;
    setSelectedIndex((idx) => {
      const newIdx = idx + delta;
      if (newIdx < 0) return 0;
      if (newIdx >= selectableItems.length) return selectableItems.length - 1;
      return newIdx;
    });
  }, [selectableItems.length]);

  // Handle actions
  const handleAction = useCallback(async () => {
    if (!config) return;

    const item = selectableItems[selectedIndex];
    if (!item || item.disabled) return;

    try {
      if (item.id === 'connect') {
        const newConfig = updateProviderConfig('claudeCode', { enabled: true });
        setConfig(newConfig);
        setToast({ message: 'Connected to Claude Code', type: 'success' });
      } else if (item.id === 'disconnect') {
        const newConfig = updateProviderConfig('claudeCode', {
          enabled: false,
          autoEnrichSummaries: false,
        });
        setConfig(newConfig);
        setToast({ message: 'Disconnected', type: 'info' });
      } else if (item.id === 'auto-enrich') {
        const newConfig = updateProviderConfig('claudeCode', {
          autoEnrichSummaries: !config.providers.claudeCode.autoEnrichSummaries,
        });
        setConfig(newConfig);
      } else if (item.id === 'generate') {
        setGenerationProgress({
          completed: 0,
          total: untitledCount,
          inFlight: 0,
          recentTitles: [],
        });

        const generatedIds: string[] = [];
        const result = await enrichUntitledConversations({
          onProgress: (progress) => setGenerationProgress(progress),
          onTitleGenerated: (convId) => generatedIds.push(convId),
        });

        setGenerationProgress(null);
        setRecentlyGeneratedIds(generatedIds);

        const newCount = await conversationRepo.countUntitled();
        setUntitledCount(newCount);

        setToast({
          message: `Generated ${result.enriched} title${result.enriched === 1 ? '' : 's'}${result.failed > 0 ? `, ${result.failed} failed` : ''}`,
          type: result.failed > 0 ? 'error' : 'success',
        });
      } else if (item.id === 'reset') {
        // Reset recently generated titles back to "Untitled"
        for (const convId of recentlyGeneratedIds) {
          await conversationRepo.updateTitle(convId, 'Untitled');
        }

        const resetCount = recentlyGeneratedIds.length;
        setRecentlyGeneratedIds([]);

        const newCount = await conversationRepo.countUntitled();
        setUntitledCount(newCount);

        setToast({
          message: `Reset ${resetCount} title${resetCount === 1 ? '' : 's'} to "Untitled"`,
          type: 'info',
        });
      }
    } catch (err) {
      setGenerationProgress(null);
      setToast({
        message: `Failed: ${err instanceof Error ? err.message : String(err)}`,
        type: 'error',
      });
    }
  }, [config, selectableItems, selectedIndex, untitledCount, recentlyGeneratedIds]);

  useInput((input, key) => {
    if (input === 'q' || key.escape) {
      exit();
      // Force exit to avoid hang
      setTimeout(() => process.exit(0), 100);
      return;
    }

    if (input === 'j' || key.downArrow) {
      moveSelection(1);
    } else if (input === 'k' || key.upArrow) {
      moveSelection(-1);
    }

    if (key.return || input === ' ') {
      handleAction();
    }
  });

  // Toast auto-dismiss
  useEffect(() => {
    if (toast && toast.type !== 'info') {
      const timer = setTimeout(() => setToast(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [toast]);

  // Spinner animation for generation
  useEffect(() => {
    if (!generationProgress) return;
    const timer = setInterval(() => setFrame((f) => (f + 1) % spinner.length), 80);
    return () => clearInterval(timer);
  }, [generationProgress, spinner.length]);

  if (loading) {
    return (
      <Box width={width} height={height} alignItems="center" justifyContent="center">
        <Text color="cyan">Loading settings...</Text>
      </Box>
    );
  }

  const cardWidth = Math.max(50, width - 4);
  const subsectionWidth = cardWidth - 6;

  // Footer key hint components (matching search.tsx style)
  const Key = ({ k }: { k: string }) => <Text color="white">{k}</Text>;
  const Sep = () => <Text dimColor> · </Text>;

  return (
    <Box width={width} height={height} flexDirection="column">
      {/* Header */}
      <Box flexDirection="column" marginBottom={1}>
        <Box paddingX={1}>
          <Text bold>⚙  Settings</Text>
        </Box>
        <Box paddingX={1}>
          <Text color="gray">{'─'.repeat(Math.max(0, width - 2))}</Text>
        </Box>
      </Box>

      {/* Claude Code Card */}
      <Box flexDirection="column" paddingX={1} marginBottom={1}>
        <Box>
          <Text color="gray">┌─ </Text>
          <Text bold>Claude Code</Text>
          <Text color="gray"> {'─'.repeat(Math.max(0, cardWidth - 14))}</Text>
        </Box>

        {/* Status row */}
        <Box>
          <Text color="gray">│  </Text>
          {claudeCodeConnected ? (
            <>
              <Text color="green">● Connected</Text>
              {credentialStatus?.subscriptionType && (
                <Text dimColor> ({credentialStatus.subscriptionType})</Text>
              )}
            </>
          ) : (
            <Text color="yellow">○ Not connected</Text>
          )}
        </Box>

        <Box>
          <Text color="gray">│</Text>
        </Box>

        {/* Menu items */}
        {selectableItems.filter(i => i.section === 'claude-code' || i.section === undefined).map((item) => {
          const actualIdx = selectableItems.indexOf(item);
          const isSelected = actualIdx === selectedIndex;
          const isDisconnect = item.id === 'disconnect';

          return (
            <Box key={item.id}>
              <Text color="gray">│  </Text>
              <Text color={isSelected ? 'cyan' : 'white'}>{isSelected ? '▸ ' : '  '}</Text>
              {item.type === 'toggle' && (
                <Text color={item.value ? 'green' : 'gray'}>[{item.value ? '✓' : ' '}] </Text>
              )}
              <Text color={isSelected ? 'cyan' : isDisconnect ? 'red' : 'white'}>{item.label}</Text>
            </Box>
          );
        })}

        {/* Titles subsection */}
        {claudeCodeConnected && (
          <>
            <Box>
              <Text color="gray">│</Text>
            </Box>
            <Box>
              <Text color="gray">│  ╭─ </Text>
              <Text dimColor>Titles from past conversations</Text>
              <Text color="gray"> {'─'.repeat(Math.max(0, subsectionWidth - 30))}╮</Text>
            </Box>

            {generationProgress ? (
              <>
                <Box>
                  <Text color="gray">│  │  </Text>
                  <ProgressBar
                    current={generationProgress.completed}
                    total={generationProgress.total}
                    width={Math.min(40, subsectionWidth - 4)}
                  />
                </Box>
                {/* Deduplicate by title for display */}
                {generationProgress.recentTitles
                  .slice(-6)
                  .filter((item, idx, arr) => arr.findIndex(x => x.title === item.title) === idx)
                  .slice(-3)
                  .map((item) => (
                  <Box key={item.id}>
                    <Text color="gray">│  │  </Text>
                    <Text color="green">✓ </Text>
                    <Text>{item.title.length > 50 ? item.title.slice(0, 47) + '...' : item.title}</Text>
                  </Box>
                ))}
                {generationProgress.inFlight > 0 && (
                  <Box>
                    <Text color="gray">│  │  </Text>
                    <Text color="cyan">{spinner[frame]} </Text>
                    <Text dimColor>{generationProgress.inFlight} generating...</Text>
                  </Box>
                )}
              </>
            ) : (
              <>
                {untitledCount === 0 ? (
                  <Box>
                    <Text color="gray">│  │  </Text>
                    <Text color="green">✓ </Text>
                    <Text dimColor>All conversations have titles</Text>
                  </Box>
                ) : (
                  <Box>
                    <Text color="gray">│  │  </Text>
                    <Text dimColor>{untitledCount} untitled conversation{untitledCount === 1 ? '' : 's'} found</Text>
                  </Box>
                )}
                {selectableItems.filter(i => i.section === 'titles').map((item) => {
                  const actualIdx = selectableItems.indexOf(item);
                  const isSelected = actualIdx === selectedIndex;
                  const isReset = item.id === 'reset';

                  return (
                    <Box key={item.id}>
                      <Text color="gray">│  │  </Text>
                      <Text color={isSelected ? 'cyan' : 'white'}>{isSelected ? '▸ ' : '  '}</Text>
                      <Text color={isSelected ? 'cyan' : isReset ? 'yellow' : 'blue'}>
                        [{isReset ? `Reset ${recentlyGeneratedIds.length}` : 'Generate Now'}]
                      </Text>
                    </Box>
                  );
                })}
              </>
            )}

            <Box>
              <Text color="gray">│  ╰{'─'.repeat(Math.max(0, subsectionWidth))}╯</Text>
            </Box>
          </>
        )}

        {/* Card bottom */}
        <Box>
          <Text color="gray">└{'─'.repeat(Math.max(0, cardWidth))}┘</Text>
        </Box>
      </Box>

      {/* Codex Card */}
      <Box flexDirection="column" paddingX={1}>
        <Box>
          <Text color="gray">┌─ </Text>
          <Text bold>Codex</Text>
          <Text color="gray"> {'─'.repeat(Math.max(0, cardWidth - 7))}</Text>
        </Box>
        <Box>
          <Text color="gray">│  </Text>
          <Text color="yellow">○ Not connected</Text>
          <Text dimColor>  Coming soon</Text>
        </Box>
        <Box>
          <Text color="gray">└{'─'.repeat(Math.max(0, cardWidth))}┘</Text>
        </Box>
      </Box>

      {/* Spacer */}
      <Box flexGrow={1} />

      {/* Toast */}
      {toast && (
        <Box paddingX={1} marginBottom={1}>
          <Text color={toast.type === 'success' ? 'green' : toast.type === 'error' ? 'red' : 'cyan'}>
            {toast.message}
          </Text>
        </Box>
      )}

      {/* Footer */}
      <Box flexDirection="column">
        <Box paddingX={1}>
          <Text color="gray">{'─'.repeat(Math.max(0, width - 2))}</Text>
        </Box>
        <Box paddingX={1}>
          <Key k="j/k" /><Text dimColor>: navigate</Text><Sep />
          <Key k="Space" /><Text dimColor>: toggle</Text><Sep />
          <Key k="Enter" /><Text dimColor>: select</Text><Sep />
          <Key k="q" /><Text dimColor>: quit</Text>
        </Box>
      </Box>
    </Box>
  );
}

export async function configCommand(): Promise<void> {
  if (!process.stdin.isTTY) {
    const config = loadConfig();
    console.log('\nDex Configuration:\n');
    console.log(JSON.stringify(config, null, 2));
    return;
  }

  const app = withFullScreen(<ConfigApp />);
  await app.start();
  await app.waitUntilExit();
}
