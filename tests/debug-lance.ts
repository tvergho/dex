import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import * as lancedb from '@lancedb/lancedb';

async function test() {
  const tempDir = await mkdtemp(join(tmpdir(), 'lance-debug-'));
  const db = await lancedb.connect(join(tempDir, 'test.db'));
  
  // Use snake_case column name instead
  const table = await db.createTable('test', [
    { id: 'msg-1', conversation_id: 'conv-1', content: 'Hello' },
    { id: 'msg-2', conversation_id: 'conv-1', content: 'World' },
  ]);
  
  console.log('All rows:', await table.query().toArray());
  console.log('Filter snake_case:', await table.query().filter(`conversation_id = 'conv-1'`).toArray());
  
  // Now try delete
  await table.delete(`conversation_id = 'conv-1'`);
  console.log('After delete:', await table.query().toArray());
  
  await rm(tempDir, { recursive: true, force: true });
  console.log('SUCCESS: snake_case works!');
}
test().catch(console.error);
