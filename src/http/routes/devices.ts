// Device registry routes.
//
// Two different callers with two different credentials live in this file:
//
//   * Browser routes use the AGI-v1 session cookie (requireAuth).
//   * POST /api/devices/pair is called by a DEVICE, not a browser. Its only
//     credential is the short-lived pairing code, so it must not require a
//     session — the code is the authorisation. It is rate-limited inside
//     deviceService and returns a deliberately vague error on every failure.
//
// A browser never receives a device credential except in the one response that
// creates it (pair) or rotates it.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Storage } from '../../storage/index.js';
import { requireAuth } from '../../auth/middleware.js';
import type { AgiCommand } from '../../devices/index.js';
import { DEVICE_TYPES } from '../../storage/repositories/deviceRepo.js';
import { listCapabilities } from '../../devices/capabilities.js';
import { requireFeature } from './agiCommand.js';

const deviceTypeSchema = z.enum(
  DEVICE_TYPES as unknown as [string, ...string[]],
) as unknown as z.ZodType<(typeof DEVICE_TYPES)[number]>;

const pairSchema = z.object({
  code: z.string().min(4).max(32),
  name: z.string().min(1).max(80),
  deviceType: deviceTypeSchema,
  platform: z.string().max(64).optional(),
  platformVersion: z.string().max(64).optional(),
  agentVersion: z.string().max(32).optional(),
  protocolVersion: z.string().max(32).optional(),
  capabilities: z
    .array(z.object({ name: z.string().max(64), version: z.number().int().min(1).default(1) }))
    .max(200)
    .optional(),
  metadata: z.record(z.unknown()).optional(),
});

const patchSchema = z
  .object({
    name: z.string().min(1).max(80).optional(),
    isPrimary: z.literal(true).optional(),
    capabilities: z
      .array(z.object({ capability: z.string().max(64), enabled: z.boolean() }))
      .max(50)
      .optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'nothing to update' });

/** Shape sent to the browser. Contains no secrets. */
function serializeDevice(entry: {
  device: {
    id: string;
    name: string;
    deviceType: string;
    platform: string;
    platformVersion: string | null;
    agentVersion: string | null;
    isPrimary: boolean;
    lastSeenAt: number | null;
    revokedAt: number | null;
    createdAt: number;
    metadata: Record<string, unknown>;
  };
  online: boolean;
  capabilities: { capability: string; version: number; advertised: boolean; enabled: boolean }[];
  groups: { id: string; name: string; slug: string }[];
}) {
  return {
    id: entry.device.id,
    name: entry.device.name,
    deviceType: entry.device.deviceType,
    platform: entry.device.platform,
    platformVersion: entry.device.platformVersion,
    agentVersion: entry.device.agentVersion,
    isPrimary: entry.device.isPrimary,
    online: entry.online,
    lastSeenAt: entry.device.lastSeenAt,
    revoked: entry.device.revokedAt !== null,
    createdAt: entry.device.createdAt,
    metadata: entry.device.metadata,
    capabilities: entry.capabilities,
    groups: entry.groups,
  };
}

export async function deviceRoutes(
  app: FastifyInstance,
  storage: Storage,
  agi: AgiCommand,
): Promise<void> {
  const auth = requireAuth(storage);
  const feature = requireFeature(agi);

  // ---- pairing ----

  app.post(
    '/api/devices/pairing-sessions',
    { preHandler: [auth, feature] },
    async (req) => {
      const issued = agi.devices.createPairingSession(req.user!.id);
      // The plaintext code appears here and nowhere else — not in logs, not in
      // the events table.
      return {
        pairingId: issued.pairingId,
        code: issued.code,
        expiresAt: issued.expiresAt,
        expiresInSeconds: Math.round((issued.expiresAt - Date.now()) / 1000),
      };
    },
  );

  // Unauthenticated on purpose: the caller is a device holding a pairing code.
  app.post('/api/devices/pair', { preHandler: [feature] }, async (req) => {
    const body = pairSchema.parse(req.body);
    const result = agi.devices.pairDevice({
      ...body,
      capabilities: body.capabilities?.map((c) => ({ name: c.name, version: c.version })),
      sourceKey: req.ip,
    });
    return {
      deviceId: result.device.id,
      deviceName: result.device.name,
      // Returned exactly once. The server keeps only a hash.
      credential: result.credentialToken,
      acceptedCapabilities: result.acceptedCapabilities,
      rejectedCapabilities: result.rejectedCapabilities,
      protocolVersion: 'agi-command/1',
    };
  });

  // ---- registry ----

  app.get('/api/devices', { preHandler: [auth, feature] }, async (req) => {
    return { devices: agi.devices.listWithState(req.user!.id).map(serializeDevice) };
  });

  app.get('/api/devices/:id', { preHandler: [auth, feature] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const entry = agi.devices.getWithState(req.user!.id, id);
    if (!entry) return reply.status(404).send({ error: 'NOT_FOUND', message: 'Device not found' });
    return {
      device: serializeDevice(entry),
      recentEvents: storage.deviceEvents.listByDevice(id, 25).map((e) => ({
        kind: e.kind,
        detail: e.detail,
        at: e.createdAt,
      })),
      recentExecutions: storage.executions.listByDevice(id, 25).map((e) => ({
        commandId: e.commandId,
        state: e.state,
        detail: e.detail,
        at: e.createdAt,
      })),
    };
  });

  app.patch('/api/devices/:id', { preHandler: [auth, feature] }, async (req) => {
    const { id } = req.params as { id: string };
    const body = patchSchema.parse(req.body);
    const userId = req.user!.id;

    if (body.name) agi.devices.rename(userId, id, body.name);
    if (body.isPrimary) agi.devices.setPrimary(userId, id);
    for (const entry of body.capabilities ?? []) {
      agi.devices.setCapabilityEnabled(userId, id, entry.capability, entry.enabled);
    }
    const fresh = agi.devices.getWithState(userId, id)!;
    return { device: serializeDevice(fresh) };
  });

  /**
   * Revoke by default; `?purge=true` deletes the history too. Revoke is the safe
   * option: the device can never reconnect, but the audit trail survives.
   */
  app.delete('/api/devices/:id', { preHandler: [auth, feature] }, async (req) => {
    const { id } = req.params as { id: string };
    const { purge } = req.query as { purge?: string };
    const userId = req.user!.id;
    if (purge === 'true') {
      agi.devices.remove(userId, id);
      return { removed: true };
    }
    agi.devices.revoke(userId, id);
    return { revoked: true };
  });

  app.post(
    '/api/devices/:id/rotate-credential',
    { preHandler: [auth, feature] },
    async (req) => {
      const { id } = req.params as { id: string };
      const credential = agi.devices.rotateCredential(req.user!.id, id);
      // Shown once; the previous credential is already dead.
      return { credential };
    },
  );

  // ---- capability catalogue ----

  app.get('/api/device-capabilities', { preHandler: [auth] }, async () => {
    return {
      capabilities: listCapabilities().map((c) => ({
        name: c.name,
        version: c.version,
        description: c.description,
        platforms: c.platforms,
        risk: c.risk,
        requiresConfirmation: c.requiresConfirmation,
        timeoutMs: c.timeoutMs,
        retrySafe: c.retrySafe,
        parallelSafe: c.parallelSafe,
        queueable: c.queueable,
      })),
    };
  });
}
