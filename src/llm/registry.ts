// Chooses the active LLM backend based on config.llmBackend.
// The MAIN brain only ever imports getLlmBackend() from here — never a
// concrete backend — so swapping is one env var:
//   LLM_BACKEND=gemini|transformers|scratch
//
// Gemini is the default for deploys; transformers is local-only (needs ~500MB
// of model weights on disk); scratch is the from-scratch trained model.

import { config } from '../config.js';
import type { LlmBackend } from './types.js';
import { getGeminiBackend } from './geminiBackend.js';

let cached: LlmBackend | null = null;

export function getLlmBackend(): LlmBackend {
  if (cached) return cached;
  switch (config.llmBackend) {
    case 'gemini':
      cached = getGeminiBackend();
      return cached;
    case 'transformers': {
      // Lazy-import so serverless builds don't try to bundle the heavy
      // transformers.js dependency when they aren't using it.
      // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
      const mod = require('./transformersBackend.js');
      cached = mod.getTransformersBackend();
      return cached!;
    }
    case 'scratch': {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
        const mod = require('./scratchBackend.js');
        cached = mod.getScratchBackend();
        return cached!;
      } catch {
        throw new Error(
          'LLM_BACKEND=scratch but src/llm/scratchBackend.js is not yet implemented.',
        );
      }
    }
    default:
      throw new Error(`unknown LLM_BACKEND: ${config.llmBackend}`);
  }
}
