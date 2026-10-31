import { ANSWER_SAMPLE, BRIEF_SAMPLE, databaseDown, expect, expectAnswer, expectNoExamples, open, robotsOf, shot, test, workingView } from "./support";

// An answer from start to permalink (design/redesign.pen N03–N06): a test run shows the working view live
// and swaps in place to the answer, and its /run/[id] and /r/[id] are noindex (D31). The test run replays
// the synthetic brand-health sample over FAKE_RUN_SECONDS with no Qloo or model call, and needs the
// server's database to store it; the run steps share it, so they run in order. The replay and the How we
// know drawer are checked on the dev samples, which need no database.

test.describe.configure({ mode: "serial" });

/** The run's page, as the test-run button opens it. */
const RUN_URL = /\/run\/[A-Za-z0-9-]+$/;

/** Past this, the smoke runs well over its two minutes: the dev server wants FAKE_RUN_SECONDS=45. */
const SLOW_RUN_SECONDS = 60;

let runId = "";

test.describe(() => {
  // The one test that starts a run: the spend guard (support.ts) lets this page's POST /api/runs through.
  test.use({ allowRun: true });

  test("a test run shows the working view live, then its answer", async ({ page }, testInfo) => {
    await open(page, "/dev/ask");
    const down = await databaseDown(page);
    test.skip(down !== null, down ?? "");
    // The dev way to start the test run (app/dev/ask): Home itself runs only real questions.
    const start = page.getByRole("button", { name: /^Start a \d+-second test run$/ });
    const seconds = Number(/(\d+)-second/.exec(await start.innerText())?.[1] ?? "0");
    expect(seconds, "the test run's length").toBeGreaterThan(0);
    if (seconds > SLOW_RUN_SECONDS) {
      const description = `FAKE_RUN_SECONDS=${seconds}: restart the dev server with FAKE_RUN_SECONDS=45 to keep the smoke near a minute`;
      testInfo.annotations.push({ type: "slow", description });
      console.warn(description);
    }
    test.setTimeout((seconds + 60) * 1000);

    await start.click();
    // A refusal (FAKE_RUN_MAX_ACTIVE or FAKE_RUN_HOURLY_CAP) puts the button back with the server's reason.
    const reason = start.locator("xpath=following-sibling::*[@role='status']");
    await Promise.race([
      page.waitForURL(RUN_URL),
      reason.waitFor().then(async () => {
        throw new Error(`the server refused the test run: ${await reason.innerText()}`);
      }),
    ]);
    runId = new URL(page.url()).pathname.split("/").pop() ?? "";
    if (seconds >= 15) {
      await expect(workingView(page)).toHaveAttribute("data-working", "live");
      await expect(page.getByRole("progressbar").first()).toBeVisible();
    }
    await expectAnswer(page, (seconds + 30) * 1000);
    await expect(workingView(page)).toHaveCount(0);
    // D31: the run page of a reader's own run is noindex too, not only its permalink.
    expect(await robotsOf(page)).toContain("noindex");
    await expectNoExamples(page);
    await shot(page, testInfo, "test-run-answer");
  });
});

test("the permalink is read-only and noindex (D31)", async ({ page }, testInfo) => {
  test.skip(runId === "", "the test run did not start");
  // The page draws the answer from report.final; the run's end is stored a moment later, and until then
  // the permalink still reads as being made. Wait for the stored end, as a reader sharing the link would.
  await expect
    .poll(async () => {
      const res = await page.request.get(`/api/runs/${runId}`);
      const body = (await res.json().catch(() => null)) as { state?: { ended?: unknown } } | null;
      return body?.state?.ended != null;
    }, { message: "the test run's end was stored", timeout: process.env.CI ? 30_000 : 15_000 })
    .toBe(true);
  await open(page, `/r/${runId}`);
  await expectAnswer(page);
  expect(await robotsOf(page)).toContain("noindex");
  // A reader's own run gets no share card: OG cards are for curated showcases only.
  await expect(page.locator('meta[property="og:image"]')).toHaveCount(0);
  await expect(page.locator('meta[name="twitter:image"]')).toHaveCount(0);
  await shot(page, testInfo, "permalink");
});

test("a key number's Source opens How we know on its number", async ({ page }, testInfo) => {
  await open(page, ANSWER_SAMPLE);
  await expectAnswer(page);
  await page.getByRole("button", { name: /^Source of / }).first().click();
  const drawer = page.getByRole("dialog", { name: "How we know" });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole("tab", { name: /^Numbers/ })).toHaveAttribute("aria-selected", "true");
  await shot(page, testInfo, "how-we-know");
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
});

test("the ledger lists every request behind the answer, each with its exact call", async ({ page }, testInfo) => {
  await open(page, ANSWER_SAMPLE);
  await expectAnswer(page);
  await page.getByRole("button", { name: /^Source of / }).first().click();
  const drawer = page.getByRole("dialog", { name: "How we know" });
  await expect(drawer).toBeVisible();
  const tab = drawer.getByRole("tab", { name: /^Sources \(\d+\)$/ });
  // The count is in the tab's accessible name ("Sources (9)"); its brackets are for screen readers only.
  const listed = Number(/\((\d+)\)/.exec((await tab.getAttribute("aria-label")) ?? "")?.[1] ?? "0");
  expect(listed, "the answer's sources").toBeGreaterThan(0);
  await tab.click();
  await expect(tab).toHaveAttribute("aria-selected", "true");
  const rows = drawer.locator("[data-source-row]");
  await expect(rows.first()).toBeVisible();
  expect(await rows.count()).toBeGreaterThan(0);
  await shot(page, testInfo, "ledger");
});

test("a replay at 4× plays the recording to its answer", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  // D26: a replay plays the stored events and starts nothing (the spend guard fails a POST /api/runs).
  await open(page, `${BRIEF_SAMPLE}&replay=1`);
  // The page head carries the controls twice (desktop and phone layouts); one shows at a time.
  const controls = page.locator("[data-replay]").filter({ visible: true });
  await expect(controls).toBeVisible();
  const four = controls.getByRole("radiogroup", { name: "Speed" }).getByRole("radio", { name: "4×" });
  await four.click();
  await expect(four).toHaveAttribute("aria-checked", "true");
  await expectAnswer(page, 75_000);
  await shot(page, testInfo, "replay-done");
});
