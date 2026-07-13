import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Storage } from '../../storage/index.js';
import { hashPassword, verifyPassword } from '../../auth/passwords.js';
import { signToken } from '../../auth/tokens.js';
import { AUTH_COOKIE, requireAuth } from '../../auth/middleware.js';
import { config } from '../../config.js';
import { Errors } from '../../util/errors.js';

const credsSchema = z.object({
  username: z.string().min(3, 'Username must be at least 3 characters').max(40).regex(/^[a-zA-Z0-9_.-]+$/, 'Username can only contain letters, numbers, underscores, dots, and hyphens'),
  password: z.string().min(10, 'Password must be at least 10 characters').max(200).regex(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^a-zA-Z0-9])/, 'Password must contain at least one uppercase letter, one lowercase letter, one number, and one special character'),
  displayName: z.string().max(80).optional(),
});

const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'lax' as const,
  path: '/',
  maxAge: 60 * 60 * 24 * 30, // 30 days
  secure: config.nodeEnv === 'production',
} as const;

export async function authRoutes(app: FastifyInstance, storage: Storage): Promise<void> {
  // Stricter rate limit for auth endpoints
  app.post('/api/auth/register', {
    config: {
      rateLimit: {
        max: 3,
        timeWindow: 60000, // 3 requests per minute
      },
    },
  }, async (req, reply) => {
    const parsed = credsSchema.safeParse(req.body);
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? 'Invalid signup details';
      throw Errors.badRequest(message, parsed.error.flatten());
    }
    const { username, password, displayName } = parsed.data;

    if (storage.users.getByUsername(username)) throw Errors.conflict('Username already exists');

    const passwordHash = await hashPassword(password);
    const user = storage.users.create({ username, passwordHash, displayName });
    const token = signToken(user.id);
    reply.setCookie(AUTH_COOKIE, token, COOKIE_OPTS);
    return { id: user.id, username: user.username, displayName: user.display_name };
  });

  app.post('/api/auth/login', {
    config: {
      rateLimit: {
        max: 5,
        timeWindow: 60000, // 5 requests per minute
      },
    },
  }, async (req, reply) => {
    const schema = z.object({ username: z.string(), password: z.string() });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) throw Errors.badRequest('Invalid credentials');
    const { username, password } = parsed.data;
    const user = storage.users.getByUsername(username);
    if (!user) throw Errors.unauthorized('Invalid username or password');
    const ok = await verifyPassword(password, user.password_hash);
    if (!ok) throw Errors.unauthorized('Invalid username or password');
    const token = signToken(user.id);
    reply.setCookie(AUTH_COOKIE, token, COOKIE_OPTS);
    return { id: user.id, username: user.username, displayName: user.display_name };
  });

  app.post('/api/auth/logout', async (_req, reply) => {
    reply.clearCookie(AUTH_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/me', { preHandler: requireAuth(storage) }, async (req) => {
    const u = req.user!;
    return { id: u.id, username: u.username, displayName: u.display_name };
  });
}
