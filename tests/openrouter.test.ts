import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenRouterBackend } from '../src/llm/openRouterBackend.js';

function streamResponse(frames: string[]): Response {
  return new Response(frames.map((frame) => `data: ${frame}\n\n`).join(''), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OpenRouter conversational fallbacks', () => {
  it('retries a rate-limited model before any text is emitted', async () => {
    const requestedModels: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { model: string };
      requestedModels.push(body.model);
      if (body.model === 'primary:free') {
        return new Response(JSON.stringify({
          error: { code: 429, message: 'rate limited', metadata: { raw: 'try another provider' } },
        }), { status: 429, headers: { 'Content-Type': 'application/json' } });
      }
      return streamResponse([
        JSON.stringify({ model: 'fallback:free', choices: [{ delta: { content: 'CHAT_OK' } }] }),
        '[DONE]',
      ]);
    }));

    const backend = new OpenRouterBackend('test-key', 'primary:free', ['fallback:free']);
    let response = '';
    for await (const chunk of backend.generate([{ role: 'user', content: 'hello' }])) {
      response += chunk;
    }

    expect(response).toBe('CHAT_OK');
    expect(requestedModels).toEqual(['primary:free', 'fallback:free']);
  });

  it('does not switch models after a response has started', async () => {
    const fetchMock = vi.fn(async () => streamResponse([
      JSON.stringify({ choices: [{ delta: { content: 'partial' } }] }),
      JSON.stringify({ error: { code: 429, message: 'rate limited' } }),
    ]));
    vi.stubGlobal('fetch', fetchMock);
    const backend = new OpenRouterBackend('test-key', 'primary:free', ['fallback:free']);
    let response = '';

    await expect((async () => {
      for await (const chunk of backend.generate([{ role: 'user', content: 'hello' }])) {
        response += chunk;
      }
    })()).rejects.toThrow(/429/);

    expect(response).toBe('partial');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries non-streaming generation on a retired model', async () => {
    const requestedModels: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { model: string };
      requestedModels.push(body.model);
      if (body.model === 'retired:free') {
        return new Response(JSON.stringify({ error: { message: 'model not found' } }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({
        model: 'fallback:free',
        choices: [{ message: { content: 'generated draft' } }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));

    const backend = new OpenRouterBackend('test-key', 'retired:free', ['fallback:free']);
    await expect(backend.generateOnce([{ role: 'user', content: 'build' }]))
      .resolves.toBe('generated draft');
    expect(requestedModels).toEqual(['retired:free', 'fallback:free']);
  });
});
