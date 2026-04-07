import type { Database as DbType } from 'better-sqlite3';
import { ids } from '../../util/ids.js';
import { now } from '../../util/time.js';

export interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  display_name: string | null;
  created_at: number;
  updated_at: number;
}

export interface CreateUserInput {
  username: string;
  passwordHash: string;
  displayName?: string;
}

export function createUserRepo(db: DbType) {
  const insertStmt = db.prepare(`
    INSERT INTO users (id, username, password_hash, display_name, created_at, updated_at)
    VALUES (@id, @username, @password_hash, @display_name, @created_at, @updated_at)
  `);
  const byUsernameStmt = db.prepare<[string]>('SELECT * FROM users WHERE username = ?');
  const byIdStmt = db.prepare<[string]>('SELECT * FROM users WHERE id = ?');

  return {
    create(input: CreateUserInput): UserRow {
      const t = now();
      const row: UserRow = {
        id: ids.user(),
        username: input.username,
        password_hash: input.passwordHash,
        display_name: input.displayName ?? null,
        created_at: t,
        updated_at: t,
      };
      insertStmt.run(row);
      return row;
    },
    getByUsername(username: string): UserRow | null {
      return (byUsernameStmt.get(username) as UserRow | undefined) ?? null;
    },
    getById(id: string): UserRow | null {
      return (byIdStmt.get(id) as UserRow | undefined) ?? null;
    },
  };
}

export type UserRepo = ReturnType<typeof createUserRepo>;
