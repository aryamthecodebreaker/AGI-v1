import type { Database as DbType } from 'better-sqlite3';
import { ids } from '../../util/ids.js';
import { now } from '../../util/time.js';

export type CapabilityRequestStatus =
  | 'pending'
  | 'generating'
  | 'validating'
  | 'pr_opened'
  | 'failed';

export interface CapabilityRequestRow {
  id: string;
  user_id: string;
  task: string;
  slug: string | null;
  status: CapabilityRequestStatus;
  branch_name: string | null;
  pr_url: string | null;
  sandbox_summary: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

export interface CapabilityRequestUpdate {
  status: CapabilityRequestStatus;
  slug?: string | null;
  branchName?: string | null;
  prUrl?: string | null;
  sandboxSummary?: string | null;
  error?: string | null;
}

export function createCapabilityRequestRepo(db: DbType) {
  const insertStmt = db.prepare(`
    INSERT INTO capability_requests
      (id, user_id, task, slug, status, branch_name, pr_url, sandbox_summary, error, created_at, updated_at)
    VALUES
      (@id, @user_id, @task, @slug, @status, @branch_name, @pr_url, @sandbox_summary, @error, @created_at, @updated_at)
  `);
  const getStmt = db.prepare<[string]>('SELECT * FROM capability_requests WHERE id = ?');
  const listStmt = db.prepare<[string]>(
    'SELECT * FROM capability_requests WHERE user_id = ? ORDER BY created_at DESC',
  );
  const updateStmt = db.prepare(`
    UPDATE capability_requests SET
      status = @status,
      slug = COALESCE(@slug, slug),
      branch_name = COALESCE(@branch_name, branch_name),
      pr_url = COALESCE(@pr_url, pr_url),
      sandbox_summary = COALESCE(@sandbox_summary, sandbox_summary),
      error = @error,
      updated_at = @updated_at
    WHERE id = @id
  `);

  return {
    create(userId: string, task: string): CapabilityRequestRow {
      const t = now();
      const row: CapabilityRequestRow = {
        id: ids.capabilityRequest(),
        user_id: userId,
        task,
        slug: null,
        status: 'pending',
        branch_name: null,
        pr_url: null,
        sandbox_summary: null,
        error: null,
        created_at: t,
        updated_at: t,
      };
      insertStmt.run(row);
      return row;
    },
    update(id: string, input: CapabilityRequestUpdate): CapabilityRequestRow | null {
      updateStmt.run({
        id,
        status: input.status,
        slug: input.slug ?? null,
        branch_name: input.branchName ?? null,
        pr_url: input.prUrl ?? null,
        sandbox_summary: input.sandboxSummary ?? null,
        error: input.error ?? null,
        updated_at: now(),
      });
      return (getStmt.get(id) as CapabilityRequestRow | undefined) ?? null;
    },
    getById(id: string): CapabilityRequestRow | null {
      return (getStmt.get(id) as CapabilityRequestRow | undefined) ?? null;
    },
    listByUser(userId: string): CapabilityRequestRow[] {
      return listStmt.all(userId) as CapabilityRequestRow[];
    },
  };
}

export type CapabilityRequestRepo = ReturnType<typeof createCapabilityRequestRepo>;
