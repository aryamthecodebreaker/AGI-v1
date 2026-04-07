// transformers.js LLM backend — our daily driver.
//
// Uses @huggingface/transformers v3's text-generation pipeline. Streaming is
// implemented via TextStreamer which pushes strings into an async queue; we
// yield those strings back to the caller one chunk at a time.

import {
  env,
  pipeline,
  TextStreamer,
  type TextGenerationPipeline,
} from '@huggingface/transformers';
import { config } from '../config.js';
import { logger } from '../logger.js';
import type { ChatMessage, GenOpts, LlmBackend } from './types.js';

// Pin cache dir before any pipeline() call.
env.cacheDir = config.modelsDir;
env.localModelPath = config.modelsDir;
env.allowRemoteModels = true;

let pipePromise: Promise<TextGenerationPipeline> | null = null;

async function getPipeline(): Promise<TextGenerationPipeline> {
  if (!pipePromise) {
    logger.info({ model: config.llmModelId, cacheDir: config.modelsDir }, 'loading LLM');
    pipePromise = pipeline('text-generation', config.llmModelId, {
      // q4 where available keeps download under ~250 MB for SmolLM2-360M.
      dtype: 'q4',
    }) as Promise<TextGenerationPipeline>;
    pipePromise
      .then(() => logger.info({ model: config.llmModelId }, 'LLM ready'))
      .catch((err) => {
        logger.error({ err }, 'LLM load failed');
        pipePromise = null;
      });
  }
  return pipePromise;
}

export async function warmLlm(): Promise<void> {
  const pipe = await getPipeline();
  // Tiny run to trigger the first forward pass / compile.
  await pipe(
    [{ role: 'user', content: 'hi' }] as unknown as string,
    { max_new_tokens: 1, do_sample: false } as unknown as Record<string, unknown>,
  );
}

// ---------- Streamer helper ----------
//
// TextStreamer invokes a callback synchronously each time new tokens are
// decoded. We bridge it to an AsyncIterable via a simple unbounded queue.
class TokenQueue {
  private readonly chunks: string[] = [];
  private resolver: ((value: IteratorResult<string>) => void) | null = null;
  private done = false;
  private error: Error | null = null;

  push(chunk: string): void {
    if (this.resolver) {
      const r = this.resolver;
      this.resolver = null;
      r({ value: chunk, done: false });
    } else {
      this.chunks.push(chunk);
    }
  }

  close(err?: Error): void {
    this.done = true;
    if (err) this.error = err;
    if (this.resolver) {
      const r = this.resolver;
      this.resolver = null;
      if (err) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (r as any)(Promise.reject(err));
      } else {
        r({ value: undefined as unknown as string, done: true });
      }
    }
  }

  next(): Promise<IteratorResult<string>> {
    if (this.chunks.length > 0) {
      return Promise.resolve({ value: this.chunks.shift()!, done: false });
    }
    if (this.done) {
      if (this.error) return Promise.reject(this.error);
      return Promise.resolve({ value: undefined as unknown as string, done: true });
    }
    return new Promise((resolve) => {
      this.resolver = resolve;
    });
  }
}

class TransformersBackend implements LlmBackend {
  readonly name = `transformers:${config.llmModelId}`;

  async ready(): Promise<void> {
    await getPipeline();
  }

  async *generate(messages: ChatMessage[], opts: GenOpts = {}): AsyncIterable<string> {
    const pipe = await getPipeline();
    const queue = new TokenQueue();

    // TextStreamer writes decoded strings via callback_function.
    // skip_prompt: don't replay the input; skip_special_tokens: no <|im_end|> etc.
    const streamer = new TextStreamer(pipe.tokenizer, {
      skip_prompt: true,
      skip_special_tokens: true,
      callback_function: (text: string) => {
        if (text) queue.push(text);
      },
    });

    const genOpts: Record<string, unknown> = {
      max_new_tokens: opts.maxNewTokens ?? 256,
      do_sample: (opts.temperature ?? 0.7) > 0,
      temperature: opts.temperature ?? 0.7,
      top_p: opts.topP ?? 0.9,
      top_k: opts.topK ?? 50,
      repetition_penalty: opts.repetitionPenalty ?? 1.1,
      streamer,
      return_full_text: false,
    };

    // Fire the generate call without awaiting — we want to yield from the
    // queue as chunks arrive.
    const runPromise = pipe(messages as unknown as string, genOpts as Record<string, unknown>)
      .then(() => queue.close())
      .catch((err: unknown) => queue.close(err as Error));

    // Honor abort signal from caller (e.g. HTTP client disconnect).
    if (opts.signal) {
      opts.signal.addEventListener('abort', () => queue.close(new Error('aborted')), { once: true });
    }

    try {
      while (true) {
        const { value, done } = await queue.next();
        if (done) break;
        yield value;
      }
    } finally {
      await runPromise.catch(() => undefined);
    }
  }

  async generateOnce(messages: ChatMessage[], opts: GenOpts = {}): Promise<string> {
    const pipe = await getPipeline();
    const genOpts: Record<string, unknown> = {
      max_new_tokens: opts.maxNewTokens ?? 256,
      do_sample: (opts.temperature ?? 0.2) > 0,
      temperature: opts.temperature ?? 0.2,
      top_p: opts.topP ?? 0.9,
      top_k: opts.topK ?? 50,
      repetition_penalty: opts.repetitionPenalty ?? 1.1,
      return_full_text: false,
    };
    const result = await pipe(messages as unknown as string, genOpts);
    // Result shape: [{ generated_text: string | ChatMessage[] }]
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const first = Array.isArray(result) ? (result[0] as any) : (result as any);
    const gt = first?.generated_text;
    if (typeof gt === 'string') return gt;
    if (Array.isArray(gt)) {
      // Chat-format returns full message list; last message is the assistant reply.
      const last = gt[gt.length - 1];
      return typeof last?.content === 'string' ? last.content : String(last ?? '');
    }
    return String(gt ?? '');
  }
}

let instance: TransformersBackend | null = null;
export function getTransformersBackend(): LlmBackend {
  if (!instance) instance = new TransformersBackend();
  return instance;
}
