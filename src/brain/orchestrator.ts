// The MAIN brain — the per-message pipeline.
//
// handleUserMessage is an async generator. Every `yield` is one token-chunk
// to stream to the client. The pipeline:
//
//   1. Insert the user's message into `messages`.
//   2. Embed + persist it as a raw_turn memory (so it's immediately searchable).
//   2b. If AGI Command is on, see whether this turn is a device request. If it
//       is, the device layer answers from real device state and the LLM reply is
//       skipped entirely.
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
import type { AgiCommand } from '../devices/index.js';
import { handleDeviceTurn } from './deviceTurn.js';

export interface HandleUserMessageInput {
  userId: string;
  conversationId: string;
  content: string;
  signal?: AbortSignal;
  /** The browser session's paired device, so "this device" can resolve. */
  thisDeviceId?: string | null;
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

/**
 * Break text into small chunks on word boundaries so a locally-generated reply
 * streams like an LLM one. Purely cosmetic — the whole string is already known.
 */
function* chunkText(text: string, size = 24): Generator<string> {
  let buffer = '';
  for (const word of text.split(/(\s+)/)) {
    buffer += word;
    if (buffer.length >= size) {
      yield buffer;
      buffer = '';
    }
  }
  if (buffer) yield buffer;
}

export function createOrchestrator(
  storage: Storage,
  backend?: LlmBackend,
  agi?: AgiCommand,
): Orchestrator {
  // Resolved on first use, not at construction. Building the server must not
  // require an LLM API key: the device subsystem never calls the model, and a
  // missing key should surface as a clear error on the first chat turn rather
  // than preventing the process from starting at all.
  let cached: LlmBackend | null = backend ?? null;
  const llm = (): LlmBackend => (cached ??= getLlmBackend());

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

      // 2b. Device turn. Runs before retrieval so a device request never pays
      //     for embedding search it will not use. Any failure here falls through
      //     to ordinary chat rather than breaking the turn.
      if (agi?.enabled) {
        let deviceResult: Awaited<ReturnType<typeof handleDeviceTurn>> = { handled: false };
        try {
          deviceResult = await handleDeviceTurn({
            agi,
            storage,
            llm,
            userId,
            conversationId,
            messageId: userMsg.id,
            content,
            thisDeviceId: input.thisDeviceId ?? null,
          });
        } catch (err) {
          logger.error({ err }, 'device turn failed — falling back to normal chat');
        }

        if (deviceResult.handled && deviceResult.text) {
          yield { type: 'meta', meta: { ...deviceResult.meta, deviceTurn: true } };
          for (const chunk of chunkText(deviceResult.text)) {
            yield { type: 'token', data: chunk };
          }

          const assistantMsg = storage.messages.insert({
            conversationId,
            userId,
            role: 'assistant',
            content: deviceResult.text,
          });
          // Store the exchange so it is searchable, but deliberately skip fact
          // extraction: "Phone Two was offline" and "YouTube opened" are command
          // history, not durable facts about the user. Command history lives in
          // device_commands / device_executions where it can go stale safely.
          try {
            const vec = await embed(deviceResult.text);
            storage.memories.insert({
              userId,
              conversationId,
              sourceMessageId: assistantMsg.id,
              kind: 'raw_turn',
              content: `ASSISTANT: ${deviceResult.text}`,
              embedding: vec,
            });
          } catch (err) {
            logger.warn({ err }, 'device reply embed failed');
            storage.memories.insert({
              userId,
              conversationId,
              sourceMessageId: assistantMsg.id,
              kind: 'raw_turn',
              content: `ASSISTANT: ${deviceResult.text}`,
            });
          }

          yield { type: 'done' };
          return;
        }
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
        const backendInstance = llm();
        await backendInstance.ready();
        for await (const chunk of backendInstance.generate(prompt, { maxNewTokens: 384, temperature: 0.7, signal })) {
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

      // 6. Fire-and-forget: unified people + facts extraction. One LLM call
      //    instead of two — critical for Gemini's free-tier RPM limits.
      //    Runs off the hot path so streaming latency isn't affected.
      trackBackground(
        (async () => {
          try {
            const { extractAndStoreMemory } = await import('./memoryExtraction.js');
            await extractAndStoreMemory(storage, llm(), {
              userId,
              conversationId,
              sourceMessageId: userMsg.id,
              userMessage: content,
              assistantMessage: assistantText,
            });
          } catch (err) {
            logger.warn({ err }, 'memory extraction failed');
          }
        })(),
      );

      yield { type: 'done' };
    },
  };
}
