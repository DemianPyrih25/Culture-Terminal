# Culture Terminal web service (PLAN §3.2, D1, D2). One Next.js standalone server on Node 24.
# Secrets are runtime environment variables only: never build args, never copied into a layer.

FROM node:24-bookworm-slim AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    NEXT_TELEMETRY_DISABLED=1
WORKDIR /app

# Dependencies: only the manifests, so this layer is reused until a manifest or the lockfile changes.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
COPY packages/qloo/package.json packages/qloo/
COPY packages/quant/package.json packages/quant/
COPY packages/geo/package.json packages/geo/
COPY packages/agent/package.json packages/agent/
COPY packages/db/package.json packages/db/
# corepack installs the pnpm version pinned in package.json's packageManager field.
RUN corepack enable && corepack install && pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
# git does not track empty directories, so a fresh clone may lack public/.
RUN mkdir -p apps/web/public && pnpm --filter web build

FROM node:24-bookworm-slim AS runner
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    NODE_OPTIONS=--max-old-space-size=768 \
    MIGRATIONS_DIR=/app/packages/db/drizzle \
    NEXT_MANUAL_SIG_HANDLE=true
WORKDIR /app
# NEXT_MANUAL_SIG_HANDLE: Next.js leaves SIGTERM to apps/web/server/startup.ts, which drains active
# runs (SHUTDOWN_GRACE_MS, under Railway's 200 s drainingSeconds) before the process exits.

# outputFileTracingRoot is the repository root, so the standalone tree mirrors the monorepo and
# the server lives at apps/web/server.js. Static assets and public/ are not traced and are copied.
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /app/apps/web/public ./apps/web/public
# The app applies these on startup (packages/db reads MIGRATIONS_DIR).
COPY --from=build --chown=node:node /app/packages/db/drizzle ./packages/db/drizzle

USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
