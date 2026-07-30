// Durable command records. One row per user request; the per-device outcome
// lives in device_executions (see executionRepo).
//
// A command row is written BEFORE anything is dispatched. That ordering is what
// lets the assistant answer "did you actually send it?" honestly after a crash.

import type { Database as DbType } from 'better-sqlite3';
import { ids } from '../../util/ids.js';
import { now } from '../../util/time.js';

/**
 * Overall command status. Always derived from the device executions
 * (see src/devices/status.ts) rather than set by hand in more than one place.
 */
export type CommandStatus =
  | 'planned'
  | 'awaiting_confirmation'
  | 'queued'
  | 'dispatching'
  | 'in_progress'
  | 'succeeded'
  | 'partially_succeeded'
  | 'failed'
  | 'cancelled'
  | 'expired'
  | 'rejected';

export type PolicyDecision = 'allow' | 'require_confirmation' | 'deny';

export type ConfirmationState =
  | 'not_required'
  | 'pending'
  | 'confirmed'
  | 'rejected'
  | 'expired';

/** Terminal statuses never transition again — used to reject replays. */
export const TERMINAL_COMMAND_STATUSES: readonly CommandStatus[] = [
  'succeeded',
  'partially_succeeded',
  'failed',
  'cancelled',
  'expired',
  'rejected',
] as const;

export function isTerminalCommandStatus(s: CommandStatus): boolean {
  return TERMINAL_COMMAND_STATUSES.includes(s);
}

interface CommandRow {
  id: string;
  user_id: string;
  conversation_id: string | null;
  request_text: string;
  capability: string;
  parameters: string;
  target_expression: string;
  risk: string;
  policy_decision: PolicyDecision;
  policy_reason: string | null;
  confirmation_state: ConfirmationState;
  status: CommandStatus;
  queue_if_offline: number;
  idempotency_key: string;
  corrects_command_id: string | null;
  retry_of_command_id: string | null;
  workflow_run_id: string | null;
  created_at: number;
  expires_at: number;
  completed_at: number | null;
  cancelled_at: number | null;
}

export interface DeviceCommand {
  id: string;
  userId: string;
  conversationId: string | null;
  requestText: string;
  capability: string;
  parameters: Record<string, unknown>;
  targetExpression: Record<string, unknown>;
  risk: string;
  policyDecision: PolicyDecision;
  policyReason: string | null;
  confirmationState: ConfirmationState;
  status: CommandStatus;
  queueIfOffline: boolean;
  idempotencyKey: string;
  correctsCommandId: string | null;
  retryOfCommandId: string | null;
  workflowRunId: string | null;
  createdAt: number;
  expiresAt: number;
  completedAt: number | null;
  cancelledAt: number | null;
}

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function rowToCommand(r: CommandRow): DeviceCommand {
  return {
    id: r.id,
    userId: r.user_id,
    conversationId: r.conversation_id,
    requestText: r.request_text,
    capability: r.capability,
    parameters: parseJson<Record<string, unknown>>(r.parameters, {}),
    targetExpression: parseJson<Record<string, unknown>>(r.target_expression, {}),
    risk: r.risk,
    policyDecision: r.policy_decision,
    policyReason: r.policy_reason,
    confirmationState: r.confirmation_state,
    status: r.status,
    queueIfOffline: r.queue_if_offline === 1,
    idempotencyKey: r.idempotency_key,
    correctsCommandId: r.corrects_command_id,
    retryOfCommandId: r.retry_of_command_id,
    workflowRunId: r.workflow_run_id,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    completedAt: r.completed_at,
    cancelledAt: r.cancelled_at,
  };
}

export interface CreateCommandInput {
  userId: string;
  conversationId?: string | null;
  requestText: string;
  capability: string;
  parameters: Record<string, unknown>;
  targetExpression: Record<string, unknown>;
  risk: string;
  policyDecision: PolicyDecision;
  policyReason?: string | null;
  confirmationState?: ConfirmationState;
  status: CommandStatus;
  queueIfOffline?: boolean;
  idempotencyKey: string;
  correctsCommandId?: string | null;
  retryOfCommandId?: string | null;
  workflowRunId?: string | null;
  expiresAt: number;
}

export function createCommandRepo(db: DbType) {
  const insertStmt = db.prepare(`
    INSERT INTO device_commands (id, user_id, conversation_id, request_text, capability, parameters,
      target_expression, risk, policy_decision, policy_reason, confirmation_state, status,
      queue_if_offline, idempotency_key, corrects_command_id, retry_of_command_id, workflow_run_id,
      created_at, expires_at, completed_at, cancelled_at)
    VALUES (@id, @user_id, @conversation_id, @request_text, @capability, @parameters,
      @target_expression, @risk, @policy_decision, @policy_reason, @confirmation_state, @status,
      @queue_if_offline, @idempotency_key, @corrects_command_id, @retry_of_command_id, @workflow_run_id,
      @created_at, @expires_at, @completed_at, @cancelled_at)
  `);
  const byIdStmt = db.prepare<[string]>('SELECT * FROM device_commands WHERE id = ?');
  const byIdemStmt = db.prepare<[string, string]>(
    'SELECT * FROM device_commands WHERE user_id = ? AND idempotency_key = ?',
  );
  const listByUserStmt = db.prepare<[string, number]>(
    'SELECT * FROM device_commands WHERE user_id = ? ORDER BY created_at DESC LIMIT ?',
  );
  const listByConvStmt = db.prepare<[string, number]>(
    'SELECT * FROM device_commands WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?',
  );
  const listByRunStmt = db.prepare<[string]>(
    'SELECT * FROM device_commands WHERE workflow_run_id = ? ORDER BY created_at ASC',
  );
  const setStatusStmt = db.prepare<[CommandStatus, string]>(
    'UPDATE device_commands SET status = ? WHERE id = ?',
  );
  const completeStmt = db.prepare<[CommandStatus, number, string]>(
    'UPDATE device_commands SET status = ?, completed_at = ? WHERE id = ?',
  );
  const cancelStmt = db.prepare<[number, string]>(
    `UPDATE device_commands SET status = 'cancelled', cancelled_at = ? WHERE id = ?`,
  );
  const setConfirmationStmt = db.prepare<[ConfirmationState, string]>(
    'UPDATE device_commands SET confirmation_state = ? WHERE id = ?',
  );
  const expireOpenStmt = db.prepare<[number]>(
    `SELECT * FROM device_commands
      WHERE expires_at < ?
        AND status NOT IN ('succeeded','partially_succeeded','failed','cancelled','expired','rejected')`,
  );

  return {
    create(input: CreateCommandInput): DeviceCommand {
      const row: CommandRow = {
        id: ids.command(),
        user_id: input.userId,
        conversation_id: input.conversationId ?? null,
        request_text: input.requestText,
        capability: input.capability,
        parameters: JSON.stringify(input.parameters ?? {}),
        target_expression: JSON.stringify(input.targetExpression ?? {}),
        risk: input.risk,
        policy_decision: input.policyDecision,
        policy_reason: input.policyReason ?? null,
        confirmation_state: input.confirmationState ?? 'not_required',
        status: input.status,
        queue_if_offline: input.queueIfOffline ? 1 : 0,
        idempotency_key: input.idempotencyKey,
        corrects_command_id: input.correctsCommandId ?? null,
        retry_of_command_id: input.retryOfCommandId ?? null,
        workflow_run_id: input.workflowRunId ?? null,
        created_at: now(),
        expires_at: input.expiresAt,
        completed_at: null,
        cancelled_at: null,
      };
      insertStmt.run(row);
      return rowToCommand(row);
    },

    getById(id: string): DeviceCommand | null {
      const row = byIdStmt.get(id) as CommandRow | undefined;
      return row ? rowToCommand(row) : null;
    },

    getOwned(userId: string, id: string): DeviceCommand | null {
      const row = byIdStmt.get(id) as CommandRow | undefined;
      if (!row || row.user_id !== userId) return null;
      return rowToCommand(row);
    },

    /** Duplicate-intent guard. */
    getByIdempotencyKey(userId: string, key: string): DeviceCommand | null {
      const row = byIdemStmt.get(userId, key) as CommandRow | undefined;
      return row ? rowToCommand(row) : null;
    },

    listByUser(userId: string, limit = 50): DeviceCommand[] {
      return (listByUserStmt.all(userId, limit) as CommandRow[]).map(rowToCommand);
    },

    listByConversation(conversationId: string, limit = 10): DeviceCommand[] {
      return (listByConvStmt.all(conversationId, limit) as CommandRow[]).map(rowToCommand);
    },

    listByWorkflowRun(runId: string): DeviceCommand[] {
      return (listByRunStmt.all(runId) as CommandRow[]).map(rowToCommand);
    },

    setStatus(id: string, status: CommandStatus): void {
      setStatusStmt.run(status, id);
    },

    complete(id: string, status: CommandStatus): void {
      completeStmt.run(status, now(), id);
    },

    cancel(id: string): void {
      cancelStmt.run(now(), id);
    },

    setConfirmationState(id: string, state: ConfirmationState): void {
      setConfirmationStmt.run(state, id);
    },

    /** Commands past their expiry that never reached a terminal status. */
    listExpiredOpen(at: number = now()): DeviceCommand[] {
      return (expireOpenStmt.all(at) as CommandRow[]).map(rowToCommand);
    },
  };
}

export type CommandRepo = ReturnType<typeof createCommandRepo>;
