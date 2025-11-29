import React from 'react';
import { Text } from 'ink';

export interface HighlightedTextProps {
  text: string;
  query: string;
  dimColor?: boolean;
}

/**
 * Render text with highlighted search terms (yellow + bold)
 */
export function HighlightedText({
  text,
  query,
  dimColor,
}: HighlightedTextProps) {
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 0);
  if (terms.length === 0) {
    return <Text dimColor={dimColor}>{text}</Text>;
  }

  // Build regex to match any term
  const escapedTerms = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const regex = new RegExp(`(${escapedTerms.join('|')})`, 'gi');

  const parts = text.split(regex);

  return (
    <Text dimColor={dimColor} wrap="wrap">
      {parts.map((part, i) => {
        const isMatch = terms.some((t) => part.toLowerCase() === t);
        if (isMatch) {
          return <Text key={i} backgroundColor="yellow" color="black" bold>{part}</Text>;
        }
        return <Text key={i}>{part}</Text>;
      })}
    </Text>
  );
}
