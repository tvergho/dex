import React from 'react';
import { Text } from 'ink';

export interface SourceBadgeProps {
  source: string;
}

/**
 * Source badge with consistent colors across the app.
 * Shows full source name with source-specific color.
 */
export function SourceBadge({ source }: SourceBadgeProps) {
  const { name, color } = getSourceInfo(source);

  return (
    <Text color={color}>{name}</Text>
  );
}

/**
 * Get source display name and color.
 * Colors are consistent throughout the app:
 * - Cursor: cyan
 * - Claude Code: magenta
 * - Codex: yellow
 * - OpenCode: green
 */
function getSourceInfo(source: string): { name: string; color: string } {
  const normalized = source.toLowerCase();

  if (normalized === 'cursor') {
    return { name: 'Cursor', color: 'cyan' };
  }
  if (normalized === 'claude-code') {
    return { name: 'Claude Code', color: 'magenta' };
  }
  if (normalized === 'codex') {
    return { name: 'Codex', color: 'yellow' };
  }
  if (normalized === 'opencode') {
    return { name: 'OpenCode', color: 'green' };
  }

  // Unknown source - capitalize first letter
  return { name: source.charAt(0).toUpperCase() + source.slice(1), color: 'white' };
}

/**
 * Get the color for a source (useful for other components)
 */
export function getSourceColor(source: string): string {
  return getSourceInfo(source).color;
}
