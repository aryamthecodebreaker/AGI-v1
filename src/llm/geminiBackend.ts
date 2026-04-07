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

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

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

function toGeminiRequest(messages: ChatMessage[], opts: GenOpts): GeminiRequestBody {
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

export class GeminiBackend implements LlmBackend {
  readonly name: string;
  private readonly apiKey: string;
  private readonly modelId: string;

  constructor(apiKey: string, modelId: string) {
    this.apiKey = apiKey;
    this.modelId = modelId;
    this.name = `gemini:${modelId}`;
  }

  async ready(): Promise<void> {
    // No model download / warm-up. The API is always "ready".
  }

  async *generate(messages: ChatMessage[], opts: GenOpts = {}): AsyncIterable<string> {
    const url = `${API_BASE}/${this.modelId}:streamGenerateContent?alt=sse&key=${this.apiKey}`;
    const body = toGeminiRequest(messages, opts);

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      throw new Error(`Gemini stream failed: ${res.status} ${text}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });

        // Flush every complete SSE frame currently in the buffer.
        let boundary = pending.indexOf('\n\n');
        while (boundary !== -1) {
          const frame = pending.slice(0, boundary);
          pending = pending.slice(boundary + 2);
          for (const payload of parseStreamBuffer(frame)) {
            try {
              const parsed = JSON.parse(payload) as GeminiStreamChunk;
              const text = extractTextFromChunk(parsed);
              if (text) yield text;
            } catch (err) {
              logger.warn({ err, payload }, 'gemini: could not parse stream chunk');
            }
          }
          boundary = pending.indexOf('\n\n');
        }
      }
      // Drain anything left.
      if (pending.trim()) {
        for (const payload of parseStreamBuffer(pending)) {
          try {
            const parsed = JSON.parse(payload) as GeminiStreamChunk;
            const text = extractTextFromChunk(parsed);
            if (text) yield text;
          } catch {
            /* ignore */
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
  }

  async generateOnce(messages: ChatMessage[], opts: GenOpts = {}): Promise<string> {
    const url = `${API_BASE}/${this.modelId}:generateContent?key=${this.apiKey}`;
    const body = toGeminiRequest(messages, opts);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Gemini generate failed: ${res.status} ${text}`);
    }
    const json = (await res.json()) as GeminiStreamChunk;
    return extractTextFromChunk(json);
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
  cached = new GeminiBackend(config.geminiApiKey, config.llmModelId);
  return cached;
}
