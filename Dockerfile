# syntax=docker/dockerfile:1.7

# ---- deps ----
FROM node:20-slim AS deps
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.6.0 --activate
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# ---- build ----
FROM node:20-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.6.0 --activate
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Build-time env vars for the Vite bundle. Railway passes these as build args
# when declared here; the ENV line then exposes them to the `pnpm build`
# process so Vite can bake VITE_* values into the client JS. Server-only
# secrets (TURNSTILE_SECRET_KEY, API keys, etc.) stay as runtime-only vars
# on the runtime stage — no need to declare them here.
ARG VITE_TURNSTILE_SITE_KEY
ENV VITE_TURNSTILE_SITE_KEY=$VITE_TURNSTILE_SITE_KEY
RUN pnpm build

# ---- runtime ----
FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Playwright sysdeps (keep in sync with README + CLAUDE.md)
# libasound2t64 is the Ubuntu/noble name; Debian bookworm (node:20-slim base) ships libasound2.
# Try t64 first (for future Ubuntu-based bases), then fall back to the bookworm name.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnspr4 libnss3 libgtk-3-0 libgbm1 \
    ca-certificates fonts-liberation \
 && (apt-get install -y --no-install-recommends libasound2t64 \
     || apt-get install -y --no-install-recommends libasound2) \
 && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@9.6.0 --activate

# Prod dependencies only (keeps image small)
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile

# Bake Chromium into the image so cold-start doesn't download it
RUN pnpm exec playwright install chromium

# App artifacts
COPY --from=build /app/dist ./dist
COPY --from=build /app/src/db/migrations ./src/db/migrations
COPY drizzle.config.ts ./

# Default to the web server; worker service overrides CMD via Railway start-command.
CMD ["node", "dist/server.js"]
