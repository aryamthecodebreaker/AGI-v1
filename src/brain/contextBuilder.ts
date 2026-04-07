// Turns an AssembledContext + a new user message into the ChatMessage[] we
// feed to the LLM. The goal is to be explicit and terse: SmolLM2-360M has a
// small context and weak reasoning, so every token spent on preamble is a
// token not spent on the answer.

import type { ChatMessage } from '../llm/types.js';
import { buildSystemPrompt, wrapUserMessageWithContext } from '../llm/prompts.js';
import type { AssembledContext } from './retrieval.js';

export interface BuildPromptInput {
  context: AssembledContext;
  userMessage: string;
}

const MEMORY_MAX_CHARS = 2500;
const PEOPLE_MAX_CHARS = 500;

function formatMemories(
  memories: AssembledContext['relevantMemories'],
  currentUserMessage: string,
): string {
  if (memories.length === 0) return '';
  const lines: string[] = [];
  let used = 0;
  const currentNormalized = currentUserMessage.trim().toLowerCase();
  for (const m of memories) {
    // Drop assistant raw turns — feeding the bot its own past replies as
    // "memory" causes confusion loops. Short-term history already carries
    // recent assistant turns.
    if (/^ASSISTANT:\s*/.test(m.content)) continue;

    // Drop the literal current question if it happens to have matched (it
    // was just stored as a raw_turn a moment ago).
    let content = m.content.replace(/^USER:\s*/, '').trim();
    if (content.toLowerCase() === currentNormalized) continue;

    const line = `- ${content}`;
    if (used + line.length > MEMORY_MAX_CHARS) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join('\n');
}

function formatPeople(people: AssembledContext['people']): string {
  if (people.length === 0) return '';
  const lines: string[] = [];
  let used = 0;
  for (const p of people) {
    const rel = p.relationship ? ` (${p.relationship})` : '';
    const summary = p.summary ? ` — ${p.summary}` : '';
    const line = `- ${p.displayName}${rel}${summary}`;
    if (used + line.length > PEOPLE_MAX_CHARS) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join('\n');
}

export function buildPrompt(input: BuildPromptInput): ChatMessage[] {
  const memoriesBlock = formatMemories(input.context.relevantMemories, input.userMessage);
  const peopleBlock = formatPeople(input.context.people);

  const messages: ChatMessage[] = [{ role: 'system', content: buildSystemPrompt() }];

  // Recent turns in chronological order (skip system; skip the very last user
  // turn because we'll re-send it below wrapped with retrieved context).
  const recent = input.context.recentTurns.filter((t) => t.role !== 'system');
  const lastIsCurrent =
    recent.length > 0 &&
    recent[recent.length - 1]!.role === 'user' &&
    recent[recent.length - 1]!.content === input.userMessage;
  const trimmed = lastIsCurrent ? recent.slice(0, -1) : recent;

  for (const turn of trimmed) {
    messages.push({ role: turn.role, content: turn.content });
  }

  // Inject retrieved context into the current user turn. This works much
  // better with small models than relying on the system prompt to carry it.
  messages.push({
    role: 'user',
    content: wrapUserMessageWithContext(input.userMessage, memoriesBlock, peopleBlock),
  });

  return messages;
}
