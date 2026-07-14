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
  it('offers a bounded model-controlled web-search server tool', async () => {
    let request: Record<string, unknown> | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        model: 'tool-capable:free',
        choices: [{
          message: {
            content: 'SEARCH_OK',
            annotations: [{
              type: 'url_citation',
              url_citation: { url: 'https://example.com/result', title: 'Example result' },
            }],
          },
        }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));

    const backend = new OpenRouterBackend('test-key', 'primary:free');
    let response = '';
    for await (const chunk of backend.generate(
      [{ role: 'user', content: 'search for current information' }],
      {
        webSearch: {
          maxResults: 3,
          maxTotalResults: 3,
          maxCharactersPerResult: 2_500,
        },
      },
    )) {
      response += chunk;
    }

    expect(response).toBe('SEARCH_OK\n\nSources:\n- [Example result](https://example.com/result)');
    expect(request?.model).toBe('openrouter/free');
    expect(request?.stream).toBe(false);
    expect(request?.tools).toEqual([{
      type: 'openrouter:web_search',
      parameters: {
        engine: 'exa',
        max_results: 3,
        max_total_results: 3,
        max_characters: 2_500,
      },
    }]);
  });

  it('does not append unused search candidates when the answer already cites a URL', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      choices: [{
        message: {
          content: 'Source: https://amy-tutor.vercel.app/',
          annotations: [{
            type: 'url_citation',
            url_citation: { url: 'https://unrelated.example/', title: 'Unused result' },
          }],
        },
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })));

    const backend = new OpenRouterBackend('test-key', 'primary:free');
    await expect(backend.generateOnce(
      [{ role: 'user', content: 'search' }],
      { webSearch: { maxResults: 3, maxTotalResults: 3, maxCharactersPerResult: 2_500 } },
    )).resolves.toBe('Source: https://amy-tutor.vercel.app/');
  });

  it('falls back to conversational models when web search returns no text', async () => {
    const requests: Array<{
      model: string;
      stream: boolean;
      tools?: unknown;
      messages: Array<{ role: string; content: string }>;
    }> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as typeof requests[number];
      requests.push(body);
      if (body.model === 'openrouter/free') {
        return new Response(JSON.stringify({
          model: 'empty-tool-model:free',
          choices: [{ message: { content: '' } }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return streamResponse([
        JSON.stringify({ model: body.model, choices: [{ delta: { content: 'CHAT_FALLBACK_OK' } }] }),
        '[DONE]',
      ]);
    }));

    const backend = new OpenRouterBackend('test-key', 'primary:free', ['fallback:free']);
    let response = '';
    for await (const chunk of backend.generate(
      [{ role: 'user', content: 'hello' }],
      {
        webSearch: {
          maxResults: 3,
          maxTotalResults: 3,
          maxCharactersPerResult: 2_500,
        },
      },
    )) {
      response += chunk;
    }

    expect(response).toBe('CHAT_FALLBACK_OK');
    expect(requests.map((request) => request.model)).toEqual([
      'openrouter/free',
      'primary:free',
    ]);
    expect(requests[0]?.tools).toBeDefined();
    expect(requests[1]?.tools).toBeUndefined();
    expect(requests[1]?.messages.at(-1)?.content).toMatch(/do not invent sources/i);
  });

  it('keeps configured conversational models for requests without web search', async () => {
    let request: Record<string, unknown> | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return streamResponse([
        JSON.stringify({ choices: [{ delta: { content: 'CHAT_OK' } }] }),
        '[DONE]',
      ]);
    }));

    const backend = new OpenRouterBackend('test-key', 'primary:free');
    let response = '';
    for await (const chunk of backend.generate([{ role: 'user', content: 'hello' }])) {
      response += chunk;
    }

    expect(response).toBe('CHAT_OK');
    expect(request?.model).toBe('primary:free');
    expect(request?.stream).toBe(true);
    expect(request?.tools).toBeUndefined();
  });

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

  it('uses the free router after every explicit background-task model fails', async () => {
    const requestedModels: string[] = [];
    const requestBodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { model: string } & Record<string, unknown>;
      requestedModels.push(body.model);
      requestBodies.push(body);
      if (body.model !== 'openrouter/free') {
        return new Response(JSON.stringify({ error: { message: 'provider unavailable' } }), {
          status: 429,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({
        model: 'selected-task-model:free',
        choices: [{ message: { content: '{"facts":[]}' } }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));

    const backend = new OpenRouterBackend('test-key', 'primary:free', ['fallback:free']);
    await expect(backend.generateOnce(
      [{ role: 'user', content: 'extract facts as a JSON object' }],
      { jsonObject: true },
    ))
      .resolves.toBe('{"facts":[]}');
    expect(requestedModels).toEqual(['primary:free', 'fallback:free', 'openrouter/free']);
    expect(requestBodies.every((body) => (
      JSON.stringify(body.response_format) === JSON.stringify({ type: 'json_object' })
    ))).toBe(true);
  });
});
