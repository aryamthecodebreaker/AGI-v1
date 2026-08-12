// AGI Command status, the realtime event stream, and the feature gate shared by
// the other device routes.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { DeviceStorage } from '../../storage/index.js';
import { requireAuth } from '../../auth/middleware.js';
import { startSse } from '../sse.js';
import { config } from '../../config.js';
import type { AgiCommand } from '../../devices/index.js';
import { deviceEvents } from '../../devices/events.js';
import { isDeviceOnline } from '../../storage/repositories/deviceRepo.js';
import { PROTOCOL_VERSION } from '../../devices/protocol.js';
import { describeImage } from '../../llm/vision.js';

/**
 * Blocks device routes when the feature is switched off, with an explanation
 * instead of a 404. Ordinary chat is unaffected either way.
 */
export function requireFeature(agi: AgiCommand) {
  return async function requireFeatureHandler(
    _req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    if (!agi.enabled) {
      await reply.status(503).send({
        error: 'FEATURE_DISABLED',
        message:
          'AGI Command is switched off on this server. Set AGI_COMMAND_ENABLED=true and configure a device gateway to use it.',
      });
    }
  };
}

export async function agiCommandRoutes(
  app: FastifyInstance,
  storage: DeviceStorage,
  agi: AgiCommand,
): Promise<void> {
  const auth = requireAuth(storage);

  /**
   * Everything the command centre needs to decide what to render, including the
   * honest answer when device control is unavailable.
   */
  app.get('/api/agi-command/status', { preHandler: [auth] }, async (req) => {
    const userId = req.user!.id;

    if (!agi.enabled) {
      return {
        enabled: false,
        reason: 'AGI_COMMAND_ENABLED is false on this server.',
        gateway: { configured: false, reachable: false },
        voice: { backend: config.voice.backend },
        protocolVersion: PROTOCOL_VERSION,
        devices: { total: 0, online: 0 },
      };
    }

    const devices = storage.devices.listByUser(userId);
    const online = devices.filter((d) => isDeviceOnline(d, agi.settings.offlineAfterMs));

    // Ask the gateway rather than assuming. If it is down, device control is
    // reported as unavailable and the UI says so instead of failing silently.
    const health = agi.gateway.configured()
      ? await agi.gateway.health()
      : { ok: false, error: 'no gateway configured' };

    return {
      enabled: true,
      gateway: {
        configured: agi.gateway.configured(),
        reachable: health.ok,
        connections: health.connections,
        error: health.ok ? undefined : health.error,
      },
      voice: {
        backend: config.voice.backend,
        sttBackend: config.voice.sttBackend || null,
        ttsBackend: config.voice.ttsBackend || null,
      },
      protocolVersion: PROTOCOL_VERSION,
      devices: { total: devices.length, online: online.length },
      openConfirmations: storage.confirmations.listOpenForUser(userId).map((c) => ({
        id: c.id,
        commandId: c.commandId,
        workflowRunId: c.workflowRunId,
        summary: c.summary,
        expiresAt: c.expiresAt,
      })),
      timings: {
        commandTimeoutMs: agi.settings.commandTimeoutMs,
        heartbeatIntervalMs: agi.settings.heartbeatIntervalMs,
        offlineAfterMs: agi.settings.offlineAfterMs,
      },
    };
  });

  /** Diagnostics: pairing, connections, dispatches, results. */
  app.get('/api/agi-command/events', { preHandler: [auth] }, async (req) => {
    const limit = Math.min(Number((req.query as { limit?: string }).limit ?? 100), 500);
    return {
      events: storage.deviceEvents.listByUser(req.user!.id, limit).map((e) => ({
        id: e.id,
        kind: e.kind,
        detail: e.detail,
        deviceId: e.deviceId,
        commandId: e.commandId,
        at: e.createdAt,
      })),
    };
  });

  /**
   * Register (or reuse) this browser as a limited device.
   *
   * No pairing code is involved and no device credential is issued: the session
   * cookie already proves who this is, and giving page JavaScript a device
   * credential would be strictly worse than not having one. Commands for this
   * device travel down the SSE stream below.
   */
  app.post(
    '/api/devices/browser-session',
    { preHandler: [auth, requireFeature(agi)] },
    async (req) => {
      const userId = req.user!.id;
      const label =
        (req.body as { name?: string } | undefined)?.name?.trim() || 'This browser';

      // One browser device per user, reused across tabs and reloads.
      const existing = storage.devices
        .listByUser(userId)
        .find((d) => d.deviceType === 'browser');

      const device =
        existing ??
        storage.devices.create({
          userId,
          name: label,
          deviceType: 'browser',
          platform: 'browser',
          agentVersion: 'browser-1.0.0',
          protocolVersion: PROTOCOL_VERSION,
        });

      // A browser tab can do a narrow, honest subset. It is not a computer, and
      // media/volume are absent because a page cannot control the machine's
      // audio — only its own, which AGI-v1 does not play.
      storage.devices.replaceAdvertisedCapabilities(device.id, [
        { capability: 'device.ping', version: 1 },
        { capability: 'device.status', version: 1 },
        { capability: 'url.open', version: 1 },
        { capability: 'notification.show', version: 1 },
        // Only the browser can do this: getDisplayMedia() makes the OS ask which
        // window to share, so consent is enforced by the platform.
        { capability: 'screen.read', version: 1 },
      ]);

      if (!existing) {
        storage.deviceEvents.record({
          userId,
          deviceId: device.id,
          kind: 'device.registered',
          detail: 'browser session',
        });
      }

      return {
        deviceId: device.id,
        deviceName: device.name,
        capabilities: storage.devices
          .listCapabilities(device.id)
          .filter((c) => c.advertised && c.enabled)
          .map((c) => c.capability),
      };
    },
  );

  /**
   * A screen the user chose to share, for `screen.read`.
   *
   * The image arrives over HTTP rather than the device protocol because a
   * screenshot is far larger than the 64 KB frame cap. It is held in memory for
   * exactly one model call and never written to disk, never stored in the
   * database, and never logged.
   */
  app.post(
    '/api/agi-command/screen-read',
    { preHandler: [auth, requireFeature(agi)] },
    async (req, reply) => {
      const body = screenReadSchema.parse(req.body);
      const userId = req.user!.id;

      const device = storage.devices.getOwned(userId, body.deviceId);
      if (!device || device.deviceType !== 'browser') {
        return reply.status(404).send({ error: 'NOT_FOUND', message: 'Unknown browser device' });
      }

      // The execution must belong to this user, this command and this device,
      // and must still be open — the same checks the gateway path applies.
      const execution = storage.executions.getById(body.executionId);
      if (
        !execution ||
        execution.userId !== userId ||
        execution.commandId !== body.commandId ||
        execution.deviceId !== body.deviceId
      ) {
        return reply.status(404).send({ error: 'NOT_FOUND', message: 'Unknown execution' });
      }
      const command = storage.commands.getOwned(userId, body.commandId);
      if (!command || command.capability !== 'screen.read') {
        return reply.status(400).send({ error: 'BAD_REQUEST', message: 'Not a screen read' });
      }

      const question =
        typeof command.parameters.question === 'string' && command.parameters.question.trim()
          ? command.parameters.question
          : 'What is on this screen?';

      const vision = await describeImage({
        base64: body.imageBase64,
        mimeType: body.mimeType,
        question,
      });

      // Resolve the execution here: the browser only captured and uploaded, the
      // answer is produced server-side.
      const outcome = agi.commands.ingestResult({
        deviceId: body.deviceId,
        commandId: body.commandId,
        executionId: body.executionId,
        type: vision.ok ? 'completed' : 'failed',
        result: vision.ok ? { answer: vision.text } : undefined,
        failure: vision.ok ? undefined : { code: 'failed', message: vision.error },
      });

      if (!vision.ok) {
        return reply.status(200).send({ ok: false, error: vision.error });
      }
      return { ok: true, answer: vision.text, applied: outcome.accepted };
    },
  );

  /** Results from the browser device. Ownership is re-checked before applying. */
  app.post(
    '/api/agi-command/browser-result',
    { preHandler: [auth, requireFeature(agi)] },
    async (req, reply) => {
      const body = browserResultSchema.parse(req.body);
      const userId = req.user!.id;

      // The device must be this user's, and must actually be the browser device.
      const device = storage.devices.getOwned(userId, body.deviceId);
      if (!device || device.deviceType !== 'browser') {
        return reply.status(404).send({ error: 'NOT_FOUND', message: 'Unknown browser device' });
      }

      const outcome = agi.commands.ingestResult({
        deviceId: body.deviceId,
        commandId: body.commandId,
        executionId: body.executionId,
        type: body.type,
        result: body.result,
        failure: body.failure,
        progressMessage: body.progressMessage,
      });
      if (!outcome.accepted) {
        return reply.status(202).send({ accepted: false, reason: outcome.reason });
      }
      return { accepted: true };
    },
  );

  /**
   * Live updates for the command centre, over the SSE transport this project
   * already uses for chat.
   *
   * Notifications are best-effort. Durable command state remains the source of
   * truth, so a browser that reconnects re-reads it and lands on the right
   * answer regardless of what it missed.
   */
  app.get('/api/agi-command/stream', { preHandler: [auth] }, async (req, reply) => {
    const userId = req.user!.id;
    const sse = startSse(reply);
    sse.comment('agi-command stream open');

    const unsubscribe = deviceEvents.subscribe(userId, (event) => {
      try {
        sse.send(event);
      } catch {
        // Client vanished mid-write; the close handler will clean up.
      }
    });

    // While this stream is open the browser device is reachable, so mark it
    // connected — and disconnected when the stream closes. That keeps the
    // browser's online state as honest as any other device's.
    const browserDevice = agi.enabled
      ? storage.devices.listByUser(userId).find((d) => d.deviceType === 'browser')
      : undefined;
    if (browserDevice) {
      storage.devices.markConnected(browserDevice.id);
      void agi.commands.flushQueuedForDevice(browserDevice.id).catch(() => {
        /* best effort */
      });
    }

    // Proxies and load balancers drop idle connections; a comment keeps it warm
    // without polluting the event stream. It also doubles as the browser
    // device's heartbeat.
    const keepAlive = setInterval(() => {
      try {
        sse.comment('ping');
        if (browserDevice) storage.devices.heartbeat(browserDevice.id);
      } catch {
        /* ignore */
      }
    }, 25000);

    req.raw.on('close', () => {
      clearInterval(keepAlive);
      unsubscribe();
      // Only mark offline once the last tab for this user has gone.
      if (browserDevice && deviceEvents.listenerCount(userId) === 0) {
        agi.devices.markDisconnected(browserDevice.id);
      }
    });
  });
}

const browserResultSchema = z.object({
  deviceId: z.string().min(1).max(64),
  commandId: z.string().min(1).max(64),
  executionId: z.string().min(1).max(64),
  type: z.enum(['acknowledged', 'progress', 'completed', 'failed']),
  result: z.record(z.unknown()).optional(),
  failure: z
    .object({
      code: z.enum(['unsupported', 'rejected', 'failed', 'duplicate', 'invalid_parameters']),
      message: z.string().max(400).optional(),
    })
    .optional(),
  progressMessage: z.string().max(200).optional(),
});

const screenReadSchema = z.object({
  deviceId: z.string().min(1).max(64),
  commandId: z.string().min(1).max(64),
  executionId: z.string().min(1).max(64),
  // ~4 MB of raw image at most; base64 is roughly 4/3 of that.
  imageBase64: z.string().min(64).max(6_000_000),
  mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
});
