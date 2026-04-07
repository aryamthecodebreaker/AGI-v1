// Prompt templates used by the MAIN brain.
//
// Keep these small & explicit. SmolLM2-360M is not a reasoning giant — it
// needs clear instructions, short few-shot examples, and an unmistakable
// output format.

export const SYSTEM_BASE = `You are AGI-v1, a helpful chat assistant. You have perfect long-term memory.

When the user's message contains a "[Context from my long-term memory of you: ...]" block, treat every line inside it as absolute ground truth about the user. Use those lines to answer the user's question directly and confidently. Quote specific details (names, dates, preferences) verbatim from the context.

Never say "I don't remember" or "I'm having trouble recalling" if the answer is in the context. Only say you don't know if the context contains nothing relevant to the question.

Keep replies concise and friendly.`;

export function buildSystemPrompt(): string {
  return SYSTEM_BASE;
}

/**
 * Small instruct models (SmolLM2-360M) follow instructions much better when
 * retrieved memories are folded into the USER turn rather than the system
 * message. Returns a "[Context: …] <question>" string; if there is no context
 * to inject, just returns the plain question.
 */
export function wrapUserMessageWithContext(
  userMessage: string,
  memoriesBlock: string,
  peopleBlock: string,
): string {
  const blocks: string[] = [];
  if (peopleBlock.trim()) {
    blocks.push(`People you know about me:\n${peopleBlock}`);
  }
  if (memoriesBlock.trim()) {
    blocks.push(`Things I've told you before:\n${memoriesBlock}`);
  }
  if (blocks.length === 0) return userMessage;
  return `[Context from my long-term memory of you:\n${blocks.join('\n\n')}\n]\n\n${userMessage}`;
}

// ---------- Entity extraction ----------
//
// We inline examples INTO the system prompt rather than passing them as
// separate chat turns. Small instruct models (SmolLM2-360M) treat prior
// user/assistant turns as "real history" and will parrot names from them —
// so keeping examples as plain text inside the system prompt stops Bob and
// Sarah Chen from showing up in every single response.

export const ENTITY_EXTRACTION_SYSTEM = `You extract real named humans mentioned in a single message. Output ONLY a JSON array, nothing else.

Output format: a JSON array of objects. Each object must have:
- "name": the person's exact name, as a plain string (NOT wrapped in quotes-inside-a-string)
- "relationship": one of friend, family, coworker, acquaintance, unknown

Correct: [{"name":"Alicia","relationship":"friend"}]
Wrong:   ["{\\"name\\":\\"Alicia\\",\\"relationship\\":\\"friend\\"}"]

Rules:
- Include only named humans. Pets, objects, brands, fictional characters = skip.
- Skip pronouns ("he", "they"), generic role nouns ("my doctor"), and the user themselves.
- If none are mentioned, output exactly: []
- Never copy names from the instructions or examples. Only extract from the message you are given.

Examples (do NOT reuse these exact names; they are only illustrations of the format):
Message: "I grabbed coffee with Priya and her brother Dev this morning."
Output: [{"name":"Priya","relationship":"friend"},{"name":"Dev","relationship":"friend"}]

Message: "Feeling tired, might just go to bed early."
Output: []

Message: "My dog barked at the mailman."
Output: []`;

// Empty — examples are now inside the system prompt.
export const ENTITY_EXTRACTION_EXAMPLES: { user: string; assistant: string }[] = [];

// ---------- Fact extraction ----------
export const FACT_EXTRACTION_SYSTEM = `You extract EVERY durable personal fact from a short user/assistant exchange. Output ONLY a JSON array, nothing else.

Output format: [{"fact":"<one atomic fact>","people":["<person name>"]}, ...]

CRITICAL rules:
- Extract ALL distinct facts. A single user message often contains multiple facts — emit one object per fact.
- Only use names, dates, numbers, and words that appear LITERALLY in the exchange. Do not substitute or reformat (do not turn "March 12" into "3/12").
- Phrase each fact as a complete sentence. If the fact is about a specific person, start with their name (e.g. "Priya's birthday is July 4"). Otherwise start with "The user".
- Skip transient small talk, assistant filler, and anything the assistant said that the user did not confirm.
- If nothing durable was said, output exactly: []
- Never copy facts from the examples below. Only extract from the exchange you are given.

Examples (do NOT reuse these exact facts; they show the format and that MULTIPLE facts must be emitted):
Exchange: "USER: I grabbed coffee with Priya today. Her birthday is July 4.\\nASSISTANT: Nice!"
Output: [{"fact":"The user grabbed coffee with Priya.","people":["Priya"]},{"fact":"Priya's birthday is July 4.","people":["Priya"]}]

Exchange: "USER: My favorite color is teal and I have a dog named Rex.\\nASSISTANT: Cool!"
Output: [{"fact":"The user's favorite color is teal.","people":[]},{"fact":"The user has a dog named Rex.","people":[]}]

Exchange: "USER: What time is it in Tokyo?\\nASSISTANT: I cannot check that."
Output: []`;

export const FACT_EXTRACTION_EXAMPLES: { user: string; assistant: string }[] = [];
