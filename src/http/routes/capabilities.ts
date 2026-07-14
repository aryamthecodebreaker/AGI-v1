import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../../auth/middleware.js';
import { assertCapabilityAdmin } from '../../capabilities/config.js';
import { buildCapability } from '../../capabilities/service.js';
import type { Storage } from '../../storage/index.js';

const buildSchema = z.object({ task: z.string().min(10).max(2_000) }).strict();

export async function capabilityRoutes(app: FastifyInstance, storage: Storage): Promise<void> {
  const auth = requireAuth(storage);

  app.get('/api/capabilities', { preHandler: auth }, async (req) => {
    const user = req.user!;
    assertCapabilityAdmin(user.id);
    return await storage.capabilityRequests.listByUser(user.id);
  });

  app.post('/api/capabilities/build', {
    preHandler: auth,
    config: { rateLimit: { max: 2, timeWindow: 60 * 60 * 1_000 } },
  }, async (req) => {
    const user = req.user!;
    const body = buildSchema.parse(req.body);
    return await buildCapability(storage, user.id, body.task);
  });
}
