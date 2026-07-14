-- Audit trail for user-requested, sandboxed capability builds.
CREATE TABLE IF NOT EXISTS capability_requests (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task            TEXT NOT NULL,
  slug            TEXT,
  status          TEXT NOT NULL CHECK (status IN ('pending','generating','validating','pr_opened','failed')),
  branch_name     TEXT,
  pr_url          TEXT,
  sandbox_summary TEXT,
  error           TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_capability_requests_user_created
  ON capability_requests(user_id, created_at DESC);
