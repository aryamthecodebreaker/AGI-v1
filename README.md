---
title: AGI v1
emoji: 🧠
colorFrom: purple
colorTo: blue
sdk: docker
app_port: 7860
pinned: false
license: mit
short_description: A chatbot that never forgets — dual-brain persistent memory
---

# AGI-v1

A chatbot that **never forgets**. Every message from every chat is stored, indexed, and retrieved on demand — so the bot remembers names, dates, preferences, and context across conversations forever.

> **Live demo:** https://aryam123-agi-v1.hf.space
>
> Source: [github.com/aryamthecodebreaker/AGI-v1](https://github.com/aryamthecodebreaker/AGI-v1)

---

## What it is

A persistent-memory chatbot built from scratch with a **dual-brain architecture**:

- **STORAGE brain** — SQLite + FTS5 full-text search + Float32 vector embeddings. Every turn is stored twice: once as a raw conversational memory, and again as extracted structured facts / people.
- **MAIN brain** — an orchestrator that on every user turn runs a hybrid search (BM25 ⊕ cosine similarity via Reciprocal Rank Fusion), pulls the most relevant memories from anywhere in the user's history, and injects them into the LLM prompt.

The LLM itself is pluggable: a Google **Gemini** backend (default, works on any host), a local **@huggingface/transformers** backend (SmolLM2/Qwen, runs fully offline), and a from-scratch transformer backend (in progress — will train on accumulated conversations).

## Features

- 🧠 **Perfect recall across conversations.** Tell it something in one chat, ask about it in another — it remembers.
- 👥 **People tracker.** Mention a friend, family member, or coworker and the bot builds a dossier: relationship, first/last seen, all linked facts and memories.
- 📝 **Automatic fact extraction.** Background LLM pass pulls durable facts out of each exchange, with grounding guards to block hallucination.
- 🔍 **Hybrid search.** FTS5 BM25 + embedding cosine similarity combined via RRF — finds memories by meaning *and* exact keywords.
- 🔐 **Per-user auth.** Cookie-session JWT, bcrypt-hashed passwords, per-user conversations and memories.
- 📡 **Streaming chat.** Server-Sent Events stream tokens from the LLM as they're produced.
- 🎨 **Minimal web UI** under `public/` — chat, conversations, people list, memories tab.
- 💾 **100% local storage.** All data stays in a single SQLite file. No external database, no vendor lock-in.

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | Node.js 20+ / TypeScript (ESM) | Modern, single-language full-stack |
| HTTP | Fastify 5 | Fast, typed, ergonomic plugins |
| Storage | better-sqlite3 12 + SQLite FTS5 | Single-file persistent DB, zero ops, full-text + vectors in one place |
| Embeddings | `Xenova/all-MiniLM-L6-v2` via @huggingface/transformers | 384-dim, runs locally in Node, no API cost |
| LLM (default) | Google **Gemini 2.5 Flash** via REST | 15 RPM free tier, ships without downloading weights |
| LLM (offline) | SmolLM2 / Qwen2.5 via @huggingface/transformers | Fully local inference, no network |
| Auth | jsonwebtoken + bcryptjs + @fastify/cookie | Standard, stateless sessions |
| Frontend | Vanilla HTML/CSS/JS | No framework — serves statically from Fastify |
| Tests | Vitest | Fast TS-native runner |

## How it works

```
                       ┌────────────────────┐
  user message ───►    │   MAIN brain       │
                       │   (orchestrator)   │
                       └─────────┬──────────┘
                                 │
                 ┌───────────────┼───────────────┐
                 ▼               ▼               ▼
        ┌───────────────┐ ┌─────────────┐ ┌──────────────┐
        │ STORAGE brain │ │    LLM      │ │  Background  │
        │ SQLite + FTS5 │ │  Gemini /   │ │  extraction  │
        │ + embeddings  │ │  local HF   │ │ (people+facts)│
        └───────────────┘ └─────────────┘ └──────────────┘
                 ▲               │                │
                 │               ▼                ▼
                 │       ┌─────────────┐   ┌──────────────┐
                 └───────│ streamed    │   │ upserted     │
                         │ response    │   │ into STORAGE │
                         └─────────────┘   └──────────────┘
```

Each user turn runs:

1. **Persist** the message (SQLite `messages` table).
2. **Embed + store** as a searchable `raw_turn` memory (SQLite `memories` + FTS5 index).
3. **Retrieve** via hybrid search — top-K across the user's entire history.
4. **Build prompt** — system directive + recent turns + injected memory context + current question.
5. **Stream tokens** from the LLM via SSE.
6. **Background extract** people + facts from the exchange in one LLM call, apply anti-hallucination grounding guards, upsert into the store.

All steps up to (5) are synchronous, so the user message is never lost — even if the LLM crashes mid-stream.

## Running locally

**Prereqs:** Node 20+, a Google AI Studio API key (free at [aistudio.google.com/apikey](https://aistudio.google.com/apikey)).

```bash
git clone https://github.com/aryamthecodebreaker/AGI-v1.git
cd AGI-v1
npm install
cp .env.example .env
# then edit .env and put your GEMINI_API_KEY in
npm run dev
```

Open [http://localhost:3000](http://localhost:3000), register an account, and start chatting.

## Tests

```bash
npm test
```

Vitest covers the storage repositories end to end (users, conversations, messages, memories, people, FTS and vector search).

## Roadmap

- ✅ Dual-brain storage + retrieval
- ✅ Multi-user auth + per-user memory
- ✅ Unified people + fact extraction (1 LLM call per turn)
- ✅ Gemini backend + local transformers backend
- ⏳ Deployment (GitHub Pages / Hugging Face Space)
- ⏳ From-scratch transformer (`src/scratch/`) + training loop on accumulated conversations
- ⏳ Background reflection pass (bot periodically summarizes its own memory)

## License

MIT — see [LICENSE](./LICENSE).
