import { ZodError } from 'zod';

export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, status = 400, details?: unknown) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export const Errors = {
  unauthorized: (msg = 'Not authenticated') => new AppError('UNAUTHORIZED', msg, 401),
  forbidden: (msg = 'Forbidden') => new AppError('FORBIDDEN', msg, 403),
  notFound: (msg = 'Not found') => new AppError('NOT_FOUND', msg, 404),
  conflict: (msg = 'Conflict') => new AppError('CONFLICT', msg, 409),
  rateLimited: (msg = 'Too many requests') => new AppError('RATE_LIMITED', msg, 429),
  badRequest: (msg = 'Bad request', details?: unknown) =>
    new AppError('BAD_REQUEST', msg, 400, details),
  internal: (msg = 'Internal error') => new AppError('INTERNAL', msg, 500),
};

export function toHttpError(err: unknown): { status: number; body: Record<string, unknown> } {
  if (err instanceof AppError) {
    return {
      status: err.status,
      body: { error: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) },
    };
  }

  if (err instanceof ZodError) {
    return {
      status: 400,
      body: {
        error: 'BAD_REQUEST',
        message: 'Invalid request',
        details: err.flatten(),
      },
    };
  }

  // Fastify plugins such as @fastify/rate-limit can raise plain objects rather
  // than AppError instances. Preserve their safe 4xx response instead of
  // accidentally turning a client error into a 500.
  if (typeof err === 'object' && err !== null) {
    const candidate = err as { statusCode?: unknown; error?: unknown; code?: unknown; message?: unknown };
    const status = candidate.statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      const code = typeof candidate.error === 'string'
        ? candidate.error
        : typeof candidate.code === 'string'
          ? candidate.code
          : 'BAD_REQUEST';
      const message = typeof candidate.message === 'string' ? candidate.message : 'Request failed';
      return { status, body: { error: code, message } };
    }
  }

  const msg = err instanceof Error ? err.message : 'Unknown error';
  return { status: 500, body: { error: 'INTERNAL', message: msg } };
}
