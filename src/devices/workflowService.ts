// Workflows: reusable multi-device routines.
//
// A workflow is a list of validated capability calls, not a script. Running one
// creates ordinary commands — same capability registry, same policy, same
// confirmation, same execution tracking — so nothing here is a second, weaker
// path into the device layer.
//
// Confirmation: a run asks ONCE, up front, showing every step. Individual steps
// are then created pre-confirmed. Asking per step would make a four-step "study
// mode" unusable, and the user has already seen exactly what will happen.

import crypto from 'node:crypto';
import type { Storage } from '../storage/index.js';
import type {
  Workflow,
  WorkflowStep,
  WorkflowStepInput,
} from '../storage/repositories/workflowRepo.js';
import type { CommandStatus } from '../storage/repositories/commandRepo.js';
import { logger } from '../logger.js';
import { now } from '../util/time.js';
import { ids } from '../util/ids.js';
import { Errors } from '../util/errors.js';
import type { DeviceSettings } from '../config.js';
import { describeCapability, getCapability, validateParameters } from './capabilities.js';
import { evaluatePolicy, workflowRunRisk } from './policy.js';
import { resolveTargets, type ResolveContext, type TargetExpression } from './resolver.js';
import type { CommandService, CommandView } from './commandService.js';
import { tallyExecutions } from './status.js';
import type { ConfirmationRequest } from '../storage/repositories/confirmationRepo.js';

/** Matches the command-level confirmation window. */
const CONFIRMATION_TTL_MS = 2 * 60 * 1000;

export interface StepOutcome {
  position: number;
  capability: string;
  status: CommandStatus | 'skipped' | 'invalid';
  commandId?: string;
  detail?: string;
  executions?: { deviceName: string; state: string; detail?: string | null }[];
}

export interface WorkflowRunResult {
  runId: string;
  workflowName: string;
  /** Set when the run is held pending a single confirmation. */
  confirmation?: ConfirmationRequest;
  steps: StepOutcome[];
  stoppedEarly: boolean;
}

/**
 * A run that has been described to the user and is waiting on a yes/no.
 *
 * Held in memory on purpose: the durable half is the confirmation row, which
 * expires in two minutes. A restart inside that window loses the pending run and
 * the user is told the confirmation expired — which is true — rather than the
 * app resurrecting an action they no longer expect.
 */
interface PendingRun {
  runId: string;
  userId: string;
  workflowId: string;
  conversationId: string | null;
  context?: ResolveContext;
  expiresAt: number;
}

export function createWorkflowService(
  storage: Storage,
  settings: DeviceSettings,
  commands: CommandService,
) {
  const pendingRuns = new Map<string, PendingRun>();

  function prunePending(): void {
    const at = now();
    for (const [runId, run] of pendingRuns) {
      if (run.expiresAt <= at) pendingRuns.delete(runId);
    }
  }

  /**
   * Validate a workflow definition before it is saved. A workflow that cannot
   * run is not worth storing, and catching it here means a saved workflow is
   * always inspectable and executable.
   */
  function validateSteps(steps: WorkflowStepInput[]): { ok: true } | { ok: false; error: string } {
    if (steps.length === 0) return { ok: false, error: 'A workflow needs at least one step.' };
    if (steps.length > 25) return { ok: false, error: 'A workflow can have at most 25 steps.' };
    for (const [index, step] of steps.entries()) {
      const capability = getCapability(step.capability);
      if (!capability) {
        return { ok: false, error: `Step ${index + 1}: unknown action "${step.capability}".` };
      }
      const validated = validateParameters(capability, step.parameters ?? {});
      if (!validated.ok) return { ok: false, error: `Step ${index + 1}: ${validated.error}` };
      const target = (step.targetExpression ?? {}) as TargetExpression;
      const hasSelector =
        Boolean(target.includeDeviceIds?.length) ||
        Boolean(target.includeDeviceNames?.length) ||
        Boolean(target.includeGroups?.length) ||
        target.primaryOnly === true ||
        target.thisDevice === true ||
        target.onlineOnly === true;
      if (!hasSelector) {
        return {
          ok: false,
          error: `Step ${index + 1}: needs a target (a device, a group, or the primary device).`,
        };
      }
    }
    return { ok: true };
  }

  /** Consecutive `parallel` steps form one batch; `sequential` steps stand alone. */
  function batchSteps(steps: WorkflowStep[]): WorkflowStep[][] {
    const batches: WorkflowStep[][] = [];
    for (const step of steps) {
      const last = batches[batches.length - 1];
      if (step.mode === 'parallel' && last && last[0]?.mode === 'parallel') last.push(step);
      else batches.push([step]);
    }
    return batches;
  }

  function summarizeRun(workflow: Workflow, userId: string): string {
    const lines = workflow.steps.map((step, index) => {
      const action = describeCapability(step.capability, step.parameters);
      const resolved = resolveTargets(storage, {
        userId,
        expression: step.targetExpression as TargetExpression,
        capability: getCapability(step.capability),
        offlineAfterMs: settings.offlineAfterMs,
      });
      const names = [...resolved.matched, ...resolved.offline].map((d) => d.name);
      return `${index + 1}. ${action} on ${names.length > 0 ? names.join(', ') : 'no matching device'}`;
    });
    return `run "${workflow.name}":\n${lines.join('\n')}`;
  }

  function fingerprintRun(workflow: Workflow): string {
    return crypto
      .createHash('sha256')
      .update(
        JSON.stringify(
          workflow.steps.map((s) => ({
            capability: s.capability,
            parameters: s.parameters,
            target: s.targetExpression,
          })),
        ),
      )
      .digest('hex');
  }

  async function executeSteps(
    workflow: Workflow,
    runId: string,
    userId: string,
    conversationId: string | null,
    context?: ResolveContext,
  ): Promise<{ steps: StepOutcome[]; stoppedEarly: boolean }> {
    const outcomes: StepOutcome[] = [];
    let stoppedEarly = false;

    storage.deviceEvents.record({
      userId,
      kind: 'workflow.run',
      detail: `${workflow.name} (${workflow.steps.length} steps)`,
    });

    for (const batch of batchSteps(workflow.steps)) {
      const results = await Promise.all(
        batch.map(async (step): Promise<StepOutcome> => {
          const capability = getCapability(step.capability);
          if (!capability) {
            return {
              position: step.position,
              capability: step.capability,
              status: 'invalid',
              detail: 'that action no longer exists',
            };
          }
          const created = await commands.create({
            userId,
            conversationId,
            requestText: `${workflow.name} — step ${step.position + 1}`,
            capability: step.capability,
            parameters: step.parameters,
            target: step.targetExpression as TargetExpression,
            context,
            workflowRunId: runId,
            // The run was confirmed as a whole; steps must not re-ask.
            preConfirmed: true,
            idempotencyKey: `wfr:${runId}:${step.position}`,
          });

          if (created.kind !== 'created' && created.kind !== 'duplicate') {
            return {
              position: step.position,
              capability: step.capability,
              status: 'invalid',
              detail:
                created.kind === 'clarification_needed'
                  ? created.question
                  : (created as { reason: string }).reason,
            };
          }

          const commandId = created.command.id;
          await commands.waitForSettled(
            userId,
            commandId,
            step.timeoutMs ?? capability.timeoutMs,
          );
          const view = commands.view(userId, commandId);
          return {
            position: step.position,
            capability: step.capability,
            status: view?.command.status ?? 'failed',
            commandId,
            executions: view?.executions.map((e) => ({
              deviceName: e.deviceName,
              state: e.state,
              detail: e.detail,
            })),
          };
        }),
      );

      outcomes.push(...results);

      // Stop-on-failure is per step; a failing step with onFailure 'stop' ends
      // the run and the remaining steps are reported as skipped, not silently
      // dropped.
      const failing = batch.find((step, i) => {
        const outcome = results[i]!;
        return (
          step.onFailure === 'stop' &&
          (outcome.status === 'failed' ||
            outcome.status === 'invalid' ||
            outcome.status === 'partially_succeeded')
        );
      });
      if (failing) {
        stoppedEarly = true;
        const done = new Set(outcomes.map((o) => o.position));
        for (const step of workflow.steps) {
          if (!done.has(step.position)) {
            outcomes.push({
              position: step.position,
              capability: step.capability,
              status: 'skipped',
              detail: `skipped because step ${failing.position + 1} failed`,
            });
          }
        }
        break;
      }
    }

    outcomes.sort((a, b) => a.position - b.position);
    return { steps: outcomes, stoppedEarly };
  }

  return {
    validateSteps,

    create(input: {
      userId: string;
      name: string;
      description?: string | null;
      steps: WorkflowStepInput[];
    }): Workflow {
      const check = validateSteps(input.steps);
      if (!check.ok) throw Errors.badRequest(check.error);
      if (storage.workflows.getByName(input.userId, input.name)) {
        throw Errors.conflict(`You already have a workflow called "${input.name}".`);
      }
      return storage.workflows.create(input);
    },

    update(
      userId: string,
      workflowId: string,
      input: { name?: string; description?: string | null; steps?: WorkflowStepInput[] },
    ): Workflow {
      const existing = storage.workflows.getOwned(userId, workflowId);
      if (!existing) throw Errors.notFound('Workflow not found');
      if (input.steps) {
        const check = validateSteps(input.steps);
        if (!check.ok) throw Errors.badRequest(check.error);
      }
      if (input.name && input.name !== existing.name) {
        const clash = storage.workflows.getByName(userId, input.name);
        if (clash && clash.id !== workflowId) {
          throw Errors.conflict(`You already have a workflow called "${input.name}".`);
        }
      }
      return storage.workflows.update(workflowId, input)!;
    },

    remove(userId: string, workflowId: string): void {
      const existing = storage.workflows.getOwned(userId, workflowId);
      if (!existing) throw Errors.notFound('Workflow not found');
      storage.workflows.remove(workflowId);
    },

    list(userId: string): Workflow[] {
      return storage.workflows.listByUser(userId);
    },

    /**
     * Start a run. If the run needs confirmation, nothing is dispatched: the
     * caller gets a confirmation to show, and calls confirmRun() with the answer.
     */
    async run(input: {
      userId: string;
      workflowId: string;
      conversationId?: string | null;
      context?: ResolveContext;
    }): Promise<WorkflowRunResult> {
      prunePending();
      const workflow = storage.workflows.getOwned(input.userId, input.workflowId);
      if (!workflow) throw Errors.notFound('Workflow not found');

      const runId = ids.workflowRun();
      const stepRisks = workflow.steps.map((step) => {
        const capability = getCapability(step.capability);
        if (!capability) return 'moderate' as const;
        const resolved = resolveTargets(storage, {
          userId: input.userId,
          expression: step.targetExpression as TargetExpression,
          capability,
          context: input.context,
          offlineAfterMs: settings.offlineAfterMs,
        });
        return evaluatePolicy({
          capability,
          targetCount: resolved.matched.length,
          queueIfOffline: false,
        }).risk;
      });

      const risk = workflowRunRisk(stepRisks);
      // Every run is at least moderate risk, so every run asks once.
      const confirmation = storage.confirmations.create({
        workflowRunId: runId,
        userId: input.userId,
        summary: summarizeRun(workflow, input.userId),
        fingerprint: fingerprintRun(workflow),
        expiresAt: now() + CONFIRMATION_TTL_MS,
      });
      pendingRuns.set(runId, {
        runId,
        userId: input.userId,
        workflowId: workflow.id,
        conversationId: input.conversationId ?? null,
        context: input.context,
        expiresAt: now() + CONFIRMATION_TTL_MS,
      });
      logger.info({ runId, workflow: workflow.name, risk }, 'workflow run awaiting confirmation');

      return {
        runId,
        workflowName: workflow.name,
        confirmation,
        steps: [],
        stoppedEarly: false,
      };
    },

    /** Answer a run's confirmation. On yes, the steps execute. */
    async confirmRun(
      userId: string,
      runId: string,
      decision: 'confirmed' | 'rejected',
    ): Promise<
      { ok: false; reason: string } | { ok: true; result: WorkflowRunResult }
    > {
      prunePending();
      const pending = pendingRuns.get(runId);
      const confirmation = storage.confirmations.getOpenForWorkflowRun(runId);
      if (!pending || pending.userId !== userId || !confirmation) {
        return { ok: false, reason: 'That workflow confirmation has expired. Ask me again.' };
      }

      const workflow = storage.workflows.getOwned(userId, pending.workflowId);
      if (!workflow) {
        pendingRuns.delete(runId);
        return { ok: false, reason: 'That workflow no longer exists.' };
      }
      // The workflow must not have been edited since it was described.
      if (fingerprintRun(workflow) !== confirmation.fingerprint) {
        storage.confirmations.resolve(confirmation.id, 'expired');
        pendingRuns.delete(runId);
        return {
          ok: false,
          reason: 'That workflow changed after I described it, so the confirmation no longer applies.',
        };
      }
      if (!storage.confirmations.resolve(confirmation.id, decision)) {
        return { ok: false, reason: 'That confirmation was already used or has expired.' };
      }
      pendingRuns.delete(runId);

      if (decision === 'rejected') {
        return {
          ok: true,
          result: { runId, workflowName: workflow.name, steps: [], stoppedEarly: false },
        };
      }

      const { steps, stoppedEarly } = await executeSteps(
        workflow,
        runId,
        userId,
        pending.conversationId,
        pending.context,
      );
      return { ok: true, result: { runId, workflowName: workflow.name, steps, stoppedEarly } };
    },

    /** Commands created by a run, for the history view. */
    runCommands(userId: string, runId: string): CommandView[] {
      return storage.commands
        .listByWorkflowRun(runId)
        .filter((c) => c.userId === userId)
        .map((c) => commands.view(userId, c.id))
        .filter((v): v is CommandView => v !== null);
    },

    /** Is there a run waiting on this user's yes/no? */
    pendingRunFor(userId: string): PendingRun | null {
      prunePending();
      for (const run of pendingRuns.values()) {
        if (run.userId === userId) return run;
      }
      return null;
    },
  };
}

export type WorkflowService = ReturnType<typeof createWorkflowService>;

/** Human summary of a finished run. */
export function narrateWorkflowRun(result: WorkflowRunResult): string {
  if (result.steps.length === 0) {
    return `I did not run "${result.workflowName}".`;
  }
  const lines = result.steps.map((step) => {
    const label =
      step.status === 'succeeded'
        ? 'done'
        : step.status === 'skipped'
          ? 'skipped'
          : step.status === 'invalid'
            ? `could not run — ${step.detail ?? 'invalid step'}`
            : step.status === 'partially_succeeded'
              ? 'partly done'
              : step.status;
    const where = step.executions?.length
      ? ` (${step.executions.map((e) => `${e.deviceName}: ${e.state}`).join(', ')})`
      : '';
    return `${step.position + 1}. ${step.capability} — ${label}${where}`;
  });
  const header = result.stoppedEarly
    ? `"${result.workflowName}" stopped early:`
    : `"${result.workflowName}" finished:`;
  return `${header}\n${lines.join('\n')}`;
}

/** Total device outcomes across a run, for a compact status line. */
export function tallyRun(views: CommandView[]): { succeeded: number; failed: number; total: number } {
  let succeeded = 0;
  let failed = 0;
  let total = 0;
  for (const view of views) {
    const tally = tallyExecutions(view.executions);
    succeeded += tally.succeeded;
    failed += tally.failed;
    total += tally.total;
  }
  return { succeeded, failed, total };
}
