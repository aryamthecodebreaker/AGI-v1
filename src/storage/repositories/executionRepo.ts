// Per-device execution records. One row per (command, device).
//
// This table is why partial success is representable: a command over five
// devices can hold three successes, one failure and one offline device, and the
// assistant can describe exactly that instead of averaging it into a lie.
//
// State transitions are guarded: transitionIfOpen() only moves an execution
// that has not already reached a terminal state, so a late-arriving agent
// result can never resurrect a cancelled or timed-out execution.

import type { Database as DbType } from 'better-sqlite3';
import { ids } from '../../util/ids.js';
import { now } from '../../util/time.js';

export type ExecutionState =
  | 'pending'
  | 'waiting_for_confirmation'
  | 'queued'
  | 'dispatching'
  | 'dispatched'
  | 'acknowledged'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'timed_out'
  | 'cancelled'
  | 'unsupported'
  | 'rejected'
  | 'device_offline'
  | 'expired';

/** States that will never change again. */
export const TERMINAL_EXECUTION_STATES: readonly ExecutionState[] = [
  'succeeded',
  'failed',
  'timed_out',
  'cancelled',
  'unsupported',
  'rejected',
  'device_offline',
  'expired',
] as const;

export function isTerminalExecutionState(s: ExecutionState): boolean {
  return TERMINAL_EXECUTION_STATES.includes(s);
}

/** States where the command is sent but no result has arrived yet. */
export const IN_FLIGHT_EXECUTION_STATES: readonly ExecutionState[] = [
  'dispatching',
  'dispatched',
  'acknowledged',
  'running',
] as const;

const TERMINAL_LIST = TERMINAL_EXECUTION_STATES.map((s) => `'${s}'`).join(',');

interface ExecutionRow {
  id: string;
  command_id: string;
  device_id: string;
  user_id: string;
  state: ExecutionState;
  detail: string | null;
  result: string | null;
  attempt: number;
  dispatched_at: number | null;
  acknowledged_at: number | null;
  completed_at: number | null;
  deadline_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface DeviceExecution {
  id: string;
  commandId: string;
  deviceId: string;
  userId: string;
  state: ExecutionState;
  detail: string | null;
  result: Record<string, unknown> | null;
  attempt: number;
  dispatchedAt: number | null;
  acknowledgedAt: number | null;
  completedAt: number | null;
  deadlineAt: number | null;
  createdAt: number;
  updatedAt: number;
}

function rowToExecution(r: ExecutionRow): DeviceExecution {
  let result: Record<string, unknown> | null = null;
  if (r.result) {
    try {
      result = JSON.parse(r.result) as Record<string, unknown>;
    } catch {
      result = null;
    }
  }
  return {
    id: r.id,
    commandId: r.command_id,
    deviceId: r.device_id,
    userId: r.user_id,
    state: r.state,
    detail: r.detail,
    result,
    attempt: r.attempt,
    dispatchedAt: r.dispatched_at,
    acknowledgedAt: r.acknowledged_at,
    completedAt: r.completed_at,
    deadlineAt: r.deadline_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export interface CreateExecutionInput {
  commandId: string;
  deviceId: string;
  userId: string;
  state: ExecutionState;
  detail?: string | null;
  attempt?: number;
  deadlineAt?: number | null;
}

export function createExecutionRepo(db: DbType) {
  const insertStmt = db.prepare(`
    INSERT INTO device_executions (id, command_id, device_id, user_id, state, detail, result, attempt,
      dispatched_at, acknowledged_at, completed_at, deadline_at, created_at, updated_at)
    VALUES (@id, @command_id, @device_id, @user_id, @state, @detail, @result, @attempt,
      @dispatched_at, @acknowledged_at, @completed_at, @deadline_at, @created_at, @updated_at)
  `);
  const byIdStmt = db.prepare<[string]>('SELECT * FROM device_executions WHERE id = ?');
  const byCommandStmt = db.prepare<[string]>(
    'SELECT * FROM device_executions WHERE command_id = ? ORDER BY created_at ASC',
  );
  const byCommandDeviceStmt = db.prepare<[string, string]>(
    'SELECT * FROM device_executions WHERE command_id = ? AND device_id = ?',
  );
  const byDeviceStmt = db.prepare<[string, number]>(
    'SELECT * FROM device_executions WHERE device_id = ? ORDER BY created_at DESC LIMIT ?',
  );

  // Only advances an execution that is still open. `changes === 0` means it had
  // already finished and the incoming update must be ignored.
  // Params: state, detail, result, isTerminal, completedAt, updatedAt, id
  const transitionOpenStmt = db.prepare<
    [ExecutionState, string | null, string | null, number, number, number, string]
  >(`
    UPDATE device_executions
       SET state = ?,
           detail = COALESCE(?, detail),
           result = COALESCE(?, result),
           completed_at = CASE WHEN ? = 1 THEN ? ELSE completed_at END,
           updated_at = ?
     WHERE id = ? AND state NOT IN (${TERMINAL_LIST})
  `);

  const markDispatchedStmt = db.prepare<[number, number, number, string]>(
    `UPDATE device_executions
        SET state = 'dispatched', dispatched_at = ?, deadline_at = ?, updated_at = ?
      WHERE id = ? AND state NOT IN (${TERMINAL_LIST})`,
  );
  const markAckStmt = db.prepare<[number, number, string]>(
    `UPDATE device_executions
        SET state = 'acknowledged', acknowledged_at = ?, updated_at = ?
      WHERE id = ? AND state NOT IN (${TERMINAL_LIST})`,
  );
  const overdueStmt = db.prepare<[number]>(
    `SELECT * FROM device_executions
      WHERE deadline_at IS NOT NULL AND deadline_at < ?
        AND state NOT IN (${TERMINAL_LIST})`,
  );
  const openByCommandStmt = db.prepare<[string]>(
    `SELECT * FROM device_executions
      WHERE command_id = ? AND state NOT IN (${TERMINAL_LIST})`,
  );
  const queuedForDeviceStmt = db.prepare<[string]>(
    `SELECT * FROM device_executions
      WHERE device_id = ? AND state = 'queued' ORDER BY created_at ASC`,
  );

  return {
    create(input: CreateExecutionInput): DeviceExecution {
      const ts = now();
      const row: ExecutionRow = {
        id: ids.execution(),
        command_id: input.commandId,
        device_id: input.deviceId,
        user_id: input.userId,
        state: input.state,
        detail: input.detail ?? null,
        result: null,
        attempt: input.attempt ?? 1,
        dispatched_at: null,
        acknowledged_at: null,
        completed_at: null,
        deadline_at: input.deadlineAt ?? null,
        created_at: ts,
        updated_at: ts,
      };
      insertStmt.run(row);
      return rowToExecution(row);
    },

    getById(id: string): DeviceExecution | null {
      const row = byIdStmt.get(id) as ExecutionRow | undefined;
      return row ? rowToExecution(row) : null;
    },

    listByCommand(commandId: string): DeviceExecution[] {
      return (byCommandStmt.all(commandId) as ExecutionRow[]).map(rowToExecution);
    },

    get(commandId: string, deviceId: string): DeviceExecution | null {
      const row = byCommandDeviceStmt.get(commandId, deviceId) as ExecutionRow | undefined;
      return row ? rowToExecution(row) : null;
    },

    listByDevice(deviceId: string, limit = 25): DeviceExecution[] {
      return (byDeviceStmt.all(deviceId, limit) as ExecutionRow[]).map(rowToExecution);
    },

    /**
     * Move an execution to a new state, but ONLY if it is still open.
     * Returns false when the execution had already finished — the caller
     * should treat that as "this result arrived too late, ignore it".
     */
    transitionIfOpen(
      id: string,
      state: ExecutionState,
      opts: { detail?: string; result?: Record<string, unknown> } = {},
    ): boolean {
      const ts = now();
      const terminal = isTerminalExecutionState(state) ? 1 : 0;
      const res = transitionOpenStmt.run(
        state,
        opts.detail ?? null,
        opts.result ? JSON.stringify(opts.result) : null,
        terminal,
        ts,
        ts,
        id,
      );
      return res.changes === 1;
    },

    markDispatched(id: string, deadlineAt: number): boolean {
      const ts = now();
      return markDispatchedStmt.run(ts, deadlineAt, ts, id).changes === 1;
    },

    markAcknowledged(id: string): boolean {
      const ts = now();
      return markAckStmt.run(ts, ts, id).changes === 1;
    },

    /** Executions whose deadline has passed and that are still open. */
    listOverdue(at: number = now()): DeviceExecution[] {
      return (overdueStmt.all(at) as ExecutionRow[]).map(rowToExecution);
    },

    listOpenByCommand(commandId: string): DeviceExecution[] {
      return (openByCommandStmt.all(commandId) as ExecutionRow[]).map(rowToExecution);
    },

    /** Queued-while-offline work, flushed when a device reconnects. */
    listQueuedForDevice(deviceId: string): DeviceExecution[] {
      return (queuedForDeviceStmt.all(deviceId) as ExecutionRow[]).map(rowToExecution);
    },
  };
}

export type ExecutionRepo = ReturnType<typeof createExecutionRepo>;
