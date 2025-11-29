/**
 * ActivityHeatmap component - GitHub-style contribution heatmap
 *
 * Design: iOS GitHub widget aesthetic
 * - Visible empty cells (dim gray) for structure
 * - 2-char wide cells for square proportions
 * - Green color gradient for intensity
 * - Generous spacing that fills terminal width
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { DayActivity } from '../../db/analytics';

// Block characters - filled for active cells, light shade for empty
const BLOCK_FILLED = '█';
const BLOCK_EMPTY = '░';

// Day of week labels (starting Sunday)
const DAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

// Month names for labels
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export interface ActivityHeatmapProps {
  data: DayActivity[];
  weeks?: number;
  width: number;
  metric?: 'conversations' | 'messages' | 'tokens';
  showLegend?: boolean;
}

/**
 * Get cell character and style based on intensity
 * 0 = empty (░ in gray)
 * 1-4 = filled (█ in increasing green intensity)
 */
function getCellInfo(intensity: number): { char: string; color: string; dimColor?: boolean; bold?: boolean } {
  switch (intensity) {
    case 0:
      return { char: BLOCK_EMPTY, color: 'gray' };
    case 1:
      return { char: BLOCK_FILLED, color: 'green', dimColor: true };
    case 2:
      return { char: BLOCK_FILLED, color: 'green' };
    case 3:
      return { char: BLOCK_FILLED, color: 'greenBright' };
    case 4:
      return { char: BLOCK_FILLED, color: 'greenBright', bold: true };
    default:
      return { char: BLOCK_EMPTY, color: 'gray' };
  }
}

/**
 * Generate a complete date range for the heatmap
 */
function generateDateRange(weeks: number): string[] {
  const dates: string[] = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const totalDays = weeks * 7;
  const startDate = new Date(today);
  startDate.setDate(startDate.getDate() - totalDays + 1);

  // Adjust to start on Sunday
  const startDay = startDate.getDay();
  if (startDay !== 0) {
    startDate.setDate(startDate.getDate() - startDay);
  }

  const current = new Date(startDate);
  while (current <= today) {
    dates.push(current.toISOString().split('T')[0]!);
    current.setDate(current.getDate() + 1);
  }

  return dates;
}

/**
 * Get the value to display based on selected metric
 */
function getMetricValue(activity: DayActivity | undefined, metric: string): number {
  if (!activity) return 0;
  switch (metric) {
    case 'conversations':
      return activity.conversations;
    case 'messages':
      return activity.messages;
    case 'tokens':
      return activity.tokens;
    default:
      return activity.conversations;
  }
}

/**
 * Map value to intensity level (0-4)
 */
function getIntensity(value: number, maxValue: number): number {
  if (value === 0 || maxValue === 0) return 0;
  const normalized = value / maxValue;
  if (normalized >= 0.75) return 4;
  if (normalized >= 0.5) return 3;
  if (normalized >= 0.25) return 2;
  return 1;
}

/**
 * Get month labels positioned proportionally across total width
 */
function getMonthLabels(
  dates: string[],
  numWeeks: number,
  totalWidth: number
): { month: string; position: number }[] {
  const labels: { month: string; position: number }[] = [];
  let lastMonth = -1;

  for (let weekIdx = 0; weekIdx < numWeeks; weekIdx++) {
    const dateIdx = weekIdx * 7;
    if (dateIdx >= dates.length) break;

    const date = new Date(dates[dateIdx]!);
    const month = date.getMonth();

    if (month !== lastMonth) {
      const position = Math.floor((weekIdx / numWeeks) * totalWidth);
      const lastLabel = labels[labels.length - 1];

      if (!lastLabel || position >= lastLabel.position + lastLabel.month.length + 2) {
        labels.push({ month: MONTH_NAMES[month]!, position });
        lastMonth = month;
      }
    }
  }
  return labels;
}

/**
 * Render GitHub-style activity heatmap
 */
export function ActivityHeatmap({
  data,
  weeks = 12,
  width,
  metric = 'conversations',
  showLegend = true,
}: ActivityHeatmapProps) {
  // Create a map for quick lookup
  const activityMap = new Map<string, DayActivity>();
  for (const day of data) {
    activityMap.set(day.date, day);
  }

  // Generate date range
  const dates = generateDateRange(weeks);

  // Find max value for scaling
  let maxValue = 0;
  for (const date of dates) {
    const value = getMetricValue(activityMap.get(date), metric);
    maxValue = Math.max(maxValue, value);
  }

  // Build grid: rows = days of week (7), cols = weeks
  const grid: number[][] = [];
  for (let day = 0; day < 7; day++) {
    grid[day] = [];
  }

  for (let i = 0; i < dates.length; i++) {
    const date = new Date(dates[i]!);
    const dayOfWeek = date.getDay();
    const value = getMetricValue(activityMap.get(dates[i]!), metric);
    const intensity = getIntensity(value, maxValue);
    grid[dayOfWeek]!.push(intensity);
  }

  // Ensure all rows have same length
  const numWeeks = Math.ceil(dates.length / 7);
  for (let day = 0; day < 7; day++) {
    while (grid[day]!.length < numWeeks) {
      grid[day]!.push(0);
    }
  }

  // Fixed layout: 2-char cells with 1-char spacing (compact like GitHub)
  const cellWidth = 2;  // Two characters for square proportions
  const spacing = 1;    // Fixed 1-char spacing between cells

  // Get month labels positioned across full width
  const totalGridWidth = numWeeks * (cellWidth + spacing);
  const monthLabels = getMonthLabels(dates, numWeeks, totalGridWidth);

  // Count active days
  let activeDays = 0;
  for (const date of dates) {
    if (getMetricValue(activityMap.get(date), metric) > 0) {
      activeDays++;
    }
  }

  return (
    <Box flexDirection="column">
      {/* Month labels row */}
      <Box>
        <Text>{'  '}</Text>
        <Text>
          {(() => {
            let labelStr = '';
            let lastEnd = 0;
            for (const { month, position } of monthLabels) {
              const spacesNeeded = position - lastEnd;
              if (spacesNeeded > 0) {
                labelStr += ' '.repeat(spacesNeeded);
              }
              labelStr += month;
              lastEnd = position + month.length;
            }
            return <Text color="gray">{labelStr}</Text>;
          })()}
        </Text>
      </Box>

      {/* Grid - 2-char cells with fixed spacing */}
      {grid.map((row, dayIdx) => (
        <Box key={dayIdx}>
          <Text color="gray">{DAY_LABELS[dayIdx]} </Text>
          <Text>
            {row.map((intensity, weekIdx) => {
              const info = getCellInfo(intensity);
              const cellStr = info.char.repeat(cellWidth) + ' '.repeat(spacing);

              return (
                <Text
                  key={weekIdx}
                  color={info.color}
                  dimColor={info.dimColor}
                  bold={info.bold}
                >
                  {cellStr}
                </Text>
              );
            })}
          </Text>
        </Box>
      ))}

      {/* Legend */}
      {showLegend && (
        <Box marginTop={1}>
          <Text color="gray">Less </Text>
          {[0, 1, 2, 3, 4].map((intensity) => {
            const info = getCellInfo(intensity);
            return (
              <Text
                key={intensity}
                color={info.color}
                dimColor={info.dimColor}
                bold={info.bold}
              >
                {info.char}
              </Text>
            );
          })}
          <Text color="gray"> More  {activeDays} active days</Text>
        </Box>
      )}
    </Box>
  );
}

/**
 * Horizontal bar chart for hour-of-day activity
 */
export interface HourlyActivityProps {
  data: number[];
  width: number;
  color?: string;
}

export function HourlyActivity({ data, width, color = 'cyan' }: HourlyActivityProps) {
  if (data.length !== 24) {
    return <Text color="gray">Invalid hourly data</Text>;
  }

  const max = Math.max(...data);
  if (max === 0) {
    return <Text color="gray">No activity data</Text>;
  }

  const buckets: { label: string; value: number }[] = [
    { label: ' 0-2 ', value: data[0]! + data[1]! + data[2]! },
    { label: ' 3-5 ', value: data[3]! + data[4]! + data[5]! },
    { label: ' 6-8 ', value: data[6]! + data[7]! + data[8]! },
    { label: ' 9-11', value: data[9]! + data[10]! + data[11]! },
    { label: '12-14', value: data[12]! + data[13]! + data[14]! },
    { label: '15-17', value: data[15]! + data[16]! + data[17]! },
    { label: '18-20', value: data[18]! + data[19]! + data[20]! },
    { label: '21-23', value: data[21]! + data[22]! + data[23]! },
  ];

  const bucketMax = Math.max(...buckets.map(b => b.value));
  const total = buckets.reduce((sum, b) => sum + b.value, 0);
  const maxIdx = buckets.findIndex(b => b.value === bucketMax);
  const barWidth = Math.max(20, Math.min(width - 20, 40));

  return (
    <Box flexDirection="column">
      {buckets.map((bucket, idx) => {
        const filledWidth = bucketMax > 0 ? Math.round((bucket.value / bucketMax) * barWidth) : 0;
        const bar = '█'.repeat(Math.max(0, filledWidth));
        const pct = total > 0 ? Math.round((bucket.value / total) * 100) : 0;
        const isMax = idx === maxIdx && bucket.value > 0;

        return (
          <Box key={idx}>
            <Text color="gray">{bucket.label} </Text>
            <Text color={color}>{bar}</Text>
            {bucket.value > 0 && (
              <Text color="gray">
                {' '}{String(bucket.value).padStart(3)} ({String(pct).padStart(2)}%)
              </Text>
            )}
            {isMax && <Text color="yellow"> ←</Text>}
          </Box>
        );
      })}
    </Box>
  );
}

/**
 * Day-of-week activity chart with percentages
 */
export interface WeeklyActivityProps {
  data: number[];
  width: number;
  color?: string;
}

export function WeeklyActivity({ data, width, color = 'cyan' }: WeeklyActivityProps) {
  if (data.length !== 7) {
    return <Text color="gray">Invalid weekly data</Text>;
  }

  const max = Math.max(...data);
  const total = data.reduce((a, b) => a + b, 0);
  if (max === 0 || total === 0) {
    return <Text color="gray">No activity data</Text>;
  }

  const maxIdx = data.indexOf(max);
  const barWidth = Math.max(15, Math.min(width - 20, 30));

  return (
    <Box flexDirection="column">
      {DAY_LABELS.map((label, idx) => {
        const value = data[idx]!;
        const filledWidth = max > 0 ? Math.round((value / max) * barWidth) : 0;
        const bar = '█'.repeat(Math.max(0, filledWidth));
        const pct = Math.round((value / total) * 100);
        const isMax = idx === maxIdx && value > 0;

        return (
          <Box key={idx}>
            <Text color="gray">{label} </Text>
            <Text color={color}>{bar}</Text>
            {value > 0 && (
              <Text color="gray">
                {' '}{String(value).padStart(3)} ({String(pct).padStart(2)}%)
              </Text>
            )}
            {isMax && <Text color="yellow"> ←</Text>}
          </Box>
        );
      })}
    </Box>
  );
}
