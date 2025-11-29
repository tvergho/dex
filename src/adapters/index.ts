import { cursorAdapter } from './cursor/index';
import type { SourceAdapter } from './types';

// Registry of all available adapters
export const adapters: SourceAdapter[] = [cursorAdapter];

export function getAdapter(name: string): SourceAdapter | undefined {
  return adapters.find((a) => a.name === name);
}

export * from './types';
