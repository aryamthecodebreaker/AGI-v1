// Generated document routes.
//
// Files live in memory with a short TTL, so this is a download surface rather
// than a file store. Every read is ownership-checked: a document id is not a
// capability, and knowing one is not enough to fetch it.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Storage } from '../../storage/index.js';
import { requireAuth } from '../../auth/middleware.js';
import { getLlmBackend } from '../../llm/registry.js';
import {
  buildDocumentFromBrief,
  documentKindSchema,
  retrieveDocument,
} from '../../documents/service.js';

const createSchema = z.object({
  kind: documentKindSchema,
  brief: z.string().min(3).max(2000),
});

export async function documentRoutes(app: FastifyInstance, storage: Storage): Promise<void> {
  const auth = requireAuth(storage);

  /** Plan and render a document from a natural-language brief. */
  app.post('/api/documents', { preHandler: [auth] }, async (req, reply) => {
    const body = createSchema.parse(req.body);
    const result = await buildDocumentFromBrief({
      llm: getLlmBackend(),
      userId: req.user!.id,
      kind: body.kind,
      brief: body.brief,
    });

    if (!result.ok || !result.document) {
      return reply.status(422).send({ error: 'GENERATION_FAILED', message: result.error });
    }
    const doc = result.document;
    return reply.status(201).send({
      id: doc.id,
      filename: doc.filename,
      mimeType: doc.mimeType,
      bytes: doc.bytes.length,
      expiresAt: doc.expiresAt,
      downloadUrl: `/api/documents/${doc.id}`,
    });
  });

  app.get('/api/documents/:id', { preHandler: [auth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const doc = retrieveDocument(req.user!.id, id);
    if (!doc) {
      return reply.status(404).send({
        error: 'NOT_FOUND',
        message: 'That document has expired or does not exist. Generated files are kept for 30 minutes.',
      });
    }

    // The filename is already sanitised at generation time; quoting it here
    // keeps a space or comma from truncating the header value.
    return reply
      .header('Content-Type', doc.mimeType)
      .header('Content-Disposition', `attachment; filename="${doc.filename}"`)
      .header('Content-Length', String(doc.bytes.length))
      .header('Cache-Control', 'no-store')
      .send(doc.bytes);
  });
}
