/**
 * Date/time utilities for testing
 */

/**
 * Create an ISO date string for N days ago
 */
export function daysAgo(n: number): string {
  const date = new Date();
  date.setDate(date.getDate() - n);
  return date.toISOString();
}

/**
 * Create an ISO date string for N days from now
 */
export function daysFromNow(n: number): string {
  const date = new Date();
  date.setDate(date.getDate() + n);
  return date.toISOString();
}

/**
 * Create a date string in YYYY-MM-DD format
 */
export function toDateString(date: Date): string {
  return date.toISOString().split('T')[0]!;
}

/**
 * Create a YYYY-MM-DD string for N days ago
 */
export function daysAgoString(n: number): string {
  const date = new Date();
  date.setDate(date.getDate() - n);
  return toDateString(date);
}

/**
 * Create an ISO date string for a specific date
 */
export function isoDate(year: number, month: number, day: number): string {
  return new Date(year, month - 1, day).toISOString();
}

/**
 * Create a YYYY-MM-DD string for a specific date
 */
export function dateString(year: number, month: number, day: number): string {
  const m = month.toString().padStart(2, '0');
  const d = day.toString().padStart(2, '0');
  return `${year}-${m}-${d}`;
}




