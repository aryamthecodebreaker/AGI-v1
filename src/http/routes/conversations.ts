import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Storage } from '../../storage/index.js';
import { requireAuth } from '../../auth/middleware.js';
import { Errors } from '../../util/errors.js';

export async function conversationRoutes(app: FastifyInstance, storage: Storage): Promise<void> {
  const auth = { preHandler: requireAuth(storage) } as const;

  app.get('/api/conversations', auth, async (req) => {
    const user = req.user!;
    return storage.conversations.listByUser(user.id);
  });

  app.post('/api/conversations', auth, async (req) => {
    const user = req.user!;
    const schema = z.object({ title: z.string().min(1).max(200).optional() });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) throw Errors.badRequest('Invalid body');
    return storage.conversations.create(user.id, parsed.data.title ?? 'New chat');
  });

  app.get<{ Params: { id: string } }>('/api/conversations/:id/messages', auth, async (req) => {
    const user = req.user!;
    const conv = storage.conversations.getById(req.params.id);
    if (!conv || conv.user_id !== user.id) throw Errors.notFound();
    return storage.messages.listByConversation(conv.id);
  });

  app.delete<{ Params: { id: string } }>('/api/conversations/:id', auth, async (req) => {
    const user = req.user!;
    const conv = storage.conversations.getById(req.params.id);
    if (!conv || conv.user_id !== user.id) throw Errors.notFound();
    storage.conversations.delete(conv.id);
    return { ok: true };
  });

  app.patch<{ Params: { id: string } }>('/api/conversations/:id', auth, async (req) => {
    const user = req.user!;
    const conv = storage.conversations.getById(req.params.id);
    if (!conv || conv.user_id !== user.id) throw Errors.notFound();
    const schema = z.object({ title: z.string().min(1).max(200) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) throw Errors.badRequest('Invalid body');
    storage.conversations.rename(conv.id, parsed.data.title);
    return storage.conversations.getById(conv.id);
  });
}
