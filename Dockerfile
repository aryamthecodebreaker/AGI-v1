# syntax=docker/dockerfile:1
#
# AGI-v1 — Docker image for Hugging Face Spaces (Docker SDK).
#
# Multi-stage: builder compiles TypeScript and native modules (better-sqlite3),
# runtime ships only production node_modules + built dist/ + static assets.
#
# HF Spaces constraints honored here:
#   - Non-root user with UID 1000 (HF enforces this)
#   - $HOME-owned WORKDIR so the app can write to data/ at runtime
#   - Listens on 0.0.0.0:7860 (HF Space default; match app_port in README.md)

# ---------- Build stage ----------
FROM node:20-bookworm-slim AS builder

# Native build tools for better-sqlite3
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 \
        make \
        g++ \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# Install deps with a clean, reproducible lockfile install.
COPY package.json package-lock.json ./
RUN npm ci

# Compile TypeScript to dist/.
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Drop devDependencies so node_modules is lean for the runtime stage.
RUN npm prune --omit=dev


# ---------- Runtime stage ----------
FROM node:20-bookworm-slim

# node:20-bookworm-slim already ships a 'node' user at UID 1000 — use it directly.
# HF Spaces requires UID 1000, which this satisfies.
USER node

WORKDIR /home/node/app

# Copy built artifacts and production deps from the builder, owned by `node`.
COPY --chown=node:node --from=builder /build/node_modules ./node_modules
COPY --chown=node:node --from=builder /build/dist ./dist
COPY --chown=node:node --from=builder /build/package.json ./package.json

# Static frontend (served by Fastify).
COPY --chown=node:node public ./public

# Migrations are read at runtime from src/storage/migrations (see migrate.ts).
COPY --chown=node:node src/storage/migrations ./src/storage/migrations

# Pre-create data/ so first boot doesn't race on mkdir.
RUN mkdir -p /home/node/app/data

# HF Spaces defaults — override GEMINI_API_KEY and JWT_SECRET via Space secrets.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=7860 \
    DATA_DIR=/home/node/app/data \
    LOG_LEVEL=info \
    LLM_BACKEND=gemini \
    LLM_MODEL_ID=gemini-2.5-flash \
    EMBED_MODEL_ID=Xenova/all-MiniLM-L6-v2

EXPOSE 7860

# tsconfig rootDir:"." means tsc outputs src/ → dist/src/, so entry is dist/src/index.js
CMD ["node", "dist/src/index.js"]
