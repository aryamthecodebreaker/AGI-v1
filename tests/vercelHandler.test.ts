import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { emitRequestAndWait } from '../api/index.js';

describe('Vercel Fastify adapter lifecycle', () => {
  it.each(['finish', 'close'] as const)('stays pending until response %s', async (event) => {
    const server = new EventEmitter();
    const request = new EventEmitter() as IncomingMessage;
    const response = new EventEmitter() as ServerResponse;
    server.on('request', () => {});

    let settled = false;
    const pending = emitRequestAndWait(server, request, response).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    response.emit(event);
    await pending;
    expect(settled).toBe(true);
  });

  it('rejects when the response emits an error', async () => {
    const server = new EventEmitter();
    const request = new EventEmitter() as IncomingMessage;
    const response = new EventEmitter() as ServerResponse;
    server.on('request', () => {});
    const pending = emitRequestAndWait(server, request, response);

    response.emit('error', new Error('socket failed'));
    await expect(pending).rejects.toThrow('socket failed');
  });
});
