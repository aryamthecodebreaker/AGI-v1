// One-shot smoke test for the LLM backend. Downloads SmolLM2 on first run
// (~250 MB). Intended for manual step-6 verification only.

import { getLlmBackend } from '../src/llm/registry.js';
import { logger } from '../src/logger.js';

async function main(): Promise<void> {
  const backend = getLlmBackend();
  logger.info({ backend: backend.name }, 'loading backend');
  await backend.ready();

  const t0 = Date.now();
  const reply = await backend.generateOnce(
    [
      { role: 'system', content: 'You are a terse assistant.' },
      { role: 'user', content: 'In one short sentence, what is the capital of France?' },
    ],
    { maxNewTokens: 40, temperature: 0.2 },
  );
  logger.info({ ms: Date.now() - t0, reply: reply.trim() }, 'generateOnce reply');

  logger.info('streaming test:');
  const t1 = Date.now();
  let total = '';
  let chunks = 0;
  for await (const chunk of backend.generate(
    [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Write a short poem about the moon, about 4 lines.' },
    ],
    { maxNewTokens: 120, temperature: 0.7 },
  )) {
    process.stdout.write(chunk);
    total += chunk;
    chunks++;
  }
  process.stdout.write('\n');
  logger.info({ ms: Date.now() - t1, length: total.length, chunks }, 'stream done');
}

main().catch((err) => {
  logger.fatal({ err }, 'smoke-llm failed');
  process.exit(1);
});
