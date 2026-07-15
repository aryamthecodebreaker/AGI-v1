import { describe, expect, it } from 'vitest';
import { z } from 'zod';
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

  it('maps request-schema validation failures to a safe 400 response', () => {
    const result = z.object({ task: z.string().min(10) }).safeParse({ task: 'short' });
    if (result.success) throw new Error('Expected schema validation to fail');

    expect(toHttpError(result.error)).toEqual({
      status: 400,
      body: {
        error: 'BAD_REQUEST',
        message: 'Invalid request',
        details: result.error.flatten(),
      },
    });
  });

  it('does not expose unknown server errors as a client error', () => {
    expect(toHttpError({ statusCode: 500, message: 'database details' })).toEqual({
      status: 500,
      body: { error: 'INTERNAL', message: 'Unknown error' },
    });
  });
});
