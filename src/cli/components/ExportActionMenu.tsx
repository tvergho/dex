import React from 'react';
import { Box, Text } from 'ink';

export interface ExportActionMenuProps {
  selectedIndex: number;
  conversationCount: number;
  width: number;
  height: number;
}

const ACTIONS = [
  { label: 'Export to file', description: 'Save as markdown in ./dex-export/' },
  { label: 'Copy to clipboard', description: 'Copy markdown to clipboard' },
  { label: 'Show preview', description: 'Preview markdown before exporting' },
];

/**
 * Centered modal overlay for export action selection
 * Uses a solid background to ensure readability over content
 */
export function ExportActionMenu({
  selectedIndex,
  conversationCount,
  width,
  height,
}: ExportActionMenuProps) {
  const menuWidth = Math.min(60, width - 4);
  const menuHeight = 11;

  // Center the menu
  const leftPadding = Math.floor((width - menuWidth) / 2);
  const topPadding = Math.floor((height - menuHeight) / 2);

  const title =
    conversationCount === 1
      ? 'Export conversation'
      : `Export ${conversationCount} conversations`;

  // Create solid background lines
  const bgLine = ' '.repeat(menuWidth - 2);

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

      {/* Title with background */}
      <Text>
        <Text color="cyan">│</Text>
        <Text backgroundColor="black">{' ' + title.padEnd(menuWidth - 4) + ' '}</Text>
        <Text color="cyan">│</Text>
      </Text>

      {/* Separator */}
      <Text>
        <Text color="cyan">├{'─'.repeat(menuWidth - 2)}┤</Text>
      </Text>

      {/* Actions with solid background */}
      {ACTIONS.map((action, idx) => {
        const isSelected = idx === selectedIndex;
        const prefix = isSelected ? ' ▸ ' : '   ';
        const labelWithDesc = `${prefix}${action.label.padEnd(20)} ${action.description}`;
        const paddedContent = labelWithDesc.slice(0, menuWidth - 4).padEnd(menuWidth - 4);

        return (
          <Text key={action.label}>
            <Text color="cyan">│</Text>
            <Text
              backgroundColor={isSelected ? 'cyan' : 'black'}
              color={isSelected ? 'black' : 'white'}
              bold={isSelected}
            >
              {' ' + paddedContent + ' '}
            </Text>
            <Text color="cyan">│</Text>
          </Text>
        );
      })}

      {/* Empty line for spacing */}
      <Text>
        <Text color="cyan">│</Text>
        <Text backgroundColor="black">{bgLine}</Text>
        <Text color="cyan">│</Text>
      </Text>

      {/* Footer */}
      <Text>
        <Text color="cyan">│</Text>
        <Text backgroundColor="black">
          {' '}
          <Text bold color="white">Enter</Text>
          <Text color="gray"> select · </Text>
          <Text bold color="white">Esc</Text>
          <Text color="gray"> cancel</Text>
          {' '.repeat(Math.max(0, menuWidth - 28))}
        </Text>
        <Text color="cyan">│</Text>
      </Text>

      {/* Bottom border */}
      <Text color="cyan">{'╰' + '─'.repeat(menuWidth - 2) + '╯'}</Text>
    </Box>
  );
}
