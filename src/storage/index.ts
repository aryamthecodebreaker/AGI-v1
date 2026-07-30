import type { Database as DbType } from 'better-sqlite3';
import { getDb } from './db.js';
import { runMigrations } from './migrate.js';
import { createUserRepo, type UserRepo } from './repositories/userRepo.js';
import { createConversationRepo, type ConversationRepo } from './repositories/conversationRepo.js';
import { createMessageRepo, type MessageRepo } from './repositories/messageRepo.js';
import { createMemoryRepo, type MemoryRepo } from './repositories/memoryRepo.js';
import { createPersonRepo, type PersonRepo } from './repositories/personRepo.js';
import { createPersonMemoryRepo, type PersonMemoryRepo } from './repositories/personMemoryRepo.js';
// AGI Command
import { createDeviceRepo, type DeviceRepo } from './repositories/deviceRepo.js';
import {
  createDeviceCredentialRepo,
  type DeviceCredentialRepo,
} from './repositories/deviceCredentialRepo.js';
import { createPairingRepo, type PairingRepo } from './repositories/pairingRepo.js';
import { createDeviceGroupRepo, type DeviceGroupRepo } from './repositories/deviceGroupRepo.js';
import { createCommandRepo, type CommandRepo } from './repositories/commandRepo.js';
import { createExecutionRepo, type ExecutionRepo } from './repositories/executionRepo.js';
import { createConfirmationRepo, type ConfirmationRepo } from './repositories/confirmationRepo.js';
import { createDeviceEventRepo, type DeviceEventRepo } from './repositories/deviceEventRepo.js';
import { createWorkflowRepo, type WorkflowRepo } from './repositories/workflowRepo.js';

export interface Storage {
  db: DbType;
  users: UserRepo;
  conversations: ConversationRepo;
  messages: MessageRepo;
  memories: MemoryRepo;
  people: PersonRepo;
  personMemories: PersonMemoryRepo;
  // AGI Command
  devices: DeviceRepo;
  deviceCredentials: DeviceCredentialRepo;
  pairings: PairingRepo;
  deviceGroups: DeviceGroupRepo;
  commands: CommandRepo;
  executions: ExecutionRepo;
  confirmations: ConfirmationRepo;
  deviceEvents: DeviceEventRepo;
  workflows: WorkflowRepo;
}

function buildRepos(db: DbType): Storage {
  return {
    db,
    users: createUserRepo(db),
    conversations: createConversationRepo(db),
    messages: createMessageRepo(db),
    memories: createMemoryRepo(db),
    people: createPersonRepo(db),
    personMemories: createPersonMemoryRepo(db),
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

let singleton: Storage | null = null;

export function initStorage(): Storage {
  if (singleton) return singleton;
  const db = getDb();
  runMigrations(db);
  singleton = buildRepos(db);
  return singleton;
}

/** Build a storage instance around an externally-provided db (for tests). */
export function storageFromDb(db: DbType): Storage {
  runMigrations(db);
  return buildRepos(db);
}

export function resetStorageSingleton(): void {
  singleton = null;
}
