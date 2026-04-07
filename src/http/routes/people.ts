// Read-only people routes — the tracked roster of humans the user knows.

import type { FastifyInstance } from 'fastify';
import type { Storage } from '../../storage/index.js';
import { requireAuth } from '../../auth/middleware.js';

export async function peopleRoutes(app: FastifyInstance, storage: Storage): Promise<void> {
  const auth = requireAuth(storage);

  app.get('/api/people', { preHandler: auth }, async (req) => {
    const user = req.user!;
    const people = storage.people.listByUser(user.id);
    return people.map((p) => ({
      id: p.id,
      displayName: p.displayName,
      relationship: p.relationship,
      summary: p.summary,
      mentionCount: p.mentionCount,
      firstSeenAt: p.firstSeenAt,
      lastMentionedAt: p.lastMentionedAt,
    }));
  });

  app.get<{ Params: { id: string } }>('/api/people/:id', { preHandler: auth }, async (req, reply) => {
    const user = req.user!;
    const person = storage.people.getById(req.params.id);
    if (!person || person.userId !== user.id) {
      return reply.status(404).send({ error: 'person not found' });
    }
    const memories = storage.personMemories
      .getMemoriesForPerson(person.id, 50)
      .map((m) => ({ id: m.id, kind: m.kind, content: m.content, createdAt: m.createdAt }));
    return {
      id: person.id,
      displayName: person.displayName,
      aliases: person.aliases,
      relationship: person.relationship,
      summary: person.summary,
      mentionCount: person.mentionCount,
      firstSeenAt: person.firstSeenAt,
      lastMentionedAt: person.lastMentionedAt,
      memories,
    };
  });
}
