import type { Database as DbType } from 'better-sqlite3';
import { blobToEmbedding } from '../vector.js';
import type { Memory, MemoryRow } from './memoryRepo.js';

function rowToMemory(row: MemoryRow): Memory {
  return {
    id: row.id,
    userId: row.user_id,
    conversationId: row.conversation_id,
    sourceMessageId: row.source_message_id,
    kind: row.kind,
    content: row.content,
    importance: row.importance,
    embedding: blobToEmbedding(row.embedding),
    createdAt: row.created_at,
    lastAccessedAt: row.last_accessed_at,
  };
}

export function createPersonMemoryRepo(db: DbType) {
  const linkStmt = db.prepare(
    'INSERT OR IGNORE INTO person_memories (person_id, memory_id) VALUES (?, ?)',
  );
  const unlinkStmt = db.prepare('DELETE FROM person_memories WHERE person_id = ? AND memory_id = ?');
  const memoriesForPersonStmt = db.prepare<[string, number]>(`
    SELECT m.*
    FROM person_memories pm
    JOIN memories m ON m.id = pm.memory_id
    WHERE pm.person_id = ?
    ORDER BY m.created_at DESC
    LIMIT ?
  `);
  const peopleForMemoryStmt = db.prepare<[string]>(
    'SELECT person_id FROM person_memories WHERE memory_id = ?',
  );

  return {
    link(personId: string, memoryId: string): void {
      linkStmt.run(personId, memoryId);
    },
    unlink(personId: string, memoryId: string): void {
      unlinkStmt.run(personId, memoryId);
    },
    getMemoriesForPerson(personId: string, limit = 20): Memory[] {
      return (memoriesForPersonStmt.all(personId, limit) as MemoryRow[]).map(rowToMemory);
    },
    getPeopleIdsForMemory(memoryId: string): string[] {
      return (peopleForMemoryStmt.all(memoryId) as Array<{ person_id: string }>).map((r) => r.person_id);
    },
  };
}

export type PersonMemoryRepo = ReturnType<typeof createPersonMemoryRepo>;
