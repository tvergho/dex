import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

async function test() {
  const tempDir = await mkdtemp(join(tmpdir(), 'dex-debug-'));
  process.env.DEX_DATA_DIR = tempDir;

  const { resetConnection, connect } = await import('../src/db/index');
  resetConnection();
  await connect();

  const { messageRepo, conversationRepo } = await import('../src/db/repository');

  const convId = 'test-conv-id';
  await conversationRepo.upsert({
    id: convId, title: 'Test', source: 'cursor',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  } as any);

  await messageRepo.bulkInsert([{
    id: 'msg-1', conversationId: convId, role: 'user',
    content: 'Old content', messageIndex: 0, timestamp: new Date().toISOString(),
  }] as any);

  console.log('Before:', (await messageRepo.findByConversation(convId)).map(m => m.content));
  await messageRepo.deleteByConversation(convId);
  console.log('After delete:', (await messageRepo.findByConversation(convId)).map(m => m.content));

  await messageRepo.bulkInsert([{
    id: 'msg-2', conversationId: convId, role: 'user',
    content: 'New content', messageIndex: 0, timestamp: new Date().toISOString(),
  }] as any);
  console.log('After insert:', (await messageRepo.findByConversation(convId)).map(m => m.content));

  await rm(tempDir, { recursive: true, force: true });
  console.log('Done');
}
test().catch(console.error);
