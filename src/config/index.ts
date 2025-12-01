/**
 * Dex Configuration System
 *
 * Manages persisted settings in ~/.dex/config.json
 */

import { z } from 'zod';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { getDataDir } from '../utils/config.js';

/**
 * Provider configuration schema
 * - enabled: Connect/disconnect state (true = connected)
 * - autoEnrichSummaries: Whether to auto-generate titles during sync
 */
const ProviderConfigSchema = z.object({
  enabled: z.boolean().default(false),
  autoEnrichSummaries: z.boolean().default(false),
});

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

/**
 * Main Dex configuration schema
 */
export const DexConfigSchema = z.object({
  providers: z.object({
    claudeCode: ProviderConfigSchema.default({}),
    codex: ProviderConfigSchema.default({}),
  }).default({}),
});

export type DexConfig = z.infer<typeof DexConfigSchema>;

/**
 * Get the path to the config file
 */
export function getConfigPath(): string {
  return join(getDataDir(), 'config.json');
}

/**
 * Load configuration from disk
 * Returns default config if file doesn't exist or is invalid
 */
export function loadConfig(): DexConfig {
  const configPath = getConfigPath();

  if (!existsSync(configPath)) {
    return DexConfigSchema.parse({});
  }

  try {
    const content = readFileSync(configPath, 'utf-8');
    const raw = JSON.parse(content);
    return DexConfigSchema.parse(raw);
  } catch {
    // Return default config on error
    return DexConfigSchema.parse({});
  }
}

/**
 * Save configuration to disk
 */
export function saveConfig(config: DexConfig): void {
  const configPath = getConfigPath();

  // Ensure directory exists
  const dir = dirname(configPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
}

/**
 * Update a specific provider's configuration
 */
export function updateProviderConfig(
  provider: 'claudeCode' | 'codex',
  updates: Partial<ProviderConfig>
): DexConfig {
  const config = loadConfig();
  config.providers[provider] = {
    ...config.providers[provider],
    ...updates,
  };
  saveConfig(config);
  return config;
}

/**
 * Check if a provider is connected (enabled)
 */
export function isProviderConnected(provider: 'claudeCode' | 'codex'): boolean {
  const config = loadConfig();
  return config.providers[provider].enabled;
}

/**
 * Check if auto-enrich is enabled for a provider
 */
export function isAutoEnrichEnabled(provider: 'claudeCode' | 'codex'): boolean {
  const config = loadConfig();
  return config.providers[provider].enabled && config.providers[provider].autoEnrichSummaries;
}

