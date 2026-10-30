import { writeFile } from "node:fs/promises";
import { EOL } from "node:os";
import { test as base, expect, type Locator, type Page, type TestInfo } from "@playwright/test";

/**
 * Shared by the smoke specs. Selectors are roles and accessible names first, then the data attributes
 * the components already carry for their state (data-working, data-verdict, data-replay, data-lift-map):
 * no sleeps, every wait is on something the page shows.
 */

/**
 * The dev server's own race, not the app's: a rebuild (a file saved while the smoke runs) asks the router
 * to refresh before the page has hydrated. A production build has no such message.
 */
const DEV_REFRESH_RACE = "Internal Next.js error: Router action dispatched before initialization.";

/**
 * The three requests that spend: POST /api/preview reads the question with CLERK (a model call),
 * POST /api/runs starts a run (a live one costs model turns and Qloo calls), and POST /api/screener
 * runs a screen (Qloo calls). Matched in full, so the stream, the datasets and a cancel under
 * /api/runs/[id] pass.
 */
const SPEND_URL = /\/api\/(?:preview|runs|screener)(?:\?.*)?$/;

interface SmokeOptions {
  /** Lets the page send POST /api/preview: only the opt-in fail-closed spec asks a question. */
  allowPreview: boolean;
  /** Lets the page send POST /api/runs: the test run (run.spec) and the opt-in fail-closed spec. */
  allowRun: boolean;
  /** Lets the page send POST /api/screener: the screener spec, on a mock server only (liveServer). */
  allowScreener: boolean;
}

/**
 * The smoke's test: no page it opens may spend unless the test allows it, throw or fail to hydrate.
 * Every console error is kept with the test's results (console-errors.txt) and named in the output, for
 * a look.
 */
export const test = base.extend<SmokeOptions & { spendGuard: void; pageErrors: void }>({
  allowPreview: [false, { option: true }],
  allowRun: [false, { option: true }],
  allowScreener: [false, { option: true }],
  // Blocks the request before it reaches the server, so a regression (a page that previews or runs on
  // its own) costs nothing even on a server with live keys, then fails the test that saw it.
  spendGuard: [
    async ({ page, allowPreview, allowRun, allowScreener }, provide) => {
      const blocked: string[] = [];
      await page.route(SPEND_URL, (route, request) => {
        const path = new URL(request.url()).pathname;
        const allowed = path === "/api/preview" ? allowPreview : path === "/api/screener" ? allowScreener : allowRun;
        if (request.method() !== "POST" || allowed) return route.fallback();
        blocked.push(`POST ${path} from ${page.url()}`);
        return route.abort("blockedbyclient");
      });
      await provide();
      expect(blocked, "a page sent a preview, a run or a screen the test does not allow (blocked before the server)").toEqual([]);
    },
    { auto: true },
  ],
  pageErrors: [
    async ({ page }, provide, testInfo) => {
      const thrown: string[] = [];
      const logged: string[] = [];
      page.on("pageerror", (err) => {
        if (err.message !== DEV_REFRESH_RACE) thrown.push(`${page.url()} ${err.message}`);
      });
      page.on("console", (msg) => {
        if (msg.type() === "error") logged.push(`${page.url()} ${msg.text()}`);
      });
      await provide();
      if (logged.length > 0) {
        const path = testInfo.outputPath("console-errors.txt");
        await writeFile(path, logged.join(EOL + EOL));
        await testInfo.attach("console-errors", { path, contentType: "text/plain" });
        console.warn(`${testInfo.title}: ${logged.length} console error(s), in ${path}`);
      }
      expect(thrown, "a page threw").toEqual([]);
      expect(
        logged.filter((line) => line.includes("hydrat")).map((line) => line.slice(0, 300)),
        "a page did not hydrate as rendered",
      ).toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

/** The recorded brand-health run (apps/web/server/samples, invented entities), as a finished answer. */
export const BRIEF_SAMPLE = "/dev/brief?sample=brand-health";

/** The synthetic answer of a job with a lift map (app/dev/brief/job-runs.ts: Austin, invented entities). */
export const MAP_SAMPLE = "/dev/brief?job=site_selection";

/** The synthetic brand_health answer (app/dev/brief/job-runs.ts, invented entities): key numbers with Source. */
export const ANSWER_SAMPLE = "/dev/brief?job=brand_health";

/** Opens a path and checks the server answered it with a page, not an error. */
export async function open(page: Page, path: string): Promise<void> {
  const res = await page.goto(path);
  expect(res, `no response for ${path}`).not.toBeNull();
  expect(res?.status() ?? 0, `${path} answered an error`).toBeLessThan(400);
}

/** The working view, shown while an answer is being made (data-working is live or replay). */
export function workingView(page: Page): Locator {
  return page.locator("[data-working]");
}

/** Waits for the finished answer: the verdict card with its headline. */
export async function expectAnswer(page: Page, timeout?: number): Promise<void> {
  await expect(page.locator("[data-verdict]").first()).toBeVisible({ timeout });
  await expect(page.locator("[data-headline]").first()).toBeVisible();
}

/**
 * Whether the server can store a run: GET /api/health's database check. A server without its database
 * (Postgres not running) still serves every page, the dev samples and the replay of a recording, but
 * cannot start or keep a run, so the specs that need one skip with this reason.
 */
export async function databaseDown(page: Page): Promise<string | null> {
  const res = await page.request.get("/api/health");
  const body = (await res.json().catch(() => null)) as { db?: { ok?: boolean } } | null;
  return body?.db?.ok === true ? null : "the server's database is not reachable (pnpm db:up)";
}

/**
 * Whether the server runs on synthetic data with no model: GET /api/health's qloo.env is "mock" and
 * llm.configured is false (the server the smoke starts, playwright.config.ts). The specs that make Qloo
 * calls the spend guard cannot block (a screen, a profile, a request sent by the test itself) skip on
 * any other server with this reason, so a smoke pointed at a live server spends nothing.
 */
export async function liveServer(page: Page): Promise<string | null> {
  const res = await page.request.get("/api/health");
  const body = (await res.json().catch(() => null)) as { qloo?: { env?: string } | null; llm?: { configured?: boolean } } | null;
  if (body?.qloo?.env === "mock" && body.llm?.configured === false) return null;
  return "the server is not in mock mode (QLOO_MOCK=1 with blank QLOO_API_KEY and ANTHROPIC_API_KEY): this check would make live calls";
}

/** Following's API (packages/contracts/src/follows.ts): GET lists, POST adds, PATCH points at a run, DELETE removes. */
export const FOLLOWS_API = "/api/follows";

/** The brand screener's API (packages/contracts/src/screener.ts): POST a ScreenerRequest, answered with a ScreenerAnswer. */
export const SCREENER_API = "/api/screener";

/** An invented brand: the mock Qloo transport answers any name from its hash (no Qloo value, D29). */
export const INVENTED_BRAND = "Juniper Cola";

/**
 * The owner's rule for the redesign: no examples anywhere. No showcase or example surface, no "Try"
 * chips, no "See all examples" link: the page's visible words never offer one.
 */
export async function expectNoExamples(page: Page): Promise<void> {
  const words = await page.locator("body").innerText();
  expect(words, "the page offers examples").not.toMatch(/\bexamples?\b|showcase|\bTry:|See all|ready answer/i);
}

/** The robots meta of the page, or null without one. */
export async function robotsOf(page: Page): Promise<string | null> {
  const meta = page.locator('meta[name="robots"]');
  return (await meta.count()) === 0 ? null : meta.first().getAttribute("content");
}

/** Fails when the page scrolls sideways: every layout fits its viewport, the 390 px one included. */
export async function expectNoSideScroll(page: Page): Promise<void> {
  // A string expression, as tools/dev/screenshot.ts does: the page's own document, not Node's.
  const overflow = await page.evaluate<number>("document.documentElement.scrollWidth - document.documentElement.clientWidth");
  expect(overflow, "the page scrolls sideways").toBeLessThanOrEqual(0);
}

/** Keeps a screenshot of the page (or of one element) with the test's results (test-results/smoke, gitignored). */
export async function shot(target: Page | Locator, testInfo: TestInfo, name: string): Promise<void> {
  const path = testInfo.outputPath(`${name}.png`);
  // "hide" sets an inline caret-color on every field, which React, still hydrating, reports as a mismatch.
  await target.screenshot({ path, caret: "initial" });
  await testInfo.attach(name, { path, contentType: "image/png" });
}
