import { answerBlock, expect, expectNote, open, shot, test } from "./support";

// The fail-closed demo (SPEC §1.4 and §6.6, P1 #10, the README GIF). With QLOO_DISABLED=1 the
// server makes no Qloo call at all, and a live question still ends as a note: its signal reads
// Insufficient evidence (CHECKER V7) and its conviction Low (D35). No number is written without a
// request behind it, so the model never fills the gap with a guess.
//
// Opt-in: it asks a real question, which spends on the model (CLERK's read and the ANALYST's turns, no
// Qloo call), and the plain smoke never spends. It also skips, with what /status says, unless the switch
// is off and nothing else stops a live question (an Anthropic key, a Qloo client, a database, no pause).
//
// Recording the GIF:
//   1. Restart the dev server with QLOO_DISABLED=1 next to the Anthropic key, and no Turnstile keys so
//      the human check stays off: `QLOO_DISABLED=1 pnpm dev` (Git Bash) or
//      `$env:QLOO_DISABLED='1'; pnpm dev` (PowerShell). Keep a Qloo client configurable (the .env Qloo
//      key, or QLOO_MOCK=1): the run manager refuses live runs without one, even under QLOO_DISABLED, so
//      blank Qloo keys alone leave /status at "unavailable". /status must read "limited": "Qloo calls are
//      switched off (QLOO_DISABLED): live runs answer as insufficient evidence."
//   2. `SMOKE_FAIL_CLOSED=1 pnpm exec playwright test e2e/fail-closed.spec.ts --headed` asks the question
//      on /ask, runs the brief and waits for the note. The recording is the video.webm under
//      test-results/smoke/fail-closed-*. Copy it out at once: the next Playwright run of any spec clears
//      test-results/smoke. `ffmpeg -i video.webm -vf "fps=12,scale=960:-1" fail-closed.gif` makes the GIF.
//      SMOKE_FAIL_CLOSED_QUESTION asks another question.
//   3. By hand instead, for a paced take: open /ask, type the question, Enter, "Run brief", and hold on
//      the answer line "The answer — Insufficient evidence" with Conviction at Low and no requests
//      under Sources.
//   4. Restart the dev server without QLOO_DISABLED.

const QUESTION = process.env.SMOKE_FAIL_CLOSED_QUESTION ?? "Is the Juniper Cola audience a moat or a niche?";

test.skip(process.env.SMOKE_FAIL_CLOSED !== "1", "opt-in: SMOKE_FAIL_CLOSED=1 asks a live question (model spend, no Qloo call)");

// The one spec that asks: the spend guard (support.ts) lets its preview and its run through.
test.use({ allowPreview: true, allowRun: true, video: { mode: "on", size: { width: 1440, height: 900 } } });

test("with Qloo switched off, a live question ends as Insufficient evidence (V7)", async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  await open(page, "/status");
  const qloo = page.locator('[data-breaker="qloo_switch"]');
  test.skip(!(await qloo.innerText()).includes("QLOO_DISABLED"), "the server was not started with QLOO_DISABLED=1");
  // "limited" with the switch as its first reason: nothing else (no key, no Qloo client, a pause, a full
  // hour) stops the question. Otherwise the skip says what does, in /status's words.
  const lead = page.locator("[data-live-state]");
  const live = await lead.getAttribute("data-live-state");
  const said = (await lead.innerText()).trim();
  test.skip(live !== "limited" || !said.startsWith("Qloo calls are switched off"), `live analysis is ${live}: ${said}`);

  await open(page, `/ask?q=${encodeURIComponent(QUESTION)}`);
  const run = page.getByRole("button", { name: "Run brief" });
  await expect(run).toBeEnabled({ timeout: 60_000 });
  await run.click();
  await page.waitForURL(/\/run\/[A-Za-z0-9-]+$/);

  await expectNote(page, 240_000);
  await expect(answerBlock(page).getByRole("heading", { level: 2 })).toContainText("Insufficient evidence");
  // The band itself ("Low · 18"), not a word in the penalty lines.
  await expect(page.getByRole("meter", { name: "Conviction" })).toHaveAttribute("aria-valuetext", /^Low · \d+$/);
  await expect(page.locator('[data-penalty="insufficient_evidence"]')).toBeAttached();
  // Fail-closed: Sources says no Qloo request was made, and lists none.
  await expect(page.getByText("No Qloo request was made.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Request \d+: inspect$/ })).toHaveCount(0);
  await shot(page, testInfo, "fail-closed-note");
});
