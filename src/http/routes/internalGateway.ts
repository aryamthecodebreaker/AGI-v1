// The app's internal API for the device gateway.
//
// This is a machine-to-machine boundary, authenticated with the shared gateway
// secret — NOT with a user session. It is mounted under /internal/ and must never
// be reachable from a browser with only a cookie.
//
// The gateway asks the app to make every decision: is this credential valid, what
// does this device support, what does this result mean. The gateway itself knows
// nothing about users or policy.

import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Storage } from '../../storage/index.js';
import { logger } from '../../logger.js';
import type { AgiCommand } from '../../devices/index.js';
import { redactMessage } from '../../devices/protocol.js';

const helloSchema = z.object({
  credential: z.string().min(8).max(512),
  device: z
    .object({
      name: z.string().max(80).optional(),
      deviceType: z.string().max(32).optional(),
      platform: z.string().max(64).optional(),
      platformVersion: z.string().max(64).optional(),
      agentVersion: z.string().max(32).optional(),
    })
    .default({}),
  capabilities: z
    .array(z.object({ name: z.string().max(64), version: z.number().int().min(1).default(1) }))
    .max(200)
    .default([]),
  protocolVersion: z.string().max(32).optional(),
});

const deviceOnlySchema = z.object({ deviceId: z.string().min(1).max(64) });

const capabilitiesSchema = z.object({
  deviceId: z.string().min(1).max(64),
  capabilities: z
    .array(z.object({ name: z.string().max(64), version: z.number().int().min(1).default(1) }))
    .max(200),
});

const resultSchema = z.object({
  deviceId: z.string().min(1).max(64),
  commandId: z.string().min(1).max(64),
  executionId: z.string().min(1).max(64),
  type: z.enum(['acknowledged', 'progress', 'completed', 'failed']),
  result: z.record(z.unknown()).optional(),
  failure: z
    .object({ code: z.string().max(64), message: z.string().max(400).optional() })
    .optional(),
  progressMessage: z.string().max(200).optional(),
});

function secretsMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export async function internalGatewayRoutes(
  app: FastifyInstance,
  storage: Storage,
  agi: AgiCommand,
): Promise<void> {
  const secret = agi.settings.gatewayInternalSecret;

  const requireGatewaySecret = async (
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    if (!agi.enabled) {
      await reply.status(503).send({ error: 'FEATURE_DISABLED' });
      return;
    }
    // With no secret configured, this surface stays shut rather than open.
    if (!secret) {
      await reply.status(503).send({ error: 'GATEWAY_NOT_CONFIGURED' });
      return;
    }
    const presented = req.headers['x-agi-gateway-secret'];
    if (typeof presented !== 'string' || !secretsMatch(presented, secret)) {
      logger.warn({ url: req.url, ip: req.ip }, 'internal gateway request rejected');
      await reply.status(401).send({ error: 'UNAUTHORIZED' });
    }
  };

  /**
   * Device handshake. Returns 401 for unknown, revoked and wrong-secret alike so
   * the gateway (and anyone watching it) cannot tell which.
   */
  app.post(
    '/internal/gateway/authenticate',
    { preHandler: [requireGatewaySecret] },
    async (req, reply) => {
      const body = helloSchema.parse(req.body);
      const authenticated = agi.devices.authenticateDevice(body.credential);
      if (!authenticated) {
        // Note the absence of the credential in this log line.
        logger.warn({ frame: redactMessage(body) }, 'device credential rejected');
        return reply.status(401).send({ error: 'UNAUTHORIZED' });
      }

      const { device } = authenticated;
      const { acceptedCapabilities } = agi.devices.markConnected(device, {
        agentVersion: body.device.agentVersion,
        protocolVersion: body.protocolVersion,
        capabilities: body.capabilities,
      });

      // Anything queued while the device was away goes out now. Deliberately not
      // awaited: the handshake response should not wait on dispatch.
      void agi.commands.flushQueuedForDevice(device.id).catch((err) => {
        logger.warn({ err, deviceId: device.id }, 'queued command flush failed');
      });

      return {
        deviceId: device.id,
        userId: device.userId,
        deviceName: device.name,
        heartbeatIntervalMs: agi.settings.heartbeatIntervalMs,
        acceptedCapabilities,
      };
    },
  );

  app.post(
    '/internal/gateway/disconnected',
    { preHandler: [requireGatewaySecret] },
    async (req) => {
      const { deviceId } = deviceOnlySchema.parse(req.body);
      agi.devices.markDisconnected(deviceId);
      return { ok: true };
    },
  );

  app.post('/internal/gateway/heartbeat', { preHandler: [requireGatewaySecret] }, async (req) => {
    const { deviceId } = deviceOnlySchema.parse(req.body);
    agi.devices.heartbeat(deviceId);
    return { ok: true };
  });

  app.post(
    '/internal/gateway/capabilities',
    { preHandler: [requireGatewaySecret] },
    async (req, reply) => {
      const body = capabilitiesSchema.parse(req.body);
      const device = storage.devices.getById(body.deviceId);
      if (!device) return reply.status(404).send({ error: 'NOT_FOUND' });
      const rejected = agi.devices.updateAdvertisedCapabilities(device, body.capabilities);
      return { ok: true, rejected };
    },
  );

  /**
   * A result from a device. The command service re-checks that the execution
   * belongs to this command and this device before it changes anything.
   */
  app.post('/internal/gateway/result', { preHandler: [requireGatewaySecret] }, async (req, reply) => {
    const body = resultSchema.parse(req.body);
    const outcome = agi.commands.ingestResult({
      deviceId: body.deviceId,
      commandId: body.commandId,
      executionId: body.executionId,
      type: body.type,
      result: body.result,
      failure: body.failure
        ? {
            code: body.failure.code as 'unsupported' | 'rejected' | 'failed' | 'duplicate' | 'invalid_parameters',
            message: body.failure.message,
          }
        : undefined,
      progressMessage: body.progressMessage,
    });
    if (!outcome.accepted) {
      // Late or mismatched results are dropped, not applied. 202 because the
      // gateway did nothing wrong and must not retry.
      logger.debug({ reason: outcome.reason }, 'device result not applied');
      return reply.status(202).send({ accepted: false, reason: outcome.reason });
    }
    return { accepted: true };
  });
}
