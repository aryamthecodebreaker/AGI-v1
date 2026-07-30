// Pairing sessions — short-lived, single-use codes that let a device join one
// specific user's account.
//
// Codes are only ever stored as a hash, and lookup is BY hash, so a leaked
// database cannot be turned back into a usable pairing code.

import type { Database as DbType } from 'better-sqlite3';
import { ids } from '../../util/ids.js';
import { now } from '../../util/time.js';

interface PairingRow {
  id: string;
  user_id: string;
  code_hash: string;
  created_at: number;
  expires_at: number;
  consumed_at: number | null;
  device_id: string | null;
}

export interface PairingSession {
  id: string;
  userId: string;
  codeHash: string;
  createdAt: number;
  expiresAt: number;
  consumedAt: number | null;
  deviceId: string | null;
}

const rowToSession = (r: PairingRow): PairingSession => ({
  id: r.id,
  userId: r.user_id,
  codeHash: r.code_hash,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  consumedAt: r.consumed_at,
  deviceId: r.device_id,
});

export function createPairingRepo(db: DbType) {
  const insertStmt = db.prepare(`
    INSERT INTO pairing_sessions (id, user_id, code_hash, created_at, expires_at, consumed_at, device_id)
    VALUES (@id, @user_id, @code_hash, @created_at, @expires_at, @consumed_at, @device_id)
  `);
  const byHashStmt = db.prepare<[string]>('SELECT * FROM pairing_sessions WHERE code_hash = ?');
  const byIdStmt = db.prepare<[string]>('SELECT * FROM pairing_sessions WHERE id = ?');
  // Atomic claim: only succeeds if the session is still unconsumed and unexpired.
  // This is what makes a code single-use even under concurrent pairing attempts.
  const consumeStmt = db.prepare<[number, string, string, number]>(
    `UPDATE pairing_sessions SET consumed_at = ?, device_id = ?
     WHERE id = ? AND consumed_at IS NULL AND expires_at > ?`,
  );
  const countRecentStmt = db.prepare<[string, number]>(
    'SELECT COUNT(*) AS n FROM pairing_sessions WHERE user_id = ? AND created_at > ?',
  );
  const listOpenStmt = db.prepare<[string, number]>(
    `SELECT * FROM pairing_sessions
     WHERE user_id = ? AND consumed_at IS NULL AND expires_at > ?
     ORDER BY created_at DESC`,
  );
  const pruneStmt = db.prepare<[number]>(
    'DELETE FROM pairing_sessions WHERE expires_at < ? AND consumed_at IS NULL',
  );

  return {
    create(input: { userId: string; codeHash: string; expiresAt: number }): PairingSession {
      const row: PairingRow = {
        id: ids.pairing(),
        user_id: input.userId,
        code_hash: input.codeHash,
        created_at: now(),
        expires_at: input.expiresAt,
        consumed_at: null,
        device_id: null,
      };
      insertStmt.run(row);
      return rowToSession(row);
    },

    getByCodeHash(codeHash: string): PairingSession | null {
      const row = byHashStmt.get(codeHash) as PairingRow | undefined;
      return row ? rowToSession(row) : null;
    },

    getById(id: string): PairingSession | null {
      const row = byIdStmt.get(id) as PairingRow | undefined;
      return row ? rowToSession(row) : null;
    },

    /**
     * Atomically mark a session used. Returns false if it was already consumed
     * or has expired — the caller must treat false as a failed pairing.
     */
    consume(id: string, deviceId: string): boolean {
      const res = consumeStmt.run(now(), deviceId, id, now());
      return res.changes === 1;
    },

    /** Rate-limit input: how many codes this user minted in the window. */
    countRecent(userId: string, sinceMs: number): number {
      const row = countRecentStmt.get(userId, now() - sinceMs) as { n: number };
      return row.n;
    },

    listOpen(userId: string): PairingSession[] {
      return (listOpenStmt.all(userId, now()) as PairingRow[]).map(rowToSession);
    },

    /** Housekeeping: drop expired codes that were never used. */
    pruneExpired(): number {
      return pruneStmt.run(now()).changes;
    },
  };
}

export type PairingRepo = ReturnType<typeof createPairingRepo>;
