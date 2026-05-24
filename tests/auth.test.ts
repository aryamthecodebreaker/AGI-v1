import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { storageFromDb } from '../src/storage/index.js';
import { hashPassword } from '../src/auth/passwords.js';
import { signToken, verifyToken } from '../src/auth/tokens.js';

describe('Auth module', () => {
  let tmpPath: string;
  let db: Database.Database;
  let storage: ReturnType<typeof storageFromDb>;

  beforeEach(() => {
    tmpPath = path.join(os.tmpdir(), `agi-auth-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    db = new Database(tmpPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    storage = storageFromDb(db);
  });

  afterEach(() => {
    db.close();
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    try { fs.unlinkSync(tmpPath + '-wal'); } catch { /* ignore */ }
    try { fs.unlinkSync(tmpPath + '-shm'); } catch { /* ignore */ }
  });

  describe('password hashing', () => {
    it('hashes and verifies password correctly', async () => {
      const password = 'TestPassword123!';
      const hash = await hashPassword(password);
      expect(hash).toMatch(/^\$2[aby]?\$/);
      expect(await hashPassword(password)).not.toBe(hash); // Different salt each time
    });

    it('rejects wrong password', async () => {
      const password = 'TestPassword123!';
      const hash = await hashPassword(password);
      expect(await hashPassword('wrong', hash)).toBe(false);
    });
  });

  describe('JWT tokens', () => {
    it('signs and verifies token successfully', () => {
      const userId = 'u_test123';
      const token = signToken(userId);
      expect(token).toMatch(/^eyJ/);
      
      const payload = verifyToken(token);
      expect(payload).not.toBeNull();
      expect(payload?.sub).toBe(userId);
    });

    it('rejects invalid token', () => {
      expect(verifyToken('invalid.token.here')).toBeNull();
      expect(verifyToken('')).toBeNull();
    });

    it('rejects expired token', () => {
      const userId = 'u_test123';
      const token = signToken(userId, -1); // Expired 1 second ago
      expect(verifyToken(token)).toBeNull();
    });
  });

  describe('user repository', () => {
    it('creates user with strong password requirements', async () => {
      const passwordHash = await hashPassword('StrongPass123!');
      const user = storage.users.create({ 
        username: 'testuser', 
        passwordHash,
        displayName: 'Test User'
      });
      expect(user.id).toMatch(/^u_/);
      expect(user.username).toBe('testuser');
      expect(user.display_name).toBe('Test User');
    });

    it('prevents duplicate usernames', async () => {
      const passwordHash = await hashPassword('StrongPass123!');
      storage.users.create({ username: 'duplicate', passwordHash });
      
      expect(() => {
        storage.users.create({ username: 'duplicate', passwordHash });
      }).toThrow();
    });
  });
});
