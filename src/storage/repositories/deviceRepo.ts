// Device registry — the authoritative list of a user's paired devices and the
// capabilities each one actually advertises.
//
// Online/offline is deliberately NOT a stored boolean. It is derived from
// connected_at + last_seen_at, so if the gateway process dies without sending
// disconnect notices, devices age out of "online" on their own instead of
// being stuck there forever and making the assistant lie to the user.

import type { Database as DbType } from 'better-sqlite3';
import { ids } from '../../util/ids.js';
import { now } from '../../util/time.js';

export type DeviceType =
  | 'android_phone'
  | 'android_tablet'
  | 'windows'
  | 'browser'
  | 'generic'
  | 'simulated';

export const DEVICE_TYPES: readonly DeviceType[] = [
  'android_phone',
  'android_tablet',
  'windows',
  'browser',
  'generic',
  'simulated',
] as const;

/** Human-readable labels used when the assistant talks about a device type. */
export const DEVICE_TYPE_LABELS: Record<DeviceType, string> = {
  android_phone: 'Android phone',
  android_tablet: 'Android tablet',
  windows: 'Windows computer',
  browser: 'browser session',
  generic: 'device',
  simulated: 'simulated device',
};

interface DeviceRow {
  id: string;
  user_id: string;
  name: string;
  device_type: DeviceType;
  platform: string;
  platform_version: string | null;
  agent_version: string | null;
  protocol_version: string | null;
  is_primary: number;
  connected_at: number | null;
  last_seen_at: number | null;
  revoked_at: number | null;
  metadata: string;
  created_at: number;
  updated_at: number;
}

export interface Device {
  id: string;
  userId: string;
  name: string;
  deviceType: DeviceType;
  platform: string;
  platformVersion: string | null;
  agentVersion: string | null;
  protocolVersion: string | null;
  isPrimary: boolean;
  connectedAt: number | null;
  lastSeenAt: number | null;
  revokedAt: number | null;
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface DeviceCapabilityEntry {
  deviceId: string;
  capability: string;
  version: number;
  /** The agent claims to support this. */
  advertised: boolean;
  /** The user has not switched it off. */
  enabled: boolean;
  updatedAt: number;
}

function rowToDevice(row: DeviceRow): Device {
  let metadata: Record<string, unknown> = {};
  try {
    metadata = JSON.parse(row.metadata);
  } catch {
    /* tolerate bad JSON, same as personRepo */
  }
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    deviceType: row.device_type,
    platform: row.platform,
    platformVersion: row.platform_version,
    agentVersion: row.agent_version,
    protocolVersion: row.protocol_version,
    isPrimary: row.is_primary === 1,
    connectedAt: row.connected_at,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at,
    metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * A device counts as online only if the gateway currently holds a connection
 * AND we have heard from it recently. Both halves matter: the first catches a
 * clean disconnect, the second catches a gateway that vanished.
 */
export function isDeviceOnline(
  device: Device,
  offlineAfterMs: number,
  at: number = now(),
): boolean {
  if (device.revokedAt) return false;
  if (device.connectedAt === null) return false;
  const seen = device.lastSeenAt ?? device.connectedAt;
  return at - seen <= offlineAfterMs;
}

export interface CreateDeviceInput {
  userId: string;
  name: string;
  deviceType: DeviceType;
  platform?: string;
  platformVersion?: string;
  agentVersion?: string;
  protocolVersion?: string;
  metadata?: Record<string, unknown>;
}

export function createDeviceRepo(db: DbType) {
  const insertStmt = db.prepare(`
    INSERT INTO devices (id, user_id, name, device_type, platform, platform_version, agent_version,
                         protocol_version, is_primary, connected_at, last_seen_at, revoked_at,
                         metadata, created_at, updated_at)
    VALUES (@id, @user_id, @name, @device_type, @platform, @platform_version, @agent_version,
            @protocol_version, @is_primary, @connected_at, @last_seen_at, @revoked_at,
            @metadata, @created_at, @updated_at)
  `);
  const byIdStmt = db.prepare<[string]>('SELECT * FROM devices WHERE id = ?');
  const byNameStmt = db.prepare<[string, string]>(
    'SELECT * FROM devices WHERE user_id = ? AND name = ? COLLATE NOCASE',
  );
  const listByUserStmt = db.prepare<[string]>(
    'SELECT * FROM devices WHERE user_id = ? AND revoked_at IS NULL ORDER BY is_primary DESC, name ASC',
  );
  const listAllByUserStmt = db.prepare<[string]>(
    'SELECT * FROM devices WHERE user_id = ? ORDER BY is_primary DESC, name ASC',
  );
  const renameStmt = db.prepare<[string, number, string]>(
    'UPDATE devices SET name = ?, updated_at = ? WHERE id = ?',
  );
  const clearPrimaryStmt = db.prepare<[number, string]>(
    'UPDATE devices SET is_primary = 0, updated_at = ? WHERE user_id = ?',
  );
  const setPrimaryStmt = db.prepare<[number, string]>(
    'UPDATE devices SET is_primary = 1, updated_at = ? WHERE id = ?',
  );
  const markConnectedStmt = db.prepare<[number, number, number, string | null, string | null, string]>(
    `UPDATE devices SET connected_at = ?, last_seen_at = ?, updated_at = ?,
                       agent_version = COALESCE(?, agent_version),
                       protocol_version = COALESCE(?, protocol_version)
     WHERE id = ?`,
  );
  const markDisconnectedStmt = db.prepare<[number, string]>(
    'UPDATE devices SET connected_at = NULL, updated_at = ? WHERE id = ?',
  );
  const heartbeatStmt = db.prepare<[number, string]>(
    'UPDATE devices SET last_seen_at = ? WHERE id = ?',
  );
  const revokeStmt = db.prepare<[number, number, string]>(
    'UPDATE devices SET revoked_at = ?, connected_at = NULL, updated_at = ? WHERE id = ?',
  );
  const deleteStmt = db.prepare<[string]>('DELETE FROM devices WHERE id = ?');
  const updateMetaStmt = db.prepare<[string, number, string]>(
    'UPDATE devices SET metadata = ?, updated_at = ? WHERE id = ?',
  );
  const updatePlatformStmt = db.prepare<
    [string, string | null, string | null, string | null, number, string]
  >(
    `UPDATE devices SET platform = ?, platform_version = ?, agent_version = ?, protocol_version = ?,
                        updated_at = ? WHERE id = ?`,
  );

  // ---- capabilities ----
  const upsertCapStmt = db.prepare<[string, string, number, number]>(`
    INSERT INTO device_capabilities (device_id, capability, version, advertised, enabled, updated_at)
    VALUES (?, ?, ?, 1, 1, ?)
    ON CONFLICT (device_id, capability)
      DO UPDATE SET version = excluded.version, advertised = 1, updated_at = excluded.updated_at
  `);
  const unadvertiseAllStmt = db.prepare<[number, string]>(
    'UPDATE device_capabilities SET advertised = 0, updated_at = ? WHERE device_id = ?',
  );
  const listCapsStmt = db.prepare<[string]>(
    'SELECT * FROM device_capabilities WHERE device_id = ? ORDER BY capability',
  );
  const setCapEnabledStmt = db.prepare<[number, number, string, string]>(
    'UPDATE device_capabilities SET enabled = ?, updated_at = ? WHERE device_id = ? AND capability = ?',
  );
  const getCapStmt = db.prepare<[string, string]>(
    'SELECT * FROM device_capabilities WHERE device_id = ? AND capability = ?',
  );

  interface CapRow {
    device_id: string;
    capability: string;
    version: number;
    advertised: number;
    enabled: number;
    updated_at: number;
  }
  const rowToCap = (r: CapRow): DeviceCapabilityEntry => ({
    deviceId: r.device_id,
    capability: r.capability,
    version: r.version,
    advertised: r.advertised === 1,
    enabled: r.enabled === 1,
    updatedAt: r.updated_at,
  });

  return {
    create(input: CreateDeviceInput): Device {
      const ts = now();
      const row: DeviceRow = {
        id: ids.device(),
        user_id: input.userId,
        name: input.name,
        device_type: input.deviceType,
        platform: input.platform ?? 'unknown',
        platform_version: input.platformVersion ?? null,
        agent_version: input.agentVersion ?? null,
        protocol_version: input.protocolVersion ?? null,
        is_primary: 0,
        connected_at: null,
        last_seen_at: null,
        revoked_at: null,
        metadata: JSON.stringify(input.metadata ?? {}),
        created_at: ts,
        updated_at: ts,
      };
      insertStmt.run(row);
      return rowToDevice(row);
    },

    getById(id: string): Device | null {
      const row = byIdStmt.get(id) as DeviceRow | undefined;
      return row ? rowToDevice(row) : null;
    },

    /** Ownership-checked read. Use this on every request path. */
    getOwned(userId: string, id: string): Device | null {
      const row = byIdStmt.get(id) as DeviceRow | undefined;
      if (!row || row.user_id !== userId) return null;
      return rowToDevice(row);
    },

    getByName(userId: string, name: string): Device | null {
      const row = byNameStmt.get(userId, name) as DeviceRow | undefined;
      return row ? rowToDevice(row) : null;
    },

    /** Active (non-revoked) devices. */
    listByUser(userId: string): Device[] {
      return (listByUserStmt.all(userId) as DeviceRow[]).map(rowToDevice);
    },

    /** Includes revoked devices — for the settings screen and audits. */
    listAllByUser(userId: string): Device[] {
      return (listAllByUserStmt.all(userId) as DeviceRow[]).map(rowToDevice);
    },

    rename(id: string, name: string): void {
      renameStmt.run(name, now(), id);
    },

    /** Exactly one primary per user. */
    setPrimary(userId: string, deviceId: string): void {
      const tx = db.transaction(() => {
        clearPrimaryStmt.run(now(), userId);
        setPrimaryStmt.run(now(), deviceId);
      });
      tx();
    },

    getPrimary(userId: string): Device | null {
      return this.listByUser(userId).find((d) => d.isPrimary) ?? null;
    },

    markConnected(
      id: string,
      opts: { agentVersion?: string; protocolVersion?: string } = {},
    ): void {
      const ts = now();
      markConnectedStmt.run(
        ts,
        ts,
        ts,
        opts.agentVersion ?? null,
        opts.protocolVersion ?? null,
        id,
      );
    },

    markDisconnected(id: string): void {
      markDisconnectedStmt.run(now(), id);
    },

    heartbeat(id: string): void {
      heartbeatStmt.run(now(), id);
    },

    revoke(id: string): void {
      const ts = now();
      revokeStmt.run(ts, ts, id);
    },

    /** Hard delete. Cascades to credentials, capabilities, executions, events. */
    remove(id: string): void {
      deleteStmt.run(id);
    },

    updateMetadata(id: string, metadata: Record<string, unknown>): void {
      updateMetaStmt.run(JSON.stringify(metadata), now(), id);
    },

    updatePlatformInfo(
      id: string,
      info: {
        platform: string;
        platformVersion?: string;
        agentVersion?: string;
        protocolVersion?: string;
      },
    ): void {
      updatePlatformStmt.run(
        info.platform,
        info.platformVersion ?? null,
        info.agentVersion ?? null,
        info.protocolVersion ?? null,
        now(),
        id,
      );
    },

    // ---- capabilities ----

    /**
     * Replace the advertised capability set. Capabilities the agent no longer
     * reports are marked unadvertised rather than deleted, so a user's
     * "disabled" choice survives an agent downgrade and reinstall.
     */
    replaceAdvertisedCapabilities(
      deviceId: string,
      caps: { capability: string; version?: number }[],
    ): void {
      const ts = now();
      const tx = db.transaction(() => {
        unadvertiseAllStmt.run(ts, deviceId);
        for (const c of caps) {
          upsertCapStmt.run(deviceId, c.capability, c.version ?? 1, ts);
        }
      });
      tx();
    },

    listCapabilities(deviceId: string): DeviceCapabilityEntry[] {
      return (listCapsStmt.all(deviceId) as CapRow[]).map(rowToCap);
    },

    getCapability(deviceId: string, capability: string): DeviceCapabilityEntry | null {
      const row = getCapStmt.get(deviceId, capability) as CapRow | undefined;
      return row ? rowToCap(row) : null;
    },

    setCapabilityEnabled(deviceId: string, capability: string, enabled: boolean): void {
      setCapEnabledStmt.run(enabled ? 1 : 0, now(), deviceId, capability);
    },
  };
}

export type DeviceRepo = ReturnType<typeof createDeviceRepo>;
