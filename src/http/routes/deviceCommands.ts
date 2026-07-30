// Command routes — the REST face of the same command service the chat path uses.
//
// There is no separate execution path here. A command created over HTTP goes
// through identical validation, resolution, policy and dispatch, so the API
// cannot be used to sidestep a confirmation.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Storage } from '../../storage/index.js';
import { requireAuth } from '../../auth/middleware.js';
import type { AgiCommand } from '../../devices/index.js';
import { requireFeature } from './agiCommand.js';
import { narrateCommandOutcome } from '../../devices/narrate.js';
import type { CommandView } from '../../devices/commandService.js';
import { executionStateLabel } from '../../devices/status.js';

const targetSchema = z
  .object({
    includeDeviceIds: z.array(z.string().max(64)).max(50).optional(),
    includeDeviceNames: z.array(z.string().max(80)).max(50).optional(),
    includeGroups: z.array(z.string().max(60)).max(20).optional(),
    excludeDeviceIds: z.array(z.string().max(64)).max(50).optional(),
    excludeDeviceNames: z.array(z.string().max(80)).max(50).optional(),
    excludeGroups: z.array(z.string().max(60)).max(20).optional(),
    primaryOnly: z.boolean().optional(),
    thisDevice: z.boolean().optional(),
    sameAsPrevious: z.boolean().optional(),
    failedOnly: z.boolean().optional(),
    onlineOnly: z.boolean().optional(),
  })
  .strict();

const createSchema = z.object({
  capability: z.string().min(1).max(64),
  parameters: z.record(z.unknown()).default({}),
  target: targetSchema,
  queueIfOffline: z.boolean().optional(),
  conversationId: z.string().max(64).optional(),
  thisDeviceId: z.string().max(64).optional(),
  requestText: z.string().max(500).optional(),
  /** Supply to make a retried POST idempotent. */
  idempotencyKey: z.string().min(8).max(120).optional(),
});

export function serializeCommand(view: CommandView) {
  return {
    id: view.command.id,
    capability: view.command.capability,
    parameters: view.command.parameters,
    requestText: view.command.requestText,
    status: view.command.status,
    risk: view.command.risk,
    policyDecision: view.command.policyDecision,
    policyReason: view.command.policyReason,
    confirmationState: view.command.confirmationState,
    queueIfOffline: view.command.queueIfOffline,
    correctsCommandId: view.command.correctsCommandId,
    retryOfCommandId: view.command.retryOfCommandId,
    workflowRunId: view.command.workflowRunId,
    createdAt: view.command.createdAt,
    expiresAt: view.command.expiresAt,
    completedAt: view.command.completedAt,
    summary: narrateCommandOutcome(view),
    executions: view.executions.map((e) => ({
      id: e.id,
      deviceId: e.deviceId,
      deviceName: e.deviceName,
      state: e.state,
      label: executionStateLabel(e.state),
      detail: e.detail,
      result: e.result,
      attempt: e.attempt,
      dispatchedAt: e.dispatchedAt,
      acknowledgedAt: e.acknowledgedAt,
      completedAt: e.completedAt,
    })),
    confirmation: view.confirmation
      ? {
          id: view.confirmation.id,
          summary: view.confirmation.summary,
          expiresAt: view.confirmation.expiresAt,
        }
      : null,
  };
}

export async function deviceCommandRoutes(
  app: FastifyInstance,
  storage: Storage,
  agi: AgiCommand,
): Promise<void> {
  const auth = requireAuth(storage);
  const feature = requireFeature(agi);

  app.post('/api/device-commands', { preHandler: [auth, feature] }, async (req, reply) => {
    const body = createSchema.parse(req.body);
    const userId = req.user!.id;

    // A conversation id, if given, must belong to this user.
    if (body.conversationId) {
      const conv = storage.conversations.getById(body.conversationId);
      if (!conv || conv.user_id !== userId) {
        return reply.status(404).send({ error: 'NOT_FOUND', message: 'Conversation not found' });
      }
    }

    const result = await agi.commands.create({
      userId,
      conversationId: body.conversationId ?? null,
      requestText: body.requestText ?? `${body.capability} via API`,
      capability: body.capability,
      parameters: body.parameters,
      target: body.target,
      queueIfOffline: body.queueIfOffline,
      context: { thisDeviceId: body.thisDeviceId ?? null },
      idempotencyKey: body.idempotencyKey,
    });

    switch (result.kind) {
      case 'invalid':
        return reply.status(400).send({ error: 'INVALID_COMMAND', message: result.reason });
      case 'denied':
        return reply.status(403).send({ error: 'DENIED', message: result.reason });
      case 'clarification_needed':
        return reply.status(409).send({
          error: 'AMBIGUOUS_TARGET',
          message: result.question,
          ambiguous: result.resolved.ambiguous.map((a) => ({
            reference: a.reference,
            candidates: a.candidates.map((d) => ({ id: d.id, name: d.name })),
          })),
          unmatched: result.resolved.unmatched,
        });
      case 'duplicate':
        return reply
          .status(200)
          .send({ duplicate: true, command: serializeCommand(agi.commands.view(userId, result.command.id)!) });
      case 'created':
        return reply
          .status(201)
          .send({ command: serializeCommand(agi.commands.view(userId, result.command.id)!) });
    }
  });

  app.get('/api/device-commands', { preHandler: [auth, feature] }, async (req) => {
    const limit = Math.min(Number((req.query as { limit?: string }).limit ?? 25), 100);
    return { commands: agi.commands.list(req.user!.id, limit).map(serializeCommand) };
  });

  app.get('/api/device-commands/:id', { preHandler: [auth, feature] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const view = agi.commands.view(req.user!.id, id);
    if (!view) return reply.status(404).send({ error: 'NOT_FOUND', message: 'Command not found' });
    return {
      command: serializeCommand(view),
      events: storage.deviceEvents.listByCommand(id).map((e) => ({
        kind: e.kind,
        detail: e.detail,
        at: e.createdAt,
      })),
    };
  });

  app.post('/api/device-commands/:id/confirm', { preHandler: [auth, feature] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ confirm: z.boolean() }).parse(req.body ?? { confirm: true });
    const result = await agi.commands.confirm(
      req.user!.id,
      id,
      body.confirm ? 'confirmed' : 'rejected',
    );
    if (!result.ok) {
      return reply.status(409).send({ error: 'CONFIRMATION_INVALID', message: result.reason });
    }
    return { command: serializeCommand(agi.commands.view(req.user!.id, id)!) };
  });

  app.post('/api/device-commands/:id/cancel', { preHandler: [auth, feature] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const view = agi.commands.view(req.user!.id, id);
    if (!view) return reply.status(404).send({ error: 'NOT_FOUND', message: 'Command not found' });
    const outcome = await agi.commands.cancel(req.user!.id, id);
    return {
      ...outcome,
      // Stated explicitly: cancelling does not roll back what already ran.
      note:
        outcome.alreadyCompleted > 0
          ? 'Actions that already completed on a device cannot be undone automatically.'
          : undefined,
      command: serializeCommand(agi.commands.view(req.user!.id, id)!),
    };
  });

  app.post('/api/device-commands/:id/retry', { preHandler: [auth, feature] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({ includeSucceeded: z.boolean().optional() })
      .parse(req.body ?? {});
    const result = await agi.commands.retry(req.user!.id, id, {
      includeSucceeded: body.includeSucceeded,
    });
    if (result.kind === 'invalid') {
      return reply.status(400).send({ error: 'CANNOT_RETRY', message: result.reason });
    }
    if (result.kind === 'denied') {
      return reply.status(403).send({ error: 'DENIED', message: result.reason });
    }
    if (result.kind === 'clarification_needed') {
      return reply.status(409).send({ error: 'AMBIGUOUS_TARGET', message: result.question });
    }
    return reply.status(201).send({
      retriedDeviceIds: 'retriedDeviceIds' in result ? result.retriedDeviceIds : [],
      command: serializeCommand(agi.commands.view(req.user!.id, result.command.id)!),
    });
  });
}
