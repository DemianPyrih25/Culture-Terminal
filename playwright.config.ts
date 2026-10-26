// The local smoke (SPEC §10.2, P1 #14): a Playwright run against a server that is already up, before the
// feature freeze, never in CI. It checks the Launchpad, a test run streaming to its note, a replay at 8×
// reaching the note, the lift map mounting, the request inspector opening, /method /trust /status, the
// /r/[id] permalink (noindex for a reader's own run, D31) and the brief's tabs at 390×844. It makes no
// Qloo or model call: the test run replays a recorded brief, and the map reads the dev sample. Vitest
// never collects e2e/ (vitest.config.ts includes packages, apps/web and tools only).
//
//   pnpm smoke                                        against http://localhost:3100
//   SMOKE_BASE_URL=http://localhost:3000 pnpm smoke   against another server
//   pnpm exec tsc -p e2e/tsconfig.json                typechecks the specs and this file
//
// The server is a development one (pnpm dev): the smoke opens /dev/ask and /dev/brief, which a production
// build answers 404. A short FAKE_RUN_SECONDS (45) keeps the whole run near a minute. e2e/fail-closed.spec.ts
// is opt-in (SMOKE_FAIL_CLOSED=1) and skipped otherwise. Every page runs behind a spend guard (e2e/support.ts)
// that blocks POST /api/preview and /api/runs unless the test allows them.
//
// test-results/ and playwright-report/ are generated and gitignored. After a failure the report carries the
// trace viewer's JavaScript bundles, which ESLint skips only through eslint.config.mjs's globalIgnores.
import { defineConfig } from "@playwright/test";

const baseURL = process.env.SMOKE_BASE_URL ?? "http://localhost:3100";

export default defineConfig({
  testDir: "e2e",
  // Under test-results/ (gitignored); cleared at the start of each run.
  outputDir: "test-results/smoke",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: true,
  // One shared dev server compiles each route on its first request (the global setup asks for each once
  // first): a few workers, not one per core.
  workers: 4,
  retries: 0,
  forbidOnly: true,
  // Per test; the test run's own steps set theirs from FAKE_RUN_SECONDS.
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    baseURL,
    browserName: "chromium",
    navigationTimeout: 20_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "desktop",
      testIgnore: /mobile\.spec\.ts$/,
      // The design exports' frame (design/exports/concept-a).
      use: { viewport: { width: 1440, height: 900 } },
    },
    {
      name: "mobile",
      testMatch: /mobile\.spec\.ts$/,
      use: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
    },
  ],
});
