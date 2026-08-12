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
  // Deliberately minimal: this is a demo-first app and the complexity rules were
  // getting in the way of showing it. Passwords are still bcrypt-hashed and
  // login is still rate-limited; only the composition requirement is gone.
  // Tighten this before it holds anything that matters.
  password: z.string().min(4, 'Password must be at least 4 characters').max(200),
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

    if (await storage.users.getByUsername(username)) throw Errors.conflict('Username already exists');

    const passwordHash = await hashPassword(password);
    let user;
    try {
      user = await storage.users.create({ username, passwordHash, displayName });
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        ('code' in error && error.code === '23505')
      ) {
        throw Errors.conflict('Username already exists');
      }
      throw error;
    }
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
    const user = await storage.users.getByUsername(username);
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
