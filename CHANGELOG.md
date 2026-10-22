# Changelog

Notable changes to Culture Terminal. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org).

## [Unreleased]

### Added: Foundation

- Gating probe of the Qloo hackathon API (`tools/probe/run-probe.ts`) and the frozen Qloo parameter allowlist (`packages/qloo/src/allowlist.ts`). Findings are recorded as shapes and booleans only.
- LLM bench that compares Sonnet and Haiku on cost, speed and quality (`tools/llm-bench`).
- pnpm monorepo on Node 24: the Next.js app in `apps/web` and the source-only packages `contracts`, `qloo`, `quant`, `geo`, `agent` and `db`.
- Shared contracts in `packages/contracts`: SSE events, report, datasets and tools.
- Postgres schema and Drizzle migrations, plus a docker-compose `postgres:17` for local development.
- Walking skeleton: a fake agent run streamed over SSE that resumes from `Last-Event-ID` after a reconnect.
- Multi-stage `Dockerfile` (Next.js standalone server, non-root) and `railway.json` for the Railway `web` service: healthcheck `/api/health`, restart on failure, sleep off, 200 s draining.
- CI on every push and pull request to `main`: install, typecheck, lint, test against Postgres, `pnpm guard`, build, a client-bundle guard and a full-history gitleaks scan.
- `pnpm guard`, the repository data guard (D29): forbidden paths, UUIDs, Qloo request IDs, copied decimals and secrets, across the working tree, the full git history and the built client bundle.
- `.env.example` listing every variable the system reads, with placeholders only.
- `ATTRIBUTION.md` for fonts, chart and map libraries, and basemap data.
