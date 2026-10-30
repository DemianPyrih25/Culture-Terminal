import { databaseDown, expect, expectNoExamples, expectNoSideScroll, FOLLOWS_API, INVENTED_BRAND, open, shot, test } from "./support";

// Following (/following, PLAN §2.4, Part 10): a fresh browser follows nothing, and the page lists none; a
// brand followed through the API (POST /api/follows from a profile, packages/contracts/src/follows.ts)
// shows on the page with its Re-run, and is removed again. Adding a follow makes no Qloo or model call;
// the spec never presses Re-run (it starts a run, which the spend guard blocks). Follows live in the
// server's database, so the spec skips without it. Each test has its own browser context, so its own
// visitor and follows.

interface FollowBody {
  id: string;
  kind: string;
  label: string;
  latest: unknown;
}

test("a fresh browser follows nothing, and a follow added through the API shows with its Re-run", async ({ page }, testInfo) => {
  await open(page, "/following");
  const down = await databaseDown(page);
  test.skip(down !== null, down ?? "");

  const empty = await page.request.get(FOLLOWS_API);
  expect(empty.status(), `GET ${FOLLOWS_API}`).toBe(200);
  const before = (await empty.json()) as { follows: FollowBody[]; max: number };
  expect(before.follows, "a fresh browser context follows nothing").toEqual([]);
  expect(before.max).toBeGreaterThan(0);

  await expect(page).toHaveTitle(/ · Culture Terminal$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.locator("main")).not.toContainText(INVENTED_BRAND);
  await expectNoExamples(page);
  await expectNoSideScroll(page);
  await shot(page, testInfo, "following-empty");

  let id = "";
  try {
    const added = await page.request.post(FOLLOWS_API, { data: { from: "profile", name: INVENTED_BRAND } });
    expect(added.ok(), `POST ${FOLLOWS_API} answered ${added.status()}: ${await added.text()}`).toBe(true);
    const first = (await added.json()) as { follow: FollowBody; created: boolean };
    id = first.follow.id;
    expect(first.created).toBe(true);
    expect(first.follow.kind).toBe("brand");
    expect(first.follow.label).toContain(INVENTED_BRAND);
    // Nothing has run for it yet.
    expect(first.follow.latest).toBeNull();

    // One follow per subject: the same brand again is the same follow.
    const again = (await (await page.request.post(FOLLOWS_API, { data: { from: "profile", name: INVENTED_BRAND } })).json()) as {
      follow: FollowBody;
      created: boolean;
    };
    expect(again.created).toBe(false);
    expect(again.follow.id).toBe(id);

    const listed = (await (await page.request.get(FOLLOWS_API)).json()) as { follows: FollowBody[] };
    expect(listed.follows.map((f) => f.id)).toEqual([id]);

    await open(page, "/following");
    await expect(page.locator("main")).toContainText(INVENTED_BRAND);
    // A profile follow has no note yet, so its control reads Run; it reads Re-run once a note exists.
    const rerun = /^(re-?)?run\b/i;
    await expect(page.getByRole("button", { name: rerun }).or(page.getByRole("link", { name: rerun })).first()).toBeVisible();
    await expectNoSideScroll(page);
    await shot(page, testInfo, "following-one");
  } finally {
    if (id !== "") {
      const removed = await page.request.delete(FOLLOWS_API, { data: { id } });
      expect(removed.ok(), `DELETE ${FOLLOWS_API} answered ${removed.status()}`).toBe(true);
      expect(((await removed.json()) as { removed: boolean }).removed).toBe(true);
    }
  }

  const after = (await (await page.request.get(FOLLOWS_API)).json()) as { follows: FollowBody[] };
  expect(after.follows).toEqual([]);
});

test("a follow the API refuses says why, and adds nothing", async ({ page }) => {
  await open(page, "/following");
  const down = await databaseDown(page);
  test.skip(down !== null, down ?? "");
  // No name: the body fails FollowCreate, and the answer is a FollowError, never a stored follow.
  const bad = await page.request.post(FOLLOWS_API, { data: { from: "profile", name: "" } });
  expect(bad.status()).toBeGreaterThanOrEqual(400);
  expect(bad.status()).toBeLessThan(500);
  const body = (await bad.json()) as { error?: unknown };
  expect(typeof body.error).toBe("string");
  const listed = (await (await page.request.get(FOLLOWS_API)).json()) as { follows: FollowBody[] };
  expect(listed.follows).toEqual([]);
});
