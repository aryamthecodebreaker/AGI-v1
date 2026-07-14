// OpenRouter backend using the OpenAI-compatible chat completions API.

import { config } from '../config.js';
import { logger } from '../logger.js';
import type { ChatMessage, GenOpts, LlmBackend } from './types.js';

const CHAT_COMPLETIONS_URL = 'https://openrouter.ai/api/v1/chat/completions';
const WEB_SEARCH_FALLBACK_NOTE: ChatMessage = {
  role: 'system',
  content: [
    'The web-search provider was temporarily unavailable for this request.',
    'Answer from existing knowledge when possible.',
    'If the answer requires current verification, say that clearly.',
    'Do not claim you searched the web and do not invent sources.',
  ].join(' '),
};

interface OpenRouterError {
  code?: number | string;
  message?: string;
  metadata?: { raw?: string };
}

interface OpenRouterChunk {
  model?: string;
  error?: OpenRouterError;
  choices?: Array<{
    delta?: { content?: string | null };
    message?: {
      content?: string | null;
      annotations?: Array<{
        type?: string;
        url_citation?: {
          url?: string;
          title?: string;
        };
      }>;
    };
  }>;
}

class OpenRouterRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'OpenRouterRequestError';
  }
}

function requestBody(messages: ChatMessage[], opts: GenOpts, stream: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: config.llmModelId,
    messages,
    stream,
    temperature: opts.temperature ?? 0.7,
    max_tokens: opts.maxNewTokens ?? 512,
    top_p: opts.topP,
  };
  if (opts.webSearch) {
    body.tools = [{
      type: 'openrouter:web_search',
      parameters: {
        engine: 'exa',
        max_results: opts.webSearch.maxResults,
        max_total_results: opts.webSearch.maxTotalResults,
        max_characters: opts.webSearch.maxCharactersPerResult,
      },
    }];
  }
  if (opts.jsonObject) {
    body.response_format = { type: 'json_object' };
  }
  return body;
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
  const parsedCode = Number(chunk.error.code);
  const status = Number.isFinite(parsedCode) ? parsedCode : 502;
  const detail = chunk.error.metadata?.raw ?? chunk.error.message ?? 'unknown provider error';
  throw new OpenRouterRequestError(status, `OpenRouter stream failed ${status}: ${detail.slice(0, 1_000)}`);
}

async function responseError(res: Response, operation: string): Promise<OpenRouterRequestError> {
  const payload = await res.json().catch(() => ({})) as OpenRouterChunk;
  const detail = payload.error?.metadata?.raw
    ?? payload.error?.message
    ?? `HTTP ${res.status}`;
  return new OpenRouterRequestError(
    res.status,
    `${operation} failed ${res.status}: ${detail.slice(0, 1_000)}`,
  );
}

function retryable(error: unknown): error is OpenRouterRequestError {
  return error instanceof OpenRouterRequestError
    && (error.status === 404
      || error.status === 408
      || error.status === 409
      || error.status === 429
      || error.status >= 500);
}

function appendMissingCitations(content: string, chunk: OpenRouterChunk): string {
  // If the model already supplied a source URL, preserve its curated answer.
  // Raw annotations can include search candidates that were not actually used.
  if (/https?:\/\//i.test(content)) return content;
  const citations = chunk.choices?.[0]?.message?.annotations
    ?.filter((annotation) => annotation.type === 'url_citation')
    .map((annotation) => annotation.url_citation)
    .filter((citation): citation is { url: string; title?: string } => Boolean(citation?.url))
    ?? [];
  const missing = Array.from(
    new Map(citations.map((citation) => [citation.url, citation])).values(),
  ).filter((citation) => !content.includes(citation.url));
  if (missing.length === 0) return content;
  return `${content}\n\nSources:\n${missing
    .map((citation) => {
      const label = citation.title?.replace(/[\[\]\r\n]/g, ' ').trim() || citation.url;
      return `- [${label}](${citation.url})`;
    })
    .join('\n')}`;
}

export class OpenRouterBackend implements LlmBackend {
  readonly name: string;
  readonly supportsWebSearch: boolean;

  constructor(
    private readonly apiKey: string,
    private readonly modelId: string,
    private readonly fallbackModelIds: string[] = [],
    webSearchEnabled = true,
    private readonly webSearchModelId = 'openrouter/free',
    private readonly taskFallbackModelId = 'openrouter/free',
  ) {
    this.name = `openrouter:${modelId}`;
    this.supportsWebSearch = webSearchEnabled;
  }

  async ready(): Promise<void> {
    // Hosted API; there is no local model to warm up.
  }

  private models(opts: GenOpts, includeTaskFallback = false): string[] {
    if (opts.webSearch) return [this.webSearchModelId];
    return Array.from(new Set([
      this.modelId,
      ...this.fallbackModelIds,
      ...(includeTaskFallback ? [this.taskFallbackModelId] : []),
    ]));
  }

  private async *generateWithModel(
    model: string,
    messages: ChatMessage[],
    opts: GenOpts,
  ): AsyncIterable<string> {
    const res = await fetch(CHAT_COMPLETIONS_URL, {
      method: 'POST',
      headers: headers(this.apiKey),
      body: JSON.stringify({ ...requestBody(messages, opts, true), model }),
      signal: opts.signal,
    });
    if (!res.ok || !res.body) {
      throw await responseError(res, 'OpenRouter stream');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    let sawContent = false;
    let reportedModel = false;
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
              if (chunk.model && !reportedModel) {
                logger.info({ requestedModel: model, selectedModel: chunk.model }, 'openrouter: model selected');
                reportedModel = true;
              }
              const text = chunk.choices?.[0]?.delta?.content;
              if (text) {
                sawContent = true;
                yield text;
              }
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
          if (text) {
            sawContent = true;
            yield text;
          }
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* ignore */
      }
    }
    if (!sawContent) {
      throw new OpenRouterRequestError(502, `OpenRouter stream failed 502: ${model} returned no text`);
    }
  }

  async *generate(messages: ChatMessage[], opts: GenOpts = {}): AsyncIterable<string> {
    // OpenRouter's free router filters for models that support the requested
    // server tools. Use its non-streaming path for web search so annotations
    // can be preserved as source links. Ordinary chat remains streamed through
    // the explicitly configured conversational model fallbacks.
    if (opts.webSearch) {
      try {
        yield await this.generateOnce(messages, opts);
        return;
      } catch (error) {
        if (opts.signal?.aborted) throw error;
        logger.warn(
          { err: error, webSearchModel: this.webSearchModelId },
          'openrouter: web search failed; retrying without web search',
        );
        const fallbackMessages = [...messages, WEB_SEARCH_FALLBACK_NOTE];
        const fallbackOpts = { ...opts, webSearch: undefined };
        for await (const text of this.generate(fallbackMessages, fallbackOpts)) {
          yield text;
        }
        return;
      }
    }

    const models = this.models(opts);
    let lastError: unknown;
    for (let index = 0; index < models.length; index++) {
      const model = models[index]!;
      let emitted = false;
      try {
        for await (const text of this.generateWithModel(model, messages, opts)) {
          emitted = true;
          yield text;
        }
        return;
      } catch (error) {
        lastError = error;
        const nextModel = models[index + 1];
        if (emitted || !nextModel || !retryable(error)) throw error;
        logger.warn({ err: error, model, nextModel }, 'openrouter: retrying with fallback model');
      }
    }
    throw lastError ?? new Error('OpenRouter stream failed without a model attempt');
  }

  async generateOnce(messages: ChatMessage[], opts: GenOpts = {}): Promise<string> {
    // Single-shot calls power background extraction, classification, and
    // validated proposal drafts. If every pinned provider is unavailable,
    // the free router is a final chance to complete the task; downstream
    // schemas and static validation still reject malformed output.
    const models = this.models(opts, true);
    let lastError: unknown;
    for (let index = 0; index < models.length; index++) {
      const model = models[index]!;
      try {
        const res = await fetch(CHAT_COMPLETIONS_URL, {
          method: 'POST',
          headers: headers(this.apiKey),
          body: JSON.stringify({ ...requestBody(messages, opts, false), model }),
          signal: opts.signal,
        });
        if (!res.ok) throw await responseError(res, 'OpenRouter request');
        const json = (await res.json()) as OpenRouterChunk;
        throwChunkError(json);
        const content = json.choices?.[0]?.message?.content?.trim() ?? '';
        if (!content) {
          throw new OpenRouterRequestError(502, `OpenRouter request failed 502: ${model} returned no text`);
        }
        logger.info({ requestedModel: model, selectedModel: json.model }, 'openrouter: model selected');
        return appendMissingCitations(content, json);
      } catch (error) {
        lastError = error;
        const nextModel = models[index + 1];
        if (!nextModel || !retryable(error)) throw error;
        logger.warn({ err: error, model, nextModel }, 'openrouter: retrying request with fallback model');
      }
    }
    throw lastError ?? new Error('OpenRouter request failed without a model attempt');
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
  cached = new OpenRouterBackend(
    config.openRouterApiKey,
    config.llmModelId,
    config.openRouterFallbackModelIds,
    config.openRouterWebSearchEnabled,
    config.openRouterWebSearchModelId,
    config.openRouterTaskFallbackModelId,
  );
  return cached;
}
