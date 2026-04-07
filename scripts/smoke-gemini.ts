// Quick smoke test: generateOnce + streaming generate against Gemini.
// Run after adding GEMINI_API_KEY to .env:
//   npx tsx scripts/smoke-gemini.ts

import { getGeminiBackend } from '../src/llm/geminiBackend.js';

async function main(): Promise<void> {
  const llm = getGeminiBackend();
  await llm.ready();
  console.log('backend ready:', llm.name);

  console.log('\n-- generateOnce --');
  const once = await llm.generateOnce(
    [
      { role: 'system', content: 'You are a helpful assistant. Keep answers to one sentence.' },
      { role: 'user', content: 'What is the capital of France?' },
    ],
    { maxNewTokens: 60, temperature: 0.2 },
  );
  console.log('reply:', once);

  console.log('\n-- streaming generate --');
  let chunks = 0;
  let combined = '';
  for await (const tok of llm.generate(
    [
      { role: 'system', content: 'You write short rhyming couplets.' },
      { role: 'user', content: 'Write a two-line rhyme about the moon.' },
    ],
    { maxNewTokens: 120, temperature: 0.8 },
  )) {
    chunks++;
    combined += tok;
    process.stdout.write(tok);
  }
  console.log(`\n\n[chunks=${chunks}, chars=${combined.length}]`);
}

main().catch((err) => {
  console.error('FAIL:', err);
  process.exit(1);
});
