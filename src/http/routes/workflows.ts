// Workflow routes.
//
// Steps are validated on save, so a stored workflow is always inspectable and
// runnable. There is no script field — a workflow can only reference capabilities
// that already exist in the registry.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Storage } from '../../storage/index.js';
import { requireAuth } from '../../auth/middleware.js';
import type { AgiCommand } from '../../devices/index.js';
import { requireFeature } from './agiCommand.js';
import type { Workflow } from '../../storage/repositories/workflowRepo.js';

const stepSchema = z.object({
  capability: z.string().min(1).max(64),
  parameters: z.record(z.unknown()).default({}),
  targetExpression: z.record(z.unknown()).default({}),
  mode: z.enum(['sequential', 'parallel']).default('sequential'),
  onFailure: z.enum(['stop', 'continue']).default('stop'),
  timeoutMs: z.number().int().min(1000).max(120000).nullable().optional(),
});

const createSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(400).nullable().optional(),
  steps: z.array(stepSchema).min(1).max(25),
});

const patchSchema = z
  .object({
    name: z.string().min(1).max(80).optional(),
    description: z.string().max(400).nullable().optional(),
    steps: z.array(stepSchema).min(1).max(25).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'nothing to update' });

function serializeWorkflow(workflow: Workflow) {
  return {
    id: workflow.id,
    name: workflow.name,
    description: workflow.description,
    createdAt: workflow.createdAt,
    updatedAt: workflow.updatedAt,
    steps: workflow.steps.map((s) => ({
      id: s.id,
      position: s.position,
      capability: s.capability,
      parameters: s.parameters,
      targetExpression: s.targetExpression,
      mode: s.mode,
      onFailure: s.onFailure,
      timeoutMs: s.timeoutMs,
    })),
  };
}

export async function workflowRoutes(
  app: FastifyInstance,
  storage: Storage,
  agi: AgiCommand,
): Promise<void> {
  const auth = requireAuth(storage);
  const feature = requireFeature(agi);

  app.get('/api/workflows', { preHandler: [auth, feature] }, async (req) => {
    return { workflows: agi.workflows.list(req.user!.id).map(serializeWorkflow) };
  });

  app.post('/api/workflows', { preHandler: [auth, feature] }, async (req, reply) => {
    const body = createSchema.parse(req.body);
    const workflow = agi.workflows.create({
      userId: req.user!.id,
      name: body.name,
      description: body.description ?? null,
      steps: body.steps,
    });
    return reply.status(201).send({ workflow: serializeWorkflow(workflow) });
  });

  app.patch('/api/workflows/:id', { preHandler: [auth, feature] }, async (req) => {
    const { id } = req.params as { id: string };
    const body = patchSchema.parse(req.body);
    const workflow = agi.workflows.update(req.user!.id, id, body);
    return { workflow: serializeWorkflow(workflow) };
  });

  app.delete('/api/workflows/:id', { preHandler: [auth, feature] }, async (req) => {
    const { id } = req.params as { id: string };
    agi.workflows.remove(req.user!.id, id);
    return { removed: true };
  });

  /**
   * Starting a run does not dispatch anything. It returns one confirmation
   * describing every step and target; the caller answers it at
   * /api/workflows/runs/:runId/confirm.
   */
  app.post('/api/workflows/:id/run', { preHandler: [auth, feature] }, async (req) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({
        conversationId: z.string().max(64).optional(),
        thisDeviceId: z.string().max(64).optional(),
      })
      .parse(req.body ?? {});
    const run = await agi.workflows.run({
      userId: req.user!.id,
      workflowId: id,
      conversationId: body.conversationId ?? null,
      context: { thisDeviceId: body.thisDeviceId ?? null },
    });
    return {
      runId: run.runId,
      workflowName: run.workflowName,
      confirmation: run.confirmation
        ? {
            id: run.confirmation.id,
            summary: run.confirmation.summary,
            expiresAt: run.confirmation.expiresAt,
          }
        : null,
    };
  });

  app.post(
    '/api/workflows/runs/:runId/confirm',
    { preHandler: [auth, feature] },
    async (req, reply) => {
      const { runId } = req.params as { runId: string };
      const body = z.object({ confirm: z.boolean() }).parse(req.body ?? { confirm: true });
      const outcome = await agi.workflows.confirmRun(
        req.user!.id,
        runId,
        body.confirm ? 'confirmed' : 'rejected',
      );
      if (!outcome.ok) {
        return reply.status(409).send({ error: 'CONFIRMATION_INVALID', message: outcome.reason });
      }
      return {
        runId,
        workflowName: outcome.result.workflowName,
        stoppedEarly: outcome.result.stoppedEarly,
        steps: outcome.result.steps,
      };
    },
  );

  app.get('/api/workflows/runs/:runId', { preHandler: [auth, feature] }, async (req) => {
    const { runId } = req.params as { runId: string };
    const commands = agi.workflows.runCommands(req.user!.id, runId);
    return {
      runId,
      commands: commands.map((view) => ({
        id: view.command.id,
        capability: view.command.capability,
        status: view.command.status,
        executions: view.executions.map((e) => ({
          deviceName: e.deviceName,
          state: e.state,
          detail: e.detail,
        })),
      })),
    };
  });
}
