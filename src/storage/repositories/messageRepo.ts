import type { Database as DbType } from 'better-sqlite3';
import { ids } from '../../util/ids.js';
import { now } from '../../util/time.js';

export type Role = 'user' | 'assistant' | 'system';

export interface MessageRow {
  id: string;
  conversation_id: string;
  user_id: string;
  role: Role;
  content: string;
  token_count: number | null;
  created_at: number;
}

export interface InsertMessageInput {
  conversationId: string;
  userId: string;
  role: Role;
  content: string;
  tokenCount?: number;
}

export function createMessageRepo(db: DbType) {
  const insertStmt = db.prepare(`
    INSERT INTO messages (id, conversation_id, user_id, role, content, token_count, created_at)
    VALUES (@id, @conversation_id, @user_id, @role, @content, @token_count, @created_at)
  `);
  const byConvStmt = db.prepare<[string]>(
    'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC',
  );
  const recentByConvStmt = db.prepare<[string, number]>(
    `SELECT * FROM messages
     WHERE conversation_id = ?
     ORDER BY created_at DESC
     LIMIT ?`,
  );
  const byIdStmt = db.prepare<[string]>('SELECT * FROM messages WHERE id = ?');
  const countByConvStmt = db.prepare<[string]>(
    'SELECT COUNT(*) as c FROM messages WHERE conversation_id = ?',
  );

  return {
    insert(input: InsertMessageInput): MessageRow {
      const row: MessageRow = {
        id: ids.message(),
        conversation_id: input.conversationId,
        user_id: input.userId,
        role: input.role,
        content: input.content,
        token_count: input.tokenCount ?? null,
        created_at: now(),
      };
      insertStmt.run(row);
      return row;
    },
    getById(id: string): MessageRow | null {
      return (byIdStmt.get(id) as MessageRow | undefined) ?? null;
    },
    listByConversation(conversationId: string): MessageRow[] {
      return byConvStmt.all(conversationId) as MessageRow[];
    },
    listRecentByConversation(conversationId: string, limit: number): MessageRow[] {
      // Returned newest-first; most callers will .reverse() for chronological order.
      return recentByConvStmt.all(conversationId, limit) as MessageRow[];
    },
    countByConversation(conversationId: string): number {
      return (countByConvStmt.get(conversationId) as { c: number }).c;
    },
  };
}

export type MessageRepo = ReturnType<typeof createMessageRepo>;
