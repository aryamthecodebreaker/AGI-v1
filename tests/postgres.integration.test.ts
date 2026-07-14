import dotenv from 'dotenv';
import { afterEach, describe, expect, it } from 'vitest';
import { neon } from '@neondatabase/serverless';
import { createPostgresStorage } from '../src/storage/postgres/index.js';

dotenv.config({ path: '.env.local' });

const databaseUrl = process.env.DATABASE_URL;
const shouldRun = process.env.RUN_POSTGRES_INTEGRATION === '1' && Boolean(databaseUrl);
const createdUserIds: string[] = [];

describe.skipIf(!shouldRun)('Neon Postgres integration', () => {
  afterEach(async () => {
    if (!databaseUrl || createdUserIds.length === 0) return;
    const sql = neon(databaseUrl);
    for (const userId of createdUserIds.splice(0)) {
      await sql.query('DELETE FROM users WHERE id = $1', [userId]);
    }
  });

  it('shares auth, messages, and memory search across storage instances', async () => {
    const storageA = await createPostgresStorage(databaseUrl!);
    const username = `codex_neon_smoke_${Date.now()}`;
    const user = await storageA.users.create({ username, passwordHash: 'test-only' });
    createdUserIds.push(user.id);

    const conversation = await storageA.conversations.create(user.id, 'Shared storage smoke');
    await storageA.messages.insert({
      conversationId: conversation.id,
      userId: user.id,
      role: 'user',
      content: 'Neon shared state works',
    });
    await storageA.memories.insert({
      userId: user.id,
      conversationId: conversation.id,
      kind: 'fact',
      content: 'Neon shared state works',
    });

    // A separately-created adapter represents another Vercel function instance.
    const storageB = await createPostgresStorage(databaseUrl!);
    const crossInstanceUser = await storageB.users.getById(user.id);
    const messages = await storageB.messages.listByConversation(conversation.id);
    const ftsHits = await storageB.memories.ftsSearch(user.id, 'shared state', 5);
    const capability = await storageA.capabilityRequests.create(user.id, 'Build a shared-state test tool');
    await storageA.capabilityRequests.update(capability.id, {
      status: 'validating',
      slug: 'shared-state-tool',
    });
    const capabilityFromB = await storageB.capabilityRequests.getById(capability.id);

    expect(storageB.kind).toBe('postgres');
    expect(crossInstanceUser?.username).toBe(username);
    expect(messages.map((message) => message.content)).toContain('Neon shared state works');
    expect(ftsHits.map((hit) => hit.memory.content)).toContain('Neon shared state works');
    expect(capabilityFromB?.status).toBe('validating');
  });
});
