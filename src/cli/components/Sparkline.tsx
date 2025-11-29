/**
 * Sparkline component - renders a small inline trend chart
 * Uses Unicode block characters: ▁▂▃▄▅▆▇█
 */

import React from 'react';
import { Text } from 'ink';

const BLOCKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

export interface SparklineProps {
  data: number[];
  width?: number;
  color?: string;
  showTrend?: boolean;
}

/**
 * Calculate trend direction and percentage change from data
 */
function getTrendInfo(data: number[]): { direction: 'up' | 'down' | 'flat'; percent: number } {
  if (data.length < 2) return { direction: 'flat', percent: 0 };

  // Compare first half average to second half average
  const mid = Math.floor(data.length / 2);
  const firstHalf = data.slice(0, mid);
  const secondHalf = data.slice(mid);

  const firstAvg = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
  const secondAvg = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;

  const diff = secondAvg - firstAvg;
  const threshold = Math.max(firstAvg, secondAvg) * 0.1; // 10% threshold

  // Calculate percentage change
  const percent = firstAvg > 0 ? Math.round((diff / firstAvg) * 100) : 0;

  if (diff > threshold) return { direction: 'up', percent: Math.abs(percent) };
  if (diff < -threshold) return { direction: 'down', percent: Math.abs(percent) };
  return { direction: 'flat', percent: 0 };
}

/**
 * Render a sparkline from numeric data
 */
export function Sparkline({ data, width, color = 'cyan', showTrend = false }: SparklineProps) {
  if (data.length === 0) {
    return <Text dimColor>No data</Text>;
  }

  // Resample data if width is specified and different from data length
  let displayData = data;
  if (width && width > 0 && width !== data.length) {
    displayData = resample(data, width);
  }

  const max = Math.max(...displayData);
  const min = Math.min(...displayData);
  const range = max - min || 1;

  // Map values to block characters
  const sparkline = displayData.map(value => {
    const normalized = (value - min) / range;
    const index = Math.min(Math.floor(normalized * BLOCKS.length), BLOCKS.length - 1);
    return BLOCKS[index];
  }).join('');

  // Get trend indicator
  const trendInfo = showTrend ? getTrendInfo(data) : null;
  const trendChar = trendInfo?.direction === 'up' ? '↑' : trendInfo?.direction === 'down' ? '↓' : '';
  const trendColor = trendInfo?.direction === 'up' ? 'green' : trendInfo?.direction === 'down' ? 'red' : 'gray';

  return (
    <Text>
      <Text color={color}>{sparkline}</Text>
      {showTrend && trendInfo && trendInfo.direction !== 'flat' && (
        <Text color={trendColor}> {trendChar}{trendInfo.percent}%</Text>
      )}
    </Text>
  );
}

/**
 * Resample data to a target length using linear interpolation
 */
function resample(data: number[], targetLength: number): number[] {
  if (data.length === 0) return [];
  if (data.length === 1) return new Array(targetLength).fill(data[0]);

  const result: number[] = [];
  const step = (data.length - 1) / (targetLength - 1);

  for (let i = 0; i < targetLength; i++) {
    const pos = i * step;
    const lower = Math.floor(pos);
    const upper = Math.min(Math.ceil(pos), data.length - 1);
    const t = pos - lower;

    result.push(data[lower]! * (1 - t) + data[upper]! * t);
  }

  return result;
}
