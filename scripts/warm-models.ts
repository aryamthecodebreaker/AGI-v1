// Pre-downloads all LLM and embedding models into data/models/ so the first
// user request doesn't have to wait for 250+ MB of downloads. Idempotent —
// safe to re-run.

import { config } from '../src/config.js';
import { logger } from '../src/logger.js';
import { warmEmbeddings } from '../src/llm/embeddings.js';

async function main(): Promise<void> {
  logger.info({ modelsDir: config.modelsDir }, 'warming models');

  // 1. Embedding model (~25 MB)
  logger.info({ model: config.embedModelId }, 'warming embedding model');
  const t0 = Date.now();
  const vec = await (async () => {
    await warmEmbeddings();
    // Second call to confirm the cached pipeline returns the right shape.
    const { embed } = await import('../src/llm/embeddings.js');
    return embed('hello world');
  })();
  logger.info({ dim: vec.length, ms: Date.now() - t0 }, 'embedding model ready');

  // 2. LLM model (~250 MB). Dynamic path string so this script still compiles
  //    before the LLM backend module exists.
  const llmBackendPath = '../src/llm/transformersBackend.js';
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = await import(llmBackendPath);
    if (mod && typeof mod.warmLlm === 'function') {
      logger.info({ model: config.llmModelId }, 'warming LLM model');
      const t1 = Date.now();
      await mod.warmLlm();
      logger.info({ ms: Date.now() - t1 }, 'LLM model ready');
    } else {
      logger.info('LLM backend module exists but no warmLlm export — skipping');
    }
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes('Cannot find module') || msg.includes('ERR_MODULE_NOT_FOUND')) {
      logger.info('LLM backend not implemented yet — skipping LLM warm-up');
    } else {
      throw err;
    }
  }

  logger.info('warm complete');
}

main().catch((err) => {
  logger.fatal({ err }, 'warm-models failed');
  process.exit(1);
});
