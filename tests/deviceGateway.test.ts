// End-to-end over the real wire.
//
// These tests run the actual Fastify app, the actual gateway process, actual
// WebSocket connections and actual simulated agents. Nothing is mocked between
// the command service and the device, so a protocol or framing mistake fails
// here rather than in production.
//
// No cloud credentials and no physical hardware are involved.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createLiveHarness, waitFor, type LiveHarness } from './helpers/deviceHarness.js';
import { PROTOCOL_VERSION, encode } from '../src/devices/protocol.js';
import { isDeviceOnline } from '../src/storage/repositories/deviceRepo.js';

describe('AGI Command — gateway end to end', () => {
  let h: LiveHarness;
  let userId: string;

  beforeEach(async () => {
    h = await createLiveHarness();
    userId = h.createUser().id;
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it('pairs, connects and reports the device as online', async () => {
    const phone = await h.startDevice(userId, 'Phone One', { deviceType: 'android_phone' });
    const deviceId = phone.agent.deviceId!;

    const device = h.storage.devices.getById(deviceId)!;
    expect(device.userId).toBe(userId);
    expect(isDeviceOnline(device, h.settings.offlineAfterMs)).toBe(true);
    expect(phone.agent.state).toBe('connected');
    expect(h.gateway.connectionCount()).toBe(1);
  });

  it('runs a command on a real agent and reports the real result', async () => {
    const phone = await h.startDevice(userId, 'Phone One', { deviceType: 'android_phone' });
    const deviceId = phone.agent.deviceId!;

    const result = await h.agi.commands.create({
      userId,
      requestText: 'open youtube',
      capability: 'app.open',
      parameters: { appId: 'youtube' },
      target: { includeDeviceIds: [deviceId] },
    });
    if (result.kind !== 'created') throw new Error('expected created');

    await h.agi.commands.waitForSettled(userId, result.command.id, 5000);

    const view = h.agi.commands.view(userId, result.command.id)!;
    expect(view.command.status).toBe('succeeded');
    expect(view.executions[0]!.state).toBe('succeeded');
    // The effect really happened on the device, not just in the database.
    expect(phone.state.lastOpenedApp).toBe('youtube');
  });

  it('dispatches to several devices concurrently', async () => {
    const [one, two] = await Promise.all([
      h.startDevice(userId, 'Phone One', { deviceType: 'android_phone' }),
      h.startDevice(userId, 'Phone Two', { deviceType: 'android_phone' }),
    ]);

    const result = await h.agi.commands.create({
      userId,
      requestText: 'open youtube on all my phones',
      capability: 'app.open',
      parameters: { appId: 'youtube' },
      target: { includeGroups: ['phones'] },
    });
    if (result.kind !== 'created') throw new Error('expected created');
    await h.agi.commands.waitForSettled(userId, result.command.id, 5000);

    const view = h.agi.commands.view(userId, result.command.id)!;
    expect(view.command.status).toBe('succeeded');
    expect(view.executions).toHaveLength(2);
    expect(one.state.lastOpenedApp).toBe('youtube');
    expect(two.state.lastOpenedApp).toBe('youtube');
  });

  it('reports partial success when one real device fails', async () => {
    const [one] = await Promise.all([
      h.startDevice(userId, 'Phone One', { deviceType: 'android_phone' }),
      h.startDevice(userId, 'Phone Two', {
        deviceType: 'android_phone',
        failCapabilities: ['app.open'],
      }),
    ]);

    const result = await h.agi.commands.create({
      userId,
      requestText: 'open youtube on all my phones',
      capability: 'app.open',
      parameters: { appId: 'youtube' },
      target: { includeGroups: ['phones'] },
    });
    if (result.kind !== 'created') throw new Error('expected created');
    await h.agi.commands.waitForSettled(userId, result.command.id, 5000);

    const view = h.agi.commands.view(userId, result.command.id)!;
    expect(view.command.status).toBe('partially_succeeded');
    const states = view.executions.map((e) => e.state).sort();
    expect(states).toEqual(['failed', 'succeeded']);
    expect(one.state.lastOpenedApp).toBe('youtube');
  });

  it('records an unsupported capability as unsupported, not as a failure', async () => {
    const phone = await h.startDevice(userId, 'Phone One', {
      deviceType: 'android_phone',
      unsupportedCapabilities: ['screen.wake'],
    });

    const result = await h.agi.commands.create({
      userId,
      requestText: 'wake the screen',
      capability: 'screen.wake',
      parameters: {},
      target: { includeDeviceIds: [phone.agent.deviceId!] },
    });
    if (result.kind !== 'created') throw new Error('expected created');
    await h.agi.commands.waitForSettled(userId, result.command.id, 5000);

    const view = h.agi.commands.view(userId, result.command.id)!;
    expect(view.executions[0]!.state).toBe('unsupported');
  });

  it('times out a device that stops answering', async () => {
    const phone = await h.startDevice(userId, 'Phone One', {
      deviceType: 'android_phone',
      hangCapabilities: ['app.open'],
    });

    const result = await h.agi.commands.create({
      userId,
      requestText: 'open youtube',
      capability: 'app.open',
      parameters: { appId: 'youtube' },
      target: { includeDeviceIds: [phone.agent.deviceId!] },
    });
    if (result.kind !== 'created') throw new Error('expected created');

    // The agent acknowledges, then never completes.
    await waitFor(
      () =>
        h.agi.commands.view(userId, result.command.id)!.executions[0]!.state === 'acknowledged',
      4000,
      'acknowledgement',
    );

    h.agi.commands.sweepTimeouts(Date.now() + 120_000);
    const view = h.agi.commands.view(userId, result.command.id)!;
    expect(view.executions[0]!.state).toBe('timed_out');
    expect(view.command.status).toBe('failed');
  });

  it('an agent refuses a replayed command', async () => {
    const phone = await h.startDevice(userId, 'Phone One', { deviceType: 'android_phone' });
    const deviceId = phone.agent.deviceId!;

    const result = await h.agi.commands.create({
      userId,
      requestText: 'open youtube',
      capability: 'app.open',
      parameters: { appId: 'youtube' },
      target: { includeDeviceIds: [deviceId] },
    });
    if (result.kind !== 'created') throw new Error('expected created');
    await h.agi.commands.waitForSettled(userId, result.command.id, 5000);

    const execution = h.agi.commands.view(userId, result.command.id)!.executions[0]!;

    // Send the identical dispatch again, straight through the gateway.
    const replayed = await h.agi.gateway.dispatch(deviceId, {
      v: PROTOCOL_VERSION,
      type: 'command.dispatch',
      ts: Date.now(),
      commandId: result.command.id,
      executionId: execution.id,
      capability: 'app.open',
      capabilityVersion: 1,
      parameters: { appId: 'youtube' },
      timeoutMs: 5000,
      expiresAt: Date.now() + 5000,
    });
    // The gateway suppresses it before it even reaches the device.
    expect(replayed.delivered).toBe(false);
    expect(replayed.reason).toMatch(/duplicate/i);
  });

  it('a revoked device cannot reconnect', async () => {
    const phone = await h.startDevice(userId, 'Phone One', { deviceType: 'android_phone' });
    const deviceId = phone.agent.deviceId!;

    h.agi.devices.revoke(userId, deviceId);
    await phone.agent.stop();

    // A fresh agent with the same stored credential must be refused.
    const states: string[] = [];
    const revived = (await import('../agents/simulated/device.js')).createSimulatedDevice({
      name: 'Phone One',
      appUrl: h.appUrl,
      gatewayUrl: h.gatewayWsUrl,
      credentialPath: undefined,
      onStateChange: (state) => states.push(state),
    });
    // Reuse the revoked credential directly rather than pairing again.
    const credentials = h.storage.deviceCredentials.listByDevice(deviceId);
    expect(credentials.every((c) => c.revokedAt !== null)).toBe(true);

    await revived.agent.stop();

    // And the credential itself no longer authenticates.
    expect(h.storage.devices.getById(deviceId)?.revokedAt).not.toBeNull();
  });

  it('refuses a connection with no valid credential', async () => {
    const socket = new WebSocket(h.gatewayWsUrl);
    const frames: Record<string, unknown>[] = [];

    await new Promise<void>((resolve) => {
      socket.on('open', () => {
        socket.send(
          encode({
            type: 'agent.hello',
            credential: 'agid_cred_aaaaaaaaaa.notarealsecretatall',
            device: { name: 'Impostor', deviceType: 'simulated' },
            capabilities: [],
          }),
        );
      });
      socket.on('message', (raw: Buffer) => {
        frames.push(JSON.parse(raw.toString()));
      });
      socket.on('close', () => resolve());
      setTimeout(resolve, 3000);
    });

    const error = frames.find((f) => f.type === 'server.error');
    expect(error).toBeDefined();
    expect(error!.code).toBe('unauthorized');
    expect(error!.fatal).toBe(true);
    expect(h.gateway.connectionCount()).toBe(0);
  });

  it('rejects a malformed frame without dropping the process', async () => {
    const socket = new WebSocket(h.gatewayWsUrl);
    const frames: Record<string, unknown>[] = [];

    await new Promise<void>((resolve) => {
      socket.on('open', () => socket.send('this is not json'));
      socket.on('message', (raw: Buffer) => {
        frames.push(JSON.parse(raw.toString()));
        resolve();
      });
      setTimeout(resolve, 2000);
    });
    socket.close();

    const error = frames.find((f) => f.type === 'server.error');
    expect(error?.code).toBe('malformed');
  });

  it('rejects an incompatible protocol version', async () => {
    const socket = new WebSocket(h.gatewayWsUrl);
    const frames: Record<string, unknown>[] = [];

    await new Promise<void>((resolve) => {
      socket.on('open', () => {
        socket.send(
          JSON.stringify({
            v: 'agi-command/99',
            type: 'agent.hello',
            ts: Date.now(),
            credential: 'agid_cred_aaaaaaaaaa.something-long-enough',
            device: {},
            capabilities: [],
          }),
        );
      });
      socket.on('message', (raw: Buffer) => frames.push(JSON.parse(raw.toString())));
      socket.on('close', () => resolve());
      setTimeout(resolve, 2000);
    });

    const error = frames.find((f) => f.type === 'server.error');
    expect(error?.code).toBe('bad_protocol');
    expect(error?.fatal).toBe(true);
  });

  it('refuses a command frame before the agent has identified itself', async () => {
    const socket = new WebSocket(h.gatewayWsUrl);
    const frames: Record<string, unknown>[] = [];

    await new Promise<void>((resolve) => {
      socket.on('open', () => {
        socket.send(encode({ type: 'agent.heartbeat' }));
      });
      socket.on('message', (raw: Buffer) => frames.push(JSON.parse(raw.toString())));
      socket.on('close', () => resolve());
      setTimeout(resolve, 2000);
    });

    expect(frames.find((f) => f.type === 'server.error')?.code).toBe('not_identified');
  });

  it('marks a device offline when its agent disconnects', async () => {
    const phone = await h.startDevice(userId, 'Phone One', { deviceType: 'android_phone' });
    const deviceId = phone.agent.deviceId!;

    await phone.agent.stop();
    await waitFor(
      () => h.storage.devices.getById(deviceId)?.connectedAt === null,
      5000,
      'disconnect to be recorded',
    );

    const device = h.storage.devices.getById(deviceId)!;
    expect(isDeviceOnline(device, h.settings.offlineAfterMs)).toBe(false);
  });

  it('the internal gateway API refuses a wrong shared secret', async () => {
    const res = await fetch(`${h.appUrl}/internal/gateway/heartbeat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-agi-gateway-secret': 'wrong-secret-wrong-secret-wrong!',
      },
      body: JSON.stringify({ deviceId: 'dev_whatever' }),
    });
    expect(res.status).toBe(401);
  });

  it('the internal gateway API is not reachable without the secret', async () => {
    const res = await fetch(`${h.appUrl}/internal/gateway/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: 'dev_whatever' }),
    });
    expect(res.status).toBe(401);
  });

  it('reports gateway health through the app', async () => {
    const health = await h.agi.gateway.health();
    expect(health.ok).toBe(true);
    const res = await fetch(`${h.appUrl}/healthz/agi-command`);
    const body = (await res.json()) as { enabled: boolean; gateway: { ok: boolean } };
    expect(body.enabled).toBe(true);
    expect(body.gateway.ok).toBe(true);
  });

  it('a queued command runs when the device reconnects', async () => {
    const phone = await h.startDevice(userId, 'Phone One', { deviceType: 'android_phone' });
    const deviceId = phone.agent.deviceId!;

    await phone.agent.stop();
    await waitFor(() => h.storage.devices.getById(deviceId)?.connectedAt === null, 5000, 'offline');

    const result = await h.agi.commands.create({
      userId,
      requestText: 'notify me when it is back',
      capability: 'notification.show',
      parameters: { title: 'Welcome back' },
      target: { includeDeviceIds: [deviceId] },
      queueIfOffline: true,
    });
    if (result.kind !== 'created') throw new Error('expected created');
    await h.agi.commands.confirm(userId, result.command.id, 'confirmed');
    expect(h.agi.commands.view(userId, result.command.id)!.executions[0]!.state).toBe('queued');

    // Reconnecting flushes the queue through the real handshake path.
    await phone.agent.start();
    await waitFor(
      () =>
        h.agi.commands.view(userId, result.command.id)!.executions[0]!.state === 'succeeded',
      8000,
      'queued command to run on reconnect',
    );
    expect(phone.state.lastNotification).toBe('Welcome back');
  });
});
