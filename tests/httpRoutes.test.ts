import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/http/server.js';
import { storageFromDb, type Storage } from '../src/storage/index.js';

vi.mock('../src/llm/embeddings.js', () => ({
  embed: vi.fn(async () => new Float32Array(384)),
}));

const PASSWORD = 'StrongPass123!';

function cookieFrom(response: { headers: Record<string, string | string[] | undefined> }): string {
  const header = response.headers['set-cookie'];
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) throw new Error('Authentication response did not set a cookie');
  return value.split(';', 1)[0]!;
}

describe.sequential('HTTP route integration', () => {
  let db: Database.Database;
  let storage: Storage;
  let app: FastifyInstance;

  beforeEach(async () => {
    process.env.CAPABILITY_BUILDER_ENABLED = 'true';
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    storage = storageFromDb(db);
    app = await buildServer(storage);
  });

  afterEach(async () => {
    await app.close();
    db.close();
    delete process.env.CAPABILITY_BUILDER_ENABLED;
  });

  async function register(username: string): Promise<{ cookie: string; id: string }> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username, password: PASSWORD, displayName: username.toUpperCase() },
    });
    expect(response.statusCode).toBe(200);
    return { cookie: cookieFrom(response), id: response.json().id as string };
  }

  it('serves health and protects every private collection', async () => {
    const health = await app.inject({ method: 'GET', url: '/healthz' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ ok: true, storage: 'sqlite' });

    for (const url of [
      '/api/me',
      '/api/conversations',
      '/api/memories',
      '/api/people',
      '/api/capabilities',
    ]) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode, url).toBe(401);
      expect(response.json()).toMatchObject({ error: 'UNAUTHORIZED' });
    }
  });

  it('registers, logs in, rejects duplicates, and clears the session', async () => {
    const weak = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'alice', password: 'weak' },
    });
    expect(weak.statusCode).toBe(400);

    const account = await register('alice');
    const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: account.cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ id: account.id, username: 'alice', displayName: 'ALICE' });

    const duplicate = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'alice', password: PASSWORD },
    });
    expect(duplicate.statusCode).toBe(409);

    const wrongPassword = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'alice', password: 'WrongPass123!' },
    });
    expect(wrongPassword.statusCode).toBe(401);

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'alice', password: PASSWORD },
    });
    expect(login.statusCode).toBe(200);
    const logout = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie: cookieFrom(login) },
    });
    expect(logout.statusCode).toBe(200);
    expect(logout.headers['set-cookie']).toContain('agi_token=;');
  });

  it('keeps conversations, messages, memories, people, and capabilities user-scoped', async () => {
    const alice = await register('alice');
    const bob = await register('bob');

    const created = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: { cookie: alice.cookie },
      payload: { title: 'Private plan' },
    });
    expect(created.statusCode).toBe(200);
    const conversationId = created.json().id as string;

    await storage.messages.insert({
      conversationId,
      userId: alice.id,
      role: 'user',
      content: 'Alice-only message',
    });
    const memory = await storage.memories.insert({
      userId: alice.id,
      conversationId,
      kind: 'fact',
      content: 'Alice prefers ultramarine',
    });
    const person = await storage.people.upsert({
      userId: alice.id,
      displayName: 'Sarah',
      relationship: 'friend',
    });
    await storage.personMemories.link(person.id, memory.id);
    await storage.capabilityRequests.create(alice.id, 'Build an offline word counting tool');

    const aliceMessages = await app.inject({
      method: 'GET',
      url: `/api/conversations/${conversationId}/messages`,
      headers: { cookie: alice.cookie },
    });
    expect(aliceMessages.statusCode).toBe(200);
    expect(aliceMessages.json()).toHaveLength(1);

    const bobMessages = await app.inject({
      method: 'GET',
      url: `/api/conversations/${conversationId}/messages`,
      headers: { cookie: bob.cookie },
    });
    expect(bobMessages.statusCode).toBe(404);

    const rename = await app.inject({
      method: 'PATCH',
      url: `/api/conversations/${conversationId}`,
      headers: { cookie: alice.cookie },
      payload: { title: 'Renamed plan' },
    });
    expect(rename.statusCode).toBe(200);
    expect(rename.json().title).toBe('Renamed plan');

    const memories = await app.inject({ method: 'GET', url: '/api/memories', headers: { cookie: alice.cookie } });
    expect(memories.json()).toEqual([expect.objectContaining({ content: 'Alice prefers ultramarine' })]);
    const bobMemories = await app.inject({ method: 'GET', url: '/api/memories', headers: { cookie: bob.cookie } });
    expect(bobMemories.json()).toEqual([]);

    const people = await app.inject({ method: 'GET', url: '/api/people', headers: { cookie: alice.cookie } });
    expect(people.json()).toEqual([expect.objectContaining({ displayName: 'Sarah' })]);
    const personDetail = await app.inject({
      method: 'GET',
      url: `/api/people/${person.id}`,
      headers: { cookie: alice.cookie },
    });
    expect(personDetail.json()).toMatchObject({ displayName: 'Sarah', memories: [expect.objectContaining({ id: memory.id })] });
    const bobPerson = await app.inject({
      method: 'GET',
      url: `/api/people/${person.id}`,
      headers: { cookie: bob.cookie },
    });
    expect(bobPerson.statusCode).toBe(404);
    const bobDeleteMemory = await app.inject({
      method: 'DELETE',
      url: `/api/memories/${memory.id}`,
      headers: { cookie: bob.cookie },
    });
    expect(bobDeleteMemory.statusCode).toBe(404);
    const aliceDeleteMemory = await app.inject({
      method: 'DELETE',
      url: `/api/memories/${memory.id}`,
      headers: { cookie: alice.cookie },
    });
    expect(aliceDeleteMemory.statusCode).toBe(200);
    expect(await storage.memories.getById(memory.id)).toBeNull();

    const capabilities = await app.inject({
      method: 'GET',
      url: '/api/capabilities',
      headers: { cookie: alice.cookie },
    });
    expect(capabilities.statusCode).toBe(200);
    expect(capabilities.json()).toEqual([expect.objectContaining({ user_id: alice.id })]);
    const bobCapabilities = await app.inject({
      method: 'GET',
      url: '/api/capabilities',
      headers: { cookie: bob.cookie },
    });
    expect(bobCapabilities.json()).toEqual([]);

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/conversations/${conversationId}`,
      headers: { cookie: alice.cookie },
    });
    expect(removed.statusCode).toBe(200);
    const missing = await app.inject({
      method: 'GET',
      url: `/api/conversations/${conversationId}/messages`,
      headers: { cookie: alice.cookie },
    });
    expect(missing.statusCode).toBe(404);
  });

  it('returns safe 400 responses for malformed chat, memory, and capability inputs', async () => {
    const alice = await register('alice');
    const checks = [
      app.inject({
        method: 'POST',
        url: '/api/chat',
        headers: { cookie: alice.cookie },
        payload: { conversationId: '', content: '' },
      }),
      app.inject({
        method: 'GET',
        url: '/api/memories?limit=0',
        headers: { cookie: alice.cookie },
      }),
      app.inject({
        method: 'POST',
        url: '/api/capabilities/build',
        headers: { cookie: alice.cookie },
        payload: { task: 'short' },
      }),
    ];

    for (const response of await Promise.all(checks)) {
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: 'BAD_REQUEST' });
      expect(response.body).not.toContain('stack');
    }
  });

  it('enforces auth, capability, and chat rate limits for remote clients', async () => {
    const authAddress = '198.51.100.10';
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        remoteAddress: authAddress,
        payload: { username: 'x', password: 'weak' },
      });
      expect(response.statusCode).toBe(400);
    }
    const authLimited = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      remoteAddress: authAddress,
      payload: { username: 'x', password: 'weak' },
    });
    expect(authLimited.statusCode).toBe(429);
    expect(authLimited.json()).toMatchObject({ error: 'RATE_LIMITED' });

    const alice = await register('alice');
    const capabilityAddress = '198.51.100.20';
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/capabilities/build',
        remoteAddress: capabilityAddress,
        headers: { cookie: alice.cookie },
        payload: { task: 'short' },
      });
      expect(response.statusCode).toBe(400);
    }
    const capabilityLimited = await app.inject({
      method: 'POST',
      url: '/api/capabilities/build',
      remoteAddress: capabilityAddress,
      headers: { cookie: alice.cookie },
      payload: { task: 'short' },
    });
    expect(capabilityLimited.statusCode).toBe(429);
    expect(capabilityLimited.json()).toMatchObject({ error: 'RATE_LIMITED' });

    const chatAddress = '198.51.100.30';
    for (let attempt = 0; attempt < 30; attempt++) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/chat',
        remoteAddress: chatAddress,
        headers: { cookie: alice.cookie },
        payload: { conversationId: '', content: '' },
      });
      expect(response.statusCode).toBe(400);
    }
    const chatLimited = await app.inject({
      method: 'POST',
      url: '/api/chat',
      remoteAddress: chatAddress,
      headers: { cookie: alice.cookie },
      payload: { conversationId: '', content: '' },
    });
    expect(chatLimited.statusCode).toBe(429);
    expect(chatLimited.json()).toMatchObject({ error: 'RATE_LIMITED' });
  });
});
