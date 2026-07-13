import { describe, expect, it } from 'vitest';
import { AppError, toHttpError } from '../src/util/errors.js';

describe('toHttpError', () => {
  it('serializes application errors', () => {
    expect(toHttpError(new AppError('NOPE', 'Nope', 409))).toEqual({
      status: 409,
      body: { error: 'NOPE', message: 'Nope' },
    });
  });

  it('preserves safe Fastify plugin 4xx errors', () => {
    expect(toHttpError({
      statusCode: 429,
      error: 'RATE_LIMITED',
      message: 'Too many requests',
    })).toEqual({
      status: 429,
      body: { error: 'RATE_LIMITED', message: 'Too many requests' },
    });
  });

  it('does not expose unknown server errors as a client error', () => {
    expect(toHttpError({ statusCode: 500, message: 'database details' })).toEqual({
      status: 500,
      body: { error: 'INTERNAL', message: 'Unknown error' },
    });
  });
});
