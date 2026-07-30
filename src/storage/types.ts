import type { Database as SqliteDatabase } from 'better-sqlite3';
import type {
  ConversationRow,
} from './repositories/conversationRepo.js';
import type {
  HybridSearchResult,
  InsertMemoryInput,
  Memory,
} from './repositories/memoryRepo.js';
import type {
  InsertMessageInput,
  MessageRow,
} from './repositories/messageRepo.js';
import type {
  Person,
  UpsertPersonInput,
} from './repositories/personRepo.js';
import type {
  CreateUserInput,
  UserRow,
} from './repositories/userRepo.js';
import type {
  CapabilityRequestRow,
  CapabilityRequestUpdate,
} from './repositories/capabilityRequestRepo.js';
import type { DeviceRepo } from './repositories/deviceRepo.js';
import type { DeviceCredentialRepo } from './repositories/deviceCredentialRepo.js';
import type { PairingRepo } from './repositories/pairingRepo.js';
import type { DeviceGroupRepo } from './repositories/deviceGroupRepo.js';
import type { CommandRepo } from './repositories/commandRepo.js';
import type { ExecutionRepo } from './repositories/executionRepo.js';
import type { ConfirmationRepo } from './repositories/confirmationRepo.js';
import type { DeviceEventRepo } from './repositories/deviceEventRepo.js';
import type { WorkflowRepo } from './repositories/workflowRepo.js';

/**
 * SQLite calls are synchronous while Neon calls are asynchronous. Application
 * code always awaits repository operations, so local/test SQLite remains fast
 * without forcing the production adapter to pretend HTTP queries are sync.
 */
export type MaybePromise<T> = T | Promise<T>;

export interface UserRepository {
  create(input: CreateUserInput): MaybePromise<UserRow>;
  getByUsername(username: string): MaybePromise<UserRow | null>;
  getById(id: string): MaybePromise<UserRow | null>;
}

export interface ConversationRepository {
  create(userId: string, title?: string): MaybePromise<ConversationRow>;
  getById(id: string): MaybePromise<ConversationRow | null>;
  listByUser(userId: string): MaybePromise<ConversationRow[]>;
  touch(id: string): MaybePromise<void>;
  rename(id: string, title: string): MaybePromise<void>;
  delete(id: string): MaybePromise<void>;
}

export interface MessageRepository {
  insert(input: InsertMessageInput): MaybePromise<MessageRow>;
  getById(id: string): MaybePromise<MessageRow | null>;
  listByConversation(conversationId: string): MaybePromise<MessageRow[]>;
  listRecentByConversation(conversationId: string, limit: number): MaybePromise<MessageRow[]>;
  countByConversation(conversationId: string): MaybePromise<number>;
}

export interface MemoryRepository {
  insert(input: InsertMemoryInput): MaybePromise<Memory>;
  getById(id: string): MaybePromise<Memory | null>;
  listRecentByUser(userId: string, limit?: number): MaybePromise<Memory[]>;
  countByUser(userId: string): MaybePromise<number>;
  delete(id: string, userId: string): MaybePromise<boolean>;
  touchAccessed(id: string): MaybePromise<void>;
  vectorSearch(
    userId: string,
    queryEmbedding: Float32Array,
    k: number,
    scanLimit?: number,
  ): MaybePromise<Array<{ memory: Memory; score: number }>>;
  ftsSearch(
    userId: string,
    queryText: string,
    k: number,
  ): MaybePromise<Array<{ memory: Memory; score: number }>>;
  hybridSearch(
    userId: string,
    queryText: string,
    queryEmbedding: Float32Array | null,
    k: number,
  ): MaybePromise<HybridSearchResult[]>;
}

export interface PersonRepository {
  upsert(input: UpsertPersonInput): MaybePromise<Person>;
  getById(id: string): MaybePromise<Person | null>;
  getByCanonical(userId: string, canonicalName: string): MaybePromise<Person | null>;
  listByUser(userId: string): MaybePromise<Person[]>;
  updateSummary(id: string, summary: string): MaybePromise<void>;
  mergeMetadata(id: string, partial: Record<string, unknown>): MaybePromise<void>;
}

export interface PersonMemoryRepository {
  link(personId: string, memoryId: string): MaybePromise<void>;
  unlink(personId: string, memoryId: string): MaybePromise<void>;
  getMemoriesForPerson(personId: string, limit?: number): MaybePromise<Memory[]>;
  getPeopleIdsForMemory(memoryId: string): MaybePromise<string[]>;
}

export interface CapabilityRequestRepository {
  create(userId: string, task: string): MaybePromise<CapabilityRequestRow>;
  update(id: string, input: CapabilityRequestUpdate): MaybePromise<CapabilityRequestRow | null>;
  getById(id: string): MaybePromise<CapabilityRequestRow | null>;
  listByUser(userId: string): MaybePromise<CapabilityRequestRow[]>;
}

/**
 * AGI Command repositories.
 *
 * Synchronous and SQLite-backed. Device control needs a long-running gateway
 * process, so it does not run on the serverless Postgres path, and the Postgres
 * adapter deliberately does not implement these — shipping half-working
 * implementations would be a worse lie than saying so plainly.
 * Narrow with `isDeviceStorage()` from ./index.js.
 */
export interface DeviceRepositories {
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

export interface Storage {
  kind: 'sqlite' | 'postgres';
  db: SqliteDatabase | null;
  users: UserRepository;
  conversations: ConversationRepository;
  messages: MessageRepository;
  memories: MemoryRepository;
  people: PersonRepository;
  personMemories: PersonMemoryRepository;
  capabilityRequests: CapabilityRequestRepository;
  // Present only on the SQLite backend — see DeviceRepositories.
  devices?: DeviceRepo;
  deviceCredentials?: DeviceCredentialRepo;
  pairings?: PairingRepo;
  deviceGroups?: DeviceGroupRepo;
  commands?: CommandRepo;
  executions?: ExecutionRepo;
  confirmations?: ConfirmationRepo;
  deviceEvents?: DeviceEventRepo;
  workflows?: WorkflowRepo;
}

/** Storage that can back AGI Command: SQLite, with the device repositories. */
export type DeviceStorage = Storage & DeviceRepositories & { db: SqliteDatabase };
