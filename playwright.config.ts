// The smoke (SPEC §10.2, PLAN §10.2): a Playwright run in mock mode, locally and in CI. It checks Home and
// Your answers with no examples anywhere, a test run's working view swapping to its answer, the How we
// know drawer and its ledger, a replay at 4×, the map cards mounting in Austin and Nashville, How it works,
// /method with its cost per use, /status (and /trust's 308), the /r/[id] permalink (noindex for a reader's
// own run, D31), /following with a follow added through the API, /screener with an invented screen, the
// /d/[entity] profile, the phone layout at 390×844 (and the iPhone and Android emulations of e2e/phone.spec.ts), and axe-core on every public page at both widths. It
// makes no live Qloo or model call: the test run replays a recorded run, the map reads the dev sample, and
// the server runs on the synthetic Qloo transport with no model key. The test run, its permalink, the
// follows and the profile need the server's database, and skip without it. Vitest never collects e2e/
// (vitest.config.ts includes packages, apps/web and tools only).
//
//   pnpm smoke                                        starts the mock dev server below on :3100 (or reuses
//                                                     one already there, outside CI), then runs
//   SMOKE_BASE_URL=http://localhost:3000 pnpm smoke   against a server already up; nothing is started
//   pnpm exec tsc -p e2e/tsconfig.json                typechecks the specs and this file
//
// The server is a development one (next dev): the smoke opens /dev/ask and /dev/brief, which a production
// build answers 404. It starts with blank ANTHROPIC_API_KEY, QLOO_API_KEY and Turnstile keys and
// QLOO_MOCK=1 (variables already set win over the repository's .env, next.config.ts), so no page can make
// a live call; a reused or SMOKE_BASE_URL server is checked in the global setup, and the specs that would
// call Qloo outside the spend guard skip on a live one (e2e/support.ts liveServer). A short
// FAKE_RUN_SECONDS (45) keeps the whole run near a minute. e2e/fail-closed.spec.ts is opt-in
// (SMOKE_FAIL_CLOSED=1) and skipped otherwise. Every page runs behind a spend guard (e2e/support.ts)
// that blocks POST /api/preview, /api/runs and /api/screener unless the test allows them.
//
// test-results/ and playwright-report/ are generated and gitignored. After a failure the report carries the
// trace viewer's JavaScript bundles, which ESLint skips only through eslint.config.mjs's globalIgnores.
import { defineConfig } from "@playwright/test";

const SMOKE_PORT = 3100;
const external = process.env.SMOKE_BASE_URL;
const baseURL = external ?? `http://localhost:${SMOKE_PORT}`;

/** The started server's environment: mock Qloo and public data, no model, no Turnstile, a 45-second test run. */
const MOCK_ENV = {
  QLOO_MOCK: "1",
  QLOO_API_KEY: "",
  ANTHROPIC_API_KEY: "",
  TURNSTILE_SITE_KEY: "",
  TURNSTILE_SECRET_KEY: "",
  FAKE_RUN_SECONDS: "45",
  // No sign-in gate for the mock smoke: "/" is the question page and app routes are open.
  AUTH_REQUIRED: "0",
  NEXT_TELEMETRY_DISABLED: "1",
};

export default defineConfig({
  testDir: "e2e",
  // Under test-results/ (gitignored); cleared at the start of each run.
  outputDir: "test-results/smoke",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: true,
  // One shared dev server compiles each route on its first request (the global setup asks for each once
  // first): a few workers, not one per core. The CI runner has two cores, so two there.
  workers: process.env.CI ? 2 : 4,
  retries: 0,
  forbidOnly: true,
  // Per test; the test run's own steps set theirs from FAKE_RUN_SECONDS. Doubled in CI, where the dev
  // server compiles heavy routes (/method, /dev/figures) several times slower than a workstation.
  timeout: process.env.CI ? 60_000 : 30_000,
  expect: { timeout: 10_000 },
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  // SMOKE_BASE_URL names a server already up: nothing is started.
  ...(external
    ? {}
    : {
        webServer: {
          command: `pnpm --filter web exec next dev -p ${SMOKE_PORT}`,
          // A static page: /api/health answers 503 while the database is down, and the smoke still runs then.
          url: `${baseURL}/how-it-works`,
          env: MOCK_ENV,
          // Outside CI a dev server already on the port is reused; the global setup says when it is not a mock one.
          reuseExistingServer: !process.env.CI,
          timeout: 240_000,
          stdout: "ignore" as const,
          stderr: "pipe" as const,
        },
      }),
  use: {
    baseURL,
    browserName: "chromium",
    navigationTimeout: process.env.CI ? 40_000 : 20_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "desktop",
      testIgnore: /(mobile|phone)\.spec\.ts$/,
      // The design exports' frame (design/exports/redesign).
      use: { viewport: { width: 1440, height: 900 } },
    },
    {
      name: "mobile",
      testMatch: /mobile\.spec\.ts$/,
      use: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
    },
    // The phone check at 390 px (Part 11): e2e/phone.spec.ts sets each phone's screen and user agent itself.
    { name: "phone-iphone", testMatch: /phone\.spec\.ts$/, grep: /iPhone/ },
    { name: "phone-android", testMatch: /phone\.spec\.ts$/, grep: /Android/ },
  ],
});
