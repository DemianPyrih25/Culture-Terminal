// Showcases (pinShowcaseRun, unpinShowcase, pinRunCacheEntries, replaceShowcasePins) against a real
// Postgres in a throwaway database. Skips only when no database is reachable; in CI with DATABASE_URL
// set it never skips. Every question, slug, cache key and entity id is invented (D29).
import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/client";
import { createRun, getRun } from "../src/repos/runs";
import {
  getPinnedShowcase,
  listPinnedShowcases,
  listShowcasePins,
  pinRunCacheEntries,
  pinShowcaseRun,
  replaceShowcasePins,
  unpinShowcase,
  type ShowcasePinInput,
} from "../src/repos/showcases";
import { type NewRun, qlooCache, qlooCalls } from "../src/schema";
import { createTestDatabase, probeTestDatabase, type TestDatabase } from "./support/testDb";

const probe = await probeTestDatabase();

const PINS: ShowcasePinInput[] = [
  { mention: "Juniper Cola", entityId: "synthetic-juniper-1", name: "Juniper Cola", type: "brand" },
  { mention: "Brand Alpha", entityId: "synthetic-alpha-1", name: "Brand Alpha", type: "brand" },
];

describe.skipIf(!probe.ok)("showcases against Postgres", () => {
  let t: TestDatabase | undefined;
  let db: Db;

  beforeAll(async () => {
    t = await createTestDatabase();
    db = t.db;
  }, 60_000);

  afterAll(async () => {
    await t?.dispose();
  }, 30_000);

  let n = 0;
  const seed = async (over: Partial<NewRun> = {}): Promise<string> =>
    (
      await createRun(db, {
        question: "Is the Juniper Cola audience a moat or a niche?",
        questionHash: `q1:test-${++n}`,
        status: "completed",
        ...over,
      })
    ).id;

  it("pins a run as the slug's showcase and lists it in launchpad order", async () => {
    const second = await seed();
    const first = await seed();
    await pinShowcaseRun(db, { slug: "juniper-second", runId: second, order: 2 });
    const pinned = await pinShowcaseRun(db, { slug: "juniper-first", runId: first, order: 1 });

    expect(pinned?.run).toMatchObject({ id: first, isShowcase: true, showcaseSlug: "juniper-first", showcaseOrder: 1 });
    expect(pinned?.replaced).toEqual([]);
    expect(pinned?.movedFrom).toBeNull();
    const list = (await listPinnedShowcases(db)).filter((p) => p.slug.startsWith("juniper-"));
    expect(list.map((p) => [p.slug, p.order, p.runId])).toEqual([
      ["juniper-first", 1, first],
      ["juniper-second", 2, second],
    ]);
    expect(await getPinnedShowcase(db, "juniper-first")).toMatchObject({ runId: first, status: "completed", parentRunId: null });
    expect(await getPinnedShowcase(db, "juniper-none")).toBeUndefined();
  });

  it("keeps one run per slug: pinning another unpins the one before", async () => {
    const old = await seed();
    const fresh = await seed();
    await pinShowcaseRun(db, { slug: "alpha-moat", runId: old, order: 3 });
    const result = await pinShowcaseRun(db, { slug: "alpha-moat", runId: fresh, order: 3 });

    expect(result?.replaced).toEqual([old]);
    expect(await getRun(db, old)).toMatchObject({ isShowcase: false, showcaseSlug: null, showcaseOrder: null });
    expect(await getPinnedShowcase(db, "alpha-moat")).toMatchObject({ runId: fresh });
    // Pinning the same run again changes nothing else.
    expect((await pinShowcaseRun(db, { slug: "alpha-moat", runId: fresh, order: 3 }))?.replaced).toEqual([]);
  });

  it("says where a run moved from, and leaves that slug without a run", async () => {
    const run = await seed();
    await pinShowcaseRun(db, { slug: "beta-before", runId: run, order: 4 });
    const result = await pinShowcaseRun(db, { slug: "beta-after", runId: run, order: 5 });
    expect(result?.movedFrom).toBe("beta-before");
    expect(await getPinnedShowcase(db, "beta-before")).toBeUndefined();
    expect(await getPinnedShowcase(db, "beta-after")).toMatchObject({ runId: run, order: 5 });
  });

  it("rewrites the question hash only when asked, and returns undefined for a missing run", async () => {
    const run = await seed({ questionHash: "cli:adopt-me" });
    await pinShowcaseRun(db, { slug: "gamma-keep", runId: run, order: null });
    expect((await getRun(db, run))?.questionHash).toBe("cli:adopt-me");
    await pinShowcaseRun(db, { slug: "gamma-keep", runId: run, order: null, questionHash: "q1:adopted" });
    expect(await getRun(db, run)).toMatchObject({ questionHash: "q1:adopted", showcaseOrder: null });
    expect(await pinShowcaseRun(db, { slug: "gamma-keep", runId: "no-such-run-0001", order: 1 })).toBeUndefined();
  });

  it("aborts the pin when the verifier throws, with the run and the slug unchanged", async () => {
    const holder = await seed();
    const candidate = await seed({ status: "failed" });
    await pinShowcaseRun(db, { slug: "delta-guarded", runId: holder, order: 6 });
    const seen: string[] = [];
    const refused = await pinShowcaseRun(db, { slug: "delta-guarded", runId: candidate, order: 6 }, async (run, tx) => {
      seen.push(run.status);
      // The verifier reads inside the same transaction.
      seen.push((await getRun(tx, holder))?.showcaseSlug ?? "none");
      if (run.status !== "completed") throw new Error("not completed");
    }).catch((err: unknown) => err);

    expect(refused).toBeInstanceOf(Error);
    expect(seen).toEqual(["failed", "delta-guarded"]);
    expect(await getRun(db, candidate)).toMatchObject({ isShowcase: false, showcaseSlug: null });
    expect(await getPinnedShowcase(db, "delta-guarded")).toMatchObject({ runId: holder });
  });

  it("refuses a bad slug or order before touching the database", async () => {
    const run = await seed();
    await expect(pinShowcaseRun(db, { slug: "Not A Slug", runId: run, order: 1 })).rejects.toThrow(RangeError);
    await expect(pinShowcaseRun(db, { slug: "epsilon", runId: run, order: 0 })).rejects.toThrow(RangeError);
    await expect(pinShowcaseRun(db, { slug: "epsilon", runId: run, order: 1, questionHash: " " })).rejects.toThrow(RangeError);
    await expect(unpinShowcase(db, "-bad")).rejects.toThrow(RangeError);
  });

  it("serialises concurrent pins of one slug, so exactly one run ends up pinned", async () => {
    const ids = await Promise.all([seed(), seed(), seed(), seed()]);
    await Promise.all(ids.map((runId) => pinShowcaseRun(db, { slug: "zeta-race", runId, order: 7 })));
    const pinned = (await listPinnedShowcases(db)).filter((p) => p.slug === "zeta-race");
    expect(pinned).toHaveLength(1);
    expect(ids).toContain(pinned[0]?.runId);
  });

  it("unpins whatever the slug opens", async () => {
    const run = await seed();
    await pinShowcaseRun(db, { slug: "eta-unpin", runId: run, order: 8 });
    expect(await unpinShowcase(db, "eta-unpin")).toEqual([run]);
    expect(await getRun(db, run)).toMatchObject({ isShowcase: false, showcaseSlug: null, showcaseOrder: null });
    expect(await unpinShowcase(db, "eta-unpin")).toEqual([]);
  });

  it("pins the cached Qloo answers a run used, and only those", async () => {
    const run = await seed();
    const other = await seed();
    const cached = (key: string) => ({
      key,
      path: "/search",
      params: { query: "Juniper Cola" },
      status: 200,
      body: Buffer.from("{}"),
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    await db.insert(qlooCache).values([cached("k-lambda-1"), cached("k-lambda-2"), cached("k-lambda-other")]);
    const call = (runId: string, cacheKey: string | null) => ({
      env: "dev",
      runId,
      path: "/search",
      params: { query: "Juniper Cola" },
      cacheKey,
      cacheStatus: "miss" as const,
    });
    await db
      .insert(qlooCalls)
      .values([call(run, "k-lambda-1"), call(run, "k-lambda-1"), call(run, "k-lambda-2"), call(run, "k-lambda-gone"), call(run, null), call(other, "k-lambda-other")]);

    expect(await pinRunCacheEntries(db, run)).toEqual({ keys: 3, pinned: 2 });
    const rows = await db.select().from(qlooCache).where(inArray(qlooCache.key, ["k-lambda-1", "k-lambda-2", "k-lambda-other"]));
    const byKey = Object.fromEntries(rows.map((r) => [r.key, [r.pinned, r.expiresAt]]));
    expect(byKey).toEqual({ "k-lambda-1": [true, null], "k-lambda-2": [true, null], "k-lambda-other": [false, expect.any(Date)] });
    expect(await pinRunCacheEntries(db, "no-calls-run-0001")).toEqual({ keys: 0, pinned: 0 });
  });

  it("replaces a slug's pinned entities and lists them by slug and mention", async () => {
    expect(await replaceShowcasePins(db, "theta-pins", PINS)).toBe(2);
    await replaceShowcasePins(db, "iota-pins", [PINS[0]!]);
    expect((await listShowcasePins(db, "theta-pins")).map((p) => [p.mention, p.entityId, p.name, p.type])).toEqual([
      ["Brand Alpha", "synthetic-alpha-1", "Brand Alpha", "brand"],
      ["Juniper Cola", "synthetic-juniper-1", "Juniper Cola", "brand"],
    ]);

    // A pin not listed again is removed; other slugs keep theirs.
    expect(await replaceShowcasePins(db, "theta-pins", [{ ...PINS[1]!, entityId: "synthetic-alpha-2" }])).toBe(1);
    expect((await listShowcasePins(db, "theta-pins")).map((p) => [p.mention, p.entityId])).toEqual([["Brand Alpha", "synthetic-alpha-2"]]);
    expect(await replaceShowcasePins(db, "iota-pins", [])).toBe(0);
    expect(await listShowcasePins(db, "iota-pins")).toEqual([]);
    expect((await listShowcasePins(db)).map((p) => p.slug)).toContain("theta-pins");
  });

  it("refuses repeated mentions and empty fields, keeping the stored pins", async () => {
    await replaceShowcasePins(db, "kappa-pins", PINS);
    await expect(replaceShowcasePins(db, "kappa-pins", [PINS[0]!, PINS[0]!])).rejects.toThrow(/listed twice/);
    await expect(replaceShowcasePins(db, "kappa-pins", [{ ...PINS[0]!, entityId: " " }])).rejects.toThrow(/non-empty/);
    expect(await listShowcasePins(db, "kappa-pins")).toHaveLength(2);
  });
});
