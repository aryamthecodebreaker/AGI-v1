// Isolated smoke test for entity + fact extraction. Runs against SmolLM2
// directly and prints the raw output so we can see what's actually being
// returned.

import { getLlmBackend } from '../src/llm/registry.js';
import {
  ENTITY_EXTRACTION_SYSTEM,
  FACT_EXTRACTION_SYSTEM,
} from '../src/llm/prompts.js';
import { parsePeople } from '../src/brain/entityExtraction.js';
import { parseFacts } from '../src/brain/factExtraction.js';

async function main(): Promise<void> {
  const llm = getLlmBackend();
  await llm.ready();

  const inputs = [
    'I had lunch with my friend Sarah today. Her birthday is March 12.',
    "My favorite color is cerulean and I have a cat named Mochi.",
    "I'm feeling tired, probably going to bed early.",
  ];

  for (const text of inputs) {
    console.log('\n===========================================');
    console.log('INPUT:', text);
    console.log('-- entity extraction --');
    const entRaw = await llm.generateOnce(
      [
        { role: 'system', content: ENTITY_EXTRACTION_SYSTEM },
        { role: 'user', content: text },
      ],
      { maxNewTokens: 120, temperature: 0.1 },
    );
    console.log('raw:', JSON.stringify(entRaw));
    console.log('parsed:', JSON.stringify(parsePeople(entRaw)));

    console.log('-- fact extraction --');
    const factRaw = await llm.generateOnce(
      [
        { role: 'system', content: FACT_EXTRACTION_SYSTEM },
        {
          role: 'user',
          content: `USER: ${text}\nASSISTANT: Got it, I will remember.`,
        },
      ],
      { maxNewTokens: 200, temperature: 0.1 },
    );
    console.log('raw:', JSON.stringify(factRaw));
    console.log('parsed:', JSON.stringify(parseFacts(factRaw)));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
