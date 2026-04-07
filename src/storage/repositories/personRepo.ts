import type { Database as DbType } from 'better-sqlite3';
import { ids } from '../../util/ids.js';
import { now } from '../../util/time.js';

export interface PersonRow {
  id: string;
  user_id: string;
  canonical_name: string;
  display_name: string;
  aliases: string; // JSON array
  relationship: string | null;
  summary: string | null;
  metadata: string; // JSON object
  first_seen_at: number;
  last_mentioned_at: number;
  mention_count: number;
}

export interface Person {
  id: string;
  userId: string;
  canonicalName: string;
  displayName: string;
  aliases: string[];
  relationship: string | null;
  summary: string | null;
  metadata: Record<string, unknown>;
  firstSeenAt: number;
  lastMentionedAt: number;
  mentionCount: number;
}

function rowToPerson(row: PersonRow): Person {
  let aliases: string[] = [];
  let metadata: Record<string, unknown> = {};
  try { aliases = JSON.parse(row.aliases); } catch { /* tolerate bad JSON */ }
  try { metadata = JSON.parse(row.metadata); } catch { /* tolerate bad JSON */ }
  return {
    id: row.id,
    userId: row.user_id,
    canonicalName: row.canonical_name,
    displayName: row.display_name,
    aliases,
    relationship: row.relationship,
    summary: row.summary,
    metadata,
    firstSeenAt: row.first_seen_at,
    lastMentionedAt: row.last_mentioned_at,
    mentionCount: row.mention_count,
  };
}

export function canonicalize(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

export interface UpsertPersonInput {
  userId: string;
  displayName: string;
  relationship?: string;
  summary?: string;
  metadata?: Record<string, unknown>;
  aliases?: string[];
}

export function createPersonRepo(db: DbType) {
  const insertStmt = db.prepare(`
    INSERT INTO people (id, user_id, canonical_name, display_name, aliases, relationship, summary, metadata, first_seen_at, last_mentioned_at, mention_count)
    VALUES (@id, @user_id, @canonical_name, @display_name, @aliases, @relationship, @summary, @metadata, @first_seen_at, @last_mentioned_at, @mention_count)
  `);
  const byCanonicalStmt = db.prepare<[string, string]>(
    'SELECT * FROM people WHERE user_id = ? AND canonical_name = ?',
  );
  const byIdStmt = db.prepare<[string]>('SELECT * FROM people WHERE id = ?');
  const listByUserStmt = db.prepare<[string]>(
    'SELECT * FROM people WHERE user_id = ? ORDER BY last_mentioned_at DESC',
  );
  const bumpMentionStmt = db.prepare<[number, string]>(
    'UPDATE people SET mention_count = mention_count + 1, last_mentioned_at = ? WHERE id = ?',
  );
  const updateSummaryStmt = db.prepare<[string, string]>(
    'UPDATE people SET summary = ? WHERE id = ?',
  );
  const updateMetadataStmt = db.prepare<[string, string]>(
    'UPDATE people SET metadata = ? WHERE id = ?',
  );
  const updateRelationshipStmt = db.prepare<[string, string]>(
    'UPDATE people SET relationship = ? WHERE id = ?',
  );
  const updateAliasesStmt = db.prepare<[string, string]>(
    'UPDATE people SET aliases = ? WHERE id = ?',
  );

  return {
    upsert(input: UpsertPersonInput): Person {
      const canonical = canonicalize(input.displayName);
      const existing = byCanonicalStmt.get(input.userId, canonical) as PersonRow | undefined;
      if (existing) {
        bumpMentionStmt.run(now(), existing.id);
        if (input.relationship && !existing.relationship) updateRelationshipStmt.run(input.relationship, existing.id);
        if (input.summary) updateSummaryStmt.run(input.summary, existing.id);
        if (input.metadata) {
          const merged = { ...(JSON.parse(existing.metadata || '{}')), ...input.metadata };
          updateMetadataStmt.run(JSON.stringify(merged), existing.id);
        }
        if (input.aliases && input.aliases.length) {
          const curAliases: string[] = JSON.parse(existing.aliases || '[]');
          const unique = Array.from(new Set([...curAliases, ...input.aliases]));
          updateAliasesStmt.run(JSON.stringify(unique), existing.id);
        }
        const fresh = byIdStmt.get(existing.id) as PersonRow;
        return rowToPerson(fresh);
      }
      const row: PersonRow = {
        id: ids.person(),
        user_id: input.userId,
        canonical_name: canonical,
        display_name: input.displayName,
        aliases: JSON.stringify(input.aliases ?? []),
        relationship: input.relationship ?? null,
        summary: input.summary ?? null,
        metadata: JSON.stringify(input.metadata ?? {}),
        first_seen_at: now(),
        last_mentioned_at: now(),
        mention_count: 1,
      };
      insertStmt.run(row);
      return rowToPerson(row);
    },
    getById(id: string): Person | null {
      const row = byIdStmt.get(id) as PersonRow | undefined;
      return row ? rowToPerson(row) : null;
    },
    getByCanonical(userId: string, canonicalName: string): Person | null {
      const row = byCanonicalStmt.get(userId, canonicalName) as PersonRow | undefined;
      return row ? rowToPerson(row) : null;
    },
    listByUser(userId: string): Person[] {
      return (listByUserStmt.all(userId) as PersonRow[]).map(rowToPerson);
    },
    updateSummary(id: string, summary: string): void {
      updateSummaryStmt.run(summary, id);
    },
    mergeMetadata(id: string, partial: Record<string, unknown>): void {
      const cur = byIdStmt.get(id) as PersonRow | undefined;
      if (!cur) return;
      const merged = { ...JSON.parse(cur.metadata || '{}'), ...partial };
      updateMetadataStmt.run(JSON.stringify(merged), id);
    },
  };
}

export type PersonRepo = ReturnType<typeof createPersonRepo>;
