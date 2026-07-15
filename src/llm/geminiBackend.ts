// Gemini backend — calls Google's Generative Language API.
//
// Implements the same LlmBackend interface as the transformers.js backend, so
// the MAIN brain is oblivious to which is running. Chosen when
// LLM_BACKEND=gemini.
//
// We hit the REST endpoint directly (no SDK) to keep the dependency surface
// minimal and work in any serverless runtime that has fetch.

import { config } from '../config.js';
import { logger } from '../logger.js';
import type { ChatMessage, GenOpts, LlmBackend } from './types.js';
import {
  appendWebSources,
  collectWebEvidence,
  evidenceSystemMessage,
  type WebSource,
} from './webSearch.js';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const MAX_REQUEST_ATTEMPTS = 3;
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const MODEL_FALLBACK_STATUSES = new Set([404, ...RETRYABLE_STATUSES]);
type GeminiThinkingLevel = 'minimal' | 'low' | 'medium' | 'high';
type RetryWait = (attempt: number, response: Response | undefined, signal: AbortSignal | undefined) => Promise<void>;

class GeminiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly responseText: string,
  ) {
    super(message);
    this.name = 'GeminiRequestError';
  }
}

interface GeminiPart {
  text: string;
}
interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}
interface GeminiRequestBody {
  contents: GeminiContent[];
  systemInstruction?: { parts: GeminiPart[] };
  generationConfig?: {
    temperature?: number;
    maxOutputTokens?: number;
    topP?: number;
    topK?: number;
    responseMimeType?: 'application/json';
    thinkingConfig?: { thinkingLevel: GeminiThinkingLevel };
  };
}
interface GeminiStreamChunk {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
      role?: string;
    };
    finishReason?: string;
  }>;
}

function toGeminiRequest(
  messages: ChatMessage[],
  opts: GenOpts,
  thinkingLevel?: GeminiThinkingLevel,
): GeminiRequestBody {
  // Split system instructions (Gemini has a dedicated field) from the chat.
  const systemParts: string[] = [];
  const contents: GeminiContent[] = [];
  for (const m of messages) {
    if (m.role === 'system') {
      systemParts.push(m.content);
      continue;
    }
    contents.push({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    });
  }
  // Gemini requires the first content to be 'user'. If the trimmed history
  // starts with 'model', prepend an empty user turn so the API accepts it.
  if (contents.length > 0 && contents[0]!.role === 'model') {
    contents.unshift({ role: 'user', parts: [{ text: ' ' }] });
  }
  // Same failure mode if the whole chat collapsed to system only.
  if (contents.length === 0) {
    contents.push({ role: 'user', parts: [{ text: ' ' }] });
  }

  const body: GeminiRequestBody = {
    contents,
    generationConfig: {
      temperature: opts.temperature ?? 0.7,
      maxOutputTokens: opts.maxNewTokens ?? 512,
      topP: opts.topP,
      topK: opts.topK,
      ...(opts.jsonObject ? { responseMimeType: 'application/json' as const } : {}),
      ...(thinkingLevel ? { thinkingConfig: { thinkingLevel } } : {}),
    },
  };
  if (systemParts.length > 0) {
    body.systemInstruction = { parts: [{ text: systemParts.join('\n\n') }] };
  }
  return body;
}

/**
 * Parse one or more JSON blobs emitted by Gemini's SSE stream. The wire
 * format is `data: {...}\n\n` but `data:` can also be omitted when using the
 * non-SSE streaming endpoint (a bare JSON array of objects). We handle both.
 */
function* parseStreamBuffer(buffer: string): Generator<string> {
  // SSE frames separated by double newlines.
  const frames = buffer.split(/\r?\n\r?\n/);
  for (const frame of frames) {
    const trimmed = frame.trim();
    if (!trimmed) continue;
    // Strip optional "data:" prefix (possibly repeated on multi-line frames).
    const payload = trimmed
      .split(/\r?\n/)
      .map((l) => l.replace(/^data:\s?/, ''))
      .join('');
    if (!payload || payload === '[DONE]') continue;
    yield payload;
  }
}

function extractTextFromChunk(chunk: GeminiStreamChunk): string {
  const cand = chunk.candidates?.[0];
  if (!cand?.content?.parts) return '';
  return cand.content.parts.map((p) => p.text ?? '').join('');
}

function currentUserQuery(messages: ChatMessage[]): string {
  const content = [...messages].reverse().find((message) => message.role === 'user')?.content.trim() ?? '';
  if (!content.startsWith('[Context from my long-term memory of you:')) return content;
  const marker = ']\n\n';
  const markerIndex = content.lastIndexOf(marker);
  return markerIndex >= 0 ? content.slice(markerIndex + marker.length).trim() : content;
}

function retryDelayMs(attempt: number, response?: Response): number {
  const retryAfter = response?.headers.get('retry-after')?.trim();
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.min(Math.max(seconds * 1_000, 0), 5_000);
    const dateDelay = Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(dateDelay)) return Math.min(Math.max(dateDelay, 0), 5_000);
  }
  return Math.min(500 * (2 ** (attempt - 1)), 4_000);
}

function isDailyQuotaExhaustion(responseText: string): boolean {
  return /(?:GenerateRequestsPerDay|requests?\s+per\s+day|\bRPD\b)/i.test(responseText);
}

const waitBeforeRetry: RetryWait = async (attempt, response, signal) => {
  const delay = retryDelayMs(attempt, response);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, delay);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('Request aborted'));
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal) {
      setTimeout(() => signal.removeEventListener('abort', onAbort), delay + 1);
    }
  });
};

export class GeminiBackend implements LlmBackend {
  readonly name: string;
  readonly supportsWebSearch: boolean;
  private readonly apiKey: string;
  private readonly modelId: string;
  private readonly modelIds: string[];

  constructor(
    apiKey: string,
    modelId: string,
    webSearchEnabled = true,
    private readonly thinkingLevel: GeminiThinkingLevel = 'minimal',
    private readonly retryWait: RetryWait = waitBeforeRetry,
    fallbackModelIds: string[] = [],
  ) {
    this.apiKey = apiKey;
    this.modelId = modelId;
    this.modelIds = [...new Set([modelId, ...fallbackModelIds.map((value) => value.trim()).filter(Boolean)])];
    this.name = `gemini:${modelId}`;
    this.supportsWebSearch = webSearchEnabled;
  }

  async ready(): Promise<void> {
    // No model download / warm-up. The API is always "ready".
  }

  async *generate(messages: ChatMessage[], opts: GenOpts = {}): AsyncIterable<string> {
    if (opts.webSearch && this.supportsWebSearch) {
      const { groundedMessages, sources, searched } = await this.groundWebRequest(messages, opts);
      if (searched) {
        const response = await this.generateOnce(groundedMessages, { ...opts, webSearch: undefined });
        yield appendWebSources(response, sources);
        return;
      }
    }

    let remainingModels = this.modelIds;
    while (remainingModels.length > 0) {
      const { response, modelId } = await this.requestWithModelFallback(
        messages,
        opts,
        'stream',
        remainingModels,
      );
      let sawText = false;
      for await (const text of this.readStreamText(response)) {
        sawText = true;
        yield text;
      }
      if (sawText) return;

      const nextIndex = remainingModels.indexOf(modelId) + 1;
      const nextModels = remainingModels.slice(nextIndex);
      if (nextModels.length === 0) {
        throw new Error(`Gemini stream failed 502: ${modelId} returned no text`);
      }
      logger.warn({ modelId, nextModel: nextModels[0] }, 'gemini: empty stream; trying fallback model');
      remainingModels = nextModels;
    }
  }

  async generateOnce(messages: ChatMessage[], opts: GenOpts = {}): Promise<string> {
    if (opts.webSearch && this.supportsWebSearch) {
      const { groundedMessages, sources, searched } = await this.groundWebRequest(messages, opts);
      if (searched) {
        const response = await this.generateOnce(groundedMessages, { ...opts, webSearch: undefined });
        return appendWebSources(response, sources);
      }
    }

    let remainingModels = this.modelIds;
    while (remainingModels.length > 0) {
      const { response, modelId } = await this.requestWithModelFallback(
        messages,
        opts,
        'generate',
        remainingModels,
      );
      const json = (await response.json()) as GeminiStreamChunk;
      const text = extractTextFromChunk(json).trim();
      if (text) return text;

      const nextIndex = remainingModels.indexOf(modelId) + 1;
      const nextModels = remainingModels.slice(nextIndex);
      if (nextModels.length === 0) {
        throw new Error(`Gemini generate failed 502: ${modelId} returned no text`);
      }
      logger.warn({ modelId, nextModel: nextModels[0] }, 'gemini: empty response; trying fallback model');
      remainingModels = nextModels;
    }
    throw new Error('Gemini generate failed 502: every configured model returned no text');
  }

  private async groundWebRequest(
    messages: ChatMessage[],
    opts: GenOpts,
  ): Promise<{ groundedMessages: ChatMessage[]; sources: WebSource[]; searched: boolean }> {
    const query = currentUserQuery(messages);
    const evidence = await collectWebEvidence(
      query,
      opts.webSearch?.maxTotalResults ?? opts.webSearch?.maxResults ?? 3,
      opts.signal,
    );
    if (!evidence.searched) return { groundedMessages: messages, sources: [], searched: false };
    const evidenceMessage = evidenceSystemMessage(
      evidence,
      opts.webSearch?.maxCharactersPerResult ?? 2_500,
    );
    return {
      groundedMessages: [...messages, { role: 'system', content: evidenceMessage }],
      sources: evidence.sources,
      searched: true,
    };
  }

  private async *readStreamText(response: Response): AsyncIterable<string> {
    if (!response.body) return;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });

        let boundary = pending.indexOf('\n\n');
        while (boundary !== -1) {
          const frame = pending.slice(0, boundary);
          pending = pending.slice(boundary + 2);
          for (const payload of parseStreamBuffer(frame)) {
            try {
              const parsed = JSON.parse(payload) as GeminiStreamChunk;
              const text = extractTextFromChunk(parsed);
              if (text) yield text;
            } catch (error) {
              logger.warn({ err: error, payload }, 'gemini: could not parse stream chunk');
            }
          }
          boundary = pending.indexOf('\n\n');
        }
      }
      if (pending.trim()) {
        for (const payload of parseStreamBuffer(pending)) {
          try {
            const parsed = JSON.parse(payload) as GeminiStreamChunk;
            const text = extractTextFromChunk(parsed);
            if (text) yield text;
          } catch {
            /* ignore incomplete final frames */
          }
        }
      }
    } finally {
      try { reader.releaseLock(); } catch { /* ignore */ }
    }
  }

  private async requestWithModelFallback(
    messages: ChatMessage[],
    opts: GenOpts,
    operation: 'stream' | 'generate',
    modelIds = this.modelIds,
  ): Promise<{ response: Response; modelId: string }> {
    let lastError: Error | undefined;
    for (let index = 0; index < modelIds.length; index++) {
      const modelId = modelIds[index]!;
      const nextModel = modelIds[index + 1];
      const params = new URLSearchParams({ key: this.apiKey });
      if (operation === 'stream') params.set('alt', 'sse');
      const url = `${API_BASE}/${modelId}:${operation === 'stream' ? 'streamGenerateContent' : 'generateContent'}?${params}`;
      const body = toGeminiRequest(
        messages,
        opts,
        modelId.startsWith('gemini-3') ? this.thinkingLevel : undefined,
      );
      try {
        const response = await this.requestWithRetry(modelId, url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: opts.signal,
        }, operation);
        if (index > 0) logger.info({ modelId, operation }, 'gemini: fallback model succeeded');
        return { response, modelId };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (opts.signal?.aborted || !nextModel) throw lastError;
        const status = lastError instanceof GeminiRequestError ? lastError.status : undefined;
        if (status !== undefined && !MODEL_FALLBACK_STATUSES.has(status)) throw lastError;
        logger.warn(
          { err: lastError, modelId, nextModel, operation },
          'gemini: trying fallback model',
        );
      }
    }
    throw lastError ?? new Error(`Gemini ${operation} failed`);
  }

  private async requestWithRetry(
    modelId: string,
    url: string,
    init: RequestInit,
    operation: 'stream' | 'generate',
  ): Promise<Response> {
    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= MAX_REQUEST_ATTEMPTS; attempt++) {
      let response: Response;
      try {
        response = await fetch(url, init);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (init.signal?.aborted || attempt === MAX_REQUEST_ATTEMPTS) throw lastError;
        logger.warn({ err: lastError, attempt, modelId, operation }, 'gemini: retrying transient network failure');
        await this.retryWait(attempt, undefined, init.signal ?? undefined);
        continue;
      }

      if (response.ok) return response;
      const text = await response.text().catch(() => '');
      lastError = new GeminiRequestError(
        `Gemini ${operation} failed: ${response.status} ${text}`,
        response.status,
        text,
      );
      const dailyQuotaExhausted = response.status === 429 && isDailyQuotaExhaustion(text);
      if (dailyQuotaExhausted || !RETRYABLE_STATUSES.has(response.status) || attempt === MAX_REQUEST_ATTEMPTS) {
        throw lastError;
      }
      logger.warn(
        { status: response.status, attempt, modelId, operation },
        'gemini: retrying transient provider response',
      );
      await this.retryWait(attempt, response, init.signal ?? undefined);
    }
    throw lastError ?? new Error(`Gemini ${operation} failed`);
  }
}

let cached: GeminiBackend | null = null;

export function getGeminiBackend(): GeminiBackend {
  if (cached) return cached;
  if (!config.geminiApiKey) {
    throw new Error(
      'LLM_BACKEND=gemini but GEMINI_API_KEY is not set. Add it to .env (local) or the platform env vars.',
    );
  }
  cached = new GeminiBackend(
    config.geminiApiKey,
    config.llmModelId,
    config.geminiWebSearchEnabled,
    config.geminiThinkingLevel,
    undefined,
    config.geminiFallbackModelIds,
  );
  return cached;
}
