import { databaseDown, expect, expectNoExamples, expectNoSideScroll, INVENTED_BRAND, liveServer, open, shot, test } from "./support";

// The brand profile (/d/[entity], the DES): an invented name read on a mock server, where the synthetic
// transport answers any name from its hash. The page renders on the server and makes its Qloo calls there,
// out of the spend guard's reach, so the spec runs on a mock server only (support.ts liveServer); the
// profile's cache needs the server's database too.

test("a profile renders its header and sections for an invented brand", async ({ page }, testInfo) => {
  await open(page, "/status");
  const live = await liveServer(page);
  test.skip(live !== null, live ?? "");
  const down = await databaseDown(page);
  test.skip(down !== null, down ?? "");
  test.setTimeout(60_000);

  await open(page, `/d/${encodeURIComponent(INVENTED_BRAND)}`);
  await expect(page).toHaveTitle(/ · Culture Terminal$/);
  // A resolved name shows the profile; the mock may also find it more than once and offer the picker.
  const profile = page.locator('[data-profile="true"]');
  const picker = page.locator("[data-candidate]").first();
  await expect(profile.or(picker)).toBeVisible({ timeout: 30_000 });
  if (await profile.isVisible()) {
    await expect(page.locator('[data-entity-header="true"]')).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  }
  await expectNoExamples(page);
  await expectNoSideScroll(page);
  await shot(page, testInfo, "profile");
});

test("the profile look-up page renders", async ({ page }) => {
  await open(page, "/d");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expectNoExamples(page);
  await expectNoSideScroll(page);
});
