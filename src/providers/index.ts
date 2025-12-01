/**
 * Provider registry
 *
 * Exports provider infrastructure for credentials and clients.
 * Designed to be extensible for additional providers (Codex, etc.)
 */

export * from './claude-code/credentials.js';
export * from './claude-code/client.js';

// Future: export * from './codex/credentials.js';
// Future: export * from './codex/client.js';

