// HTTP surface.
//
// Checks the boundaries rather than re-testing the service layer: is the feature
// gate honoured, is every route authenticated, is the pairing endpoint reachable
// by a device that has no session, and can one account touch another's devices.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/http/server.js';
import { createHarness, type Harness } from './helpers/deviceHarness.js';

async function login(app: FastifyInstance, username: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { username, password: 'StrongPass123!' },
  });
  const cookie = res.headers['set-cookie'];
  const raw = Array.isArray(cookie) ? cookie[0]! : String(cookie);
  return raw.split(';')[0]!;
}

describe('AGI Command — HTTP routes', () => {
  let h: Harness;
  let app: FastifyInstance;
  let cookie: string;

  beforeEach(async () => {
    h = createHarness();
    app = await buildServer({ storage: h.storage, agi: h.agi });
    cookie = await login(app, 'router');
  });
  afterEach(async () => {
    await app.close();
    h.cleanup();
  });

  it('requires authentication on every device route', async () => {
    for (const [method, url] of [
      ['GET', '/api/devices'],
      ['POST', '/api/devices/pairing-sessions'],
      ['GET', '/api/device-groups'],
      ['GET', '/api/device-commands'],
      ['GET', '/api/workflows'],
      ['GET', '/api/agi-command/status'],
      ['GET', '/api/agi-command/stream'],
    ] as const) {
      const res = await app.inject({ method, url });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it('issues a pairing code and pairs a device that has no session', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/devices/pairing-sessions',
      headers: { cookie },
    });
    expect(created.statusCode).toBe(200);
    const { code } = created.json() as { code: string };

    // Deliberately no cookie: the caller is a device holding the code.
    const paired = await app.inject({
      method: 'POST',
      url: '/api/devices/pair',
      payload: { code, name: 'Phone One', deviceType: 'android_phone' },
    });
    expect(paired.statusCode).toBe(200);
    const body = paired.json() as { credential: string; deviceId: string };
    expect(body.credential).toMatch(/^agid_/);

    const list = await app.inject({ method: 'GET', url: '/api/devices', headers: { cookie } });
    const devices = (list.json() as { devices: { id: string; name: string }[] }).devices;
    expect(devices.map((d) => d.name)).toContain('Phone One');
  });

  it('never returns a device credential in the device listing', async () => {
    const user = (await h.storage.users.getByUsername('router'))!;
    h.addDevice(user.id, 'Phone One');

    const res = await app.inject({ method: 'GET', url: '/api/devices', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    // No secret material anywhere in the payload the browser receives.
    expect(res.body).not.toMatch(/agid_/);
    expect(res.body).not.toMatch(/secret/i);
  });

  it('rejects a malformed body with 400, not 500', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/device-commands',
      headers: { cookie },
      payload: { capability: 'app.open' }, // no target
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'BAD_REQUEST' });
  });

  it('returns 409 with the candidates when a target is ambiguous', async () => {
    const user = (await h.storage.users.getByUsername('router'))!;
    h.addDevice(user.id, 'Phone One', { deviceType: 'android_phone' });
    h.addDevice(user.id, 'Phone Two', { deviceType: 'android_phone' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/device-commands',
      headers: { cookie },
      payload: {
        capability: 'app.open',
        parameters: { appId: 'youtube' },
        target: { includeDeviceNames: ['Phone'] },
      },
    });
    expect(res.statusCode).toBe(409);
    const body = res.json() as { error: string; ambiguous: { candidates: unknown[] }[] };
    expect(body.error).toBe('AMBIGUOUS_TARGET');
    expect(body.ambiguous[0]!.candidates).toHaveLength(2);
  });

  it('stops one account reaching another account\'s device', async () => {
    const owner = h.storage.users.getByUsername('router')!;
    const device = h.addDevice(owner.id, 'Private Phone');
    const intruderCookie = await login(app, 'intruder');

    const read = await app.inject({
      method: 'GET',
      url: `/api/devices/${device.id}`,
      headers: { cookie: intruderCookie },
    });
    expect(read.statusCode).toBe(404);

    const revoke = await app.inject({
      method: 'DELETE',
      url: `/api/devices/${device.id}`,
      headers: { cookie: intruderCookie },
    });
    expect(revoke.statusCode).toBe(404);

    const command = await app.inject({
      method: 'POST',
      url: '/api/device-commands',
      headers: { cookie: intruderCookie },
      payload: {
        capability: 'device.ping',
        parameters: {},
        target: { includeDeviceIds: [device.id] },
      },
    });
    // Resolves to nothing, so it asks who they meant rather than acting.
    expect(command.statusCode).toBe(409);
  });

  it('refuses a group containing a device the caller does not own', async () => {
    const other = h.createUser('someone-else');
    const foreign = h.addDevice(other.id, 'Foreign');

    const res = await app.inject({
      method: 'POST',
      url: '/api/device-groups',
      headers: { cookie },
      payload: { name: 'Sneaky', deviceIds: [foreign.id] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('exposes the capability catalogue without secrets', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/device-capabilities',
      headers: { cookie },
    });
    const body = res.json() as { capabilities: { name: string; risk: string }[] };
    expect(body.capabilities.map((c) => c.name)).toContain('app.open');
    // Prohibited actions are absent from the catalogue entirely.
    expect(body.capabilities.map((c) => c.name)).not.toContain('shell.exec');
  });

  it('reports the feature as available with gateway state', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/agi-command/status',
      headers: { cookie },
    });
    const body = res.json() as { enabled: boolean; gateway: { configured: boolean } };
    expect(body.enabled).toBe(true);
    expect(body.gateway.configured).toBe(true);
  });
});

describe('AGI Command — disabled', () => {
  let h: Harness;
  let app: FastifyInstance;
  let cookie: string;

  beforeEach(async () => {
    h = createHarness({ enabled: false });
    app = await buildServer({ storage: h.storage, agi: h.agi });
    cookie = await login(app, 'offuser');
  });
  afterEach(async () => {
    await app.close();
    h.cleanup();
  });

  it('reports the feature off with a reason instead of pretending', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/agi-command/status',
      headers: { cookie },
    });
    const body = res.json() as { enabled: boolean; reason: string };
    expect(body.enabled).toBe(false);
    expect(body.reason).toMatch(/AGI_COMMAND_ENABLED/);
  });

  it('returns 503 with an explanation on device routes', async () => {
    for (const url of ['/api/devices', '/api/device-commands', '/api/workflows']) {
      const res = await app.inject({ method: 'GET', url, headers: { cookie } });
      expect(res.statusCode, url).toBe(503);
      expect(res.json()).toMatchObject({ error: 'FEATURE_DISABLED' });
    }
  });

  it('keeps the rest of AGI-v1 working', async () => {
    const health = await app.inject({ method: 'GET', url: '/healthz' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ ok: true, agiCommand: false });

    const conversation = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: { cookie },
      payload: {},
    });
    expect(conversation.statusCode).toBe(200);

    const list = await app.inject({
      method: 'GET',
      url: '/api/conversations',
      headers: { cookie },
    });
    expect(list.statusCode).toBe(200);
    expect((list.json() as unknown[]).length).toBe(1);
  });

  it('keeps the internal gateway surface shut', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/internal/gateway/heartbeat',
      headers: { 'x-agi-gateway-secret': 'test-server-secret-that-is-long-enough-32' },
      payload: { deviceId: 'dev_x' },
    });
    expect(res.statusCode).toBe(503);
  });
});
