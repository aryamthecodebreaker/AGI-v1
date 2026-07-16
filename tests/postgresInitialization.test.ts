import { describe, expect, it, vi } from 'vitest';
import type { NeonQueryFunction } from '@neondatabase/serverless';
import { createPostgresStorage } from '../src/storage/postgres/index.js';

type Sql = NeonQueryFunction<false, false>;

function transientTimeout(): Error {
  const timeout = new Error('connect ETIMEDOUT') as Error & { code: string };
  timeout.code = 'ETIMEDOUT';
  const aggregate = new AggregateError([timeout], 'all connection attempts failed');
  return new Error('Error connecting to database: TypeError: fetch failed', {
    cause: aggregate,
  });
}

describe('Postgres storage initialization', () => {
  it('retries transient Neon connection failures inside one initialization', async () => {
    const sql = {} as Sql;
    let attempts = 0;
    const migrationRunner = vi.fn(async () => {
      attempts += 1;
      if (attempts < 3) throw transientTimeout();
    });
    const retryWait = vi.fn(async () => {});

    const storage = await createPostgresStorage('postgres://test.invalid/db', {
      sqlFactory: () => sql,
      migrationRunner,
      retryWait,
      maxAttempts: 4,
    });

    expect(storage.kind).toBe('postgres');
    expect(migrationRunner).toHaveBeenCalledTimes(3);
    expect(retryWait.mock.calls.map(([attempt]) => attempt)).toEqual([1, 2]);
  });

  it('does not retry permanent configuration or authentication failures', async () => {
    const migrationRunner = vi.fn(async () => {
      throw new Error('password authentication failed for user');
    });
    const retryWait = vi.fn(async () => {});

    await expect(createPostgresStorage('postgres://test.invalid/db', {
      sqlFactory: () => ({} as Sql),
      migrationRunner,
      retryWait,
    })).rejects.toThrow('password authentication failed');

    expect(migrationRunner).toHaveBeenCalledTimes(1);
    expect(retryWait).not.toHaveBeenCalled();
  });

  it('rethrows a transient failure after the retry budget is exhausted', async () => {
    const migrationRunner = vi.fn(async () => {
      throw transientTimeout();
    });
    const retryWait = vi.fn(async () => {});

    await expect(createPostgresStorage('postgres://test.invalid/db', {
      sqlFactory: () => ({} as Sql),
      migrationRunner,
      retryWait,
      maxAttempts: 3,
    })).rejects.toThrow('fetch failed');

    expect(migrationRunner).toHaveBeenCalledTimes(3);
    expect(retryWait.mock.calls.map(([attempt]) => attempt)).toEqual([1, 2]);
  });
});
