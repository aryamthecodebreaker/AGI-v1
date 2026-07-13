// OpenRouter backend using the OpenAI-compatible chat completions API.

import { config } from '../config.js';
import { logger } from '../logger.js';
import type { ChatMessage, GenOpts, LlmBackend } from './types.js';

const CHAT_COMPLETIONS_URL = 'https://openrouter.ai/api/v1/chat/completions';

interface OpenRouterError {
  code?: number | string;
  message?: string;
}

interface OpenRouterChunk {
  error?: OpenRouterError;
  choices?: Array<{
    delta?: { content?: string | null };
    message?: { content?: string | null };
  }>;
}

function requestBody(messages: ChatMessage[], opts: GenOpts, stream: boolean): Record<string, unknown> {
  return {
    model: config.llmModelId,
    messages,
    stream,
    temperature: opts.temperature ?? 0.7,
    max_tokens: opts.maxNewTokens ?? 512,
    top_p: opts.topP,
  };
}

function headers(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': 'https://agi-v1-five.vercel.app',
    'X-Title': 'AGI-v1',
  };
}

function parseDataLine(line: string): OpenRouterChunk | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith(':') || !trimmed.startsWith('data:')) return null;
  const payload = trimmed.slice(5).trim();
  if (!payload || payload === '[DONE]') return null;
  return JSON.parse(payload) as OpenRouterChunk;
}

function throwChunkError(chunk: OpenRouterChunk): void {
  if (!chunk.error) return;
  const code = chunk.error.code ? ` ${chunk.error.code}` : '';
  throw new Error(`OpenRouter stream failed${code}: ${chunk.error.message ?? 'unknown error'}`);
}

export class OpenRouterBackend implements LlmBackend {
  readonly name: string;

  constructor(
    private readonly apiKey: string,
    private readonly modelId: string,
  ) {
    this.name = `openrouter:${modelId}`;
  }

  async ready(): Promise<void> {
    // Hosted API; there is no local model to warm up.
  }

  async *generate(messages: ChatMessage[], opts: GenOpts = {}): AsyncIterable<string> {
    const res = await fetch(CHAT_COMPLETIONS_URL, {
      method: 'POST',
      headers: headers(this.apiKey),
      body: JSON.stringify({ ...requestBody(messages, opts, true), model: this.modelId }),
      signal: opts.signal,
    });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      throw new Error(`OpenRouter stream failed: ${res.status} ${text}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        let newline = pending.indexOf('\n');
        while (newline !== -1) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          try {
            const chunk = parseDataLine(line);
            if (chunk) {
              throwChunkError(chunk);
              const text = chunk.choices?.[0]?.delta?.content;
              if (text) yield text;
            }
          } catch (err) {
            if (err instanceof SyntaxError) {
              logger.warn({ err, line }, 'openrouter: could not parse stream chunk');
            } else {
              throw err;
            }
          }
          newline = pending.indexOf('\n');
        }
      }
      if (pending.trim()) {
        const chunk = parseDataLine(pending);
        if (chunk) {
          throwChunkError(chunk);
          const text = chunk.choices?.[0]?.delta?.content;
          if (text) yield text;
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* ignore */
      }
    }
  }

  async generateOnce(messages: ChatMessage[], opts: GenOpts = {}): Promise<string> {
    const res = await fetch(CHAT_COMPLETIONS_URL, {
      method: 'POST',
      headers: headers(this.apiKey),
      body: JSON.stringify({ ...requestBody(messages, opts, false), model: this.modelId }),
      signal: opts.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`OpenRouter request failed: ${res.status} ${text}`);
    }
    const json = (await res.json()) as OpenRouterChunk;
    throwChunkError(json);
    return json.choices?.[0]?.message?.content?.trim() ?? '';
  }
}

let cached: OpenRouterBackend | null = null;

export function getOpenRouterBackend(): OpenRouterBackend {
  if (cached) return cached;
  if (!config.openRouterApiKey) {
    throw new Error(
      'LLM_BACKEND=openrouter but OPENROUTER_API_KEY is not set. Add it to .env (local) or the platform env vars.',
    );
  }
  cached = new OpenRouterBackend(config.openRouterApiKey, config.llmModelId);
  return cached;
}
