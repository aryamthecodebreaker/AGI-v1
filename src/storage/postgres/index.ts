import { neon, type NeonQueryFunction } from '@neondatabase/serverless';
import { ids } from '../../util/ids.js';
import { now } from '../../util/time.js';
import { cosineSim } from '../vector.js';
import type { ConversationRow } from '../repositories/conversationRepo.js';
import type {
  HybridSearchResult,
  InsertMemoryInput,
  Memory,
  MemoryKind,
} from '../repositories/memoryRepo.js';
import type { InsertMessageInput, MessageRow, Role } from '../repositories/messageRepo.js';
import { canonicalize, type Person, type UpsertPersonInput } from '../repositories/personRepo.js';
import type { CreateUserInput, UserRow } from '../repositories/userRepo.js';
import type {
  CapabilityRequestRow,
  CapabilityRequestUpdate,
} from '../repositories/capabilityRequestRepo.js';
import type { Storage } from '../types.js';
import { runPostgresMigrations } from './migrate.js';

type Sql = NeonQueryFunction<false, false>;
type DbValue = string | number | null;

interface PostgresMemoryRow {
  id: string;
  user_id: string;
  conversation_id: string | null;
  source_message_id: string | null;
  kind: MemoryKind;
  content: string;
  importance: number | string;
  embedding: number[] | null;
  created_at: DbValue;
  last_accessed_at: DbValue;
}

interface PostgresPersonRow {
  id: string;
  user_id: string;
  canonical_name: string;
  display_name: string;
  aliases: string[] | string;
  relationship: string | null;
  summary: string | null;
  metadata: Record<string, unknown> | string;
  first_seen_at: DbValue;
  last_mentioned_at: DbValue;
  mention_count: number | string;
}

function asNumber(value: string | number): number {
  return typeof value === 'number' ? value : Number(value);
}

function normalizeUser(row: UserRow): UserRow {
  return { ...row, created_at: asNumber(row.created_at), updated_at: asNumber(row.updated_at) };
}

function normalizeConversation(row: ConversationRow): ConversationRow {
  return { ...row, created_at: asNumber(row.created_at), updated_at: asNumber(row.updated_at) };
}

function normalizeMessage(row: MessageRow): MessageRow {
  return { ...row, created_at: asNumber(row.created_at) };
}

function normalizeCapabilityRequest(row: CapabilityRequestRow): CapabilityRequestRow {
  return {
    ...row,
    created_at: asNumber(row.created_at),
    updated_at: asNumber(row.updated_at),
  };
}

function toMemory(row: PostgresMemoryRow): Memory {
  return {
    id: row.id,
    userId: row.user_id,
    conversationId: row.conversation_id,
    sourceMessageId: row.source_message_id,
    kind: row.kind,
    content: row.content,
    importance: asNumber(row.importance),
    embedding: row.embedding ? Float32Array.from(row.embedding) : null,
    createdAt: asNumber(row.created_at ?? 0),
    lastAccessedAt: row.last_accessed_at === null ? null : asNumber(row.last_accessed_at),
  };
}

function parseJson<T>(value: T | string, fallback: T): T {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function toPerson(row: PostgresPersonRow): Person {
  return {
    id: row.id,
    userId: row.user_id,
    canonicalName: row.canonical_name,
    displayName: row.display_name,
    aliases: parseJson(row.aliases, []),
    relationship: row.relationship,
    summary: row.summary,
    metadata: parseJson(row.metadata, {}),
    firstSeenAt: asNumber(row.first_seen_at ?? 0),
    lastMentionedAt: asNumber(row.last_mentioned_at ?? 0),
    mentionCount: asNumber(row.mention_count),
  };
}

async function rows<T>(sql: Sql, query: string, params: unknown[] = []): Promise<T[]> {
  return await sql.query(query, params) as unknown as T[];
}

function createPostgresRepos(sql: Sql): Omit<Storage, 'kind' | 'db'> {
  const memories = {
    async insert(input: InsertMemoryInput): Promise<Memory> {
      const createdAt = now();
      const result = await rows<PostgresMemoryRow>(sql, `
        INSERT INTO memories
          (id, user_id, conversation_id, source_message_id, kind, content, importance, embedding, created_at, last_accessed_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, NULL)
        RETURNING *
      `, [
        ids.memory(), input.userId, input.conversationId ?? null, input.sourceMessageId ?? null,
        input.kind, input.content, input.importance ?? 0.5,
        input.embedding ? JSON.stringify(Array.from(input.embedding)) : null, createdAt,
      ]);
      return toMemory(result[0]!);
    },
    async getById(id: string): Promise<Memory | null> {
      const result = await rows<PostgresMemoryRow>(sql, 'SELECT * FROM memories WHERE id = $1', [id]);
      return result[0] ? toMemory(result[0]) : null;
    },
    async listRecentByUser(userId: string, limit = 50): Promise<Memory[]> {
      const result = await rows<PostgresMemoryRow>(
        sql,
        'SELECT * FROM memories WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2',
        [userId, limit],
      );
      return result.map(toMemory);
    },
    async countByUser(userId: string): Promise<number> {
      const result = await rows<{ c: string | number }>(
        sql,
        'SELECT COUNT(*) AS c FROM memories WHERE user_id = $1',
        [userId],
      );
      return asNumber(result[0]?.c ?? 0);
    },
    async touchAccessed(id: string): Promise<void> {
      await sql.query('UPDATE memories SET last_accessed_at = $1 WHERE id = $2', [now(), id]);
    },
    async vectorSearch(
      userId: string,
      queryEmbedding: Float32Array,
      k: number,
      scanLimit = 5000,
    ): Promise<Array<{ memory: Memory; score: number }>> {
      const result = await rows<PostgresMemoryRow>(sql, `
        SELECT * FROM memories
        WHERE user_id = $1 AND embedding IS NOT NULL
        ORDER BY created_at DESC
        LIMIT $2
      `, [userId, scanLimit]);
      return result
        .map(toMemory)
        .filter((memory) => memory.embedding !== null)
        .map((memory) => ({ memory, score: cosineSim(queryEmbedding, memory.embedding!) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, k);
    },
    async ftsSearch(
      userId: string,
      queryText: string,
      k: number,
    ): Promise<Array<{ memory: Memory; score: number }>> {
      if (!queryText.trim()) return [];
      const result = await rows<PostgresMemoryRow & { rank: number | string }>(sql, `
        SELECT m.*, ts_rank_cd(
          to_tsvector('simple', m.content),
          websearch_to_tsquery('simple', $2)
        ) AS rank
        FROM memories m
        WHERE m.user_id = $1
          AND to_tsvector('simple', m.content) @@ websearch_to_tsquery('simple', $2)
        ORDER BY rank DESC, m.created_at DESC
        LIMIT $3
      `, [userId, queryText, k]);
      return result.map((row) => ({ memory: toMemory(row), score: asNumber(row.rank) }));
    },
    async hybridSearch(
      userId: string,
      queryText: string,
      queryEmbedding: Float32Array | null,
      k: number,
    ): Promise<HybridSearchResult[]> {
      const [ftsHits, vectorHits] = await Promise.all([
        queryText ? this.ftsSearch(userId, queryText, Math.max(k * 4, 20)) : [],
        queryEmbedding ? this.vectorSearch(userId, queryEmbedding, Math.max(k * 4, 20)) : [],
      ]);
      const scores = new Map<string, HybridSearchResult>();
      ftsHits.forEach((hit, index) => {
        const rank = index + 1;
        scores.set(hit.memory.id, { memory: hit.memory, score: 1 / (60 + rank), ftsRank: rank });
      });
      vectorHits.forEach((hit, index) => {
        const rank = index + 1;
        const existing = scores.get(hit.memory.id);
        if (existing) {
          existing.score += 1 / (60 + rank);
          existing.vectorRank = rank;
        } else {
          scores.set(hit.memory.id, { memory: hit.memory, score: 1 / (60 + rank), vectorRank: rank });
        }
      });
      return [...scores.values()].sort((a, b) => b.score - a.score).slice(0, k);
    },
  } satisfies Storage['memories'];

  return {
    users: {
      async create(input: CreateUserInput): Promise<UserRow> {
        const t = now();
        const result = await rows<UserRow>(sql, `
          INSERT INTO users (id, username, password_hash, display_name, created_at, updated_at)
          VALUES ($1, $2, $3, $4, $5, $5)
          RETURNING *
        `, [ids.user(), input.username, input.passwordHash, input.displayName ?? null, t]);
        return normalizeUser(result[0]!);
      },
      async getByUsername(username: string): Promise<UserRow | null> {
        const result = await rows<UserRow>(sql, 'SELECT * FROM users WHERE username = $1', [username]);
        return result[0] ? normalizeUser(result[0]) : null;
      },
      async getById(id: string): Promise<UserRow | null> {
        const result = await rows<UserRow>(sql, 'SELECT * FROM users WHERE id = $1', [id]);
        return result[0] ? normalizeUser(result[0]) : null;
      },
    },
    conversations: {
      async create(userId: string, title = 'New chat'): Promise<ConversationRow> {
        const t = now();
        const result = await rows<ConversationRow>(sql, `
          INSERT INTO conversations (id, user_id, title, created_at, updated_at)
          VALUES ($1, $2, $3, $4, $4)
          RETURNING *
        `, [ids.conversation(), userId, title, t]);
        return normalizeConversation(result[0]!);
      },
      async getById(id: string): Promise<ConversationRow | null> {
        const result = await rows<ConversationRow>(sql, 'SELECT * FROM conversations WHERE id = $1', [id]);
        return result[0] ? normalizeConversation(result[0]) : null;
      },
      async listByUser(userId: string): Promise<ConversationRow[]> {
        const result = await rows<ConversationRow>(
          sql,
          'SELECT * FROM conversations WHERE user_id = $1 ORDER BY updated_at DESC',
          [userId],
        );
        return result.map(normalizeConversation);
      },
      async touch(id: string): Promise<void> {
        await sql.query('UPDATE conversations SET updated_at = $1 WHERE id = $2', [now(), id]);
      },
      async rename(id: string, title: string): Promise<void> {
        await sql.query('UPDATE conversations SET title = $1, updated_at = $2 WHERE id = $3', [title, now(), id]);
      },
      async delete(id: string): Promise<void> {
        await sql.query('DELETE FROM conversations WHERE id = $1', [id]);
      },
    },
    messages: {
      async insert(input: InsertMessageInput): Promise<MessageRow> {
        const result = await rows<MessageRow>(sql, `
          INSERT INTO messages (id, conversation_id, user_id, role, content, token_count, created_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          RETURNING *
        `, [
          ids.message(), input.conversationId, input.userId, input.role,
          input.content, input.tokenCount ?? null, now(),
        ]);
        return normalizeMessage(result[0]!);
      },
      async getById(id: string): Promise<MessageRow | null> {
        const result = await rows<MessageRow>(sql, 'SELECT * FROM messages WHERE id = $1', [id]);
        return result[0] ? normalizeMessage(result[0]) : null;
      },
      async listByConversation(conversationId: string): Promise<MessageRow[]> {
        const result = await rows<MessageRow>(
          sql,
          'SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC',
          [conversationId],
        );
        return result.map(normalizeMessage);
      },
      async listRecentByConversation(conversationId: string, limit: number): Promise<MessageRow[]> {
        const result = await rows<MessageRow>(sql, `
          SELECT * FROM messages
          WHERE conversation_id = $1
          ORDER BY created_at DESC
          LIMIT $2
        `, [conversationId, limit]);
        return result.map(normalizeMessage);
      },
      async countByConversation(conversationId: string): Promise<number> {
        const result = await rows<{ c: string | number }>(
          sql,
          'SELECT COUNT(*) AS c FROM messages WHERE conversation_id = $1',
          [conversationId],
        );
        return asNumber(result[0]?.c ?? 0);
      },
    },
    memories,
    people: {
      async upsert(input: UpsertPersonInput): Promise<Person> {
        const t = now();
        const result = await rows<PostgresPersonRow>(sql, `
          INSERT INTO people
            (id, user_id, canonical_name, display_name, aliases, relationship, summary, metadata, first_seen_at, last_mentioned_at, mention_count)
          VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8::jsonb, $9, $9, 1)
          ON CONFLICT (user_id, canonical_name) DO UPDATE SET
            mention_count = people.mention_count + 1,
            last_mentioned_at = EXCLUDED.last_mentioned_at,
            relationship = COALESCE(people.relationship, EXCLUDED.relationship),
            summary = COALESCE(EXCLUDED.summary, people.summary),
            metadata = people.metadata || EXCLUDED.metadata,
            aliases = people.aliases || EXCLUDED.aliases
          RETURNING *
        `, [
          ids.person(), input.userId, canonicalize(input.displayName), input.displayName,
          JSON.stringify(input.aliases ?? []), input.relationship ?? null, input.summary ?? null,
          JSON.stringify(input.metadata ?? {}), t,
        ]);
        return toPerson(result[0]!);
      },
      async getById(id: string): Promise<Person | null> {
        const result = await rows<PostgresPersonRow>(sql, 'SELECT * FROM people WHERE id = $1', [id]);
        return result[0] ? toPerson(result[0]) : null;
      },
      async getByCanonical(userId: string, canonicalName: string): Promise<Person | null> {
        const result = await rows<PostgresPersonRow>(
          sql,
          'SELECT * FROM people WHERE user_id = $1 AND canonical_name = $2',
          [userId, canonicalName],
        );
        return result[0] ? toPerson(result[0]) : null;
      },
      async listByUser(userId: string): Promise<Person[]> {
        const result = await rows<PostgresPersonRow>(
          sql,
          'SELECT * FROM people WHERE user_id = $1 ORDER BY last_mentioned_at DESC',
          [userId],
        );
        return result.map(toPerson);
      },
      async updateSummary(id: string, summary: string): Promise<void> {
        await sql.query('UPDATE people SET summary = $1 WHERE id = $2', [summary, id]);
      },
      async mergeMetadata(id: string, partial: Record<string, unknown>): Promise<void> {
        await sql.query('UPDATE people SET metadata = metadata || $1::jsonb WHERE id = $2', [JSON.stringify(partial), id]);
      },
    },
    personMemories: {
      async link(personId: string, memoryId: string): Promise<void> {
        await sql.query(`
          INSERT INTO person_memories (person_id, memory_id)
          VALUES ($1, $2)
          ON CONFLICT (person_id, memory_id) DO NOTHING
        `, [personId, memoryId]);
      },
      async unlink(personId: string, memoryId: string): Promise<void> {
        await sql.query('DELETE FROM person_memories WHERE person_id = $1 AND memory_id = $2', [personId, memoryId]);
      },
      async getMemoriesForPerson(personId: string, limit = 20): Promise<Memory[]> {
        const result = await rows<PostgresMemoryRow>(sql, `
          SELECT m.*
          FROM person_memories pm
          JOIN memories m ON m.id = pm.memory_id
          WHERE pm.person_id = $1
          ORDER BY m.created_at DESC
          LIMIT $2
        `, [personId, limit]);
        return result.map(toMemory);
      },
      async getPeopleIdsForMemory(memoryId: string): Promise<string[]> {
        const result = await rows<{ person_id: string }>(
          sql,
          'SELECT person_id FROM person_memories WHERE memory_id = $1',
          [memoryId],
        );
        return result.map((row) => row.person_id);
      },
    },
    capabilityRequests: {
      async create(userId: string, task: string): Promise<CapabilityRequestRow> {
        const t = now();
        const result = await rows<CapabilityRequestRow>(sql, `
          INSERT INTO capability_requests
            (id, user_id, task, slug, status, branch_name, pr_url, sandbox_summary, error, created_at, updated_at)
          VALUES ($1, $2, $3, NULL, 'pending', NULL, NULL, NULL, NULL, $4, $4)
          RETURNING *
        `, [ids.capabilityRequest(), userId, task, t]);
        return normalizeCapabilityRequest(result[0]!);
      },
      async update(id: string, input: CapabilityRequestUpdate): Promise<CapabilityRequestRow | null> {
        const result = await rows<CapabilityRequestRow>(sql, `
          UPDATE capability_requests SET
            status = $2,
            slug = COALESCE($3, slug),
            branch_name = COALESCE($4, branch_name),
            pr_url = COALESCE($5, pr_url),
            sandbox_summary = COALESCE($6, sandbox_summary),
            error = $7,
            updated_at = $8
          WHERE id = $1
          RETURNING *
        `, [
          id, input.status, input.slug ?? null, input.branchName ?? null,
          input.prUrl ?? null, input.sandboxSummary ?? null, input.error ?? null, now(),
        ]);
        return result[0] ? normalizeCapabilityRequest(result[0]) : null;
      },
      async getById(id: string): Promise<CapabilityRequestRow | null> {
        const result = await rows<CapabilityRequestRow>(
          sql,
          'SELECT * FROM capability_requests WHERE id = $1',
          [id],
        );
        return result[0] ? normalizeCapabilityRequest(result[0]) : null;
      },
      async listByUser(userId: string): Promise<CapabilityRequestRow[]> {
        const result = await rows<CapabilityRequestRow>(sql, `
          SELECT * FROM capability_requests
          WHERE user_id = $1
          ORDER BY created_at DESC
        `, [userId]);
        return result.map(normalizeCapabilityRequest);
      },
    },
  };
}

export async function createPostgresStorage(databaseUrl: string): Promise<Storage> {
  const sql = neon(databaseUrl);
  await runPostgresMigrations(sql);
  return {
    kind: 'postgres',
    db: null,
    ...createPostgresRepos(sql),
  };
}
