// POST /api/chat — the SSE streaming chat endpoint.
// Accepts { conversationId, content } and streams { token } frames, plus a
// final [DONE]. Uses requireAuth to bind the user to the request.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Storage } from '../../storage/index.js';
import { requireAuth } from '../../auth/middleware.js';
import { createOrchestrator } from '../../brain/orchestrator.js';
import { startSse } from '../sse.js';
import { logger } from '../../logger.js';
import type { AgiCommand } from '../../devices/index.js';

const chatSchema = z.object({
  conversationId: z.string().min(1),
  content: z.string().min(1).max(8000),
  /**
   * The device id of the browser session, when it has been paired. Lets "open
   * this on this device" resolve. Validated against the caller's own registry
   * before use — a forged id resolves to nothing.
   */
  thisDeviceId: z.string().max(64).optional(),
});

export async function chatRoutes(
  app: FastifyInstance,
  storage: Storage,
  agi?: AgiCommand,
): Promise<void> {
  const auth = requireAuth(storage);
  const orchestrator = createOrchestrator(storage, undefined, agi);

  app.post('/api/chat', { preHandler: auth }, async (req, reply) => {
    const body = chatSchema.parse(req.body);
    const user = req.user!;

    // Verify the conversation belongs to this user.
    const conv = storage.conversations.getById(body.conversationId);
    if (!conv || conv.user_id !== user.id) {
      return reply.status(404).send({ error: 'conversation not found' });
    }

    // Open an SSE stream.
    const sse = startSse(reply);

    // Propagate client-side disconnects into the orchestrator so we can stop
    // generating tokens as soon as the browser closes the connection.
    const abortController = new AbortController();
    req.raw.on('close', () => {
      abortController.abort();
    });

    try {
      // Only honour a device id the caller actually owns.
      const thisDeviceId =
        body.thisDeviceId && storage.devices.getOwned(user.id, body.thisDeviceId)
          ? body.thisDeviceId
          : null;

      for await (const event of orchestrator.handleUserMessage({
        userId: user.id,
        conversationId: body.conversationId,
        content: body.content,
        signal: abortController.signal,
        thisDeviceId,
      })) {
        if (event.type === 'token') sse.send({ token: event.data });
        else if (event.type === 'meta') sse.send({ meta: event.meta });
        else if (event.type === 'error') sse.send({ error: event.data });
        else if (event.type === 'done') break;
      }
    } catch (err) {
      logger.error({ err }, 'chat stream failed');
      sse.send({ error: (err as Error).message });
    } finally {
      sse.done();
    }
  });
}
