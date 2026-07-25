// Live smoke for AGI-v1's provider-independent search tool plus Gemini answer.
// Requires GEMINI_API_KEY in the environment. No search-provider key is used.

import { getGeminiBackend } from '../src/llm/geminiBackend.js';

const query = process.argv.slice(2).join(' ').trim()
  || 'Search for the current stable Node.js release and cite the official source.';

const backend = getGeminiBackend();
let response = '';
for await (const chunk of backend.generate(
  [
    { role: 'system', content: 'Answer from retrieved web evidence and cite supporting links.' },
    { role: 'user', content: query },
  ],
  {
    maxNewTokens: 384,
    temperature: 0.2,
    webSearch: {
      maxResults: 3,
      maxTotalResults: 3,
      maxCharactersPerResult: 2_500,
    },
  },
)) {
  response += chunk;
}

if (!response.trim()) throw new Error('Web-search smoke returned no text');
console.log(response.trim());
