import type { Database as DbType } from 'better-sqlite3';
import { ids } from '../../util/ids.js';
import { now } from '../../util/time.js';
import { blobToEmbedding, cosineSim, embeddingToBlob } from '../vector.js';

export type MemoryKind = 'raw_turn' | 'fact' | 'summary';

export interface MemoryRow {
  id: string;
  user_id: string;
  conversation_id: string | null;
  source_message_id: string | null;
  kind: MemoryKind;
  content: string;
  importance: number;
  embedding: Buffer | null;
  created_at: number;
  last_accessed_at: number | null;
}

/** Memory as decoded for application code — embedding is a Float32Array (or null). */
export interface Memory {
  id: string;
  userId: string;
  conversationId: string | null;
  sourceMessageId: string | null;
  kind: MemoryKind;
  content: string;
  importance: number;
  embedding: Float32Array | null;
  createdAt: number;
  lastAccessedAt: number | null;
}

export interface InsertMemoryInput {
  userId: string;
  conversationId?: string | null;
  sourceMessageId?: string | null;
  kind: MemoryKind;
  content: string;
  importance?: number;
  embedding?: Float32Array | null;
}

export interface HybridSearchResult {
  memory: Memory;
  score: number;
  vectorRank?: number;
  ftsRank?: number;
}

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

export function createMemoryRepo(db: DbType) {
  const insertStmt = db.prepare(`
    INSERT INTO memories (id, user_id, conversation_id, source_message_id, kind, content, importance, embedding, created_at, last_accessed_at)
    VALUES (@id, @user_id, @conversation_id, @source_message_id, @kind, @content, @importance, @embedding, @created_at, @last_accessed_at)
  `);
  const byIdStmt = db.prepare<[string]>('SELECT * FROM memories WHERE id = ?');
  const allByUserStmt = db.prepare<[string, number]>(
    'SELECT * FROM memories WHERE user_id = ? ORDER BY created_at DESC LIMIT ?',
  );
  const listRecentStmt = db.prepare<[string, number]>(
    'SELECT * FROM memories WHERE user_id = ? ORDER BY created_at DESC LIMIT ?',
  );
  const touchAccessedStmt = db.prepare<[number, string]>(
    'UPDATE memories SET last_accessed_at = ? WHERE id = ?',
  );
  const countByUserStmt = db.prepare<[string]>(
    'SELECT COUNT(*) as c FROM memories WHERE user_id = ?',
  );
  // FTS join — returns memories whose FTS index matches. ORDER BY bm25 is the default FTS5 rank.
  const ftsStmt = db.prepare<[string, string, number]>(`
    SELECT m.*
    FROM memories_fts f
    JOIN memories m ON m.rowid = f.rowid
    WHERE m.user_id = ? AND f.content MATCH ?
    ORDER BY bm25(memories_fts)
    LIMIT ?
  `);

  return {
    insert(input: InsertMemoryInput): Memory {
      const row: MemoryRow = {
        id: ids.memory(),
        user_id: input.userId,
        conversation_id: input.conversationId ?? null,
        source_message_id: input.sourceMessageId ?? null,
        kind: input.kind,
        content: input.content,
        importance: input.importance ?? 0.5,
        embedding: input.embedding ? embeddingToBlob(input.embedding) : null,
        created_at: now(),
        last_accessed_at: null,
      };
      insertStmt.run(row);
      return rowToMemory(row);
    },
    getById(id: string): Memory | null {
      const row = byIdStmt.get(id) as MemoryRow | undefined;
      return row ? rowToMemory(row) : null;
    },
    listRecentByUser(userId: string, limit = 50): Memory[] {
      return (listRecentStmt.all(userId, limit) as MemoryRow[]).map(rowToMemory);
    },
    countByUser(userId: string): number {
      return (countByUserStmt.get(userId) as { c: number }).c;
    },
    touchAccessed(id: string): void {
      touchAccessedStmt.run(now(), id);
    },
    /**
     * Vector-space cosine similarity search.
     *
     * Strategy: pull up to `scanLimit` most-recent rows for the user, sort by cosine similarity to the query,
     * return top-k. For tens of thousands of rows this is a few ms; later we can switch to a native vector
     * extension if needed.
     */
    vectorSearch(
      userId: string,
      queryEmbedding: Float32Array,
      k: number,
      scanLimit = 50_000,
    ): Array<{ memory: Memory; score: number }> {
      const rows = allByUserStmt.all(userId, scanLimit) as MemoryRow[];
      const scored: Array<{ memory: Memory; score: number }> = [];
      for (const row of rows) {
        const emb = blobToEmbedding(row.embedding);
        if (!emb) continue;
        const score = cosineSim(queryEmbedding, emb);
        scored.push({ memory: rowToMemory(row), score });
      }
      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, k);
    },
    /**
     * FTS5 keyword search. Sanitizes the query so stray double-quotes or MATCH operators don't blow up.
     */
    ftsSearch(userId: string, queryText: string, k: number): Array<{ memory: Memory; score: number }> {
      const sanitized = sanitizeFtsQuery(queryText);
      if (!sanitized) return [];
      try {
        const rows = ftsStmt.all(userId, sanitized, k) as MemoryRow[];
        // Rank is implicit in the order; assign a descending pseudo-score so callers can compare.
        return rows.map((row, i) => ({ memory: rowToMemory(row), score: 1 / (1 + i) }));
      } catch {
        return [];
      }
    },
    /**
     * Hybrid search combining vector + FTS via Reciprocal Rank Fusion (RRF).
     *   score(m) = sum_over_lists( 1 / (k_rrf + rank(m)) )
     * RRF needs no tuning and robustly beats either single-source ranker.
     */
    hybridSearch(
      userId: string,
      queryText: string,
      queryEmbedding: Float32Array | null,
      k: number,
    ): HybridSearchResult[] {
      const K_RRF = 60;
      const ftsHits = queryText ? this.ftsSearch(userId, queryText, Math.max(k * 4, 20)) : [];
      const vecHits = queryEmbedding ? this.vectorSearch(userId, queryEmbedding, Math.max(k * 4, 20)) : [];

      const scores = new Map<string, HybridSearchResult>();
      ftsHits.forEach((hit, i) => {
        const rank = i + 1;
        const contrib = 1 / (K_RRF + rank);
        const existing = scores.get(hit.memory.id);
        if (existing) {
          existing.score += contrib;
          existing.ftsRank = rank;
        } else {
          scores.set(hit.memory.id, { memory: hit.memory, score: contrib, ftsRank: rank });
        }
      });
      vecHits.forEach((hit, i) => {
        const rank = i + 1;
        const contrib = 1 / (K_RRF + rank);
        const existing = scores.get(hit.memory.id);
        if (existing) {
          existing.score += contrib;
          existing.vectorRank = rank;
        } else {
          scores.set(hit.memory.id, { memory: hit.memory, score: contrib, vectorRank: rank });
        }
      });

      return Array.from(scores.values())
        .sort((a, b) => b.score - a.score)
        .slice(0, k);
    },
  };
}

/**
 * FTS5 queries accept operators (AND/OR/NEAR/""/-). User input may contain quotes or
 * stray punctuation. We split on non-word chars and rejoin with OR + phrase-quoted tokens
 * to make the query robust while still respecting the user's terms.
 */
function sanitizeFtsQuery(input: string): string {
  const tokens = input
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1);
  if (tokens.length === 0) return '';
  // Quote every token to escape operators, then OR them.
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
}

export type MemoryRepo = ReturnType<typeof createMemoryRepo>;
