import Database from 'better-sqlite3';
import type { Database as DbType } from 'better-sqlite3';
import { config } from '../config.js';

let instance: DbType | null = null;

export function getDb(): DbType {
  if (instance) return instance;

  const db = new Database(config.dbPath);
  // Pragmas every connection needs. journal_mode/synchronous are also set by 001_init.sql but repeating is harmless.
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  instance = db;
  return db;
}

export function closeDb(): void {
  if (instance) {
    instance.close();
    instance = null;
  }
}

/** Open a fresh database at an arbitrary path (used by tests). Caller is responsible for closing. */
export function openDbAt(path: string): DbType {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}
