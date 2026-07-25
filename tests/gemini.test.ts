import { afterEach, describe, expect, it, vi } from 'vitest';
import { GeminiBackend } from '../src/llm/geminiBackend.js';

function geminiJson(text: string): Response {
  return new Response(JSON.stringify({
    candidates: [{ content: { role: 'model', parts: [{ text }] } }],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function geminiStream(text: string): Response {
  return new Response(`data: ${JSON.stringify({
    candidates: [{ content: { role: 'model', parts: [{ text }] } }],
  })}\n\n`, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Gemini backend', () => {
  it('keeps ordinary chat streamed without calling the search provider', async () => {
    const requests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      requests.push(url);
      return geminiStream('HELLO_OK');
    }));

    const backend = new GeminiBackend('test-key', 'gemini-test');
    let response = '';
    for await (const chunk of backend.generate(
      [{ role: 'user', content: 'How are you?' }],
      { webSearch: { maxResults: 3, maxTotalResults: 3, maxCharactersPerResult: 2_500 } },
    )) {
      response += chunk;
    }

    expect(response).toBe('HELLO_OK');
    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain('streamGenerateContent');
  });

  it('uses public search evidence and appends real source links', async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith('https://html.duckduckgo.com/')) {
        return new Response(`
          <a class="result__a" href="https://nodejs.org/en/about/previous-releases">Node.js releases</a>
          <a class="result__snippet">The official Node.js release table.</a>
        `, { status: 200, headers: { 'Content-Type': 'text/html' } });
      }
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return geminiJson('The current release is shown by the official Node.js table.');
    }));

    const backend = new GeminiBackend('test-key', 'gemini-test');
    let response = '';
    for await (const chunk of backend.generate(
      [{ role: 'user', content: 'Search for the current Node.js release.' }],
      { webSearch: { maxResults: 3, maxTotalResults: 3, maxCharactersPerResult: 2_500 } },
    )) {
      response += chunk;
    }

    expect(response).toContain('The current release');
    expect(response).toContain('[Node.js releases](https://nodejs.org/en/about/previous-releases)');
    expect(requestBodies).toHaveLength(1);
    expect(JSON.stringify(requestBodies[0]?.systemInstruction)).toContain('server-side tools');
    expect(JSON.stringify(requestBodies[0]?.systemInstruction)).toContain('https://nodejs.org/en/about/previous-releases');
  });

  it('requests JSON-object output for schema-validated background work', async () => {
    let requestBody: Record<string, unknown> | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return geminiJson('{"people":[],"facts":[]}');
    }));

    const backend = new GeminiBackend('test-key', 'gemini-3-test');
    await expect(backend.generateOnce(
      [{ role: 'user', content: 'Return JSON.' }],
      { jsonObject: true },
    )).resolves.toBe('{"people":[],"facts":[]}');

    expect(requestBody?.generationConfig).toMatchObject({
      responseMimeType: 'application/json',
      thinkingConfig: { thinkingLevel: 'minimal' },
    });
  });

  it('surfaces an explicit error when Gemini returns no text', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => geminiJson('')));
    const backend = new GeminiBackend('test-key', 'gemini-test');
    await expect(backend.generateOnce([{ role: 'user', content: 'hello' }]))
      .rejects.toThrow('returned no text');
  });

  it('retries transient non-streaming provider failures before succeeding', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('high demand', { status: 503 }))
      .mockResolvedValueOnce(geminiJson('RECOVERED'));
    vi.stubGlobal('fetch', fetchMock);
    const backend = new GeminiBackend('test-key', 'gemini-test', true, 'minimal', async () => {});

    await expect(backend.generateOnce([{ role: 'user', content: 'hello' }]))
      .resolves.toBe('RECOVERED');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries a transient stream response only before output begins', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('temporarily unavailable', { status: 503 }))
      .mockResolvedValueOnce(geminiStream('STREAM_RECOVERED'));
    vi.stubGlobal('fetch', fetchMock);
    const backend = new GeminiBackend('test-key', 'gemini-test', true, 'minimal', async () => {});
    let response = '';

    for await (const chunk of backend.generate([{ role: 'user', content: 'hello' }])) {
      response += chunk;
    }

    expect(response).toBe('STREAM_RECOVERED');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry permanent authentication failures', async () => {
    const fetchMock = vi.fn(async () => new Response('bad key', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    const backend = new GeminiBackend('test-key', 'gemini-test', true, 'minimal', async () => {});

    await expect(backend.generateOnce([{ role: 'user', content: 'hello' }]))
      .rejects.toThrow('Gemini generate failed: 401');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('bounds persistent transient failures to three attempts', async () => {
    const fetchMock = vi.fn(async () => new Response('high demand', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    const backend = new GeminiBackend('test-key', 'gemini-test', true, 'minimal', async () => {});

    await expect(backend.generateOnce([{ role: 'user', content: 'hello' }]))
      .rejects.toThrow('Gemini generate failed: 503');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('moves immediately to the next model when a per-model daily quota is exhausted', async () => {
    const retryWait = vi.fn(async () => {});
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: {
          code: 429,
          status: 'RESOURCE_EXHAUSTED',
          details: [{
            '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
            violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }],
          }],
        },
      }), { status: 429 }))
      .mockResolvedValueOnce(geminiJson('FALLBACK_OK'));
    vi.stubGlobal('fetch', fetchMock);
    const backend = new GeminiBackend(
      'test-key',
      'gemini-3-flash-preview',
      true,
      'minimal',
      retryWait,
      ['gemini-3.5-flash', 'gemini-3.1-flash-lite'],
    );

    await expect(backend.generateOnce([{ role: 'user', content: 'hello' }]))
      .resolves.toBe('FALLBACK_OK');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/gemini-3-flash-preview:generateContent');
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('/gemini-3.5-flash:generateContent');
    expect(retryWait).not.toHaveBeenCalled();
  });

  it('falls back after bounded retries for a persistently unavailable model', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('high demand', { status: 503 }))
      .mockResolvedValueOnce(new Response('high demand', { status: 503 }))
      .mockResolvedValueOnce(new Response('high demand', { status: 503 }))
      .mockResolvedValueOnce(geminiJson('SECOND_MODEL_OK'));
    vi.stubGlobal('fetch', fetchMock);
    const backend = new GeminiBackend(
      'test-key',
      'gemini-3-flash-preview',
      true,
      'minimal',
      async () => {},
      ['gemini-3.5-flash'],
    );

    await expect(backend.generateOnce([{ role: 'user', content: 'hello' }]))
      .resolves.toBe('SECOND_MODEL_OK');
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(String(fetchMock.mock.calls[3]?.[0])).toContain('/gemini-3.5-flash:generateContent');
  });

  it('falls back when a successful non-streaming response contains no text', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(geminiJson(''))
      .mockResolvedValueOnce(geminiJson('VISIBLE_FALLBACK'));
    vi.stubGlobal('fetch', fetchMock);
    const backend = new GeminiBackend(
      'test-key',
      'gemini-3-flash-preview',
      true,
      'minimal',
      async () => {},
      ['gemini-3.5-flash'],
    );

    await expect(backend.generateOnce([{ role: 'user', content: 'hello' }]))
      .resolves.toBe('VISIBLE_FALLBACK');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('falls back when a successful stream completes before emitting text', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(geminiStream(''))
      .mockResolvedValueOnce(geminiStream('STREAM_FALLBACK'));
    vi.stubGlobal('fetch', fetchMock);
    const backend = new GeminiBackend(
      'test-key',
      'gemini-3-flash-preview',
      true,
      'minimal',
      async () => {},
      ['gemini-3.5-flash'],
    );
    let response = '';

    for await (const chunk of backend.generate([{ role: 'user', content: 'hello' }])) {
      response += chunk;
    }

    expect(response).toBe('STREAM_FALLBACK');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
