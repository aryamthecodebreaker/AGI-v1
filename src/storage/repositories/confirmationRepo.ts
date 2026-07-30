// Confirmation requests.
//
// A confirmation is bound to exactly one command by id AND by fingerprint. The
// fingerprint is a hash of the action, resolved targets and parameters, so if
// the command is corrected afterwards the old confirmation stops matching and
// cannot be used to wave through a different action than the user saw.

import type { Database as DbType } from 'better-sqlite3';
import { ids } from '../../util/ids.js';
import { now } from '../../util/time.js';

export type ConfirmationDecision = 'confirmed' | 'rejected' | 'expired';

interface ConfirmationRow {
  id: string;
  command_id: string | null;
  workflow_run_id: string | null;
  user_id: string;
  summary: string;
  fingerprint: string;
  created_at: number;
  expires_at: number;
  resolved_at: number | null;
  decision: ConfirmationDecision | null;
}

export interface ConfirmationRequest {
  id: string;
  /** Null when this confirmation authorises a whole workflow run. */
  commandId: string | null;
  workflowRunId: string | null;
  userId: string;
  summary: string;
  fingerprint: string;
  createdAt: number;
  expiresAt: number;
  resolvedAt: number | null;
  decision: ConfirmationDecision | null;
}

const rowToConfirmation = (r: ConfirmationRow): ConfirmationRequest => ({
  id: r.id,
  commandId: r.command_id,
  workflowRunId: r.workflow_run_id,
  userId: r.user_id,
  summary: r.summary,
  fingerprint: r.fingerprint,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  resolvedAt: r.resolved_at,
  decision: r.decision,
});

export function createConfirmationRepo(db: DbType) {
  const insertStmt = db.prepare(`
    INSERT INTO confirmation_requests (id, command_id, workflow_run_id, user_id, summary, fingerprint,
      created_at, expires_at, resolved_at, decision)
    VALUES (@id, @command_id, @workflow_run_id, @user_id, @summary, @fingerprint,
      @created_at, @expires_at, @resolved_at, @decision)
  `);
  const byIdStmt = db.prepare<[string]>('SELECT * FROM confirmation_requests WHERE id = ?');
  const byCommandStmt = db.prepare<[string]>(
    'SELECT * FROM confirmation_requests WHERE command_id = ? ORDER BY created_at DESC',
  );
  const byRunStmt = db.prepare<[string]>(
    'SELECT * FROM confirmation_requests WHERE workflow_run_id = ? ORDER BY created_at DESC',
  );
  const openForUserStmt = db.prepare<[string, number]>(
    `SELECT * FROM confirmation_requests
      WHERE user_id = ? AND resolved_at IS NULL AND expires_at > ?
      ORDER BY created_at DESC`,
  );
  // Single-use: resolves only if still unresolved and unexpired.
  const resolveStmt = db.prepare<[ConfirmationDecision, number, string, number]>(
    `UPDATE confirmation_requests SET decision = ?, resolved_at = ?
      WHERE id = ? AND resolved_at IS NULL AND expires_at > ?`,
  );
  const expireStmt = db.prepare<[number, number]>(
    `UPDATE confirmation_requests SET decision = 'expired', resolved_at = ?
      WHERE resolved_at IS NULL AND expires_at < ?`,
  );

  return {
    /** Exactly one of commandId / workflowRunId must be supplied. */
    create(input: {
      commandId?: string | null;
      workflowRunId?: string | null;
      userId: string;
      summary: string;
      fingerprint: string;
      expiresAt: number;
    }): ConfirmationRequest {
      const row: ConfirmationRow = {
        id: ids.confirmation(),
        command_id: input.commandId ?? null,
        workflow_run_id: input.workflowRunId ?? null,
        user_id: input.userId,
        summary: input.summary,
        fingerprint: input.fingerprint,
        created_at: now(),
        expires_at: input.expiresAt,
        resolved_at: null,
        decision: null,
      };
      insertStmt.run(row);
      return rowToConfirmation(row);
    },

    getById(id: string): ConfirmationRequest | null {
      const row = byIdStmt.get(id) as ConfirmationRow | undefined;
      return row ? rowToConfirmation(row) : null;
    },

    listByCommand(commandId: string): ConfirmationRequest[] {
      return (byCommandStmt.all(commandId) as ConfirmationRow[]).map(rowToConfirmation);
    },

    listByWorkflowRun(runId: string): ConfirmationRequest[] {
      return (byRunStmt.all(runId) as ConfirmationRow[]).map(rowToConfirmation);
    },

    /** The newest live confirmation for a command, if any. */
    getOpenForCommand(commandId: string): ConfirmationRequest | null {
      const at = now();
      return (
        this.listByCommand(commandId).find((c) => !c.resolvedAt && c.expiresAt > at) ?? null
      );
    },

    getOpenForWorkflowRun(runId: string): ConfirmationRequest | null {
      const at = now();
      return (
        this.listByWorkflowRun(runId).find((c) => !c.resolvedAt && c.expiresAt > at) ?? null
      );
    },

    listOpenForUser(userId: string): ConfirmationRequest[] {
      return (openForUserStmt.all(userId, now()) as ConfirmationRow[]).map(rowToConfirmation);
    },

    /** Returns false if it was already used or had expired. */
    resolve(id: string, decision: ConfirmationDecision): boolean {
      const at = now();
      return resolveStmt.run(decision, at, id, at).changes === 1;
    },

    /** Sweep stale confirmations so the UI does not show live-looking cards. */
    expireStale(): number {
      const at = now();
      return expireStmt.run(at, at).changes;
    },
  };
}

export type ConfirmationRepo = ReturnType<typeof createConfirmationRepo>;
