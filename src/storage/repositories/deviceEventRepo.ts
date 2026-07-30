// Audit / diagnostics trail for the device subsystem.
//
// Deliberately coarse: an event kind plus a short human-readable detail. It
// must never carry credentials, pairing codes, JWTs or audio — see
// docs/security-threat-model.md. Retention is bounded by
// DEVICE_EVENT_RETENTION_DAYS via pruneOlderThan().

import type { Database as DbType } from 'better-sqlite3';
import { ids } from '../../util/ids.js';
import { now } from '../../util/time.js';

export type DeviceEventKind =
  | 'pairing.created'
  | 'pairing.consumed'
  | 'pairing.failed'
  | 'device.registered'
  | 'device.connected'
  | 'device.disconnected'
  | 'device.renamed'
  | 'device.revoked'
  | 'device.removed'
  | 'device.credential_rotated'
  | 'device.capabilities_updated'
  | 'auth.failed'
  | 'command.created'
  | 'command.resolved'
  | 'command.policy'
  | 'command.confirmation_requested'
  | 'command.confirmed'
  | 'command.rejected'
  | 'command.dispatched'
  | 'command.acknowledged'
  | 'command.progress'
  | 'command.succeeded'
  | 'command.failed'
  | 'command.timed_out'
  | 'command.cancelled'
  | 'command.expired'
  | 'command.retried'
  | 'command.queued'
  | 'workflow.run';

interface EventRow {
  id: string;
  user_id: string;
  device_id: string | null;
  command_id: string | null;
  kind: string;
  detail: string | null;
  created_at: number;
}

export interface DeviceEvent {
  id: string;
  userId: string;
  deviceId: string | null;
  commandId: string | null;
  kind: string;
  detail: string | null;
  createdAt: number;
}

const rowToEvent = (r: EventRow): DeviceEvent => ({
  id: r.id,
  userId: r.user_id,
  deviceId: r.device_id,
  commandId: r.command_id,
  kind: r.kind,
  detail: r.detail,
  createdAt: r.created_at,
});

export function createDeviceEventRepo(db: DbType) {
  const insertStmt = db.prepare(`
    INSERT INTO device_events (id, user_id, device_id, command_id, kind, detail, created_at)
    VALUES (@id, @user_id, @device_id, @command_id, @kind, @detail, @created_at)
  `);
  const listByUserStmt = db.prepare<[string, number]>(
    'SELECT * FROM device_events WHERE user_id = ? ORDER BY created_at DESC LIMIT ?',
  );
  const listByDeviceStmt = db.prepare<[string, number]>(
    'SELECT * FROM device_events WHERE device_id = ? ORDER BY created_at DESC LIMIT ?',
  );
  const listByCommandStmt = db.prepare<[string]>(
    'SELECT * FROM device_events WHERE command_id = ? ORDER BY created_at ASC',
  );
  const pruneStmt = db.prepare<[number]>('DELETE FROM device_events WHERE created_at < ?');

  return {
    record(input: {
      userId: string;
      kind: DeviceEventKind;
      deviceId?: string | null;
      commandId?: string | null;
      detail?: string | null;
    }): DeviceEvent {
      const row: EventRow = {
        id: ids.event(),
        user_id: input.userId,
        device_id: input.deviceId ?? null,
        command_id: input.commandId ?? null,
        kind: input.kind,
        detail: input.detail ?? null,
        created_at: now(),
      };
      insertStmt.run(row);
      return rowToEvent(row);
    },

    listByUser(userId: string, limit = 100): DeviceEvent[] {
      return (listByUserStmt.all(userId, limit) as EventRow[]).map(rowToEvent);
    },

    listByDevice(deviceId: string, limit = 50): DeviceEvent[] {
      return (listByDeviceStmt.all(deviceId, limit) as EventRow[]).map(rowToEvent);
    },

    listByCommand(commandId: string): DeviceEvent[] {
      return (listByCommandStmt.all(commandId) as EventRow[]).map(rowToEvent);
    },

    pruneOlderThan(days: number): number {
      const cutoff = now() - days * 24 * 60 * 60 * 1000;
      return pruneStmt.run(cutoff).changes;
    },
  };
}

export type DeviceEventRepo = ReturnType<typeof createDeviceEventRepo>;
