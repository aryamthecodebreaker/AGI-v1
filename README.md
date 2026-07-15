---
title: AGI v1
emoji: 🧠
colorFrom: purple
colorTo: blue
sdk: docker
app_port: 7860
pinned: false
license: mit
short_description: A multi-user chatbot with cross-conversation memory
---

# AGI-v1

AGI-v1 is a multi-user chatbot that stores messages, extracts grounded facts and people, and retrieves relevant context across conversations.

> Live Vercel deployment: [agi-v1-five.vercel.app](https://agi-v1-five.vercel.app)
>
> Source: [github.com/aryamthecodebreaker/AGI-v1](https://github.com/aryamthecodebreaker/AGI-v1)

## Current status

The hosted app uses Google's `gemini-3-flash-preview` model through the Gemini REST API and Neon Postgres for shared storage. AGI-v1 supplies its own server-side public-search and safe direct-URL inspection tool, so web answers do not depend on Gemini grounding or an OpenRouter search quota. Gemini 3 runs with minimal thinking by default so bounded chat and JSON tasks return complete visible output. The Gemini API key stays in Vercel's encrypted server-side environment and is never sent to the browser. OpenRouter remains available as an optional backend. Local development falls back to SQLite when `DATABASE_URL` is absent.

The project is not general-purpose AGI. It is an experimental persistent-memory chatbot with authenticated, human-reviewed capability and source-improvement workflows.

## Features

- Cross-conversation memory with recent-turn, keyword, and embedding retrieval.
- Grounded people and fact extraction in a background LLM pass.
- Per-user conversations and memories with bcrypt password hashes and an HTTP-only JWT cookie.
- Server-Sent Events (SSE) chat streaming.
- A small framework-free web UI for conversations, people, and memories.
- SQLite + FTS5 for local development and tests.
- Neon Postgres + Postgres full-text search for shared hosted state.
- Automatic provider-independent web search and safe direct-URL inspection for requests that need current or online information, capped at three sources per turn.
- Automatic capability-gap recovery: a missing safe ability starts a sandboxed tool build or FixMap-guided source-improvement draft without requiring a slash command.
- Explicit, authenticated `/build-tool` and `/run-tool` commands for sandboxed capability development. Example: `/run-tool word-count {"text":"one two three"}`.
- An authenticated `/improve-self` command that uses FixMap, validates a structured source proposal offline, and opens a draft PR.

## Architecture

```text
browser
  ├─ auth / conversations / memories
  └─ SSE chat
        │
        ▼
Fastify orchestrator
  ├─ persists messages before LLM generation
  ├─ retrieves recent turns + hybrid memory + people
  ├─ detects web intent and retrieves bounded public evidence or a safe direct URL
  ├─ detects capability gaps and starts safe recovery
  ├─ streams an OpenRouter, Gemini, or local-model response
  └─ extracts grounded facts and people through Vercel-aware background work
        │
        ├─ local: SQLite + FTS5
        └─ hosted: Neon Postgres + tsvector search
```

Memory ranking uses Reciprocal Rank Fusion to combine keyword and cosine-similarity result lists. Embeddings are stored as SQLite blobs locally and JSON arrays in Postgres; vector similarity is calculated in application code over a bounded recent-memory scan.

## Safe capability building

Capability building is disabled unless the deployment explicitly enables and configures it. It does not let the running app rewrite or merge `main`.

1. A signed-in user sends `/build-tool <task>`, or normal chat detects that a safe request needs a missing offline tool.
2. The LLM proposes one dependency-free Node.js tool, tests, and sample input as strict JSON.
3. Static validation rejects environment, process, filesystem, network, child-process, worker, dynamic-import, and dynamic-code access.
4. Vercel Sandbox runs syntax checks, `node:test`, and one sample execution in a fresh non-persistent microVM with network policy `deny-all` and no credentials.
5. A GitHub App scoped only to this repository opens a new branch and draft pull request.
6. A human reviews the PR and the protected-branch checks. The app has no merge endpoint.
7. After the PR is merged to `main`, `/run-tool <slug> <json-input>` fetches that merged tool and executes it in another network-denied sandbox.

Generated tools intentionally cannot access the network, files, production secrets, or arbitrary subprocesses. That limits what they can do, but keeps unreviewed code away from the application process and credentials.

Each user may have one active capability request at a time and may start at most two capability or source-improvement requests per hour. Merged tools remain available to all signed-in users and still run inside the same isolated sandbox.

## Safe source improvement

`/improve-self <goal>` lets a signed-in user ask AGI-v1 to propose a focused change to its own brain, chat routes, LLM adapters, utilities, browser UI, scripts, tests, or README. Normal chat can start the same workflow automatically when the model emits a source-level capability-gap signal.

1. A fresh Vercel Sandbox clones the public `main` branch and installs its already-reviewed dependencies without receiving application or GitHub credentials.
2. Sandbox egress is switched to `deny-all`.
3. FixMap 0.3.1 ranks the repository files and test route relevant to the goal.
4. The LLM receives that bounded context and returns strict JSON containing exact, unique text replacements for existing files or complete contents for new files. AGI-v1 materializes the proposal and generates the Git diff itself, avoiding model-invented line numbers and malformed patch headers. Static rules block dependency, auth, storage-migration, command-router/server, publishing, sandbox, and self-improvement-guardrail changes.
5. Executable proposals must include regression tests. Git validates the generated diff, then the sandbox runs `npm test` and `npm run build` without network access.
6. One failed proposal may be regenerated from the validation output. Only a passing proposal is published by the repository-scoped GitHub App as a draft PR.

The running app cannot push to `main`, merge a PR, edit its safeguards, access production secrets from generated code, or continuously modify itself without a signed-in user's request and human review.

Reply text streams before hosted fact and people extraction runs, but AGI-v1 does not send the final SSE completion marker until durable memory work finishes. The same task is registered with Vercel's `waitUntil()` API so it can continue if the client disconnects during finalization. The unified extraction call requires JSON-object output so the free task fallback is limited to structured-output-capable models before AGI-v1 applies its own grounding checks.

## Tech stack

| Layer | Current choice |
|---|---|
| Runtime | Node.js 24 and TypeScript ESM |
| HTTP | Fastify 5 |
| Hosted storage | Neon Postgres through `@neondatabase/serverless` |
| Local/test storage | `better-sqlite3` with FTS5 |
| Embeddings | `Xenova/all-MiniLM-L6-v2` through `@huggingface/transformers` |
| Hosted LLM | Google Gemini REST API with `gemini-3-flash-preview` |
| Other LLM option | OpenRouter API with ordered conversational fallbacks and the `openrouter:web_search` server tool |
| Web evidence | AGI-v1 public-search adapters plus DNS-checked direct-URL inspection |
| Generated-code isolation | Vercel Sandbox |
| Repository context map | FixMap 0.3.1 |
| Frontend | Vanilla HTML, CSS, and JavaScript |
| Tests | Vitest plus gated Neon and Sandbox integration tests |

## Run locally

Prerequisites:

- Node.js 24.
- An OpenRouter API key or Gemini API key for hosted generation.

```bash
git clone https://github.com/aryamthecodebreaker/AGI-v1.git
cd AGI-v1
npm install
cp .env.example .env
npm run dev
```

Set one of these combinations in `.env`:

```dotenv
LLM_BACKEND=openrouter
LLM_MODEL_ID=qwen/qwen3-next-80b-a3b-instruct:free
OPENROUTER_API_KEY=your_server_side_key
OPENROUTER_FALLBACK_MODEL_IDS=meta-llama/llama-3.3-70b-instruct:free,google/gemma-4-31b-it:free
OPENROUTER_TASK_FALLBACK_MODEL_ID=openrouter/free
OPENROUTER_WEB_SEARCH_MODEL_ID=openrouter/free
```

or:

```dotenv
LLM_BACKEND=gemini
LLM_MODEL_ID=gemini-3-flash-preview
GEMINI_API_KEY=your_server_side_key
GEMINI_WEB_SEARCH_ENABLED=true
GEMINI_THINKING_LEVEL=minimal
```

If `DATABASE_URL` is empty, the app creates a local SQLite database under `DATA_DIR`. Never expose either LLM key to browser code.

Open [localhost:3000](http://localhost:3000), register an account, and create a conversation.

## Deploy to Vercel

The repository includes `vercel.json`. The deployed project needs:

- `JWT_SECRET` with at least 32 random characters.
- `GEMINI_API_KEY` for the checked-in Vercel Gemini configuration.
- The checked-in model is `gemini-3-flash-preview`; preview model identifiers and availability can change.
- Optional `GEMINI_WEB_SEARCH_ENABLED=false` to disable AGI-v1's server-side search and URL-inspection tool.
- Optional `GEMINI_THINKING_LEVEL=minimal|low|medium|high`; `minimal` is the production default so small output budgets are not consumed by hidden reasoning.
- If switching back to OpenRouter, set `OPENROUTER_API_KEY`. Optional `OPENROUTER_WEB_SEARCH_ENABLED`, `OPENROUTER_WEB_SEARCH_MODEL_ID`, and `OPENROUTER_TASK_FALLBACK_MODEL_ID` settings apply only to that backend.
- A Neon integration that provides `DATABASE_URL`.

Without `DATABASE_URL`, Vercel falls back to a SQLite file under `/tmp`. That storage is per-instance and ephemeral, so signup may appear to work and a later authenticated request may return HTTP 401 from another instance. Use shared Postgres for any multi-instance deployment.

## Configure capability building

Keep the feature disabled until all fields are ready:

```dotenv
CAPABILITY_BUILDER_ENABLED=false
GITHUB_APP_ID=
GITHUB_APP_INSTALLATION_ID=
GITHUB_APP_PRIVATE_KEY=
```

The GitHub App must be installed only on `aryamthecodebreaker/AGI-v1` with:

- Repository metadata: read (automatic).
- Contents: read and write.
- Pull requests: read and write.
- No administration, secrets, Actions, or workflows permission.

Vercel supplies Sandbox authentication through project OIDC in production. Once the GitHub App values are configured, set `CAPABILITY_BUILDER_ENABLED=true` to make explicit commands and automatic capability recovery available to signed-in users.

## Tests

```bash
npm test
npm run build
npm run smoke:web-search -- "search for example.com"
```

The default suite uses isolated SQLite databases and does not require cloud credentials. Optional live checks are gated:

```bash
RUN_POSTGRES_INTEGRATION=1 npx vitest run tests/postgres.integration.test.ts
RUN_SANDBOX_INTEGRATION=1 npx vitest run tests/sandbox.integration.test.ts
```

The integration tests create temporary data and remove it after the run. `.env.local` is ignored by Git and may be populated by `vercel env pull`.

## Known limitations

- `gemini-3-flash-preview` is a preview model, so its identifier, limits, and behavior can change.
- The no-key public search adapters are best-effort and can be throttled or change markup. AGI-v1 falls back between providers and never invents a successful search when none returned evidence.
- Direct-URL inspection accepts only public HTTP(S) hosts on standard ports, checks DNS for private addresses, follows at most three validated redirects, and reads a bounded text response. It does not execute page JavaScript.
- Every configured OpenRouter fallback can still be rate-limited at the same time when that optional backend is active. Fallback occurs only before any output is emitted, preventing a response from switching models midway through a sentence.
- Tool-enabled web replies are returned after the bounded search completes instead of token-by-token so URL citation annotations can be retained as clickable source links.
- The local embedding model can add cold-start time and memory usage.
- Postgres vector search currently performs a bounded application-side scan instead of using `pgvector`.
- Generated capabilities are deliberately limited to dependency-free, offline computation.
- Capability PRs still require human review and protected-branch checks.
- Automatic source self-improvements are bounded patch proposals, not an autonomous merge or deployment loop.
- `LLM_BACKEND=scratch` is a placeholder; a scratch backend is not implemented.

## License

MIT — see [LICENSE](./LICENSE).
