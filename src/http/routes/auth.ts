import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Storage } from '../../storage/index.js';
import { hashPassword, verifyPassword } from '../../auth/passwords.js';
import { signToken } from '../../auth/tokens.js';
import { AUTH_COOKIE, requireAuth } from '../../auth/middleware.js';
import { Errors } from '../../util/errors.js';

const credsSchema = z.object({
  username: z.string().min(3).max(40).regex(/^[a-zA-Z0-9_.-]+$/),
  password: z.string().min(6).max(200),
  displayName: z.string().max(80).optional(),
});

const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'lax' as const,
  path: '/',
  maxAge: 60 * 60 * 24 * 30, // 30 days
  secure: false, // local dev; flip to true behind HTTPS
};

export async function authRoutes(app: FastifyInstance, storage: Storage): Promise<void> {
  app.post('/api/auth/register', async (req, reply) => {
    const parsed = credsSchema.safeParse(req.body);
    if (!parsed.success) throw Errors.badRequest('Invalid credentials', parsed.error.flatten());
    const { username, password, displayName } = parsed.data;

    if (storage.users.getByUsername(username)) throw Errors.conflict('Username already exists');

    const passwordHash = await hashPassword(password);
    const user = storage.users.create({ username, passwordHash, displayName });
    const token = signToken(user.id);
    reply.setCookie(AUTH_COOKIE, token, COOKIE_OPTS);
    return { id: user.id, username: user.username, displayName: user.display_name };
  });

  app.post('/api/auth/login', async (req, reply) => {
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
