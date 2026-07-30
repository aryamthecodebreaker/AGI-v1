// Device handling inside the chat turn.
//
// This is the bridge between AGI-v1's existing conversation loop and AGI Command.
// It runs BEFORE the normal reply is generated, and only takes over the turn when
// the message is genuinely about devices. Everything else returns
// { handled: false } and the conversation proceeds exactly as it did before this
// feature existed.
//
// The reply text is always built from stored command state, never from the
// planner's opinion of what would happen.

import type { DeviceStorage } from '../storage/index.js';
import type { LlmBackend } from '../llm/types.js';
import { logger } from '../logger.js';
import type { AgiCommand } from '../devices/index.js';
import { isDeviceOnline } from '../storage/repositories/deviceRepo.js';
import { findUnsupportedIntent } from '../devices/policy.js';
import {
  planDeviceIntent,
  triageMessage,
  type DevicePlan,
  type PlannerContext,
} from '../devices/planner.js';
import { knownGroupSlugs, type ResolveContext, type TargetExpression } from '../devices/resolver.js';
import {
  narrateBatteryResults,
  narrateCommandOutcome,
  narrateConfirmationRequest,
  narrateDeviceQuery,
  narrateFailures,
} from '../devices/narrate.js';
import { narrateWorkflowRun } from '../devices/workflowService.js';
import type { CommandView } from '../devices/commandService.js';
import { getCapability } from '../devices/capabilities.js';

export interface DeviceTurnInput {
  agi: AgiCommand;
  storage: DeviceStorage;
  /**
   * Only used by the planner. Device queries, corrections, retries and
   * confirmations are answered deterministically from stored state and never
   * reach the model.
   */
  llm: LlmBackend;
  userId: string;
  conversationId: string;
  /** Used as the idempotency key so one chat message runs one command. */
  messageId: string;
  content: string;
  /** The browser session's paired device, when it has one. */
  thisDeviceId?: string | null;
}

export interface DeviceTurnResult {
  handled: boolean;
  text?: string;
  meta?: Record<string, unknown>;
}

const NOT_HANDLED: DeviceTurnResult = { handled: false };

/** How long a chat reply is willing to wait for devices to report back. */
const SETTLE_TIMEOUT_MS = 9000;

export async function handleDeviceTurn(input: DeviceTurnInput): Promise<DeviceTurnResult> {
  const { agi, storage, userId, conversationId, content } = input;
  if (!agi.enabled) return NOT_HANDLED;

  const devicesWithState = agi.devices.listWithState(userId);

  // Say plainly what we will not do, rather than planning something doomed.
  const unsupported = findUnsupportedIntent(content);
  if (unsupported) {
    // Only claim this is a device matter if devices are actually in play.
    if (devicesWithState.length > 0 || /device|phone|laptop|computer|tablet/i.test(content)) {
      return { handled: true, text: unsupported, meta: { agiCommand: 'unsupported_intent' } };
    }
  }

  const openConfirmations = storage.confirmations.listOpenForUser(userId);
  const pendingRun = agi.workflows.pendingRunFor(userId);
  const latest = agi.commands.latestInConversation(conversationId);

  const context: PlannerContext = {
    devices: devicesWithState.map((d) => ({
      name: d.device.name,
      type: d.device.deviceType,
      online: d.online,
      isPrimary: d.device.isPrimary,
    })),
    groups: knownGroupSlugs(storage, userId),
    workflows: agi.workflows.list(userId).map((w) => w.name),
    lastCommand: latest
      ? {
          capability: latest.command.capability,
          requestText: latest.command.requestText,
          targets: latest.executions.map((e) => e.deviceName),
          failedTargets: latest.executions
            .filter((e) =>
              ['failed', 'timed_out', 'device_offline', 'expired'].includes(e.state),
            )
            .map((e) => e.deviceName),
          status: latest.command.status,
        }
      : null,
    hasPendingConfirmation: openConfirmations.length > 0 || pendingRun !== null,
  };

  const triage = triageMessage(content, context);
  if (triage.decision === 'skip') return NOT_HANDLED;

  const plan: DevicePlan =
    triage.decision === 'immediate'
      ? triage.plan
      : await planDeviceIntent(input.llm, context, content);

  if (plan.kind === 'chat') return NOT_HANDLED;

  logger.debug({ kind: plan.kind, action: plan.action }, 'device plan');

  const resolveContext: ResolveContext = {
    thisDeviceId: input.thisDeviceId ?? null,
    previousDeviceIds: latest?.executions.map((e) => e.deviceId) ?? [],
    failedDeviceIds:
      latest?.executions
        .filter((e) =>
          ['failed', 'timed_out', 'device_offline', 'expired'].includes(e.state),
        )
        .map((e) => e.deviceId) ?? [],
  };

  switch (plan.kind) {
    case 'ambiguous':
      return {
        handled: true,
        text: plan.question ?? 'Which device did you mean?',
        meta: { agiCommand: 'ambiguous' },
      };

    case 'device_query':
      return handleQuery(input, plan, devicesWithState, latest, resolveContext);

    case 'device_command':
      return handleCommand(input, plan, resolveContext);

    case 'correction':
      return handleCorrection(input, plan, latest, resolveContext);

    case 'retry':
      return handleRetry(input, latest);

    case 'cancel':
      return handleCancel(input, latest, openConfirmations.map((c) => c.commandId));

    case 'command_status':
      return {
        handled: true,
        text: latest
          ? narrateCommandOutcome(latest)
          : 'I have not run a device command in this conversation yet.',
        meta: { agiCommand: 'status', commandId: latest?.command.id },
      };

    case 'confirmation_response':
      return handleConfirmationResponse(input, plan, openConfirmations);

    case 'workflow_run':
      return handleWorkflowRun(input, plan, resolveContext);

    default:
      return NOT_HANDLED;
  }
}

// ---------------------------------------------------------------------------

async function handleQuery(
  input: DeviceTurnInput,
  plan: DevicePlan,
  devicesWithState: ReturnType<AgiCommand['devices']['listWithState']>,
  latest: CommandView | null,
  resolveContext: ResolveContext,
): Promise<DeviceTurnResult> {
  const { agi } = input;
  const query = plan.query ?? 'status';

  if (query === 'failed') {
    return {
      handled: true,
      text: narrateFailures(latest),
      meta: { agiCommand: 'query', query },
    };
  }

  // Battery is a live reading, so ask the devices instead of reciting stale data.
  if (query === 'battery') {
    const target: TargetExpression = plan.target ?? { includeGroups: ['all'], onlineOnly: true };
    const created = await agi.commands.create({
      userId: input.userId,
      conversationId: input.conversationId,
      requestText: input.content,
      capability: 'battery.read',
      parameters: {},
      target,
      context: resolveContext,
      idempotencyKey: `msg:${input.messageId}`,
    });
    if (created.kind !== 'created') {
      return { handled: true, text: describeNonCreation(created), meta: { agiCommand: 'query' } };
    }
    await agi.commands.waitForSettled(input.userId, created.command.id, SETTLE_TIMEOUT_MS);
    const view = agi.commands.view(input.userId, created.command.id);
    return {
      handled: true,
      text: view ? narrateBatteryResults(view) : 'No battery readings came back.',
      meta: { agiCommand: 'query', query, commandId: created.command.id },
    };
  }

  return {
    handled: true,
    text: narrateDeviceQuery(query, devicesWithState, agi.settings.offlineAfterMs),
    meta: { agiCommand: 'query', query, deviceCount: devicesWithState.length },
  };
}

async function handleCommand(
  input: DeviceTurnInput,
  plan: DevicePlan,
  resolveContext: ResolveContext,
): Promise<DeviceTurnResult> {
  const { agi } = input;
  if (!plan.action) return NOT_HANDLED;

  const created = await agi.commands.create({
    userId: input.userId,
    conversationId: input.conversationId,
    requestText: input.content,
    capability: plan.action,
    parameters: plan.parameters ?? {},
    target: (plan.target ?? {}) as TargetExpression,
    queueIfOffline: plan.queueIfOffline,
    context: resolveContext,
    // One chat message creates at most one command, even if the request is
    // retried by the client.
    idempotencyKey: `msg:${input.messageId}`,
  });

  if (created.kind !== 'created') {
    return {
      handled: true,
      text: describeNonCreation(created),
      meta: { agiCommand: 'command', outcome: created.kind },
    };
  }

  if (created.confirmation) {
    const view = agi.commands.view(input.userId, created.command.id)!;
    return {
      handled: true,
      text: narrateConfirmationRequest(view),
      meta: {
        agiCommand: 'confirmation_required',
        commandId: created.command.id,
        confirmationId: created.confirmation.id,
      },
    };
  }

  await agi.commands.waitForSettled(input.userId, created.command.id, SETTLE_TIMEOUT_MS);
  const view = agi.commands.view(input.userId, created.command.id)!;
  return {
    handled: true,
    text: narrateCommandOutcome(view),
    meta: {
      agiCommand: 'command',
      commandId: created.command.id,
      status: view.command.status,
    },
  };
}

async function handleCorrection(
  input: DeviceTurnInput,
  plan: DevicePlan,
  latest: CommandView | null,
  resolveContext: ResolveContext,
): Promise<DeviceTurnResult> {
  const { agi } = input;
  if (!latest) {
    return {
      handled: true,
      text: 'There is no recent device command for me to change. What would you like me to do?',
      meta: { agiCommand: 'correction' },
    };
  }
  // A correction with no new target is not a correction we can act on.
  if (!plan.target) return NOT_HANDLED;

  const result = await agi.commands.correct({
    userId: input.userId,
    commandId: latest.command.id,
    requestText: input.content,
    target: plan.target as TargetExpression,
    parameters: plan.parameters,
    context: resolveContext,
    idempotencyKey: `msg:${input.messageId}`,
  });

  const prefix =
    result.alreadySucceededOn && result.alreadySucceededOn.length > 0
      ? `${describeCapabilityShort(latest)} had already run on ${result.alreadySucceededOn.join(' and ')}. `
      : '';

  if (result.kind !== 'created') {
    return {
      handled: true,
      text: prefix + describeNonCreation(result),
      meta: { agiCommand: 'correction', outcome: result.kind },
    };
  }

  if (result.confirmation) {
    const view = agi.commands.view(input.userId, result.command.id)!;
    return {
      handled: true,
      text: prefix + narrateConfirmationRequest(view),
      meta: { agiCommand: 'confirmation_required', commandId: result.command.id },
    };
  }

  await agi.commands.waitForSettled(input.userId, result.command.id, SETTLE_TIMEOUT_MS);
  const view = agi.commands.view(input.userId, result.command.id)!;
  return {
    handled: true,
    text: prefix + narrateCommandOutcome(view),
    meta: {
      agiCommand: 'correction',
      commandId: result.command.id,
      correctsCommandId: latest.command.id,
    },
  };
}

async function handleRetry(
  input: DeviceTurnInput,
  latest: CommandView | null,
): Promise<DeviceTurnResult> {
  const { agi } = input;
  if (!latest) {
    return {
      handled: true,
      text: 'There is no recent device command to retry.',
      meta: { agiCommand: 'retry' },
    };
  }
  const result = await agi.commands.retry(input.userId, latest.command.id, {
    requestText: input.content,
  });
  if (result.kind !== 'created') {
    return {
      handled: true,
      text: describeNonCreation(result),
      meta: { agiCommand: 'retry', outcome: result.kind },
    };
  }
  await agi.commands.waitForSettled(input.userId, result.command.id, SETTLE_TIMEOUT_MS);
  const view = agi.commands.view(input.userId, result.command.id)!;
  return {
    handled: true,
    text: `Retried on ${result.retriedDeviceIds?.length ?? 0} device(s). ${narrateCommandOutcome(view)}`,
    meta: { agiCommand: 'retry', commandId: result.command.id },
  };
}

async function handleCancel(
  input: DeviceTurnInput,
  latest: CommandView | null,
  confirmationCommandIds: (string | null)[],
): Promise<DeviceTurnResult> {
  const { agi } = input;

  // "cancel that" while a confirmation is open means "don't do it".
  const pendingCommandId = confirmationCommandIds.find((id): id is string => Boolean(id));
  if (pendingCommandId) {
    const result = await agi.commands.confirm(input.userId, pendingCommandId, 'rejected');
    return {
      handled: true,
      text: result.ok
        ? 'Cancelled — I did not run it.'
        : (result.reason ?? 'That command was already resolved.'),
      meta: { agiCommand: 'cancel', commandId: pendingCommandId },
    };
  }

  const pendingRun = agi.workflows.pendingRunFor(input.userId);
  if (pendingRun) {
    await agi.workflows.confirmRun(input.userId, pendingRun.runId, 'rejected');
    return {
      handled: true,
      text: 'Cancelled — I did not start that workflow.',
      meta: { agiCommand: 'cancel' },
    };
  }

  if (!latest) {
    return {
      handled: true,
      text: 'There is nothing pending to cancel.',
      meta: { agiCommand: 'cancel' },
    };
  }

  const outcome = await agi.commands.cancel(input.userId, latest.command.id);
  const parts: string[] = [];
  if (outcome.cancelled > 0) parts.push(`Cancelled ${outcome.cancelled} pending action(s).`);
  if (outcome.alreadyCompleted > 0) {
    parts.push(
      `${outcome.alreadyCompleted} had already completed on ${outcome.alreadyCompleted === 1 ? 'a device' : 'devices'} — I cannot undo those automatically.`,
    );
  }
  if (parts.length === 0) parts.push('That command had already finished, so there was nothing to cancel.');
  return {
    handled: true,
    text: parts.join(' '),
    meta: { agiCommand: 'cancel', commandId: latest.command.id },
  };
}

async function handleConfirmationResponse(
  input: DeviceTurnInput,
  plan: DevicePlan,
  openConfirmations: { id: string; commandId: string | null; workflowRunId: string | null }[],
): Promise<DeviceTurnResult> {
  const { agi } = input;
  const decision = plan.confirm === false ? 'rejected' : 'confirmed';

  const runConfirmation = openConfirmations.find((c) => c.workflowRunId);
  if (runConfirmation?.workflowRunId) {
    const result = await agi.workflows.confirmRun(
      input.userId,
      runConfirmation.workflowRunId,
      decision,
    );
    if (!result.ok) {
      return { handled: true, text: result.reason, meta: { agiCommand: 'confirmation' } };
    }
    return {
      handled: true,
      text:
        decision === 'rejected'
          ? 'Understood — I did not run it.'
          : narrateWorkflowRun(result.result),
      meta: { agiCommand: 'confirmation', runId: runConfirmation.workflowRunId },
    };
  }

  const commandConfirmation = openConfirmations.find((c) => c.commandId);
  if (!commandConfirmation?.commandId) {
    return {
      handled: true,
      text: 'There is nothing waiting for your confirmation right now.',
      meta: { agiCommand: 'confirmation' },
    };
  }

  const result = await agi.commands.confirm(
    input.userId,
    commandConfirmation.commandId,
    decision,
  );
  if (!result.ok) {
    return {
      handled: true,
      text: result.reason ?? 'That confirmation is no longer valid.',
      meta: { agiCommand: 'confirmation' },
    };
  }
  if (decision === 'rejected') {
    return {
      handled: true,
      text: 'Understood — I did not run it.',
      meta: { agiCommand: 'confirmation' },
    };
  }

  await agi.commands.waitForSettled(
    input.userId,
    commandConfirmation.commandId,
    SETTLE_TIMEOUT_MS,
  );
  const view = agi.commands.view(input.userId, commandConfirmation.commandId)!;
  return {
    handled: true,
    text: narrateCommandOutcome(view),
    meta: { agiCommand: 'confirmation', commandId: commandConfirmation.commandId },
  };
}

async function handleWorkflowRun(
  input: DeviceTurnInput,
  plan: DevicePlan,
  resolveContext: ResolveContext,
): Promise<DeviceTurnResult> {
  const { agi } = input;
  const name = plan.workflowName?.trim();
  const workflows = agi.workflows.list(input.userId);
  if (workflows.length === 0) {
    return {
      handled: true,
      text: 'You have no saved workflows yet. You can create one in the Workflows panel.',
      meta: { agiCommand: 'workflow' },
    };
  }
  const match =
    (name && workflows.find((w) => w.name.toLowerCase() === name.toLowerCase())) ||
    (name && workflows.find((w) => w.name.toLowerCase().includes(name.toLowerCase())));
  if (!match) {
    return {
      handled: true,
      text: `I could not find a workflow called "${name ?? ''}". You have: ${workflows.map((w) => w.name).join(', ')}.`,
      meta: { agiCommand: 'workflow' },
    };
  }

  const run = await agi.workflows.run({
    userId: input.userId,
    workflowId: match.id,
    conversationId: input.conversationId,
    context: resolveContext,
  });

  // Runs always ask once before touching anything.
  return {
    handled: true,
    text: `Before I ${run.confirmation?.summary ?? `run "${match.name}"`}\n\nShould I go ahead?`,
    meta: { agiCommand: 'confirmation_required', runId: run.runId },
  };
}

// ---------------------------------------------------------------------------

function describeNonCreation(
  result: { kind: string } & Record<string, unknown>,
): string {
  switch (result.kind) {
    case 'invalid':
    case 'denied':
      return String(result.reason);
    case 'clarification_needed':
      return String(result.question);
    case 'duplicate':
      return 'I had already started that — I am not going to run it twice.';
    default:
      return 'I could not run that.';
  }
}

function describeCapabilityShort(view: CommandView): string {
  const capability = getCapability(view.command.capability);
  return capability ? capability.name.split('.')[0]! : 'That';
}

/** Devices online right now — used by the status endpoint and the UI header. */
export function countOnlineDevices(storage: DeviceStorage, userId: string, offlineAfterMs: number): number {
  return storage.devices
    .listByUser(userId)
    .filter((d) => isDeviceOnline(d, offlineAfterMs)).length;
}
