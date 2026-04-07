import type { Database as DbType } from 'better-sqlite3';
import { getDb } from './db.js';
import { runMigrations } from './migrate.js';
import { createUserRepo, type UserRepo } from './repositories/userRepo.js';
import { createConversationRepo, type ConversationRepo } from './repositories/conversationRepo.js';
import { createMessageRepo, type MessageRepo } from './repositories/messageRepo.js';
import { createMemoryRepo, type MemoryRepo } from './repositories/memoryRepo.js';
import { createPersonRepo, type PersonRepo } from './repositories/personRepo.js';
import { createPersonMemoryRepo, type PersonMemoryRepo } from './repositories/personMemoryRepo.js';

export interface Storage {
  db: DbType;
  users: UserRepo;
  conversations: ConversationRepo;
  messages: MessageRepo;
  memories: MemoryRepo;
  people: PersonRepo;
  personMemories: PersonMemoryRepo;
}

let singleton: Storage | null = null;

export function initStorage(): Storage {
  if (singleton) return singleton;
  const db = getDb();
  runMigrations(db);
  singleton = {
    db,
    users: createUserRepo(db),
    conversations: createConversationRepo(db),
    messages: createMessageRepo(db),
    memories: createMemoryRepo(db),
    people: createPersonRepo(db),
    personMemories: createPersonMemoryRepo(db),
  };
  return singleton;
}

/** Build a storage instance around an externally-provided db (for tests). */
export function storageFromDb(db: DbType): Storage {
  runMigrations(db);
  return {
    db,
    users: createUserRepo(db),
    conversations: createConversationRepo(db),
    messages: createMessageRepo(db),
    memories: createMemoryRepo(db),
    people: createPersonRepo(db),
    personMemories: createPersonMemoryRepo(db),
  };
}

export function resetStorageSingleton(): void {
  singleton = null;
}
