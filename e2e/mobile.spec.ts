import { ANSWER_SAMPLE, expect, expectAnswer, expectNoExamples, expectNoSideScroll, open, shot, test } from "./support";

// The phone layout at 390×844 (design/redesign.pen N17, N18; the "mobile" project): Home in one column
// under the 56 px header with its menu sheet, and an answer stacked card under card. Nothing scrolls
// sideways, and the header's buttons are 44 px touch targets.

test("Home fits 390 px, with the menu sheet", async ({ page }, testInfo) => {
  await open(page, "/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByLabel("Your question")).toBeVisible();
  await expect(page.getByRole("button", { name: "Get answer" })).toBeVisible();
  await expectNoExamples(page);
  await expectNoSideScroll(page);
  await shot(page, testInfo, "home-390");

  const menu = page.getByRole("button", { name: "Menu" });
  const box = await menu.boundingBox();
  expect(box?.height ?? 0, "the menu button's touch target").toBeGreaterThanOrEqual(44);
  await menu.click();
  const sheet = page.getByRole("dialog", { name: "Menu" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("link", { name: "Your answers" })).toBeVisible();
  await expect(sheet.getByRole("link", { name: "How it works" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
});

test("an answer stacks at 390 px, and its menu opens How we know", async ({ page }, testInfo) => {
  await open(page, ANSWER_SAMPLE);
  await expectAnswer(page);
  await expect(page.getByRole("region", { name: "Key numbers" })).toBeVisible();
  await expectNoSideScroll(page);
  await shot(page, testInfo, "answer-390");

  await page.getByRole("button", { name: "Menu" }).click();
  await page.getByRole("dialog", { name: "Menu" }).getByRole("button", { name: "How we know" }).click();
  await expect(page.getByRole("dialog", { name: "How we know" })).toBeVisible();
  await expectNoSideScroll(page);
});
