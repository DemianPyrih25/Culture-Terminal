import { expect, expectNoSideScroll, open, test } from "./support";

// The reference pages (D11): /method and /trust in P0, /status in P1. Each renders its one title and
// fits the viewport; /status also shows the Qloo switch the fail-closed demo turns (QLOO_DISABLED).

const PAGES = [
  { path: "/method", title: /Method/ },
  { path: "/trust", title: /Trust/ },
  { path: "/status", title: /Status/ },
] as const;

for (const { path, title } of PAGES) {
  test(`${path} renders`, async ({ page }) => {
    await open(page, path);
    await expect(page).toHaveTitle(title);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
    await expectNoSideScroll(page);
  });
}

test("/status reads the live state and the Qloo switch", async ({ page }) => {
  await open(page, "/status");
  await expect(page.locator("[data-live-state]")).not.toBeEmpty();
  await expect(page.locator('[data-breaker="qloo_switch"]')).toHaveText(/^(Allowed|Switched off \(QLOO_DISABLED\))/);
});
