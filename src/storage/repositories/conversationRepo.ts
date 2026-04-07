import type { Database as DbType } from 'better-sqlite3';
import { ids } from '../../util/ids.js';
import { now } from '../../util/time.js';

export interface ConversationRow {
  id: string;
  user_id: string;
  title: string;
  created_at: number;
  updated_at: number;
}

export function createConversationRepo(db: DbType) {
  const insertStmt = db.prepare(`
    INSERT INTO conversations (id, user_id, title, created_at, updated_at)
    VALUES (@id, @user_id, @title, @created_at, @updated_at)
  `);
  const byIdStmt = db.prepare<[string]>('SELECT * FROM conversations WHERE id = ?');
  const listByUserStmt = db.prepare<[string]>(
    'SELECT * FROM conversations WHERE user_id = ? ORDER BY updated_at DESC',
  );
  const touchStmt = db.prepare<[number, string]>(
    'UPDATE conversations SET updated_at = ? WHERE id = ?',
  );
  const renameStmt = db.prepare<[string, number, string]>(
    'UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?',
  );
  const deleteStmt = db.prepare<[string]>('DELETE FROM conversations WHERE id = ?');

  return {
    create(userId: string, title = 'New chat'): ConversationRow {
      const t = now();
      const row: ConversationRow = { id: ids.conversation(), user_id: userId, title, created_at: t, updated_at: t };
      insertStmt.run(row);
      return row;
    },
    getById(id: string): ConversationRow | null {
      return (byIdStmt.get(id) as ConversationRow | undefined) ?? null;
    },
    listByUser(userId: string): ConversationRow[] {
      return listByUserStmt.all(userId) as ConversationRow[];
    },
    touch(id: string): void {
      touchStmt.run(now(), id);
    },
    rename(id: string, title: string): void {
      renameStmt.run(title, now(), id);
    },
    delete(id: string): void {
      deleteStmt.run(id);
    },
  };
}

export type ConversationRepo = ReturnType<typeof createConversationRepo>;
