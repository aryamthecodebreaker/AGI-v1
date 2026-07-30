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
// AGI Command — SQLite only, see deviceRepositories() below.
import { createDeviceRepo } from './repositories/deviceRepo.js';
import { createDeviceCredentialRepo } from './repositories/deviceCredentialRepo.js';
import { createPairingRepo } from './repositories/pairingRepo.js';
import { createDeviceGroupRepo } from './repositories/deviceGroupRepo.js';
import { createCommandRepo } from './repositories/commandRepo.js';
import { createExecutionRepo } from './repositories/executionRepo.js';
import { createConfirmationRepo } from './repositories/confirmationRepo.js';
import { createDeviceEventRepo } from './repositories/deviceEventRepo.js';
import { createWorkflowRepo } from './repositories/workflowRepo.js';
import { createPostgresStorage } from './postgres/index.js';
import type { DeviceRepositories, DeviceStorage, Storage } from './types.js';

export type { Storage, DeviceStorage } from './types.js';

let singleton: Promise<Storage> | null = null;

/**
 * The AGI Command repositories.
 *
 * Deliberately SQLite-only. Device control already requires a long-running
 * gateway process, so it cannot run on the serverless Postgres deployment path
 * anyway — providing half-working Postgres implementations would be a worse lie
 * than saying so plainly. `isDeviceStorage()` is how callers check.
 */
function deviceRepositories(db: DbType): DeviceRepositories {
  return {
    devices: createDeviceRepo(db),
    deviceCredentials: createDeviceCredentialRepo(db),
    pairings: createPairingRepo(db),
    deviceGroups: createDeviceGroupRepo(db),
    commands: createCommandRepo(db),
    executions: createExecutionRepo(db),
    confirmations: createConfirmationRepo(db),
    deviceEvents: createDeviceEventRepo(db),
    workflows: createWorkflowRepo(db),
  };
}

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
    ...deviceRepositories(db),
  };
}

/** True when this storage can back AGI Command. */
export function isDeviceStorage(storage: Storage): storage is DeviceStorage {
  return storage.kind === 'sqlite' && storage.db !== null && storage.devices !== undefined;
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
export function storageFromDb(db: DbType): DeviceStorage {
  return sqliteStorage(db) as DeviceStorage;
}

export function resetStorageSingleton(): void {
  singleton = null;
}
