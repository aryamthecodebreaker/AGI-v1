// The MAIN brain — the per-message pipeline.
//
// handleUserMessage is an async generator. Every `yield` is one token-chunk
// to stream to the client. The pipeline:
//
//   1. Insert the user's message into `messages`.
//   2. Embed + persist it as a raw_turn memory (so it's immediately searchable).
//   3. Retrieve relevant context (recent turns + hybrid search + people).
//   4. Build the prompt and stream tokens from the LLM.
//   5. Persist the assembled assistant reply as a message + raw_turn memory.
//   6. Fire-and-forget: extract people + facts from this exchange.
//
// Steps 1-2 are synchronous so that even if the LLM crashes mid-stream, the
// user's message is never lost.

import type { Storage } from '../storage/index.js';
import type { LlmBackend, ChatMessage } from '../llm/types.js';
import { waitUntil } from '@vercel/functions';
import { getLlmBackend } from '../llm/registry.js';
import { embed } from '../llm/embeddings.js';
import { logger } from '../logger.js';
import {
  createAutoCapabilityRecovery,
  parseCapabilityGapMarker,
  type AutoCapabilityRecovery,
} from '../capabilities/autoRecovery.js';
import { assembleContext } from './retrieval.js';
import { buildPrompt } from './contextBuilder.js';
import { resolveDirectMemoryRecall } from './directRecall.js';

export interface HandleUserMessageInput {
  userId: string;
  conversationId: string;
  content: string;
  signal?: AbortSignal;
}

export interface OrchestratorEvent {
  type: 'token' | 'done' | 'error' | 'meta';
  data?: string;
  meta?: Record<string, unknown>;
}

/** Background task handle — exposed for tests that need to flush. */
const backgroundTasks = new Set<Promise<void>>();
const MAX_BACKGROUND_TASKS = 50;

export async function flushBackgroundTasks(): Promise<void> {
  const pending = Array.from(backgroundTasks);
  await Promise.allSettled(pending);
}

function trackBackground(p: Promise<void>): void {
  // A Vercel Function may stop as soon as its response finishes. Register the
  // promise with the platform so post-response extraction remains inside the
  // invocation lifecycle without delaying the streamed chat response.
  if (process.env.VERCEL === '1') {
    try {
      waitUntil(p);
    } catch (err) {
      logger.warn({ err }, 'could not register background task with Vercel');
    }
  }

  // Prune completed tasks before adding new one
  const completed = Array.from(backgroundTasks).filter((t) => {
    const status = (t as Promise<void> & { status?: string }).status;
    return status === 'fulfilled' || status === 'rejected';
  });
  completed.forEach((t) => backgroundTasks.delete(t));
  
  // If too many pending tasks, wait for some to complete
  if (backgroundTasks.size >= MAX_BACKGROUND_TASKS) {
    const toWait = Array.from(backgroundTasks).slice(0, MAX_BACKGROUND_TASKS / 2);
    Promise.allSettled(toWait).then(() => {
      toWait.forEach((t) => backgroundTasks.delete(t));
    });
  }
  
  backgroundTasks.add(p);
  p.finally(() => backgroundTasks.delete(p));
}

export interface Orchestrator {
  handleUserMessage(input: HandleUserMessageInput): AsyncGenerator<OrchestratorEvent>;
}

const CAPABILITY_MARKER_PREFIX = '<capability-gap>';

export function createOrchestrator(
  storage: Storage,
  backend?: LlmBackend,
  recovery?: AutoCapabilityRecovery,
): Orchestrator {
  const llm = backend ?? getLlmBackend();
  const capabilityRecovery = recovery ?? (backend
    ? undefined
    : createAutoCapabilityRecovery(storage, llm));
  const webSearchAvailable = llm.supportsWebSearch === true;

  return {
    async *handleUserMessage(input: HandleUserMessageInput): AsyncGenerator<OrchestratorEvent> {
      const { userId, conversationId, content, signal } = input;
      logger.debug({ userId, conversationId, len: content.length }, 'orchestrator: handle user msg');

      // 1. Persist user message.
      const userMsg = await storage.messages.insert({
        conversationId,
        userId,
        role: 'user',
        content,
      });

      // 2. Embed + persist raw_turn memory (so it's searchable immediately).
      //    This is fire-and-forget at the embedding level: if the embedding
      //    model is still loading we still insert the row with a null
      //    embedding so FTS can find it.
      try {
        const vec = await embed(content);
        await storage.memories.insert({
          userId,
          conversationId,
          sourceMessageId: userMsg.id,
          kind: 'raw_turn',
          content: `USER: ${content}`,
          embedding: vec,
        });
      } catch (err) {
        logger.warn({ err }, 'user message embed failed — inserting without embedding');
        await storage.memories.insert({
          userId,
          conversationId,
          sourceMessageId: userMsg.id,
          kind: 'raw_turn',
          content: `USER: ${content}`,
        });
      }

      // Bump conversation updated_at + title (first-message auto-title).
      await storage.conversations.touch(conversationId);
      const existingTitle = (await storage.conversations.getById(conversationId))?.title;
      if (!existingTitle || existingTitle === 'New chat') {
        const title = content.split('\n')[0]!.slice(0, 60) || 'New chat';
        await storage.conversations.rename(conversationId, title);
      }

      // 3. Retrieve context.
      const ctx = await assembleContext(storage, {
        userId,
        conversationId,
        userMessage: content,
      });
      yield {
        type: 'meta',
        meta: {
          memoriesUsed: ctx.relevantMemories.length,
          peopleInContext: ctx.people.length,
          recentTurns: ctx.recentTurns.length,
        },
      };

      // 4. Build prompt and stream tokens. Direct self-fact recall is resolved
      //    deterministically so a people-card name cannot override a grounded
      //    value already present in long-term memory.
      const prompt: ChatMessage[] = buildPrompt({
        context: ctx,
        userMessage: content,
        webSearchAvailable,
      });

      let assembled = '';
      let held = '';
      let streamMode: 'pending' | 'normal' | 'marker' = 'pending';
      try {
        const directRecall = resolveDirectMemoryRecall(content, ctx.relevantMemories);
        if (directRecall) {
          assembled = directRecall;
          streamMode = 'normal';
          yield { type: 'token', data: directRecall };
        } else {
          await llm.ready();
          for await (const chunk of llm.generate(prompt, {
            maxNewTokens: 384,
            temperature: 0.7,
            signal,
            ...(webSearchAvailable
              ? {
                  webSearch: {
                    maxResults: 3,
                    maxTotalResults: 3,
                    maxCharactersPerResult: 2_500,
                  },
                }
              : {}),
          })) {
            assembled += chunk;
            if (streamMode === 'normal') {
              yield { type: 'token', data: chunk };
              continue;
            }

            held += chunk;
            const candidate = held.trimStart().toLowerCase();
            if (
              candidate.length < CAPABILITY_MARKER_PREFIX.length
              && CAPABILITY_MARKER_PREFIX.startsWith(candidate)
            ) {
              continue;
            }
            if (candidate.startsWith(CAPABILITY_MARKER_PREFIX)) {
              streamMode = 'marker';
              continue;
            }
            streamMode = 'normal';
            yield { type: 'token', data: held };
            held = '';
          }
        }
      } catch (err) {
        logger.error({ err }, 'LLM generation failed');
        yield { type: 'error', data: (err as Error).message };
        return;
      }

      let assistantText = assembled.trim();
      if (!assistantText) {
        const message = 'The model returned an empty response. Please try again.';
        logger.warn({ userId, conversationId }, 'LLM generation returned no text');
        yield { type: 'error', data: message };
        return;
      }

      const markerGap = parseCapabilityGapMarker(assistantText);
      let gap = markerGap;
      if (!gap && capabilityRecovery) {
        gap = await capabilityRecovery.classify(content, assistantText);
      }

      const concealedGapSignal = streamMode === 'marker';
      if (gap && capabilityRecovery) {
        const progress = gap.kind === 'tool'
          ? 'I detected a missing offline capability. I am generating and testing it now.'
          : 'I detected a source-level capability gap. I am mapping and testing an improvement now.';
        const progressText = concealedGapSignal ? progress : `\n\n${progress}`;
        yield {
          type: 'meta',
          meta: { capabilityRecovery: 'started', kind: gap.kind },
        };
        yield { type: 'token', data: progressText };

        let completion: string;
        try {
          const result = await capabilityRecovery.execute(userId, gap);
          completion = `\n\n${result.message}`;
          yield {
            type: 'meta',
            meta: {
              capabilityRecovery: 'completed',
              kind: result.kind,
              requestId: result.requestId,
              prUrl: result.prUrl,
              reused: result.reused,
            },
          };
        } catch (error) {
          logger.error({ err: error, userId, conversationId, kind: gap.kind }, 'automatic capability recovery failed');
          const detail = error instanceof Error ? error.message : 'Unknown error';
          completion = `\n\nI detected the gap, but the automatic improvement could not finish: ${detail.slice(0, 300)}`;
        }
        yield { type: 'token', data: completion };
        assistantText = concealedGapSignal
          ? `${progress}${completion}`.trim()
          : `${assistantText}${progressText}${completion}`.trim();
      } else if (concealedGapSignal) {
        const message = 'I detected a capability gap, but I could not determine a safe automatic improvement. Please try describing the task more specifically.';
        yield { type: 'token', data: message };
        assistantText = message;
      } else if (held) {
        yield { type: 'token', data: held };
      }

      // 5. Persist assistant reply.
      const assistantMsg = await storage.messages.insert({
        conversationId,
        userId,
        role: 'assistant',
        content: assistantText,
      });
      try {
        const vec = await embed(assistantText);
        await storage.memories.insert({
          userId,
          conversationId,
          sourceMessageId: assistantMsg.id,
          kind: 'raw_turn',
          content: `ASSISTANT: ${assistantText}`,
          embedding: vec,
        });
      } catch (err) {
        logger.warn({ err }, 'assistant embed failed');
        await storage.memories.insert({
          userId,
          conversationId,
          sourceMessageId: assistantMsg.id,
          kind: 'raw_turn',
          content: `ASSISTANT: ${assistantText}`,
        });
      }

      // 6. Finalize unified people + facts extraction. One LLM call
      //    instead of two — critical for Gemini's free-tier RPM limits.
      //    Reply text has streamed, but SSE completion waits for durable memory.
      //    waitUntil also protects this task if the client disconnects.
      const extractionTask = (async () => {
          try {
            const { extractAndStoreMemory } = await import('./memoryExtraction.js');
            await extractAndStoreMemory(storage, llm, {
              userId,
              conversationId,
              sourceMessageId: userMsg.id,
              userMessage: content,
              assistantMessage: assistantText,
            });
          } catch (err) {
            logger.warn({ err }, 'memory extraction failed');
          }
        })();
      trackBackground(extractionTask);
      await extractionTask;

      yield { type: 'done' };
    },
  };
}
