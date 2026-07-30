// The command lifecycle: create -> resolve -> policy -> store -> dispatch ->
// track -> report.
//
// Two invariants hold throughout, and most of the shape of this file follows
// from them:
//
//   1. Nothing is dispatched before it is durably stored. If the process dies
//      mid-flight, the record of what was attempted survives.
//   2. An execution only ever reaches a success state because a device said so.
//      There is no code path that optimistically marks something succeeded.
//
// Dispatch to multiple devices is concurrent: every online target is contacted
// without waiting for the previous one, and each is tracked separately, so
// three successes plus one failure plus one offline device is representable and
// reported as exactly that.

import crypto from 'node:crypto';
import type { Storage } from '../storage/index.js';
import type { Device } from '../storage/repositories/deviceRepo.js';
import type {
  CommandStatus,
  DeviceCommand,
} from '../storage/repositories/commandRepo.js';
import {
  isTerminalExecutionState,
  type DeviceExecution,
} from '../storage/repositories/executionRepo.js';
import type { ConfirmationRequest } from '../storage/repositories/confirmationRepo.js';
import { logger } from '../logger.js';
import { now } from '../util/time.js';
import { newId } from '../util/ids.js';
import type { DeviceSettings } from '../config.js';
import {
  describeCapability,
  getCapability,
  validateParameters,
  validateResult,
  type CapabilityDefinition,
} from './capabilities.js';
import { evaluatePolicy } from './policy.js';
import {
  needsClarification,
  clarificationQuestion,
  resolveTargets,
  type ResolveContext,
  type ResolvedTargets,
  type TargetExpression,
} from './resolver.js';
import {
  cancellableExecutions,
  retryableExecutions,
  rollupCommandStatus,
} from './status.js';
import type { GatewayClient } from './gatewayClient.js';
import { deviceEvents } from './events.js';
import type { CommandDispatch, CommandFailed } from './protocol.js';

/** How long a confirmation card stays valid. */
const CONFIRMATION_TTL_MS = 2 * 60 * 1000;

export interface CreateCommandRequest {
  userId: string;
  conversationId?: string | null;
  /** The user's own words — stored for history and diagnostics. */
  requestText: string;
  capability: string;
  parameters: unknown;
  target: TargetExpression;
  queueIfOffline?: boolean;
  context?: ResolveContext;
  correctsCommandId?: string | null;
  retryOfCommandId?: string | null;
  workflowRunId?: string | null;
  /** Set when a workflow run was already confirmed as a whole. */
  preConfirmed?: boolean;
  /**
   * Supply a stable key when the same logical request could arrive twice (a
   * chat message id, a workflow run step). Omit it for genuinely new intent —
   * a random key is generated, which correctly means "no deduplication".
   */
  idempotencyKey?: string;
}

export type CreateCommandResult =
  | { kind: 'invalid'; reason: string }
  | { kind: 'denied'; reason: string }
  | { kind: 'clarification_needed'; question: string; resolved: ResolvedTargets }
  | { kind: 'duplicate'; command: DeviceCommand; executions: DeviceExecution[] }
  | {
      kind: 'created';
      command: DeviceCommand;
      executions: DeviceExecution[];
      resolved: ResolvedTargets;
      confirmation: ConfirmationRequest | null;
    };

export interface CommandView {
  command: DeviceCommand;
  executions: (DeviceExecution & { deviceName: string })[];
  confirmation: ConfirmationRequest | null;
}

/**
 * Binds a confirmation to one exact action + target set. If the command is
 * later corrected the fingerprint changes and the old confirmation no longer
 * matches, so it cannot wave through something the user never saw.
 */
function fingerprintCommand(
  capability: string,
  parameters: Record<string, unknown>,
  deviceIds: string[],
): string {
  const canonical = JSON.stringify({
    capability,
    parameters,
    devices: [...deviceIds].sort(),
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

/**
 * Deliver to a browser device over the SSE stream. "Delivered" means a stream is
 * actually open for that user — with no listener the tab is gone, which is
 * indistinguishable from an offline device and reported as such.
 */
function dispatchToBrowser(
  userId: string,
  deviceId: string,
  envelope: CommandDispatch,
): { delivered: boolean; reason?: string } {
  if (deviceEvents.listenerCount(userId) === 0) {
    return { delivered: false, reason: 'the browser is not connected' };
  }
  deviceEvents.publish(userId, {
    kind: 'browser.dispatch',
    commandId: envelope.commandId,
    executionId: envelope.executionId,
    deviceId,
    capability: envelope.capability,
    parameters: envelope.parameters,
    timeoutMs: envelope.timeoutMs,
    expiresAt: envelope.expiresAt,
  });
  return { delivered: true };
}

export function createCommandService(
  storage: Storage,
  settings: DeviceSettings,
  gateway: GatewayClient,
) {
  function publishCommand(command: DeviceCommand): void {
    deviceEvents.publish(command.userId, {
      kind: 'command.updated',
      commandId: command.id,
      status: command.status,
    });
  }

  function publishExecution(execution: DeviceExecution, deviceName: string): void {
    deviceEvents.publish(execution.userId, {
      kind: 'execution.updated',
      commandId: execution.commandId,
      executionId: execution.id,
      deviceId: execution.deviceId,
      deviceName,
      state: execution.state,
      detail: execution.detail,
    });
  }

  /** Recompute the command's status from its executions. Never set by hand. */
  function refreshStatus(commandId: string): CommandStatus | null {
    const command = storage.commands.getById(commandId);
    if (!command) return null;
    const executions = storage.executions.listByCommand(commandId);
    const rolled = rollupCommandStatus(executions);
    if (rolled === command.status) return rolled;

    const terminal =
      rolled === 'succeeded' ||
      rolled === 'partially_succeeded' ||
      rolled === 'failed' ||
      rolled === 'cancelled';
    if (terminal) storage.commands.complete(commandId, rolled);
    else storage.commands.setStatus(commandId, rolled);

    const fresh = storage.commands.getById(commandId)!;
    publishCommand(fresh);
    if (rolled === 'succeeded' || rolled === 'partially_succeeded') {
      storage.deviceEvents.record({
        userId: command.userId,
        commandId,
        kind: 'command.succeeded',
        detail: rolled,
      });
    } else if (rolled === 'failed') {
      storage.deviceEvents.record({
        userId: command.userId,
        commandId,
        kind: 'command.failed',
      });
    }
    return rolled;
  }

  function deviceName(deviceId: string): string {
    return storage.devices.getById(deviceId)?.name ?? 'a device';
  }

  function withDeviceNames(
    executions: DeviceExecution[],
  ): (DeviceExecution & { deviceName: string })[] {
    return executions.map((e) => ({ ...e, deviceName: deviceName(e.deviceId) }));
  }

  /**
   * Send one execution to its device. Returns nothing — the outcome is written
   * to the execution row, which is the only place that matters.
   */
  async function dispatchOne(
    command: DeviceCommand,
    capability: CapabilityDefinition,
    execution: DeviceExecution,
  ): Promise<void> {
    const device = storage.devices.getById(execution.deviceId);
    if (!device || device.revokedAt !== null) {
      storage.executions.transitionIfOpen(execution.id, 'rejected', {
        detail: 'device is no longer available',
      });
      return;
    }

    // Re-check expiry at the moment of dispatch: a command that sat in a
    // confirmation queue may have aged out.
    if (command.expiresAt <= now()) {
      storage.executions.transitionIfOpen(execution.id, 'expired', {
        detail: 'the command expired before it could be sent',
      });
      return;
    }

    if (!storage.executions.transitionIfOpen(execution.id, 'dispatching')) {
      // Already terminal (cancelled while we were working) — leave it alone.
      return;
    }

    const timeoutMs = capability.timeoutMs || settings.commandTimeoutMs;
    const envelope: CommandDispatch = {
      v: 'agi-command/1',
      type: 'command.dispatch',
      ts: now(),
      commandId: command.id,
      executionId: execution.id,
      capability: capability.name,
      capabilityVersion: capability.version,
      parameters: command.parameters,
      timeoutMs,
      expiresAt: Math.min(command.expiresAt, now() + timeoutMs),
    };

    // The browser is a device too, but it reaches us over the user's own
    // authenticated SSE stream rather than the gateway — handing a device
    // credential to page JavaScript is not something we are willing to do.
    const outcome =
      device.deviceType === 'browser'
        ? dispatchToBrowser(command.userId, device.id, envelope)
        : await gateway.dispatch(device.id, envelope);
    if (!outcome.delivered) {
      // Could not reach the device: distinguish "not connected" from "gateway
      // down", because the honest explanation differs.
      const offline = /not connected|offline|unknown device/i.test(outcome.reason ?? '');
      storage.executions.transitionIfOpen(execution.id, offline ? 'device_offline' : 'failed', {
        detail: outcome.reason ?? 'could not be delivered',
      });
      const updated = storage.executions.getById(execution.id);
      if (updated) publishExecution(updated, device.name);
      return;
    }

    storage.executions.markDispatched(execution.id, now() + timeoutMs);
    storage.deviceEvents.record({
      userId: command.userId,
      deviceId: device.id,
      commandId: command.id,
      kind: 'command.dispatched',
    });
    const updated = storage.executions.getById(execution.id);
    if (updated) publishExecution(updated, device.name);
  }

  /** Cancel one in-flight execution, routed the same way its dispatch was. */
  async function sendCancel(
    userId: string,
    deviceId: string,
    commandId: string,
    executionId: string,
  ): Promise<boolean> {
    const device = storage.devices.getById(deviceId);
    if (device?.deviceType === 'browser') {
      if (deviceEvents.listenerCount(userId) === 0) return false;
      deviceEvents.publish(userId, {
        kind: 'browser.cancel',
        commandId,
        executionId,
        deviceId,
      });
      return true;
    }
    const outcome = await gateway.cancel(deviceId, commandId, executionId);
    return outcome.delivered;
  }

  /** Fan out to every pending execution at once. */
  async function dispatchPending(command: DeviceCommand): Promise<void> {
    const capability = getCapability(command.capability);
    if (!capability) return;
    const pending = storage.executions
      .listByCommand(command.id)
      .filter((e) => e.state === 'pending');
    if (pending.length === 0) {
      refreshStatus(command.id);
      return;
    }

    storage.commands.setStatus(command.id, 'dispatching');
    // Concurrent on purpose — one slow device must not delay the others.
    await Promise.allSettled(pending.map((e) => dispatchOne(command, capability, e)));
    refreshStatus(command.id);
  }

  return {
    // -----------------------------------------------------------------------
    // Creation
    // -----------------------------------------------------------------------

    async create(request: CreateCommandRequest): Promise<CreateCommandResult> {
      const capability = getCapability(request.capability);
      if (!capability) {
        return {
          kind: 'invalid',
          reason: `I do not have an action called "${request.capability}".`,
        };
      }

      const validated = validateParameters(capability, request.parameters);
      if (!validated.ok) return { kind: 'invalid', reason: validated.error };

      const resolved = resolveTargets(storage, {
        userId: request.userId,
        expression: request.target,
        capability,
        context: request.context,
        offlineAfterMs: settings.offlineAfterMs,
      });

      if (needsClarification(resolved)) {
        return {
          kind: 'clarification_needed',
          question: clarificationQuestion(resolved),
          resolved,
        };
      }

      const queueIfOffline = Boolean(request.queueIfOffline) && capability.queueable;
      const queued = queueIfOffline ? resolved.offline : [];
      const actionable = resolved.matched.length + queued.length;

      const policy = evaluatePolicy({
        capability,
        targetCount: actionable,
        queueIfOffline,
        preConfirmed: request.preConfirmed,
      });

      if (policy.decision === 'deny') {
        storage.deviceEvents.record({
          userId: request.userId,
          kind: 'command.policy',
          detail: `denied ${capability.name}: ${policy.reason}`,
        });
        return { kind: 'denied', reason: policy.reason };
      }

      const idempotencyKey = request.idempotencyKey ?? newId('idem');
      const existing = storage.commands.getByIdempotencyKey(request.userId, idempotencyKey);
      if (existing) {
        // Same logical request arriving twice — return the original rather than
        // running the action a second time.
        logger.info({ commandId: existing.id }, 'duplicate command suppressed');
        return {
          kind: 'duplicate',
          command: existing,
          executions: storage.executions.listByCommand(existing.id),
        };
      }

      const needsConfirmation = policy.decision === 'require_confirmation';
      const command = storage.commands.create({
        userId: request.userId,
        conversationId: request.conversationId ?? null,
        requestText: request.requestText,
        capability: capability.name,
        parameters: validated.parameters,
        targetExpression: request.target as Record<string, unknown>,
        risk: policy.risk,
        policyDecision: policy.decision,
        policyReason: policy.reason,
        confirmationState: needsConfirmation ? 'pending' : 'not_required',
        status: needsConfirmation ? 'awaiting_confirmation' : 'planned',
        queueIfOffline,
        idempotencyKey,
        correctsCommandId: request.correctsCommandId ?? null,
        retryOfCommandId: request.retryOfCommandId ?? null,
        workflowRunId: request.workflowRunId ?? null,
        expiresAt: now() + Math.max(capability.timeoutMs * 4, settings.commandTimeoutMs * 4),
      });

      // One execution row per targeted device, including the ones that cannot
      // run it — that is how the user gets told about them.
      for (const device of resolved.matched) {
        storage.executions.create({
          commandId: command.id,
          deviceId: device.id,
          userId: request.userId,
          state: needsConfirmation ? 'waiting_for_confirmation' : 'pending',
        });
      }
      for (const device of queued) {
        storage.executions.create({
          commandId: command.id,
          deviceId: device.id,
          userId: request.userId,
          state: 'queued',
          detail: 'waiting for the device to reconnect',
        });
      }
      if (!queueIfOffline) {
        for (const device of resolved.offline) {
          storage.executions.create({
            commandId: command.id,
            deviceId: device.id,
            userId: request.userId,
            state: 'device_offline',
            detail: 'the device was not connected',
          });
        }
      }
      for (const entry of resolved.unsupported) {
        storage.executions.create({
          commandId: command.id,
          deviceId: entry.device.id,
          userId: request.userId,
          state: 'unsupported',
          detail: entry.reason,
        });
      }

      storage.deviceEvents.record({
        userId: request.userId,
        commandId: command.id,
        kind: 'command.created',
        detail: `${capability.name} -> ${resolved.matched.length} online, ${resolved.offline.length} offline`,
      });
      deviceEvents.publish(request.userId, {
        kind: 'command.created',
        commandId: command.id,
        status: command.status,
      });

      let confirmation: ConfirmationRequest | null = null;
      if (needsConfirmation) {
        const targets = [...resolved.matched, ...queued];
        confirmation = storage.confirmations.create({
          commandId: command.id,
          userId: request.userId,
          summary: summarizeForConfirmation(capability, validated.parameters, targets),
          fingerprint: fingerprintCommand(
            capability.name,
            validated.parameters,
            targets.map((d) => d.id),
          ),
          expiresAt: now() + CONFIRMATION_TTL_MS,
        });
        storage.deviceEvents.record({
          userId: request.userId,
          commandId: command.id,
          kind: 'command.confirmation_requested',
        });
        deviceEvents.publish(request.userId, {
          kind: 'confirmation.requested',
          commandId: command.id,
          confirmationId: confirmation.id,
          summary: confirmation.summary,
        });
      } else {
        await dispatchPending(command);
      }

      const fresh = storage.commands.getById(command.id)!;
      return {
        kind: 'created',
        command: fresh,
        executions: storage.executions.listByCommand(command.id),
        resolved,
        confirmation,
      };
    },

    // -----------------------------------------------------------------------
    // Reads
    // -----------------------------------------------------------------------

    view(userId: string, commandId: string): CommandView | null {
      const command = storage.commands.getOwned(userId, commandId);
      if (!command) return null;
      return {
        command,
        executions: withDeviceNames(storage.executions.listByCommand(commandId)),
        confirmation: storage.confirmations.getOpenForCommand(commandId),
      };
    },

    list(userId: string, limit = 25): CommandView[] {
      return storage.commands.listByUser(userId, limit).map((command) => ({
        command,
        executions: withDeviceNames(storage.executions.listByCommand(command.id)),
        confirmation: storage.confirmations.getOpenForCommand(command.id),
      }));
    },

    /** Most recent command in a conversation — the anchor for corrections. */
    latestInConversation(conversationId: string): CommandView | null {
      const [command] = storage.commands.listByConversation(conversationId, 1);
      if (!command) return null;
      return {
        command,
        executions: withDeviceNames(storage.executions.listByCommand(command.id)),
        confirmation: storage.confirmations.getOpenForCommand(command.id),
      };
    },

    // -----------------------------------------------------------------------
    // Confirmation
    // -----------------------------------------------------------------------

    async confirm(
      userId: string,
      commandId: string,
      decision: 'confirmed' | 'rejected',
    ): Promise<{ ok: boolean; reason?: string; command?: DeviceCommand }> {
      const command = storage.commands.getOwned(userId, commandId);
      if (!command) return { ok: false, reason: 'That command no longer exists.' };
      if (command.confirmationState !== 'pending') {
        return {
          ok: false,
          reason: `That command is not waiting for confirmation (it is ${command.status}).`,
        };
      }
      const confirmation = storage.confirmations.getOpenForCommand(commandId);
      if (!confirmation) {
        storage.commands.setConfirmationState(commandId, 'expired');
        return { ok: false, reason: 'That confirmation has expired. Ask me again.' };
      }

      // The command must still be the one the user saw.
      const targets = storage.executions
        .listByCommand(commandId)
        .filter((e) => e.state === 'waiting_for_confirmation' || e.state === 'queued')
        .map((e) => e.deviceId);
      const currentFingerprint = fingerprintCommand(
        command.capability,
        command.parameters,
        targets,
      );
      if (currentFingerprint !== confirmation.fingerprint) {
        storage.confirmations.resolve(confirmation.id, 'expired');
        storage.commands.setConfirmationState(commandId, 'expired');
        return {
          ok: false,
          reason: 'That command changed after I asked, so the confirmation no longer applies.',
        };
      }

      if (!storage.confirmations.resolve(confirmation.id, decision)) {
        return { ok: false, reason: 'That confirmation was already used or has expired.' };
      }
      storage.commands.setConfirmationState(commandId, decision);
      deviceEvents.publish(userId, {
        kind: 'confirmation.resolved',
        commandId,
        confirmationId: confirmation.id,
      });

      if (decision === 'rejected') {
        for (const execution of cancellableExecutions(
          storage.executions.listByCommand(commandId),
        )) {
          storage.executions.transitionIfOpen(execution.id, 'cancelled', {
            detail: 'you declined this action',
          });
        }
        storage.commands.complete(commandId, 'rejected');
        storage.deviceEvents.record({ userId, commandId, kind: 'command.rejected' });
        return { ok: true, command: storage.commands.getById(commandId)! };
      }

      // Promote the held executions and send.
      for (const execution of storage.executions.listByCommand(commandId)) {
        if (execution.state === 'waiting_for_confirmation') {
          storage.executions.transitionIfOpen(execution.id, 'pending');
        }
      }
      storage.deviceEvents.record({ userId, commandId, kind: 'command.confirmed' });
      await dispatchPending(storage.commands.getById(commandId)!);
      return { ok: true, command: storage.commands.getById(commandId)! };
    },

    // -----------------------------------------------------------------------
    // Agent results (gateway-facing)
    // -----------------------------------------------------------------------

    /**
     * Ingest a result from a device. Every field is checked against the stored
     * record: the execution must exist, belong to that command, and belong to
     * that device. A result for someone else's execution is dropped.
     */
    ingestResult(input: {
      deviceId: string;
      commandId: string;
      executionId: string;
      type: 'acknowledged' | 'progress' | 'completed' | 'failed';
      result?: Record<string, unknown>;
      failure?: Pick<CommandFailed, 'code' | 'message'>;
      progressMessage?: string;
    }): { accepted: boolean; reason?: string } {
      const execution = storage.executions.getById(input.executionId);
      if (!execution) return { accepted: false, reason: 'unknown execution' };
      if (execution.commandId !== input.commandId) {
        return { accepted: false, reason: 'execution does not belong to that command' };
      }
      if (execution.deviceId !== input.deviceId) {
        return { accepted: false, reason: 'execution belongs to a different device' };
      }
      const command = storage.commands.getById(input.commandId);
      if (!command) return { accepted: false, reason: 'unknown command' };

      const name = deviceName(input.deviceId);

      switch (input.type) {
        case 'acknowledged': {
          if (!storage.executions.markAcknowledged(execution.id)) {
            return { accepted: false, reason: 'execution already finished' };
          }
          storage.deviceEvents.record({
            userId: command.userId,
            deviceId: input.deviceId,
            commandId: command.id,
            kind: 'command.acknowledged',
          });
          break;
        }
        case 'progress': {
          if (
            !storage.executions.transitionIfOpen(execution.id, 'running', {
              detail: input.progressMessage,
            })
          ) {
            return { accepted: false, reason: 'execution already finished' };
          }
          break;
        }
        case 'completed': {
          const capability = getCapability(command.capability);
          const clean = capability ? validateResult(capability, input.result) : {};
          if (
            !storage.executions.transitionIfOpen(execution.id, 'succeeded', {
              result: clean,
            })
          ) {
            return { accepted: false, reason: 'execution already finished' };
          }
          break;
        }
        case 'failed': {
          const code = input.failure?.code ?? 'failed';
          const state =
            code === 'unsupported'
              ? 'unsupported'
              : code === 'rejected'
                ? 'rejected'
                : code === 'duplicate'
                  ? 'rejected'
                  : 'failed';
          const detail =
            code === 'duplicate'
              ? 'the device had already handled this command'
              : (input.failure?.message ?? 'the device reported a failure');
          if (!storage.executions.transitionIfOpen(execution.id, state, { detail })) {
            return { accepted: false, reason: 'execution already finished' };
          }
          storage.deviceEvents.record({
            userId: command.userId,
            deviceId: input.deviceId,
            commandId: command.id,
            kind: 'command.failed',
            detail,
          });
          break;
        }
      }

      const updated = storage.executions.getById(execution.id)!;
      publishExecution(updated, name);
      refreshStatus(command.id);
      return { accepted: true };
    },

    // -----------------------------------------------------------------------
    // Cancel / retry
    // -----------------------------------------------------------------------

    /**
     * Cancel what has not run yet. Actions already completed on a device cannot
     * be undone from here, and the result says so rather than implying they were
     * rolled back.
     */
    async cancel(
      userId: string,
      commandId: string,
    ): Promise<{
      cancelled: number;
      alreadyCompleted: number;
      inFlightNotified: number;
    }> {
      const command = storage.commands.getOwned(userId, commandId);
      if (!command) throw new Error('command not found');

      const executions = storage.executions.listByCommand(commandId);
      const alreadyCompleted = executions.filter((e) => e.state === 'succeeded').length;
      const open = cancellableExecutions(executions);

      let cancelled = 0;
      let inFlightNotified = 0;
      for (const execution of open) {
        const wasSent =
          execution.state === 'dispatched' ||
          execution.state === 'acknowledged' ||
          execution.state === 'running';
        if (wasSent) {
          const delivered = await sendCancel(
            userId,
            execution.deviceId,
            commandId,
            execution.id,
          );
          if (delivered) inFlightNotified++;
        }
        const detail = wasSent
          ? 'cancelled after it had already been sent — the device may have completed it'
          : 'cancelled before it was sent';
        if (storage.executions.transitionIfOpen(execution.id, 'cancelled', { detail })) {
          cancelled++;
        }
      }

      // Cancelling a command also kills any pending confirmation for it.
      const confirmation = storage.confirmations.getOpenForCommand(commandId);
      if (confirmation) {
        storage.confirmations.resolve(confirmation.id, 'rejected');
        storage.commands.setConfirmationState(commandId, 'rejected');
      }

      storage.commands.cancel(commandId);
      // Re-derive: a command with earlier successes is not simply "cancelled".
      refreshStatus(commandId);
      storage.deviceEvents.record({
        userId,
        commandId,
        kind: 'command.cancelled',
        detail: `${cancelled} cancelled, ${alreadyCompleted} already done`,
      });
      return { cancelled, alreadyCompleted, inFlightNotified };
    },

    /**
     * Retry a command on the devices that did not succeed. Devices that already
     * succeeded are deliberately left alone unless the caller explicitly asks
     * for all of them.
     */
    async retry(
      userId: string,
      commandId: string,
      opts: { includeSucceeded?: boolean; requestText?: string } = {},
    ): Promise<CreateCommandResult & { retriedDeviceIds?: string[] }> {
      const command = storage.commands.getOwned(userId, commandId);
      if (!command) return { kind: 'invalid', reason: 'That command no longer exists.' };

      const executions = storage.executions.listByCommand(commandId);
      const pool = opts.includeSucceeded
        ? executions
        : retryableExecutions(executions);
      const deviceIds = pool.map((e) => e.deviceId);

      if (deviceIds.length === 0) {
        return {
          kind: 'invalid',
          reason: opts.includeSucceeded
            ? 'That command had no devices to retry.'
            : 'Nothing failed on that command, so there is nothing to retry.',
        };
      }

      storage.deviceEvents.record({
        userId,
        commandId,
        kind: 'command.retried',
        detail: `${deviceIds.length} device(s)`,
      });

      const result = await this.create({
        userId,
        conversationId: command.conversationId,
        requestText: opts.requestText ?? `retry: ${command.requestText}`,
        capability: command.capability,
        parameters: command.parameters,
        target: { includeDeviceIds: deviceIds },
        queueIfOffline: command.queueIfOffline,
        retryOfCommandId: command.id,
      });
      return { ...result, retriedDeviceIds: deviceIds };
    },

    /**
     * Apply a conversational correction: keep the action, change the targets.
     * Devices that already succeeded on the original are excluded so the user
     * is not made to sit through a duplicate, and anything still pending on the
     * original is cancelled.
     */
    async correct(input: {
      userId: string;
      commandId: string;
      requestText: string;
      target: TargetExpression;
      parameters?: unknown;
      context?: ResolveContext;
      idempotencyKey?: string;
    }): Promise<
      CreateCommandResult & { alreadySucceededOn?: string[]; cancelledOnOriginal?: number }
    > {
      const original = storage.commands.getOwned(input.userId, input.commandId);
      if (!original) return { kind: 'invalid', reason: 'That command no longer exists.' };

      const executions = storage.executions.listByCommand(original.id);
      const succeededDeviceIds = executions
        .filter((e) => e.state === 'succeeded')
        .map((e) => e.deviceId);
      const alreadySucceededOn = succeededDeviceIds.map((id) => deviceName(id));

      // Stop the parts of the original that have not happened yet.
      let cancelledOnOriginal = 0;
      for (const execution of cancellableExecutions(executions)) {
        const wasSent =
          execution.state === 'dispatched' ||
          execution.state === 'acknowledged' ||
          execution.state === 'running';
        if (wasSent) {
          await sendCancel(input.userId, execution.deviceId, original.id, execution.id);
        }
        if (
          storage.executions.transitionIfOpen(execution.id, 'cancelled', {
            detail: 'superseded by a correction',
          })
        ) {
          cancelledOnOriginal++;
        }
      }
      if (cancelledOnOriginal > 0) refreshStatus(original.id);

      const target: TargetExpression = {
        ...input.target,
        // Never re-run on a device that already did it.
        excludeDeviceIds: [...(input.target.excludeDeviceIds ?? []), ...succeededDeviceIds],
      };

      const result = await this.create({
        userId: input.userId,
        conversationId: original.conversationId,
        requestText: input.requestText,
        capability: original.capability,
        parameters: input.parameters ?? original.parameters,
        target,
        queueIfOffline: original.queueIfOffline,
        correctsCommandId: original.id,
        context: input.context,
        idempotencyKey: input.idempotencyKey,
      });

      return { ...result, alreadySucceededOn, cancelledOnOriginal };
    },

    // -----------------------------------------------------------------------
    // Housekeeping — timeouts, expiry, queued flush
    // -----------------------------------------------------------------------

    /** Mark overdue in-flight executions as timed out. */
    sweepTimeouts(at: number = now()): number {
      const overdue = storage.executions.listOverdue(at);
      const touchedCommands = new Set<string>();
      let count = 0;
      for (const execution of overdue) {
        if (
          storage.executions.transitionIfOpen(execution.id, 'timed_out', {
            detail: 'the device did not respond in time',
          })
        ) {
          count++;
          touchedCommands.add(execution.commandId);
          const updated = storage.executions.getById(execution.id)!;
          publishExecution(updated, deviceName(execution.deviceId));
          storage.deviceEvents.record({
            userId: execution.userId,
            deviceId: execution.deviceId,
            commandId: execution.commandId,
            kind: 'command.timed_out',
          });
        }
      }
      for (const id of touchedCommands) refreshStatus(id);
      return count;
    },

    /**
     * Expire commands that outlived their window — including queued work for a
     * device that never came back. Nothing expired is ever replayed.
     */
    sweepExpired(at: number = now()): number {
      const stale = storage.commands.listExpiredOpen(at);
      let count = 0;
      for (const command of stale) {
        for (const execution of storage.executions.listOpenByCommand(command.id)) {
          if (
            storage.executions.transitionIfOpen(execution.id, 'expired', {
              detail: 'the command expired before it ran',
            })
          ) {
            count++;
            const updated = storage.executions.getById(execution.id)!;
            publishExecution(updated, deviceName(execution.deviceId));
          }
        }
        const confirmation = storage.confirmations.getOpenForCommand(command.id);
        if (confirmation) {
          storage.confirmations.resolve(confirmation.id, 'expired');
          storage.commands.setConfirmationState(command.id, 'expired');
        }
        refreshStatus(command.id);
        storage.deviceEvents.record({
          userId: command.userId,
          commandId: command.id,
          kind: 'command.expired',
        });
      }
      storage.confirmations.expireStale();
      return count;
    },

    /**
     * A device just reconnected: send anything that was queued for it, skipping
     * commands that expired or were cancelled while it was away.
     */
    async flushQueuedForDevice(deviceId: string): Promise<number> {
      const queued = storage.executions.listQueuedForDevice(deviceId);
      let sent = 0;
      for (const execution of queued) {
        const command = storage.commands.getById(execution.commandId);
        if (!command) continue;
        if (command.cancelledAt !== null || command.expiresAt <= now()) {
          storage.executions.transitionIfOpen(execution.id, 'expired', {
            detail: 'the queued command was no longer valid when the device returned',
          });
          refreshStatus(command.id);
          continue;
        }
        const capability = getCapability(command.capability);
        if (!capability) continue;
        if (!storage.executions.transitionIfOpen(execution.id, 'pending')) continue;
        const fresh = storage.executions.getById(execution.id)!;
        await dispatchOne(command, capability, fresh);
        refreshStatus(command.id);
        sent++;
      }
      return sent;
    },

    /**
     * Wait until every execution has either finished or is parked (queued for an
     * offline device, or held for confirmation) — i.e. until no further news is
     * coming. Bounded by timeoutMs so a silent device cannot stall a chat reply;
     * anything still open at that point is described as still running rather
     * than guessed at.
     */
    async waitForSettled(userId: string, commandId: string, timeoutMs: number): Promise<void> {
      const settled = () => {
        const executions = storage.executions.listByCommand(commandId);
        if (executions.length === 0) return true;
        return executions.every(
          (e) =>
            isTerminalExecutionState(e.state) ||
            e.state === 'queued' ||
            e.state === 'waiting_for_confirmation',
        );
      };
      if (settled()) return;

      await new Promise<void>((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          unsubscribe();
          resolve();
        };
        const timer = setTimeout(finish, timeoutMs);
        const unsubscribe = deviceEvents.subscribe(userId, (event) => {
          if ('commandId' in event && event.commandId === commandId && settled()) finish();
        });
        // Re-check after subscribing, in case the last result landed in between.
        if (settled()) finish();
      });
    },

    /** Exposed for the confirm/dispatch paths and for tests. */
    dispatchPending,
    refreshStatus,
  };
}

export type CommandService = ReturnType<typeof createCommandService>;

/** The text shown on a confirmation card: action, targets, key parameters. */
export function summarizeForConfirmation(
  capability: CapabilityDefinition,
  parameters: Record<string, unknown>,
  targets: Device[],
): string {
  const action = describeCapability(capability.name, parameters);
  const names = targets.map((d) => d.name);
  const where =
    names.length === 0
      ? 'no devices'
      : names.length === 1
        ? names[0]!
        : `${names.length} devices (${names.join(', ')})`;
  return `${action} on ${where}`;
}
