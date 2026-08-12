// Single-image understanding.
//
// Deliberately separate from LlmBackend: ChatMessage is text-only, and widening
// it to carry image parts would ripple through retrieval, memory extraction and
// every backend for the sake of one feature. This is a narrow, direct call.
//
// The image is passed in memory and never written to disk by AGI-v1. Callers
// are responsible for not retaining it after the answer comes back.

import { config } from '../config.js';
import { logger } from '../logger.js';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/** Hard ceiling on what will be sent to the model. */
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

export interface DescribeImageInput {
  /** Base64 image data, without the data: URI prefix. */
  base64: string;
  mimeType: string;
  /** What the user actually asked about the image. */
  question: string;
  maxOutputTokens?: number;
}

export interface DescribeImageResult {
  ok: boolean;
  text?: string;
  error?: string;
}

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);

/**
 * Answer a question about one image.
 *
 * Returns a result object rather than throwing: a failed screen read should be
 * reported to the user as a failed device action, not crash the command.
 */
export async function describeImage(input: DescribeImageInput): Promise<DescribeImageResult> {
  if (!config.geminiApiKey) {
    return {
      ok: false,
      error: 'Reading an image needs GEMINI_API_KEY to be set on the server.',
    };
  }
  if (!ALLOWED_MIME.has(input.mimeType)) {
    return { ok: false, error: `Unsupported image type: ${input.mimeType}` };
  }
  // base64 is ~4/3 of the raw bytes.
  if (input.base64.length * 0.75 > MAX_IMAGE_BYTES) {
    return { ok: false, error: 'That image is too large to read.' };
  }

  const model = config.llmModelId.startsWith('gemini') ? config.llmModelId : 'gemini-3-flash-preview';
  const url = `${API_BASE}/${model}:generateContent?key=${config.geminiApiKey}`;

  const body = {
    contents: [
      {
        role: 'user',
        parts: [
          { inlineData: { mimeType: input.mimeType, data: input.base64 } },
          { text: input.question },
        ],
      },
    ],
    systemInstruction: {
      parts: [
        {
          text:
            'You are looking at a screenshot the user deliberately shared with you. ' +
            'Answer their question about it directly and concretely. Describe only what ' +
            'is actually visible — do not guess at content you cannot see, and say so if ' +
            'the answer is not on screen. If you notice credentials, private messages or ' +
            'other sensitive material, answer the question without repeating those details ' +
            'back verbatim.',
        },
      ],
    },
    generationConfig: { temperature: 0.2, maxOutputTokens: input.maxOutputTokens ?? 600 },
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      // Never log the body: it echoes the request, which contains the image.
      logger.warn({ status: res.status }, 'vision request failed');
      return { ok: false, error: `The model could not read the image (${res.status}).` };
    }
    const json = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const text = json.candidates?.[0]?.content?.parts
      ?.map((p) => p.text ?? '')
      .join('')
      .trim();
    if (!text) return { ok: false, error: 'The model returned no description.' };
    return { ok: true, text };
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'vision request errored');
    return { ok: false, error: 'Reading the image timed out or failed.' };
  }
}
