// Read-only memories routes. The UI uses these to render the "Memories" tab
// and (eventually) let the user search their own brain.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Storage } from '../../storage/index.js';
import { requireAuth } from '../../auth/middleware.js';
import { embed } from '../../llm/embeddings.js';

const listQuery = z.object({
  limit: z.coerce.number().int().positive().max(200).default(40),
  kind: z.enum(['raw_turn', 'fact', 'summary']).optional(),
});

const searchQuery = z.object({
  q: z.string().min(1),
  k: z.coerce.number().int().positive().max(50).default(10),
});

export async function memoryRoutes(app: FastifyInstance, storage: Storage): Promise<void> {
  const auth = requireAuth(storage);

  app.get('/api/memories', { preHandler: auth }, async (req) => {
    const user = req.user!;
    const q = listQuery.parse(req.query);
    const rows = storage.memories.listRecentByUser(user.id, q.limit);
    const filtered = q.kind ? rows.filter((r) => r.kind === q.kind) : rows;
    return filtered.map((m) => ({
      id: m.id,
      kind: m.kind,
      content: m.content,
      createdAt: m.createdAt,
      conversationId: m.conversationId,
    }));
  });

  app.get('/api/memories/search', { preHandler: auth }, async (req) => {
    const user = req.user!;
    const q = searchQuery.parse(req.query);
    let queryEmbedding: Float32Array | null = null;
    try {
      queryEmbedding = await embed(q.q);
    } catch {
      /* fall back to FTS-only if embeddings unavailable */
    }
    const hits = storage.memories.hybridSearch(user.id, q.q, queryEmbedding, q.k);
    return hits.map((h) => ({
      id: h.memory.id,
      kind: h.memory.kind,
      content: h.memory.content,
      createdAt: h.memory.createdAt,
      score: h.score,
      vectorRank: h.vectorRank,
      ftsRank: h.ftsRank,
    }));
  });
}
