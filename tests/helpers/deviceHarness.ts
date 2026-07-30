// Shared test scaffolding for AGI Command.
//
// Two harnesses, deliberately:
//
//   createHarness()      — in-process, with a recording fake gateway. Fast, and
//                          lets a test drive device results precisely.
//   createLiveHarness()  — the real app server, the real gateway, real
//                          WebSockets and real simulated agents. Slower, but it
//                          is the only way to prove the wire actually works.
//
// Neither needs cloud credentials, an API key, or a physical device.

import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { storageFromDb, type Storage } from '../../src/storage/index.js';
import { createAgiCommand, type AgiCommand } from '../../src/devices/index.js';
import { resetPairingRateLimits } from '../../src/devices/deviceService.js';
import type { DeviceSettings } from '../../src/config.js';
import type { GatewayClient } from '../../src/devices/gatewayClient.js';
import type { CommandDispatch } from '../../src/devices/protocol.js';
import { createHttpGatewayClient } from '../../src/devices/gatewayClient.js';
import { createGatewayServer, type GatewayServer } from '../../src/gateway/server.js';
import { buildServer } from '../../src/http/server.js';
import { createSimulatedDevice, type SimulatedDevice } from '../../agents/simulated/device.js';

export const TEST_SERVER_SECRET = 'test-server-secret-that-is-long-enough-32';

export function testSettings(overrides: Partial<DeviceSettings> = {}): DeviceSettings {
  return {
    enabled: true,
    gatewayUrl: 'http://127.0.0.1:0',
    gatewayInternalSecret: TEST_SERVER_SECRET,
    gatewayPort: 0,
    gatewayAppUrl: 'http://127.0.0.1:0',
    pairingTtlMs: 300_000,
    commandTimeoutMs: 2000,
    heartbeatIntervalMs: 5000,
    offlineAfterMs: 45_000,
    eventRetentionDays: 30,
    ...overrides,
  };
}

export interface DispatchRecord {
  deviceId: string;
  envelope: CommandDispatch;
}

export interface Harness {
  storage: Storage;
  agi: AgiCommand;
  settings: DeviceSettings;
  /** Every dispatch the command service handed to the gateway. */
  dispatches: DispatchRecord[];
  cancels: { deviceId: string; commandId: string; executionId: string }[];
  /** Make the fake gateway refuse to deliver, as if the device vanished. */
  setDeliverable(deliverable: boolean, reason?: string): void;
  createUser(username?: string): { id: string };
  /** Pair a device and mark it connected, ready to receive commands. */
  addDevice(
    userId: string,
    name: string,
    options?: {
      deviceType?: 'android_phone' | 'android_tablet' | 'windows' | 'browser' | 'generic' | 'simulated';
      capabilities?: string[];
      online?: boolean;
    },
  ): { id: string; credential: string };
  /** Reply to the newest dispatch for a device as that device would. */
  completeLatest(deviceId: string, result?: Record<string, unknown>): void;
  failLatest(
    deviceId: string,
    code?: 'unsupported' | 'rejected' | 'failed' | 'duplicate' | 'invalid_parameters',
    message?: string,
  ): void;
  cleanup(): void;
}

const DEFAULT_CAPABILITIES = [
  'device.ping',
  'device.status',
  'battery.read',
  'app.open',
  'url.open',
  'media.play',
  'media.pause',
  'media.next',
  'volume.get',
  'volume.set',
  'volume.mute',
  'volume.unmute',
  'screen.wake',
  'notification.show',
];

export function createHarness(settingsOverrides: Partial<DeviceSettings> = {}): Harness {
  resetPairingRateLimits();

  const tmpPath = path.join(
    os.tmpdir(),
    `agi-devices-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
  const db = new Database(tmpPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  const storage = storageFromDb(db);
  const settings = testSettings(settingsOverrides);

  const dispatches: DispatchRecord[] = [];
  const cancels: { deviceId: string; commandId: string; executionId: string }[] = [];
  let deliverable = true;
  let refusalReason = 'device is not connected';

  const gateway: GatewayClient = {
    configured: () => true,
    async dispatch(deviceId, envelope) {
      if (!deliverable) return { delivered: false, reason: refusalReason };
      dispatches.push({ deviceId, envelope });
      return { delivered: true };
    },
    async cancel(deviceId, commandId, executionId) {
      cancels.push({ deviceId, commandId, executionId });
      return { delivered: true };
    },
    async health() {
      return { ok: true, connections: 0 };
    },
    async connectedDeviceIds() {
      return [];
    },
  };

  const agi = createAgiCommand(storage, {
    settings,
    serverSecret: TEST_SERVER_SECRET,
    gateway,
  });

  let userCounter = 0;

  function latestFor(deviceId: string): DispatchRecord {
    for (let i = dispatches.length - 1; i >= 0; i--) {
      if (dispatches[i]!.deviceId === deviceId) return dispatches[i]!;
    }
    throw new Error(`no dispatch recorded for device ${deviceId}`);
  }

  return {
    storage,
    agi,
    settings,
    dispatches,
    cancels,

    setDeliverable(next, reason) {
      deliverable = next;
      if (reason) refusalReason = reason;
    },

    createUser(username?: string) {
      userCounter++;
      return storage.users.create({
        username: username ?? `user${userCounter}`,
        passwordHash: 'hash',
      });
    },

    addDevice(userId, name, options = {}) {
      const issued = agi.devices.createPairingSession(userId);
      const paired = agi.devices.pairDevice({
        code: issued.code,
        name,
        deviceType: options.deviceType ?? 'simulated',
        platform: 'test',
        capabilities: (options.capabilities ?? DEFAULT_CAPABILITIES).map((n) => ({
          name: n,
          version: 1,
        })),
        sourceKey: `test-${userId}`,
      });
      if (options.online !== false) {
        storage.devices.markConnected(paired.device.id);
      }
      return { id: paired.device.id, credential: paired.credentialToken };
    },

    completeLatest(deviceId, result = {}) {
      const record = latestFor(deviceId);
      agi.commands.ingestResult({
        deviceId,
        commandId: record.envelope.commandId,
        executionId: record.envelope.executionId,
        type: 'completed',
        result,
      });
    },

    failLatest(deviceId, code = 'failed', message = 'simulated failure') {
      const record = latestFor(deviceId);
      agi.commands.ingestResult({
        deviceId,
        commandId: record.envelope.commandId,
        executionId: record.envelope.executionId,
        type: 'failed',
        failure: { code, message },
      });
    },

    cleanup() {
      db.close();
      for (const suffix of ['', '-wal', '-shm']) {
        try {
          fs.unlinkSync(tmpPath + suffix);
        } catch {
          /* ignore */
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Live harness — real HTTP, real WebSockets, real agents
// ---------------------------------------------------------------------------

export interface LiveHarness {
  storage: Storage;
  agi: AgiCommand;
  settings: DeviceSettings;
  app: FastifyInstance;
  gateway: GatewayServer;
  appUrl: string;
  gatewayWsUrl: string;
  createUser(username?: string): { id: string };
  newPairingCode(userId: string): string;
  /** Start a simulated agent, pair it, and wait until it is online. */
  startDevice(
    userId: string,
    name: string,
    options?: Partial<Omit<SimulatedDeviceOptions, 'name' | 'appUrl' | 'gatewayUrl'>>,
  ): Promise<SimulatedDevice>;
  waitForOnline(deviceId: string, timeoutMs?: number): Promise<void>;
  cleanup(): Promise<void>;
}

type SimulatedDeviceOptions = Parameters<typeof createSimulatedDevice>[0];

export async function createLiveHarness(
  settingsOverrides: Partial<DeviceSettings> = {},
): Promise<LiveHarness> {
  resetPairingRateLimits();

  const tmpPath = path.join(
    os.tmpdir(),
    `agi-live-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
  const credentialDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agi-agent-'));

  const db = new Database(tmpPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  const storage = storageFromDb(db);

  // gatewayUrl is filled in once the gateway has a real port; the HTTP client
  // reads it lazily, so wiring order does not matter.
  const settings = testSettings({ commandTimeoutMs: 4000, ...settingsOverrides });
  const gatewayClient = createHttpGatewayClient(settings);

  const agi = createAgiCommand(storage, {
    settings,
    serverSecret: TEST_SERVER_SECRET,
    gateway: gatewayClient,
  });

  const app = await buildServer({ storage, agi });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const appAddress = app.server.address();
  const appPort = typeof appAddress === 'object' && appAddress ? appAddress.port : 0;
  const appUrl = `http://127.0.0.1:${appPort}`;

  const gateway = createGatewayServer({
    port: 0,
    host: '127.0.0.1',
    internalSecret: TEST_SERVER_SECRET,
    appUrl,
    heartbeatIntervalMs: 30_000,
    offlineAfterMs: 120_000,
    logLevel: 'error',
  });
  const { port: gatewayPort } = await gateway.listen();

  settings.gatewayUrl = `http://127.0.0.1:${gatewayPort}`;
  settings.gatewayAppUrl = appUrl;
  const gatewayWsUrl = `ws://127.0.0.1:${gatewayPort}/agent`;

  const devices: SimulatedDevice[] = [];
  let userCounter = 0;

  const newPairingCode = (userId: string): string =>
    agi.devices.createPairingSession(userId).code;

  async function waitForOnline(deviceId: string, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const device = storage.devices.getById(deviceId);
      if (device?.connectedAt !== null && device !== null) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`device ${deviceId} did not come online within ${timeoutMs}ms`);
  }

  return {
    storage,
    agi,
    settings,
    app,
    gateway,
    appUrl,
    gatewayWsUrl,

    createUser(username?: string) {
      userCounter++;
      return storage.users.create({
        username: username ?? `live${userCounter}`,
        passwordHash: 'hash',
      });
    },

    newPairingCode,

    async startDevice(userId, name, options = {}) {
      const device = createSimulatedDevice({
        name,
        appUrl,
        gatewayUrl: gatewayWsUrl,
        credentialPath: path.join(credentialDir, `${name.replace(/\W+/g, '-')}.json`),
        ...options,
      } as SimulatedDeviceOptions);
      devices.push(device);

      await device.agent.pair(newPairingCode(userId));
      await device.agent.start();
      const deviceId = device.agent.deviceId!;
      // Two separate facts, and the server learns first: it marks the device
      // connected during the handshake, while the agent only reports
      // "connected" once server.welcome arrives. Wait for both so tests never
      // race the tail of the handshake.
      await waitForOnline(deviceId);
      await waitFor(
        () => device.agent.state === 'connected',
        5000,
        `${name} agent to finish its handshake`,
      );
      return device;
    },

    waitForOnline,

    async cleanup() {
      for (const device of devices) await device.agent.stop().catch(() => {});
      await gateway.close().catch(() => {});
      await app.close().catch(() => {});
      db.close();
      for (const suffix of ['', '-wal', '-shm']) {
        try {
          fs.unlinkSync(tmpPath + suffix);
        } catch {
          /* ignore */
        }
      }
      try {
        fs.rmSync(credentialDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

/** Poll until a predicate holds, so tests never race a background transition. */
export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5000,
  label = 'condition',
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${label}`);
}
