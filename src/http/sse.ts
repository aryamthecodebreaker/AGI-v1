import type { FastifyReply } from 'fastify';

/**
 * Helper for writing Server-Sent Events from a Fastify handler.
 *
 * Usage:
 *   const sse = startSse(reply);
 *   sse.send({ token: 'hello' });
 *   sse.send({ token: ' world' });
 *   sse.done();
 */
export function startSse(reply: FastifyReply): {
  send: (data: unknown, event?: string) => void;
  comment: (text: string) => void;
  done: () => void;
} {
  reply.raw.setHeader('Content-Type', 'text/event-stream');
  reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
  reply.raw.setHeader('Connection', 'keep-alive');
  reply.raw.setHeader('X-Accel-Buffering', 'no');
  // Hijack so Fastify does not try to send its own body.
  reply.hijack();
  reply.raw.flushHeaders?.();

  return {
    send(data: unknown, event?: string) {
      if (event) reply.raw.write(`event: ${event}\n`);
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    },
    comment(text: string) {
      reply.raw.write(`: ${text}\n\n`);
    },
    done() {
      reply.raw.write('data: [DONE]\n\n');
      reply.raw.end();
    },
  };
}
