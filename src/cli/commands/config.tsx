/**
 * Config command - Settings TUI for managing provider connections and features
 *
 * Usage: dex config
 *
 * Allows users to:
 * - Connect/disconnect providers (Claude Code, Codex)
 * - Toggle auto-enrich summaries
 * - Manually generate titles for untitled conversations
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
} from '../../features/enrichment/index.js';
import { conversationRepo } from '../../db/repository.js';

type MenuItemType = 'connect' | 'disconnect' | 'toggle' | 'action' | 'disabled';

interface MenuItem {
  id: string;
  label: string;
  type: MenuItemType;
  value?: boolean;
  disabled?: boolean;
  hidden?: boolean;
}

function ConfigApp() {
  const { exit } = useApp();
  const { width, height } = useScreenSize();

  // State
  const [config, setConfig] = useState<DexConfig | null>(null);
  const [credentialStatus, setCredentialStatus] = useState<CredentialStatus | null>(null);
  const [untitledCount, setUntitledCount] = useState(0);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [actionStatus, setActionStatus] = useState<{ message: string; type: 'success' | 'error' | 'info' } | null>(null);
  const [enrichingProgress, setEnrichingProgress] = useState<{ current: number; total: number } | null>(null);

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
        setActionStatus({
          message: `Failed to load: ${err instanceof Error ? err.message : String(err)}`,
          type: 'error',
        });
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  // Build menu items based on current state
  const menuItems: MenuItem[] = [];

  if (config) {
    const claudeCodeConnected = config.providers.claudeCode.enabled;

    if (!claudeCodeConnected) {
      // Disconnected state - show Connect button
      menuItems.push({
        id: 'claude-code-connect',
        label: 'Connect',
        type: 'connect',
        disabled: !credentialStatus?.isAuthenticated,
      });
    } else {
      // Connected state - show status and options
      menuItems.push({
        id: 'claude-code-disconnect',
        label: 'Disconnect',
        type: 'disconnect',
      });

      menuItems.push({
        id: 'claude-code-auto-enrich',
        label: 'Auto-enrich titles',
        type: 'toggle',
        value: config.providers.claudeCode.autoEnrichSummaries,
      });

      if (untitledCount > 0) {
        menuItems.push({
          id: 'claude-code-enrich-now',
          label: `Generate titles for ${untitledCount} untitled conversation${untitledCount === 1 ? '' : 's'}`,
          type: 'action',
        });
      }
    }

    // Codex section (coming soon)
    menuItems.push({
      id: 'codex-connect',
      label: 'Codex (coming soon)',
      type: 'disabled',
      disabled: true,
    });
  }

  // Filter out hidden items and get selectable items
  const visibleItems = menuItems.filter((item) => !item.hidden);
  const selectableItems = visibleItems.filter((item) => !item.disabled);

  // Handle navigation
  const moveSelection = useCallback((delta: number) => {
    if (selectableItems.length === 0) return;

    // Find current selectable index
    const currentSelectableIndex = selectableItems.findIndex(
      (item) => item === visibleItems[selectedIndex]
    );

    // Calculate new selectable index
    let newSelectableIndex = currentSelectableIndex + delta;
    if (newSelectableIndex < 0) newSelectableIndex = 0;
    if (newSelectableIndex >= selectableItems.length) {
      newSelectableIndex = selectableItems.length - 1;
    }

    // Find the visible index for this selectable item
    const newItem = selectableItems[newSelectableIndex];
    const newVisibleIndex = visibleItems.findIndex((item) => item === newItem);
    if (newVisibleIndex >= 0) {
      setSelectedIndex(newVisibleIndex);
    }
  }, [selectableItems, visibleItems, selectedIndex]);

  // Handle actions
  const handleAction = useCallback(async () => {
    if (!config) return;

    const item = visibleItems[selectedIndex];
    if (!item || item.disabled) return;

    try {
      if (item.id === 'claude-code-connect') {
        // Connect Claude Code
        if (!credentialStatus?.isAuthenticated) {
          setActionStatus({
            message: credentialStatus?.error || 'No Claude Code credentials found',
            type: 'error',
          });
          return;
        }

        const newConfig = updateProviderConfig('claudeCode', { enabled: true });
        setConfig(newConfig);
        setActionStatus({
          message: `Connected to Claude Code${credentialStatus.subscriptionType ? ` (${credentialStatus.subscriptionType})` : ''}`,
          type: 'success',
        });
      } else if (item.id === 'claude-code-disconnect') {
        // Disconnect Claude Code
        const newConfig = updateProviderConfig('claudeCode', {
          enabled: false,
          autoEnrichSummaries: false,
        });
        setConfig(newConfig);
        setActionStatus({
          message: 'Disconnected from Claude Code',
          type: 'info',
        });
      } else if (item.id === 'claude-code-auto-enrich') {
        // Toggle auto-enrich
        const newConfig = updateProviderConfig('claudeCode', {
          autoEnrichSummaries: !config.providers.claudeCode.autoEnrichSummaries,
        });
        setConfig(newConfig);
      } else if (item.id === 'claude-code-enrich-now') {
        // Start enrichment
        setEnrichingProgress({ current: 0, total: untitledCount });
        setActionStatus({ message: 'Generating titles...', type: 'info' });

        const result = await enrichUntitledConversations((current, total) => {
          setEnrichingProgress({ current, total });
        });

        setEnrichingProgress(null);

        // Refresh untitled count
        const newCount = await conversationRepo.countUntitled();
        setUntitledCount(newCount);

        setActionStatus({
          message: `Generated ${result.enriched} title${result.enriched === 1 ? '' : 's'}${result.failed > 0 ? `, ${result.failed} failed` : ''}`,
          type: result.failed > 0 ? 'error' : 'success',
        });
      }
    } catch (err) {
      setActionStatus({
        message: `Action failed: ${err instanceof Error ? err.message : String(err)}`,
        type: 'error',
      });
    }
  }, [config, visibleItems, selectedIndex, credentialStatus, untitledCount]);

  useInput((input, key) => {
    // Quit
    if (input === 'q' || key.escape) {
      exit();
      return;
    }

    // Navigation
    if (input === 'j' || key.downArrow) {
      moveSelection(1);
    } else if (input === 'k' || key.upArrow) {
      moveSelection(-1);
    }

    // Actions
    if (key.return || input === ' ') {
      handleAction();
    }
  });

  // Clear status after 3 seconds
  useEffect(() => {
    if (actionStatus && actionStatus.type !== 'info') {
      const timer = setTimeout(() => setActionStatus(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [actionStatus]);

  if (loading) {
    return (
      <Box width={width} height={height} alignItems="center" justifyContent="center">
        <Text color="cyan">Loading settings...</Text>
      </Box>
    );
  }

  const claudeCodeConnected = config?.providers.claudeCode.enabled ?? false;

  return (
    <Box width={width} height={height} flexDirection="column">
      {/* Header */}
      <Box flexDirection="column" marginBottom={1}>
        <Box paddingX={1}>
          <Text bold color="white">⚙  Settings</Text>
        </Box>
        <Box paddingX={1}>
          <Text color="gray">{'─'.repeat(Math.max(0, width - 2))}</Text>
        </Box>
      </Box>

      {/* Claude Code Section */}
      <Box flexDirection="column" paddingX={1} marginBottom={1}>
        <Text bold color="white">Claude Code</Text>
        <Text color="gray">{'─'.repeat(14)}</Text>

        {claudeCodeConnected && credentialStatus && (
          <Box marginTop={1}>
            <Text color="green">● Connected</Text>
            {credentialStatus.subscriptionType && (
              <Text dimColor> ({credentialStatus.subscriptionType})</Text>
            )}
          </Box>
        )}

        {!claudeCodeConnected && credentialStatus && !credentialStatus.isAuthenticated && (
          <Box marginTop={1} flexDirection="column">
            <Text color="yellow">○ Not connected</Text>
            <Text dimColor wrap="wrap">{credentialStatus.error}</Text>
          </Box>
        )}

        {!claudeCodeConnected && credentialStatus?.isAuthenticated && (
          <Box marginTop={1}>
            <Text color="yellow">○ Not connected</Text>
            <Text dimColor> (credentials available)</Text>
          </Box>
        )}
      </Box>

      {/* Menu Items */}
      <Box flexDirection="column" paddingX={1} flexGrow={1}>
        {visibleItems.map((item, idx) => {
          const isSelected = idx === selectedIndex && !item.disabled;
          const isDisabled = item.disabled;

          // Skip codex header to add space
          if (item.id === 'codex-connect') {
            return (
              <Box key={item.id} flexDirection="column" marginTop={2}>
                <Text bold color="white">Codex</Text>
                <Text color="gray">{'─'.repeat(5)}</Text>
                <Box marginTop={1}>
                  <Text color={isSelected ? 'cyan' : 'gray'} dimColor={isDisabled}>
                    {isSelected ? '▸ ' : '  '}
                    {item.label}
                  </Text>
                </Box>
              </Box>
            );
          }

          return (
            <Box key={item.id} marginBottom={1}>
              <Text
                color={isSelected ? 'cyan' : isDisabled ? 'gray' : 'white'}
                dimColor={isDisabled}
              >
                {isSelected ? '▸ ' : '  '}
                {item.type === 'toggle' && (
                  <Text color={item.value ? 'green' : 'gray'}>
                    [{item.value ? '✓' : ' '}]{' '}
                  </Text>
                )}
                {item.type === 'action' && <Text color="blue">[◉] </Text>}
                {(item.type === 'connect' || item.type === 'disconnect') && (
                  <Text color={item.type === 'connect' ? 'green' : 'red'}>
                    [{item.type === 'connect' ? '+' : '−'}]{' '}
                  </Text>
                )}
                {item.label}
              </Text>
            </Box>
          );
        })}
      </Box>

      {/* Status/Progress */}
      {(actionStatus || enrichingProgress) && (
        <Box paddingX={1} marginBottom={1}>
          {enrichingProgress ? (
            <Text color="cyan">
              Generating title {enrichingProgress.current}/{enrichingProgress.total}...
            </Text>
          ) : actionStatus ? (
            <Text
              color={
                actionStatus.type === 'success'
                  ? 'green'
                  : actionStatus.type === 'error'
                    ? 'red'
                    : 'cyan'
              }
            >
              {actionStatus.message}
            </Text>
          ) : null}
        </Box>
      )}

      {/* Footer */}
      <Box flexDirection="column">
        <Box paddingX={1}>
          <Text color="gray">{'─'.repeat(Math.max(0, width - 2))}</Text>
        </Box>
        <Box paddingX={1}>
          <Text color="gray">
            <Text bold color="white">j/k</Text> navigate ·{' '}
            <Text bold color="white">Space/Enter</Text> select ·{' '}
            <Text bold color="white">q</Text> quit
          </Text>
        </Box>
      </Box>
    </Box>
  );
}

export async function configCommand(): Promise<void> {
  if (!process.stdin.isTTY) {
    // Non-interactive mode: just print current config
    const config = loadConfig();
    console.log('\nDex Configuration:\n');
    console.log(JSON.stringify(config, null, 2));
    return;
  }

  const app = withFullScreen(<ConfigApp />);
  await app.start();
  await app.waitUntilExit();
}

