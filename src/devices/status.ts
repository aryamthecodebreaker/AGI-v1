// Command status rollup and human-readable summaries.
//
// The overall status of a command is ALWAYS derived from its per-device
// executions — never set independently — so "succeeded" can never be reported
// while a device is still running, and a command over five devices with one
// failure reports partially_succeeded rather than a flat success or failure.

import type { CommandStatus } from '../storage/repositories/commandRepo.js';
import {
  isTerminalExecutionState,
  type DeviceExecution,
  type ExecutionState,
} from '../storage/repositories/executionRepo.js';

/** States that mean "this device did the thing". */
const SUCCESS_STATES: readonly ExecutionState[] = ['succeeded'] as const;

/** Terminal states that mean "this device did not do the thing". */
const FAILURE_STATES: readonly ExecutionState[] = [
  'failed',
  'timed_out',
  'unsupported',
  'rejected',
  'device_offline',
  'expired',
] as const;

export interface ExecutionTally {
  total: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  open: number;
  queued: number;
  awaitingConfirmation: number;
}

export function tallyExecutions(executions: DeviceExecution[]): ExecutionTally {
  const tally: ExecutionTally = {
    total: executions.length,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    open: 0,
    queued: 0,
    awaitingConfirmation: 0,
  };
  for (const e of executions) {
    if (SUCCESS_STATES.includes(e.state)) tally.succeeded++;
    else if (FAILURE_STATES.includes(e.state)) tally.failed++;
    else if (e.state === 'cancelled') tally.cancelled++;
    else {
      tally.open++;
      if (e.state === 'queued') tally.queued++;
      if (e.state === 'waiting_for_confirmation') tally.awaitingConfirmation++;
    }
  }
  return tally;
}

/**
 * Roll per-device executions up into one command status.
 *
 * Order matters: anything still open keeps the command open, because reporting
 * a final status while a device might still succeed is exactly the dishonesty
 * this subsystem exists to prevent.
 */
export function rollupCommandStatus(executions: DeviceExecution[]): CommandStatus {
  if (executions.length === 0) return 'failed';
  const t = tallyExecutions(executions);

  if (t.open > 0) {
    if (t.awaitingConfirmation === t.open && t.succeeded === 0 && t.failed === 0) {
      return 'awaiting_confirmation';
    }
    // Everything left is waiting for a device that is not connected yet.
    if (t.queued === t.open && t.succeeded === 0 && t.failed === 0) return 'queued';
    return 'in_progress';
  }

  // All executions are terminal from here on.
  if (t.cancelled === t.total) return 'cancelled';
  // Nothing actually ran — only cancellations.
  if (t.succeeded === 0 && t.failed === 0) return 'cancelled';
  // "succeeded" means every target did it. A cancelled sibling counts against
  // that: reporting plain success when half the devices were stopped is the
  // kind of rounding this rollup exists to prevent.
  if (t.failed === 0 && t.cancelled === 0) return 'succeeded';
  if (t.succeeded === 0) return 'failed';
  return 'partially_succeeded';
}

export function isExecutionSuccess(state: ExecutionState): boolean {
  return SUCCESS_STATES.includes(state);
}

export function isExecutionFailure(state: ExecutionState): boolean {
  return FAILURE_STATES.includes(state);
}

/** Executions worth retrying: failed, timed out, or never reached the device. */
export function retryableExecutions(executions: DeviceExecution[]): DeviceExecution[] {
  return executions.filter(
    (e) =>
      e.state === 'failed' ||
      e.state === 'timed_out' ||
      e.state === 'device_offline' ||
      e.state === 'expired',
  );
}

/** Cancellable executions: not yet finished. */
export function cancellableExecutions(executions: DeviceExecution[]): DeviceExecution[] {
  return executions.filter((e) => !isTerminalExecutionState(e.state));
}

/** Short label shown per device in the command centre. */
export function executionStateLabel(state: ExecutionState): string {
  switch (state) {
    case 'pending':
      return 'preparing';
    case 'waiting_for_confirmation':
      return 'waiting for confirmation';
    case 'queued':
      return 'queued until it reconnects';
    case 'dispatching':
      return 'sending';
    case 'dispatched':
      return 'sent';
    case 'acknowledged':
      return 'acknowledged';
    case 'running':
      return 'running';
    case 'succeeded':
      return 'done';
    case 'failed':
      return 'failed';
    case 'timed_out':
      return 'timed out';
    case 'cancelled':
      return 'cancelled';
    case 'unsupported':
      return 'not supported';
    case 'rejected':
      return 'refused';
    case 'device_offline':
      return 'offline';
    case 'expired':
      return 'expired';
    default:
      return state;
  }
}
