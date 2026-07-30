// Workflows — reusable, explicit, inspectable multi-device routines.
//
// A step is a capability + parameters + target expression. There is no script
// field and no eval: a workflow can only do what the capability registry
// already allows, so it inherits the same policy and confirmation checks as a
// one-off command.

import type { Database as DbType } from 'better-sqlite3';
import { ids } from '../../util/ids.js';
import { now } from '../../util/time.js';

export type StepMode = 'sequential' | 'parallel';
export type StepFailureMode = 'stop' | 'continue';

interface WorkflowRow {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  created_at: number;
  updated_at: number;
}

interface StepRow {
  id: string;
  workflow_id: string;
  position: number;
  capability: string;
  parameters: string;
  target_expression: string;
  mode: StepMode;
  on_failure: StepFailureMode;
  timeout_ms: number | null;
}

export interface WorkflowStep {
  id: string;
  workflowId: string;
  position: number;
  capability: string;
  parameters: Record<string, unknown>;
  targetExpression: Record<string, unknown>;
  mode: StepMode;
  onFailure: StepFailureMode;
  timeoutMs: number | null;
}

export interface Workflow {
  id: string;
  userId: string;
  name: string;
  description: string | null;
  createdAt: number;
  updatedAt: number;
  steps: WorkflowStep[];
}

export interface WorkflowStepInput {
  capability: string;
  parameters?: Record<string, unknown>;
  targetExpression?: Record<string, unknown>;
  mode?: StepMode;
  onFailure?: StepFailureMode;
  timeoutMs?: number | null;
}

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

const rowToStep = (r: StepRow): WorkflowStep => ({
  id: r.id,
  workflowId: r.workflow_id,
  position: r.position,
  capability: r.capability,
  parameters: parseJson<Record<string, unknown>>(r.parameters, {}),
  targetExpression: parseJson<Record<string, unknown>>(r.target_expression, {}),
  mode: r.mode,
  onFailure: r.on_failure,
  timeoutMs: r.timeout_ms,
});

export function createWorkflowRepo(db: DbType) {
  const insertWfStmt = db.prepare(`
    INSERT INTO workflows (id, user_id, name, description, created_at, updated_at)
    VALUES (@id, @user_id, @name, @description, @created_at, @updated_at)
  `);
  const insertStepStmt = db.prepare(`
    INSERT INTO workflow_steps (id, workflow_id, position, capability, parameters,
      target_expression, mode, on_failure, timeout_ms)
    VALUES (@id, @workflow_id, @position, @capability, @parameters,
      @target_expression, @mode, @on_failure, @timeout_ms)
  `);
  const byIdStmt = db.prepare<[string]>('SELECT * FROM workflows WHERE id = ?');
  const byNameStmt = db.prepare<[string, string]>(
    'SELECT * FROM workflows WHERE user_id = ? AND name = ? COLLATE NOCASE',
  );
  const listStmt = db.prepare<[string]>(
    'SELECT * FROM workflows WHERE user_id = ? ORDER BY name ASC',
  );
  const stepsStmt = db.prepare<[string]>(
    'SELECT * FROM workflow_steps WHERE workflow_id = ? ORDER BY position ASC',
  );
  const clearStepsStmt = db.prepare<[string]>('DELETE FROM workflow_steps WHERE workflow_id = ?');
  const updateWfStmt = db.prepare<[string, string | null, number, string]>(
    'UPDATE workflows SET name = ?, description = ?, updated_at = ? WHERE id = ?',
  );
  const deleteWfStmt = db.prepare<[string]>('DELETE FROM workflows WHERE id = ?');

  function insertSteps(workflowId: string, steps: WorkflowStepInput[]): void {
    steps.forEach((s, i) => {
      insertStepStmt.run({
        id: ids.workflowStep(),
        workflow_id: workflowId,
        position: i,
        capability: s.capability,
        parameters: JSON.stringify(s.parameters ?? {}),
        target_expression: JSON.stringify(s.targetExpression ?? {}),
        mode: s.mode ?? 'sequential',
        on_failure: s.onFailure ?? 'stop',
        timeout_ms: s.timeoutMs ?? null,
      });
    });
  }

  function hydrate(row: WorkflowRow): Workflow {
    return {
      id: row.id,
      userId: row.user_id,
      name: row.name,
      description: row.description,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      steps: (stepsStmt.all(row.id) as StepRow[]).map(rowToStep),
    };
  }

  return {
    create(input: {
      userId: string;
      name: string;
      description?: string | null;
      steps: WorkflowStepInput[];
    }): Workflow {
      const ts = now();
      const row: WorkflowRow = {
        id: ids.workflow(),
        user_id: input.userId,
        name: input.name,
        description: input.description ?? null,
        created_at: ts,
        updated_at: ts,
      };
      const tx = db.transaction(() => {
        insertWfStmt.run(row);
        insertSteps(row.id, input.steps);
      });
      tx();
      return hydrate(row);
    },

    getById(id: string): Workflow | null {
      const row = byIdStmt.get(id) as WorkflowRow | undefined;
      return row ? hydrate(row) : null;
    },

    getOwned(userId: string, id: string): Workflow | null {
      const row = byIdStmt.get(id) as WorkflowRow | undefined;
      if (!row || row.user_id !== userId) return null;
      return hydrate(row);
    },

    /** Name lookup so "start study mode" can find the workflow. */
    getByName(userId: string, name: string): Workflow | null {
      const row = byNameStmt.get(userId, name) as WorkflowRow | undefined;
      return row ? hydrate(row) : null;
    },

    listByUser(userId: string): Workflow[] {
      return (listStmt.all(userId) as WorkflowRow[]).map(hydrate);
    },

    /** Steps are replaced wholesale — simpler and avoids position drift. */
    update(
      id: string,
      input: { name?: string; description?: string | null; steps?: WorkflowStepInput[] },
    ): Workflow | null {
      const existing = byIdStmt.get(id) as WorkflowRow | undefined;
      if (!existing) return null;
      const tx = db.transaction(() => {
        updateWfStmt.run(
          input.name ?? existing.name,
          input.description === undefined ? existing.description : input.description,
          now(),
          id,
        );
        if (input.steps) {
          clearStepsStmt.run(id);
          insertSteps(id, input.steps);
        }
      });
      tx();
      return this.getById(id);
    },

    remove(id: string): void {
      deleteWfStmt.run(id);
    },
  };
}

export type WorkflowRepo = ReturnType<typeof createWorkflowRepo>;
