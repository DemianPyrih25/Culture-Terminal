import { writeFile } from "node:fs/promises";
import { EOL } from "node:os";
import { test as base, expect, type Locator, type Page, type TestInfo } from "@playwright/test";

/**
 * Shared by the smoke specs. Selectors are roles and accessible names first, then the data attributes
 * the components already carry for their state (data-answer, data-replay, data-lift-map): no sleeps,
 * every wait is on something the page shows.
 */

/**
 * The dev server's own race, not the app's: a rebuild (a file saved while the smoke runs) asks the router
 * to refresh before the page has hydrated. A production build has no such message.
 */
const DEV_REFRESH_RACE = "Internal Next.js error: Router action dispatched before initialization.";

/**
 * The two requests that spend: POST /api/preview reads the question with CLERK (a model call), and
 * POST /api/runs starts a run (a live one costs model turns and Qloo calls). Matched in full, so the
 * stream, the datasets and a cancel under /api/runs/[id] pass.
 */
const SPEND_URL = /\/api\/(?:preview|runs)(?:\?.*)?$/;

interface SmokeOptions {
  /** Lets the page send POST /api/preview: only the opt-in fail-closed spec asks a question. */
  allowPreview: boolean;
  /** Lets the page send POST /api/runs: the test run (run.spec) and the opt-in fail-closed spec. */
  allowRun: boolean;
}

/**
 * The smoke's test: no page it opens may spend unless the test allows it, throw or fail to hydrate.
 * Every console error is kept with the test's results (console-errors.txt) and named in the output, for
 * a look.
 */
export const test = base.extend<SmokeOptions & { spendGuard: void; pageErrors: void }>({
  allowPreview: [false, { option: true }],
  allowRun: [false, { option: true }],
  // Blocks the request before it reaches the server, so a regression (a page that previews or runs on
  // its own) costs nothing even on a server with live keys, then fails the test that saw it.
  spendGuard: [
    async ({ page, allowPreview, allowRun }, provide) => {
      const blocked: string[] = [];
      await page.route(SPEND_URL, (route, request) => {
        const path = new URL(request.url()).pathname;
        const allowed = path === "/api/preview" ? allowPreview : allowRun;
        if (request.method() !== "POST" || allowed) return route.fallback();
        blocked.push(`POST ${path} from ${page.url()}`);
        return route.abort("blockedbyclient");
      });
      await provide();
      expect(blocked, "a page sent a preview or a run the test does not allow (blocked before the server)").toEqual([]);
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

/** The recorded brand-health brief (apps/web/server/samples, invented entities), as a finished note. */
export const BRIEF_SAMPLE = "/dev/brief?sample=brand-health";

/** The synthetic brief of a job with a lift map (app/dev/brief/job-runs.ts: Austin, invented entities). */
export const MAP_SAMPLE = "/dev/brief?job=site_selection";

/** Opens a path and checks the server answered it with a page, not an error. */
export async function open(page: Page, path: string): Promise<void> {
  const res = await page.goto(path);
  expect(res, `no response for ${path}`).not.toBeNull();
  expect(res?.status() ?? 0, `${path} answered an error`).toBeLessThan(400);
}

/** The brief's answer block: data-answer is "pending" while the run is written and "final" once the note is. */
export function answerBlock(page: Page): Locator {
  return page.locator("[data-answer]");
}

/** Waits for the finished note: the answer with its headline. */
export async function expectNote(page: Page, timeout?: number): Promise<void> {
  await expect(answerBlock(page)).toHaveAttribute("data-answer", "final", { timeout });
  await expect(page.locator("[data-headline]")).toBeVisible();
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
