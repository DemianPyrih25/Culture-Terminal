import { answerBlock, expect, expectNote, open, robotsOf, shot, test } from "./support";

// One test run, followed from start to permalink (PLAN Part 6): it streams live to its note, every number
// opens the request behind it, it replays at 8× to the same note, and its /run/[id] and /r/[id] are
// unlisted and noindex (D31). The test run replays the synthetic brand-health sample over FAKE_RUN_SECONDS
// with no Qloo or model call; the steps share it, so they run in order.

test.describe.configure({ mode: "serial" });

/** The finished run's page, as the test-run button opens it. */
const RUN_URL = /\/run\/[A-Za-z0-9-]+$/;

/** Past this, the smoke runs well over its two minutes: the dev server wants FAKE_RUN_SECONDS=45. */
const SLOW_RUN_SECONDS = 60;

let runId = "";
/** FAKE_RUN_SECONDS of the server, read from the button's label. */
let seconds = 0;

test.describe(() => {
  // The one test that starts a run: the spend guard (support.ts) lets this page's POST /api/runs through.
  test.use({ allowRun: true });

  test("a test run streams live to a finished note", async ({ page }, testInfo) => {
    // The dev way to start the test run (app/dev/ask): Ask itself runs only real questions.
    await open(page, "/dev/ask");
    const start = page.getByRole("button", { name: /^Start a \d+-second test run$/ });
    seconds = Number(/(\d+)-second/.exec(await start.innerText())?.[1] ?? "0");
    expect(seconds, "the test run's length").toBeGreaterThan(0);
    if (seconds > SLOW_RUN_SECONDS) {
      const description = `FAKE_RUN_SECONDS=${seconds}: restart the dev server with FAKE_RUN_SECONDS=45 to keep the smoke near a minute`;
      testInfo.annotations.push({ type: "slow", description });
      console.warn(description);
    }
    test.setTimeout((seconds + 60) * 1000);

    await start.click();
    // A refusal (FAKE_RUN_MAX_ACTIVE or FAKE_RUN_HOURLY_CAP, which other runs on a shared server use too)
    // puts the button back with the server's reason beside it; a retry keeps it busy as "Starting…".
    const reason = start.locator("xpath=following-sibling::*[@role='status']");
    await Promise.race([
      page.waitForURL(RUN_URL),
      reason.waitFor().then(async () => {
        throw new Error(`the server refused the test run: ${await reason.innerText()}`);
      }),
    ]);
    runId = new URL(page.url()).pathname.split("/").pop() ?? "";
    // Live: the question heads the page while the answer is still being written.
    await expect(page.getByRole("heading", { level: 1 })).not.toHaveText("Waiting for the question…");
    if (seconds >= 15) await expect(answerBlock(page)).toHaveAttribute("data-answer", "pending");

    await expectNote(page, (seconds + 30) * 1000);
    // run.end has landed once the brief offers its replay.
    await expect(page.getByRole("link", { name: "Replay this run" })).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('[data-marker="UNLISTED"]')).toHaveText(/^Unlisted · /);
    // D31: the run page of a reader's own run is noindex too, not only its permalink.
    expect(await robotsOf(page)).toContain("noindex");
    await shot(page, testInfo, "test-run-note");
  });
});

test("a number and a source open the request behind them", async ({ page }, testInfo) => {
  test.skip(runId === "", "the test run did not start");
  await open(page, `/run/${runId}`);
  await expectNote(page);

  // Every number is a button (D36): the first one opens its note's inspector.
  await page.getByRole("button", { name: /note \d+: open its source$/i }).first().click();
  const note = page.getByRole("dialog", { name: /^Note \d+: the request behind it$/ });
  await expect(note).toBeVisible();
  await shot(page, testInfo, "note-inspector");
  await page.keyboard.press("Escape");
  await expect(note).toBeHidden();

  // The Sources ledger: each request opens with its parameters and "Copy as curl".
  await page.getByRole("button", { name: /^Request \d+: inspect$/ }).first().click();
  const request = page.getByRole("dialog", { name: /^Request \d+$/ });
  await expect(request).toBeVisible();
  await expect(request.getByRole("button", { name: "Copy as curl" })).toBeVisible();
  await shot(page, testInfo, "request-inspector");
});

test("the replay at 8× reaches the note", async ({ page }, testInfo) => {
  test.skip(runId === "", "the test run did not start");
  // Sized for the replay's 4× default, which plays until 8× is picked, and a dev reload on the way.
  test.setTimeout(Math.max(30, seconds / 4 + 40) * 1000);
  // D26: a replay plays the stored events and starts nothing (the spend guard fails a POST /api/runs).
  await open(page, `/run/${runId}?replay=1`);
  const bar = page.getByRole("region", { name: "Replay", exact: true });
  await expect(bar).toBeVisible();

  const eight = bar.getByRole("radiogroup", { name: "Speed" }).getByRole("radio", { name: "8×" });
  await eight.click();
  await expect(eight).toHaveAttribute("aria-checked", "true");
  await expect(bar).toHaveAttribute("data-replay", "done", { timeout: (seconds / 4 + 20) * 1000 });
  await expectNote(page);
  await expect(bar.getByRole("button", { name: "Play again" })).toBeVisible();
  await shot(page, testInfo, "replay-done");
});

test("the permalink is read-only, unlisted and noindex (D31)", async ({ page }, testInfo) => {
  test.skip(runId === "", "the test run did not start");
  await open(page, `/r/${runId}`);
  await expectNote(page);
  expect(await robotsOf(page)).toContain("noindex");
  await expect(page.locator('[data-marker="UNLISTED"]')).toHaveText(/^Unlisted · /);
  // A reader's own run gets no share card: OG cards are for curated showcases only.
  await expect(page.locator('meta[property="og:image"]')).toHaveCount(0);
  await expect(page.locator('meta[name="twitter:image"]')).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Replay this run" })).toHaveAttribute("href", `/run/${runId}?replay=1`);
  await shot(page, testInfo, "permalink");
});
