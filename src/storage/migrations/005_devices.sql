-- 005_devices.sql — AGI Command: device registry, pairing, commands, workflows.
--
-- Every table is owned by a user_id and cascades from users(id), so deleting a
-- user removes their entire device graph. Nothing here is reachable without an
-- ownership check at the repository layer as well — defence in depth.
--
-- Online/offline is NOT stored as a boolean. It is derived from
-- connected_at + last_seen_at so a gateway crash can never leave a device
-- permanently "online" in the registry.

-- ---------------------------------------------------------------------------
-- Devices
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS devices (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  device_type      TEXT NOT NULL CHECK (device_type IN
                     ('android_phone','android_tablet','windows','browser','generic','simulated')),
  platform         TEXT NOT NULL DEFAULT 'unknown',
  platform_version TEXT,
  agent_version    TEXT,
  protocol_version TEXT,
  is_primary       INTEGER NOT NULL DEFAULT 0,
  -- Set when the gateway reports a live connection, cleared on disconnect.
  connected_at     INTEGER,
  last_seen_at     INTEGER,
  revoked_at       INTEGER,
  -- Safe, non-secret metadata only (model name, screen size, ...).
  metadata         TEXT NOT NULL DEFAULT '{}',
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  -- Names are how the user refers to devices in conversation, so they must be
  -- unambiguous within one account.
  UNIQUE (user_id, name)
);
CREATE INDEX IF NOT EXISTS idx_devices_user       ON devices(user_id);
CREATE INDEX IF NOT EXISTS idx_devices_user_alive ON devices(user_id, revoked_at);

-- ---------------------------------------------------------------------------
-- Device credentials — one bearer credential per device, rotatable, revocable.
-- Only the hash of the secret half is stored.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS device_credentials (
  id           TEXT PRIMARY KEY,
  device_id    TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  secret_hash  TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_device_credentials_device ON device_credentials(device_id);

-- ---------------------------------------------------------------------------
-- Pairing sessions — short-lived, single-use codes. Codes are stored hashed so
-- a database leak cannot be replayed into a pairing.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pairing_sessions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash   TEXT NOT NULL UNIQUE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  consumed_at INTEGER,
  device_id   TEXT REFERENCES devices(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_pairing_user ON pairing_sessions(user_id, created_at);

-- ---------------------------------------------------------------------------
-- Capabilities a device actually advertises, plus the user's per-capability
-- disable switch. `advertised` is what the agent claims; `enabled` is what the
-- user permits. A command needs both.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS device_capabilities (
  device_id  TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  capability TEXT NOT NULL,
  version    INTEGER NOT NULL DEFAULT 1,
  advertised INTEGER NOT NULL DEFAULT 1,
  enabled    INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (device_id, capability)
);

-- ---------------------------------------------------------------------------
-- Device groups — user-created sets like "study devices". A device may be in
-- many. Type-derived groups ("phones", "computers", "all") are NOT stored:
-- the resolver computes them from device_type so they can never go stale.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS device_groups (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  slug       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (user_id, slug)
);

CREATE TABLE IF NOT EXISTS device_group_members (
  group_id  TEXT NOT NULL REFERENCES device_groups(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, device_id)
);
CREATE INDEX IF NOT EXISTS idx_group_members_device ON device_group_members(device_id);

-- ---------------------------------------------------------------------------
-- Commands — the durable record of intent. One row per user request; the
-- per-device outcome lives in device_executions.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS device_commands (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id     TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  -- The user's own words, kept for history and diagnostics.
  request_text        TEXT NOT NULL,
  capability          TEXT NOT NULL,
  parameters          TEXT NOT NULL DEFAULT '{}',
  -- The target expression as planned, before resolution.
  target_expression   TEXT NOT NULL DEFAULT '{}',
  risk                TEXT NOT NULL,
  policy_decision     TEXT NOT NULL CHECK (policy_decision IN ('allow','require_confirmation','deny')),
  policy_reason       TEXT,
  confirmation_state  TEXT NOT NULL DEFAULT 'not_required'
                        CHECK (confirmation_state IN ('not_required','pending','confirmed','rejected','expired')),
  status              TEXT NOT NULL,
  queue_if_offline    INTEGER NOT NULL DEFAULT 0,
  -- Guards against the same intent being executed twice.
  idempotency_key     TEXT NOT NULL,
  corrects_command_id TEXT REFERENCES device_commands(id) ON DELETE SET NULL,
  retry_of_command_id TEXT REFERENCES device_commands(id) ON DELETE SET NULL,
  workflow_run_id     TEXT,
  created_at          INTEGER NOT NULL,
  expires_at          INTEGER NOT NULL,
  completed_at        INTEGER,
  cancelled_at        INTEGER,
  UNIQUE (user_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_commands_user      ON device_commands(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_commands_conv      ON device_commands(conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_commands_open      ON device_commands(user_id, status);
CREATE INDEX IF NOT EXISTS idx_commands_wf_run    ON device_commands(workflow_run_id);

-- ---------------------------------------------------------------------------
-- One execution row per (command, device). This is what makes partial success
-- representable: 3 succeeded, 1 failed, 1 offline.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS device_executions (
  id              TEXT PRIMARY KEY,
  command_id      TEXT NOT NULL REFERENCES device_commands(id) ON DELETE CASCADE,
  device_id       TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  state           TEXT NOT NULL,
  -- Human-readable reason, shown to the user verbatim ("app launching disabled").
  detail          TEXT,
  result          TEXT,
  attempt         INTEGER NOT NULL DEFAULT 1,
  dispatched_at   INTEGER,
  acknowledged_at INTEGER,
  completed_at    INTEGER,
  deadline_at     INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  UNIQUE (command_id, device_id)
);
CREATE INDEX IF NOT EXISTS idx_exec_command ON device_executions(command_id);
CREATE INDEX IF NOT EXISTS idx_exec_device  ON device_executions(device_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_exec_open    ON device_executions(state, deadline_at);

-- ---------------------------------------------------------------------------
-- Confirmation requests — single-use and expiring, bound to exactly ONE thing:
-- either a single command, or one workflow run (which asks once instead of once
-- per step). The CHECK enforces exactly one, so a confirmation can never be
-- ambiguous about what it authorises.
--
-- `fingerprint` hashes the action + targets + parameters, so a confirmation
-- stops matching the moment the thing it described changes.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS confirmation_requests (
  id              TEXT PRIMARY KEY,
  command_id      TEXT REFERENCES device_commands(id) ON DELETE CASCADE,
  workflow_run_id TEXT,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  summary         TEXT NOT NULL,
  fingerprint     TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  resolved_at     INTEGER,
  decision        TEXT CHECK (decision IN ('confirmed','rejected','expired')),
  CHECK ((command_id IS NULL) <> (workflow_run_id IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_confirm_command ON confirmation_requests(command_id);
CREATE INDEX IF NOT EXISTS idx_confirm_run     ON confirmation_requests(workflow_run_id);
CREATE INDEX IF NOT EXISTS idx_confirm_open    ON confirmation_requests(user_id, resolved_at);

-- ---------------------------------------------------------------------------
-- Audit / diagnostics trail. Bounded by DEVICE_EVENT_RETENTION_DAYS via
-- deviceEventRepo.pruneOlderThan(). Never contains credentials or audio.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS device_events (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id  TEXT REFERENCES devices(id) ON DELETE CASCADE,
  command_id TEXT REFERENCES device_commands(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  detail     TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_user ON device_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_age  ON device_events(created_at);

-- ---------------------------------------------------------------------------
-- Workflows — reusable, explicit, inspectable sequences of capability calls.
-- Deliberately NOT a script store: every step is a validated capability +
-- parameters + target expression.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS workflows (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  UNIQUE (user_id, name)
);

CREATE TABLE IF NOT EXISTS workflow_steps (
  id                TEXT PRIMARY KEY,
  workflow_id       TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  position          INTEGER NOT NULL,
  capability        TEXT NOT NULL,
  parameters        TEXT NOT NULL DEFAULT '{}',
  target_expression TEXT NOT NULL DEFAULT '{}',
  mode              TEXT NOT NULL DEFAULT 'sequential' CHECK (mode IN ('sequential','parallel')),
  on_failure        TEXT NOT NULL DEFAULT 'stop'       CHECK (on_failure IN ('stop','continue')),
  timeout_ms        INTEGER,
  UNIQUE (workflow_id, position)
);
CREATE INDEX IF NOT EXISTS idx_workflow_steps ON workflow_steps(workflow_id, position);
