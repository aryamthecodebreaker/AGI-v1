import type { Database as DbType } from 'better-sqlite3';
import { getDb } from './db.js';
import { runMigrations } from './migrate.js';
import { createUserRepo } from './repositories/userRepo.js';
import { createConversationRepo } from './repositories/conversationRepo.js';
import { createMessageRepo } from './repositories/messageRepo.js';
import { createMemoryRepo } from './repositories/memoryRepo.js';
import { createPersonRepo } from './repositories/personRepo.js';
import { createPersonMemoryRepo } from './repositories/personMemoryRepo.js';
import { createCapabilityRequestRepo } from './repositories/capabilityRequestRepo.js';
import { createPostgresStorage } from './postgres/index.js';
import type { Storage } from './types.js';

export type { Storage } from './types.js';

let singleton: Promise<Storage> | null = null;

function sqliteStorage(db: DbType): Storage {
  runMigrations(db);
  return {
    kind: 'sqlite',
    db,
    users: createUserRepo(db),
    conversations: createConversationRepo(db),
    messages: createMessageRepo(db),
    memories: createMemoryRepo(db),
    people: createPersonRepo(db),
    personMemories: createPersonMemoryRepo(db),
    capabilityRequests: createCapabilityRequestRepo(db),
  };
}

export async function initStorage(): Promise<Storage> {
  if (!singleton) {
    const databaseUrl = process.env.DATABASE_URL?.trim();
    singleton = databaseUrl
      ? createPostgresStorage(databaseUrl)
      : Promise.resolve(sqliteStorage(getDb()));
  }
  try {
    return await singleton;
  } catch (error) {
    singleton = null;
    throw error;
  }
}

/** Build a storage instance around an externally-provided db (for tests). */
export function storageFromDb(db: DbType): Storage {
  return sqliteStorage(db);
}

export function resetStorageSingleton(): void {
  singleton = null;
}
