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

  // Routes validate their input with `schema.parse()`, which throws a ZodError.
  // That is the caller's fault, not ours — report 400 rather than 500.
  if (err instanceof ZodError) {
    const first = err.errors[0];
    const path = first?.path.join('.');
    return {
      status: 400,
      body: {
        error: 'BAD_REQUEST',
        message: `${path ? `${path}: ` : ''}${first?.message ?? 'invalid request body'}`,
        details: err.errors.map((e) => ({ path: e.path.join('.'), message: e.message })),
      },
    };
  }

  const msg = err instanceof Error ? err.message : 'Unknown error';
  return { status: 500, body: { error: 'INTERNAL', message: msg } };
}
