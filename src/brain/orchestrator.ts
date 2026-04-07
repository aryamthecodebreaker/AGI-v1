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
import { getLlmBackend } from '../llm/registry.js';
import { embed } from '../llm/embeddings.js';
import { logger } from '../logger.js';
import { assembleContext } from './retrieval.js';
import { buildPrompt } from './contextBuilder.js';

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

/** Background task handles — exposed for tests that need to flush. */
const backgroundTasks = new Set<Promise<void>>();
export async function flushBackgroundTasks(): Promise<void> {
  const pending = Array.from(backgroundTasks);
  await Promise.allSettled(pending);
}
function trackBackground(p: Promise<void>): void {
  backgroundTasks.add(p);
  p.finally(() => backgroundTasks.delete(p));
}

export interface Orchestrator {
  handleUserMessage(input: HandleUserMessageInput): AsyncGenerator<OrchestratorEvent>;
}

export function createOrchestrator(storage: Storage, backend?: LlmBackend): Orchestrator {
  const llm = backend ?? getLlmBackend();

  return {
    async *handleUserMessage(input: HandleUserMessageInput): AsyncGenerator<OrchestratorEvent> {
      const { userId, conversationId, content, signal } = input;
      logger.debug({ userId, conversationId, len: content.length }, 'orchestrator: handle user msg');

      // 1. Persist user message.
      const userMsg = storage.messages.insert({
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
        storage.memories.insert({
          userId,
          conversationId,
          sourceMessageId: userMsg.id,
          kind: 'raw_turn',
          content: `USER: ${content}`,
          embedding: vec,
        });
      } catch (err) {
        logger.warn({ err }, 'user message embed failed — inserting without embedding');
        storage.memories.insert({
          userId,
          conversationId,
          sourceMessageId: userMsg.id,
          kind: 'raw_turn',
          content: `USER: ${content}`,
        });
      }

      // Bump conversation updated_at + title (first-message auto-title).
      storage.conversations.touch(conversationId);
      const existingTitle = storage.conversations.getById(conversationId)?.title;
      if (!existingTitle || existingTitle === 'New chat') {
        const title = content.split('\n')[0]!.slice(0, 60) || 'New chat';
        storage.conversations.rename(conversationId, title);
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

      // 4. Build prompt and stream tokens.
      const prompt: ChatMessage[] = buildPrompt({ context: ctx, userMessage: content });

      let assembled = '';
      try {
        await llm.ready();
        for await (const chunk of llm.generate(prompt, { maxNewTokens: 384, temperature: 0.7, signal })) {
          assembled += chunk;
          yield { type: 'token', data: chunk };
        }
      } catch (err) {
        logger.error({ err }, 'LLM generation failed');
        yield { type: 'error', data: (err as Error).message };
        return;
      }

      const assistantText = assembled.trim() || '(no response)';

      // 5. Persist assistant reply.
      const assistantMsg = storage.messages.insert({
        conversationId,
        userId,
        role: 'assistant',
        content: assistantText,
      });
      try {
        const vec = await embed(assistantText);
        storage.memories.insert({
          userId,
          conversationId,
          sourceMessageId: assistantMsg.id,
          kind: 'raw_turn',
          content: `ASSISTANT: ${assistantText}`,
          embedding: vec,
        });
      } catch (err) {
        logger.warn({ err }, 'assistant embed failed');
        storage.memories.insert({
          userId,
          conversationId,
          sourceMessageId: assistantMsg.id,
          kind: 'raw_turn',
          content: `ASSISTANT: ${assistantText}`,
        });
      }

      // 6. Fire-and-forget: entity + fact extraction. These run off the hot
      //    path so streaming latency isn't affected. Errors are logged but
      //    never surface to the user.
      trackBackground(
        (async () => {
          try {
            const { extractAndStorePeople } = await import('./entityExtraction.js');
            await extractAndStorePeople(storage, llm, {
              userId,
              conversationId,
              sourceMessageId: userMsg.id,
              text: content,
            });
          } catch (err) {
            logger.warn({ err }, 'entity extraction failed');
          }
        })(),
      );
      trackBackground(
        (async () => {
          try {
            const { extractAndStoreFacts } = await import('./factExtraction.js');
            await extractAndStoreFacts(storage, llm, {
              userId,
              conversationId,
              userMessage: content,
              assistantMessage: assistantText,
              sourceMessageId: userMsg.id,
            });
          } catch (err) {
            logger.warn({ err }, 'fact extraction failed');
          }
        })(),
      );

      yield { type: 'done' };
    },
  };
}
