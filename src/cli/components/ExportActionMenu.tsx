import React from 'react';
import { Box, Text } from 'ink';

export interface ExportActionMenuProps {
  selectedIndex: number;
  conversationCount: number;
  width: number;
  height: number;
}

const ACTIONS = [
  { label: 'Export to file', description: 'Save as markdown' },
  { label: 'Copy to clipboard', description: 'Copy markdown to clipboard' },
];

/**
 * Centered modal overlay for export action selection
 * Simplified 2-option design with improved spacing and contrast
 */
export function ExportActionMenu({
  selectedIndex,
  conversationCount,
  width,
  height,
}: ExportActionMenuProps) {
  const menuWidth = Math.min(44, width - 4);
  const menuHeight = 14; // Increased for better spacing

  // Center the menu
  const leftPadding = Math.floor((width - menuWidth) / 2);
  const topPadding = Math.floor((height - menuHeight) / 2);

  const title =
    conversationCount === 1
      ? 'Export conversation'
      : `Export ${conversationCount} conversations`;

  // Helper to create a padded line
  const pad = (content: string) => content.padEnd(menuWidth - 4);

  return (
    <Box
      position="absolute"
      marginLeft={leftPadding}
      marginTop={topPadding}
      width={menuWidth}
      flexDirection="column"
    >
      {/* Top border */}
      <Text color="cyan">{'╭' + '─'.repeat(menuWidth - 2) + '╮'}</Text>

      {/* Empty line for top padding */}
      <Text>
        <Text color="cyan">│</Text>
        <Text backgroundColor="black">{' '.repeat(menuWidth - 2)}</Text>
        <Text color="cyan">│</Text>
      </Text>

      {/* Title */}
      <Text>
        <Text color="cyan">│</Text>
        <Text backgroundColor="black" color="white" bold>{' ' + pad(title) + ' '}</Text>
        <Text color="cyan">│</Text>
      </Text>

      {/* Empty line after title */}
      <Text>
        <Text color="cyan">│</Text>
        <Text backgroundColor="black">{' '.repeat(menuWidth - 2)}</Text>
        <Text color="cyan">│</Text>
      </Text>

      {/* Actions with description on separate line */}
      {ACTIONS.map((action, idx) => {
        const isSelected = idx === selectedIndex;
        const prefix = isSelected ? '  ▸ ' : '    ';

        return (
          <React.Fragment key={action.label}>
            {/* Action label */}
            <Text>
              <Text color="cyan">│</Text>
              <Text
                backgroundColor={isSelected ? 'cyan' : 'black'}
                color={isSelected ? 'black' : 'white'}
                bold={isSelected}
              >
                {pad(prefix + action.label) + '  '}
              </Text>
              <Text color="cyan">│</Text>
            </Text>
            {/* Action description */}
            <Text>
              <Text color="cyan">│</Text>
              <Text
                backgroundColor={isSelected ? 'cyan' : 'black'}
                color={isSelected ? 'black' : 'gray'}
              >
                {pad('      ' + action.description) + '  '}
              </Text>
              <Text color="cyan">│</Text>
            </Text>
            {/* Spacing between options */}
            {idx < ACTIONS.length - 1 && (
              <Text>
                <Text color="cyan">│</Text>
                <Text backgroundColor="black">{' '.repeat(menuWidth - 2)}</Text>
                <Text color="cyan">│</Text>
              </Text>
            )}
          </React.Fragment>
        );
      })}

      {/* Empty line before footer */}
      <Text>
        <Text color="cyan">│</Text>
        <Text backgroundColor="black">{' '.repeat(menuWidth - 2)}</Text>
        <Text color="cyan">│</Text>
      </Text>

      {/* Footer */}
      <Text>
        <Text color="cyan">│</Text>
        <Text backgroundColor="black">
          {'  '}
          <Text color="white">Enter</Text>
          <Text color="gray"> select · </Text>
          <Text color="white">Esc</Text>
          <Text color="gray"> cancel</Text>
          {' '.repeat(Math.max(0, menuWidth - 28))}
        </Text>
        <Text color="cyan">│</Text>
      </Text>

      {/* Empty line for bottom padding */}
      <Text>
        <Text color="cyan">│</Text>
        <Text backgroundColor="black">{' '.repeat(menuWidth - 2)}</Text>
        <Text color="cyan">│</Text>
      </Text>

      {/* Bottom border */}
      <Text color="cyan">{'╰' + '─'.repeat(menuWidth - 2) + '╯'}</Text>
    </Box>
  );
}
