import React from 'react';
import { Box, Text } from 'ink';

export interface SelectableRowProps {
  isSelected: boolean;
  children: React.ReactNode;
  /** Width of the row for potential full-width styling */
  width?: number;
}

/**
 * A reusable row component with consistent selection highlighting.
 * Uses cyan background with black text for selected state, matching
 * the analytics dashboard and other components.
 */
export function SelectableRow({ isSelected, children }: SelectableRowProps) {
  return (
    <Box>
      <Text
        backgroundColor={isSelected ? 'cyan' : undefined}
        color={isSelected ? 'black' : undefined}
      >
        {isSelected ? ' \u25B8 ' : '   '}
      </Text>
      {children}
    </Box>
  );
}

/**
 * Selection indicator character for inline use
 */
export function SelectionIndicator({ isSelected }: { isSelected: boolean }) {
  return (
    <Text
      backgroundColor={isSelected ? 'cyan' : undefined}
      color={isSelected ? 'black' : undefined}
    >
      {isSelected ? ' \u25B8 ' : '   '}
    </Text>
  );
}
