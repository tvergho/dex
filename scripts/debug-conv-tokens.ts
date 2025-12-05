#!/usr/bin/env npx tsx
/**
 * Debug a specific conversation's bubble token data
 * Run: npx tsx scripts/debug-conv-tokens.ts "svg refiner"
 */

import Database from 'better-sqlite3';
import { homedir } from 'os';
import { join } from 'path';

const searchTerm = process.argv[2] || '';
const dbPath = join(homedir(), 'Library/Application Support/Cursor/User/globalStorage/state.vscdb');

interface TokenCount { inputTokens?: number; outputTokens?: number }
interface Bubble { type?: number; text?: string; tokenCount?: TokenCount }

try {
  const db = new Database(dbPath, { readonly: true });

  const composerStmt = db.prepare("SELECT key, value FROM ItemTable WHERE key LIKE 'composerData:%'");

  for (const row of composerStmt.iterate() as IterableIterator<{ key: string; value: string }>) {
    try {
      const data = JSON.parse(row.value);
      const name = (data.name || '') as string;

      if (searchTerm && !name.toLowerCase().includes(searchTerm.toLowerCase())) continue;

      console.log(`\n=== ${name} ===`);
      console.log(`Mode: ${data.forceMode || 'unknown'}`);

      const bubbles: Bubble[] = data.conversation || [];
      if (bubbles.length === 0 && data.conversationMap) {
        const headers = (data.fullConversationHeadersOnly || []) as Array<{ bubbleId?: string }>;
        for (const h of headers) {
          if (h.bubbleId && data.conversationMap[h.bubbleId]) {
            bubbles.push(data.conversationMap[h.bubbleId]);
          }
        }
      }

      bubbles.forEach((b, i) => {
        const type = b.type === 1 ? 'user' : b.type === 2 ? 'asst' : `t${b.type}`;
        const text = (b.text || '').slice(0, 40).replace(/\n/g, ' ');
        const tok = b.tokenCount;
        const hasTokens = tok && (tok.inputTokens || tok.outputTokens);
        console.log(`${i + 1}. [${type}] ${hasTokens ? `${tok?.inputTokens || 0}/${tok?.outputTokens || 0}` : 'NO TOKENS'} "${text}..."`);
      });

      if (searchTerm) break;
      if (!searchTerm) { console.log('\n(pass a search term to see specific conv)'); break; }
    } catch { /* skip */ }
  }

  db.close();
} catch (err) {
  console.error('Error:', err);
}
