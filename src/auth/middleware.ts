import type { FastifyReply, FastifyRequest } from 'fastify';
import { verifyToken } from './tokens.js';
import { Errors } from '../util/errors.js';
import type { Storage } from '../storage/index.js';
import type { UserRow } from '../storage/repositories/userRepo.js';

export const AUTH_COOKIE = 'agi_token';

declare module 'fastify' {
  interface FastifyRequest {
    user?: UserRow;
  }
}

/**
 * Creates a Fastify preHandler that reads the auth cookie, verifies the JWT,
 * loads the user from STORAGE, and attaches it to `request.user`. Throws 401 if missing/invalid.
 */
export function requireAuth(storage: Storage) {
  return async function requireAuthHandler(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    // `request.cookies` comes from @fastify/cookie.
    const token = (request as FastifyRequest & { cookies: Record<string, string> }).cookies?.[AUTH_COOKIE];
    if (!token) throw Errors.unauthorized();
    const payload = verifyToken(token);
    if (!payload) throw Errors.unauthorized('Invalid or expired token');
    const user = storage.users.getById(payload.sub);
    if (!user) throw Errors.unauthorized('User not found');
    request.user = user;
  };
}
