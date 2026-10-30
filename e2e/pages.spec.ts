import { expect, expectNoExamples, expectNoSideScroll, open, test } from "./support";

// The reference pages: How it works, Method and Status. Each renders its one title in the site's
// chrome and fits the viewport; /trust moved to /how-it-works with a 308; /status also shows the Qloo
// switch the fail-closed demo turns (QLOO_DISABLED); /method states each feature's cost per use.

const PAGES = [
  { path: "/how-it-works", title: /^How it works · Culture Terminal$/ },
  { path: "/method", title: /^Method · Culture Terminal$/ },
  { path: "/status", title: /^Status · Culture Terminal$/ },
] as const;

for (const { path, title } of PAGES) {
  test(`${path} renders`, async ({ page }) => {
    await open(page, path);
    await expect(page).toHaveTitle(title);
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
    await expect(page.getByRole("contentinfo")).toBeVisible();
    await expectNoExamples(page);
    await expectNoSideScroll(page);
  });
}

test("/trust moved to /how-it-works for good (308)", async ({ page }) => {
  const res = await page.request.get("/trust", { maxRedirects: 0 });
  expect(res.status()).toBe(308);
  expect(new URL(res.headers()["location"] ?? "", "http://local.invalid").pathname).toBe("/how-it-works");
  await open(page, "/trust");
  await expect(page).toHaveURL(/\/how-it-works$/);
});

test("/method states the cost per use of every feature and job", async ({ page }) => {
  await open(page, "/method#costs");
  const costs = page.locator('[data-section="costs"]');
  await expect(costs).toBeVisible();
  await expect(costs.locator("[data-feature-cost]")).toHaveCount(8);
  await expect(costs.locator("[data-job-cost]")).toHaveCount(13);
  await expect(costs).toContainText("Plan figures");
  await expect(page.getByRole("navigation", { name: "On this page" }).first().getByRole("link", { name: "Cost per use" })).toHaveAttribute("href", "#costs");
});

test("/status reads the live state and the Qloo switch", async ({ page }) => {
  await open(page, "/status");
  await expect(page.locator("[data-live-state]")).not.toBeEmpty();
  await expect(page.locator('[data-breaker="qloo_switch"]')).toHaveText(/^(Allowed|Switched off \(QLOO_DISABLED\))/);
});
