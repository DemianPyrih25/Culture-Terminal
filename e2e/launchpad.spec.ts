import { expect, expectNote, expectNoSideScroll, open, robotsOf, shot, test } from "./support";

// The Launchpad (SPEC §8.1) and the Ask page it leads to. Which showcases are pinned depends on the
// server's database, so every tile is checked for what it shows either way, and the pinned-only check
// skips when none is.

const DESKS = ["Investment", "Location", "Marketing", "Audience"] as const;

test("the Launchpad renders with its showcase tiles", async ({ page }, testInfo) => {
  await open(page, "/");
  await expect(page.getByRole("heading", { level: 1, name: "Taste is a market. Now it has a terminal." })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Your question" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Judge in 60 seconds" })).toBeVisible();

  const showcases = page.getByRole("region", { name: "Showcases", exact: true });
  await expect(showcases).toBeVisible();
  for (const desk of DESKS) {
    await expect(showcases.getByRole("heading", { level: 3, name: desk })).toBeVisible();
  }
  // Seven showcases (SPEC §11.1): each tile is named by its exact question and can always run live.
  const tiles = await showcases.getByRole("article").all();
  expect(tiles.length).toBeGreaterThanOrEqual(7);
  for (const tile of tiles) {
    await expect(tile.getByRole("heading", { level: 4 })).not.toBeEmpty();
    await expect(tile.getByRole("link", { name: /^Run live/ })).toHaveAttribute("href", /^\/ask\?q=/);
  }
  await expectNoSideScroll(page);
  await shot(page, testInfo, "launchpad");
});

test("a pinned showcase opens as an indexed note (D31)", async ({ page }) => {
  await open(page, "/");
  const pinned = page.locator('article[data-pinned="true"]');
  test.skip((await pinned.count()) === 0, "no showcase is pinned in this server's database");
  const tile = pinned.first();
  await expect(tile.getByRole("link", { name: /^Replay/ })).toHaveAttribute("href", /^\/run\/[^/?]+\?replay=1$/);
  const href = await tile.getByRole("link", { name: /^Open note/ }).getAttribute("href");
  expect(href).toMatch(/^\/r\/[^/?]+$/);
  await open(page, href ?? "");
  await expectNote(page);
  // A curated showcase is indexed and carries no "Unlisted" marker; only readers' own runs are noindex.
  expect((await robotsOf(page)) ?? "").not.toContain("noindex");
  await expect(page.locator('[data-marker="UNLISTED"]')).toHaveCount(0);
  // Its share card (P1 #4), when the brief has something to show: served as a PNG. Read from this server
  // whatever host the meta names.
  const og = page.locator('meta[property="og:image"]');
  if ((await og.count()) > 0) {
    const card = new URL((await og.first().getAttribute("content")) ?? "", page.url());
    const res = await page.request.get(card.pathname + card.search);
    expect(res.status(), "the showcase's OG card").toBe(200);
    expect(res.headers()["content-type"]).toContain("image/png");
  }
});

test("Ask opens on an empty question and sends nothing until asked", async ({ page }) => {
  // A question in the URL is previewed on arrival (CLERK, a model call): the smoke never puts one there.
  // The spend guard (support.ts) blocks and fails a preview or a run sent without Enter.
  await open(page, "/ask");
  const field = page.getByRole("textbox", { name: "Your question" });
  await expect(field).toBeVisible();
  await expect(field).toHaveValue("");
  await field.fill("Is the Juniper Cola audience a moat or a niche?");
  await expect(field).toHaveValue("Is the Juniper Cola audience a moat or a niche?");
  await expectNoSideScroll(page);
});
