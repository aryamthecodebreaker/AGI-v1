// Shared LLM types. Both the transformers.js backend and the from-scratch
// backend implement this interface, so the MAIN brain is backend-agnostic.

export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface GenOpts {
  maxNewTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  repetitionPenalty?: number;
  /** Require a JSON object response for schema-validated background tasks. */
  jsonObject?: boolean;
  /** Let the hosted model decide when current web information is required. */
  webSearch?: {
    maxResults: number;
    maxTotalResults: number;
    maxCharactersPerResult: number;
  };
  /** Abort signal — propagate from HTTP client disconnect. */
  signal?: AbortSignal;
}

export interface LlmBackend {
  /** Identifier for logs, e.g. 'transformers:SmolLM2-360M-Instruct'. */
  readonly name: string;

  /** True only when this backend can use a model-controlled web-search tool. */
  readonly supportsWebSearch?: boolean;

  /** Ensure the model is loaded. Safe to call repeatedly. */
  ready(): Promise<void>;

  /** Stream tokens as they are generated. */
  generate(messages: ChatMessage[], opts?: GenOpts): AsyncIterable<string>;

  /** Non-streaming convenience for single-shot extraction tasks. */
  generateOnce(messages: ChatMessage[], opts?: GenOpts): Promise<string>;
}
