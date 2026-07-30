// Per-device bearer credentials.
//
// A credential is `<credentialId>.<secret>`. Only a SHA-256 hash of the secret
// half is stored, and lookup is by credentialId so verification stays O(1)
// without ever needing the plaintext in the database.
//
// Token construction/verification lives in src/devices/credentials.ts — this
// file only persists.

import type { Database as DbType } from 'better-sqlite3';
import { ids } from '../../util/ids.js';
import { now } from '../../util/time.js';

interface CredentialRow {
  id: string;
  device_id: string;
  user_id: string;
  secret_hash: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

export interface DeviceCredential {
  id: string;
  deviceId: string;
  userId: string;
  secretHash: string;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

const rowToCredential = (r: CredentialRow): DeviceCredential => ({
  id: r.id,
  deviceId: r.device_id,
  userId: r.user_id,
  secretHash: r.secret_hash,
  createdAt: r.created_at,
  lastUsedAt: r.last_used_at,
  revokedAt: r.revoked_at,
});

export function createDeviceCredentialRepo(db: DbType) {
  const insertStmt = db.prepare(`
    INSERT INTO device_credentials (id, device_id, user_id, secret_hash, created_at, last_used_at, revoked_at)
    VALUES (@id, @device_id, @user_id, @secret_hash, @created_at, @last_used_at, @revoked_at)
  `);
  const byIdStmt = db.prepare<[string]>('SELECT * FROM device_credentials WHERE id = ?');
  const listByDeviceStmt = db.prepare<[string]>(
    'SELECT * FROM device_credentials WHERE device_id = ? ORDER BY created_at DESC',
  );
  const revokeStmt = db.prepare<[number, string]>(
    'UPDATE device_credentials SET revoked_at = ? WHERE id = ?',
  );
  const revokeForDeviceStmt = db.prepare<[number, string]>(
    'UPDATE device_credentials SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL',
  );
  const touchStmt = db.prepare<[number, string]>(
    'UPDATE device_credentials SET last_used_at = ? WHERE id = ?',
  );

  return {
    create(input: { deviceId: string; userId: string; secretHash: string }): DeviceCredential {
      const row: CredentialRow = {
        id: ids.credential(),
        device_id: input.deviceId,
        user_id: input.userId,
        secret_hash: input.secretHash,
        created_at: now(),
        last_used_at: null,
        revoked_at: null,
      };
      insertStmt.run(row);
      return rowToCredential(row);
    },

    getById(id: string): DeviceCredential | null {
      const row = byIdStmt.get(id) as CredentialRow | undefined;
      return row ? rowToCredential(row) : null;
    },

    listByDevice(deviceId: string): DeviceCredential[] {
      return (listByDeviceStmt.all(deviceId) as CredentialRow[]).map(rowToCredential);
    },

    revoke(id: string): void {
      revokeStmt.run(now(), id);
    },

    /** Used by device revocation and credential rotation. */
    revokeAllForDevice(deviceId: string): void {
      revokeForDeviceStmt.run(now(), deviceId);
    },

    touch(id: string): void {
      touchStmt.run(now(), id);
    },
  };
}

export type DeviceCredentialRepo = ReturnType<typeof createDeviceCredentialRepo>;
