import { BRIEF_SAMPLE, expect, expectNote, expectNoSideScroll, open, shot, test } from "./support";

// The phone layout at 390×844 (SPEC §8.6 as D36 redraws it; the "mobile" project): the Launchpad in one
// column, and a brief's Report | Sources tabs, which show the reading column or its sidenotes, never both.

test("the Launchpad fits 390 px", async ({ page }, testInfo) => {
  await open(page, "/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Your question" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Showcases", exact: true }).getByRole("article").first()).toBeVisible();
  await expectNoSideScroll(page);
  await shot(page, testInfo, "launchpad-390");
});

test("a brief switches between Report and Sources", async ({ page }, testInfo) => {
  await open(page, BRIEF_SAMPLE);
  await expectNote(page);
  const tabs = page.getByRole("group", { name: "Brief view" });
  const report = tabs.getByRole("button", { name: "Report" });
  const sources = tabs.getByRole("button", { name: "Sources" });
  const question = page.getByRole("heading", { level: 1 });
  const sidenotes = page.getByRole("note", { name: "Sidenotes" }).first();

  await expect(report).toHaveAttribute("aria-pressed", "true");
  await expect(question).toBeVisible();
  await expect(sidenotes).toBeHidden();
  await expectNoSideScroll(page);
  await shot(page, testInfo, "brief-report-390");

  await sources.click();
  await expect(sources).toHaveAttribute("aria-pressed", "true");
  await expect(question).toBeHidden();
  await expect(sidenotes).toBeVisible();
  await expectNoSideScroll(page);
  await shot(page, testInfo, "brief-sources-390");

  await report.click();
  await expect(report).toHaveAttribute("aria-pressed", "true");
  await expect(question).toBeVisible();
});
