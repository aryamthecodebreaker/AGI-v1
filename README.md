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

## Example usage

```bash
# Run the word-count tool
curl -X POST http://localhost:3000/run-tool/word-count -H 'Content-Type: application/json' -d '{\"text\":\"Hello world! This is a test.\"}'
```

The tool returns the number of words, e.g. `7`.

The hosted app uses OpenRouter with an ordered list of explicit text-instruction models for chat generation and Neon Postgres for shared storage. Pinning conversational models avoids `openrouter/free` randomly selecting a specialist model, such as a content-safety classifier. If the primary free provider is retired, rate-limited, or unavailable before any reply token arrives, the backend tries the next configured conversational model. Local development falls back to SQLite when `DATABASE_URL` is absent. This split matters: SQLite is suitable for one local process, while Postgres keeps auth and chat state consistent across separate Vercel function instances.

The project is not general-purpose AGI. It is an experimental persistent-memory chatbot with owner-only, human-reviewed capability and source-improvement workflows.

## Features

- Cross-conversation memory with recent-turn, keyword, and embedding retrieval.
- Grounded people and fact extraction in a background LLM pass.
- Per-user conversations and memories with bcrypt password hashes and an HTTP-only JWT cookie.
- Server-Sent Events (SSE) chat streaming.
- A small framework-free web UI for conversations, people, and memories.
- SQLite + FTS5 for local development and tests.
- Neon Postgres + Postgres full-text search for shared hosted state.
- Explicit, owner-only `/build-tool` and `/run-tool` commands for sandboxed capability development.
- An owner-only `/improve-self` command that uses FixMap, validates a proposed source patch offline, and opens a draft PR.

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
  ├─ streams an OpenRouter, Gemini, or local-model response
  └─ extracts grounded facts and people in the background
        │
        ├─ local: SQLite + FTS5
        └─ hosted: Neon Postgres + tsvector search
```

Memory ranking uses Reciprocal Rank Fusion to combine keyword and cosine-similarity result lists. Embeddings are stored as SQLite blobs locally and JSON arrays in Postgres; vector similarity is calculated in application code over a bounded recent-memory scan.

## Safe capability building

Capability building is disabled unless an owner explicitly configures it. It does not let the running app rewrite or merge `main`.

1. An allowlisted owner sends `/build-tool <task>`.
2. The LLM proposes one dependency-free Node.js tool, tests, and sample input as strict JSON.
3. Static validation rejects environment, process, filesystem, network, child-process, worker, dynamic-import, and dynamic-code access.
4. Vercel Sandbox runs syntax checks, `node:test`, and one sample execution in a fresh non-persistent microVM with network policy `deny-all` and no credentials.
5. A GitHub App scoped only to this repository opens a new branch and draft pull request.
6. A human reviews the PR and the protected-branch checks. The app has no merge endpoint.
7. After the PR is merged to `main`, `/run-tool <slug> <json-input>` fetches that merged tool and executes it in another network-denied sandbox.

Generated tools intentionally cannot access the network, files, production secrets, or arbitrary subprocesses. That limits what they can do, but keeps unreviewed code away from the application process and credentials.

## Safe source improvement

`/improve-self <goal>` lets an allowlisted owner ask AGI-v1 to propose a focused change to its own brain, chat routes, LLM adapters, utilities, browser UI, scripts, tests, or README.

1. A fresh Vercel Sandbox clones the public `main` branch and installs its already-reviewed dependencies without receiving application or GitHub credentials.
2. Sandbox egress is switched to `deny-all`.
3. FixMap 0.3.1 ranks the repository files and test route relevant to the goal.
4. The LLM receives that bounded context and returns strict JSON containing exact, unique text replacements for existing files or complete contents for new files. AGI-v1 materializes the proposal and generates the Git diff itself, avoiding model-invented line numbers and malformed patch headers. Static rules block dependency, auth, storage-migration, command-router/server, publishing, sandbox, and self-improvement-guardrail changes.
5. Executable proposals must include regression tests. Git validates the generated diff, then the sandbox runs `npm test` and `npm run build` without network access.
6. One failed proposal may be regenerated from the validation output. Only a passing proposal is published by the repository-scoped GitHub App as a draft PR.

The running app cannot push to `main`, merge a PR, edit its safeguards, access production secrets from generated code, or continuously modify itself without an explicit owner request and human review.

## Tech stack

| Layer | Current choice |
|---|---|
| Runtime | Node.js 24 and TypeScript ESM |
| HTTP | Fastify 5 |
| Hosted storage | Neon Postgres through `@neondatabase/serverless` |
| Local/test storage | `better-sqlite3` with FTS5 |
| Embeddings | `Xenova/all-MiniLM-L6-v2` through `@huggingface/transformers` |
| Hosted LLM | OpenRouter API with ordered conversational free-model fallbacks |
| Other LLM option | Google Gemini REST API |
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
```

or:

```dotenv
LLM_BACKEND=gemini
LLM_MODEL_ID=gemini-2.5-flash
GEMINI_API_KEY=your_server_side_key
```

If `DATABASE_URL` is empty, the app creates a local SQLite database under `DATA_DIR`. Never expose either LLM key to browser code.

Open [localhost:3000](http://localhost:3000), register an account, and create a conversation.

## Deploy to Vercel

The repository includes `vercel.json`. The deployed project needs:

- `JWT_SECRET` with at least 32 random characters.
- `OPENROUTER_API_KEY` for the checked-in Vercel OpenRouter configuration.
- A Neon integration that provides `DATABASE_URL`.

Without `DATABASE_URL`, Vercel falls back to a SQLite file under `/tmp`. That storage is per-instance and ephemeral, so signup may appear to work and a later authenticated request may return HTTP 401 from another instance. Use shared Postgres for any multi-instance deployment.

## Configure capability building

Keep the feature disabled until all fields are ready:

```dotenv
CAPABILITY_BUILDER_ENABLED=false
CAPABILITY_ADMIN_USER_IDS=u_your_registered_user_id
GITHUB_APP_ID=
GITHUB_APP_INSTALLATION_ID=
GITHUB_APP_PRIVATE_KEY=
```

The GitHub App must be installed only on `aryamthecodebreaker/AGI-v1` with:

- Repository metadata: read (automatic).
- Contents: read and write.
- Pull requests: read and write.
- No administration, secrets, Actions, or workflows permission.

Vercel supplies Sandbox authentication through project OIDC in production. Once the GitHub App values and owner user ID are configured, set `CAPABILITY_BUILDER_ENABLED=true`.

## Tests

```bash
npm test
npm run build
```

The default suite uses isolated SQLite databases and does not require cloud credentials. Optional live checks are gated:

```bash
RUN_POSTGRES_INTEGRATION=1 npx vitest run tests/postgres.integration.test.ts
RUN_SANDBOX_INTEGRATION=1 npx vitest run tests/sandbox.integration.test.ts
```

The integration tests create temporary data and remove it after the run. `.env.local` is ignored by Git and may be populated by `vercel env pull`.

## Known limitations

- Every configured OpenRouter free-model variant can still be rate-limited at the same time. Fallback occurs only before any output is emitted, preventing a response from switching models midway through a sentence.
- The local embedding model can add cold-start time and memory usage.
- Postgres vector search currently performs a bounded application-side scan instead of using `pgvector`.
- Generated capabilities are deliberately limited to dependency-free, offline computation.
- Capability PRs still require human review and protected-branch checks.
- Source self-improvements are bounded patch proposals, not an autonomous merge or deployment loop.
- `LLM_BACKEND=scratch` is a placeholder; a scratch backend is not implemented.

## License

MIT — see [LICENSE](./LICENSE).
