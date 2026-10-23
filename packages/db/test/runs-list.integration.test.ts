// Listing finished runs (listRuns, summarizeRuns) against a real Postgres in a throwaway database.
// Skips only when no database is reachable; in CI with DATABASE_URL set it never skips. Every
// question and number is invented (D29). Runs are seeded as showcases, so the listings that are not
// about visibility see them all.
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/client";
import {
  createRun,
  listMetricDisplays,
  listRuns,
  RUN_LIST_MAX,
  RUN_VISIBLE_IDS_MAX,
  summarizeRuns,
  type RunListCursor,
  type RunListRow,
} from "../src/repos/runs";
import { metrics as metricsTable, type NewRun, type RunStatus, runs } from "../src/schema";
import { createTestDatabase, probeTestDatabase, type TestDatabase } from "./support/testDb";

const probe = await probeTestDatabase();

const FINISHED: readonly RunStatus[] = ["completed", "incomplete"];
/** The curated runs: every seeded run unless a test says otherwise. */
const SHOWCASES = { showcases: true, ids: [] } as const;

/** The report fields a list reads; the rest of a Report is irrelevant to the repo. */
function report(score: unknown, extra: { signal?: string; headline?: string; traced?: [number, number]; reused?: number } = {}) {
  const [traced, total] = extra.traced ?? [4, 4];
  return {
    verdict: {
      headline: extra.headline ?? "Juniper Cola reads as a distinct niche",
      signal: extra.signal ?? "mixed",
      confidence: { score, band: typeof score === "number" && score >= 75 ? "HIGH" : "MED", breakdown: [] },
    },
    receipt: { numbersTraced: { traced, total }, ...(extra.reused === undefined ? {} : { qlooReused: extra.reused }) },
  };
}

describe.skipIf(!probe.ok)("listing runs against Postgres", () => {
  let t: TestDatabase | undefined;
  let db: Db;

  beforeAll(async () => {
    t = await createTestDatabase();
    db = t.db;
  }, 60_000);

  afterAll(async () => {
    await t?.dispose();
  }, 30_000);

  /** A run created at `at` (an ISO time with up to microseconds) by the database clock's own type. */
  async function seed(prefix: string, at: string, over: Partial<NewRun> = {}): Promise<string> {
    const run = await createRun(db, {
      question: "Is the Juniper Cola audience a moat?",
      questionHash: `${prefix}${Math.random().toString(16).slice(2)}`,
      status: "completed",
      pillar: "investment",
      job: "brand_health",
      isShowcase: true,
      ...over,
    });
    await db.update(runs).set({ createdAt: sql`${at}::timestamptz` }).where(eq(runs.id, run.id));
    return run.id;
  }

  /** Every page of a listing, following `next` until it is null. */
  async function allPages(options: Omit<Parameters<typeof listRuns>[1], "after">): Promise<RunListRow[][]> {
    const pages: RunListRow[][] = [];
    let after: RunListCursor | null = null;
    for (let i = 0; i < 20; i++) {
      const page = await listRuns(db, { ...options, after });
      pages.push(page.rows);
      if (page.next === null) return pages;
      after = page.next;
    }
    throw new Error("the listing did not end");
  }

  it("lists finished runs of one prefix newest first, with what their reports say", async () => {
    const done = await seed("ls1:", "2026-10-20T10:00:00Z", {
      report: report(85, { signal: "strong", headline: "Brand Alpha holds its niche", reused: 5 }),
      qlooNetwork: 12,
      qlooCached: 7,
    });
    const partial = await seed("ls1:", "2026-10-21T10:00:00Z", {
      status: "incomplete",
      report: null,
      validation: { issues: [], numbersTraced: { traced: 2, total: 3 } },
      pillar: null,
      job: null,
    });
    await seed("ls1:", "2026-10-22T10:00:00Z", { status: "running" });
    await seed("ls1:", "2026-10-22T11:00:00Z", { status: "failed" });
    await seed("other:", "2026-10-22T12:00:00Z");

    const page = await listRuns(db, { hashPrefix: "ls1:", statuses: FINISHED, visible: SHOWCASES, limit: 10 });
    expect(page.next).toBeNull();
    expect(page.rows.map((r) => r.id)).toEqual([partial, done]);
    expect(page.rows[1]).toMatchObject({
      question: "Is the Juniper Cola audience a moat?",
      pillar: "investment",
      job: "brand_health",
      status: "completed",
      signal: "strong",
      headline: "Brand Alpha holds its niche",
      confidenceScore: 85,
      confidenceBand: "HIGH",
      numbersTraced: { traced: 4, total: 4 },
      qlooNetwork: 12,
      qlooCached: 7,
      qlooReused: 5,
      createdAtKey: "2026-10-20T10:00:00.000000Z",
    });
    expect(page.rows[1]?.createdAt.toISOString()).toBe("2026-10-20T10:00:00.000Z");
    expect(page.rows[0]).toMatchObject({
      status: "incomplete",
      signal: null,
      headline: null,
      confidenceScore: null,
      confidenceBand: null,
      numbersTraced: { traced: 2, total: 3 },
      qlooReused: null,
    });
  });

  it("pages by created_at and id without repeating or skipping runs made within one millisecond", async () => {
    const ids = [
      await seed("ls2:", "2026-10-22T09:00:00.000100Z"),
      await seed("ls2:", "2026-10-22T09:00:00.000200Z"),
      await seed("ls2:", "2026-10-22T09:00:00.000200Z"),
      await seed("ls2:", "2026-10-22T09:00:00.000300Z"),
      await seed("ls2:", "2026-10-22T08:00:00Z"),
    ];
    const pages = await allPages({ hashPrefix: "ls2:", statuses: FINISHED, visible: SHOWCASES, limit: 2 });
    expect(pages.map((p) => p.length)).toEqual([2, 2, 1]);
    const listed = pages.flat().map((r) => r.id);
    expect(new Set(listed).size).toBe(5);
    expect(listed[0]).toBe(ids[3]);
    expect(listed.at(-1)).toBe(ids[4]);
    expect(pages[0]?.[0]?.createdAtKey).toBe("2026-10-22T09:00:00.000300Z");
  });

  it("lists the runs created strictly before a plain created_at cursor", async () => {
    await seed("ls3:", "2026-10-22T09:00:00Z");
    const older = await seed("ls3:", "2026-10-21T09:00:00Z");
    const page = await listRuns(db, {
      hashPrefix: "ls3:",
      statuses: FINISHED,
      visible: SHOWCASES,
      limit: 10,
      after: { createdAt: "2026-10-22T09:00:00Z", id: null },
    });
    expect(page.rows.map((r) => r.id)).toEqual([older]);
  });

  it("sorts by conviction, highest first, runs without a score last, and pages through ties", async () => {
    const low = await seed("ls4:", "2026-10-22T09:00:00Z", { report: report(40) });
    const highOld = await seed("ls4:", "2026-10-20T09:00:00Z", { report: report(90) });
    const highNew = await seed("ls4:", "2026-10-21T09:00:00Z", { report: report(90) });
    const mid = await seed("ls4:", "2026-10-19T09:00:00Z", { report: report(70) });
    const none = await seed("ls4:", "2026-10-22T10:00:00Z", { status: "incomplete", report: null });
    const odd = await seed("ls4:", "2026-10-18T09:00:00Z", { report: report("85") });

    const expected = [highNew, highOld, mid, low, none, odd];
    const one = await listRuns(db, { hashPrefix: "ls4:", statuses: FINISHED, visible: SHOWCASES, limit: 10, sort: "conviction" });
    expect(one.rows.map((r) => r.id)).toEqual(expected);
    expect(one.rows.at(-1)?.confidenceScore).toBeNull();
    for (const size of [1, 2, 4]) {
      const pages = await allPages({ hashPrefix: "ls4:", statuses: FINISHED, visible: SHOWCASES, limit: size, sort: "conviction" });
      expect(pages.flat().map((r) => r.id)).toEqual(expected);
    }
    const first = await listRuns(db, { hashPrefix: "ls4:", statuses: FINISHED, visible: SHOWCASES, limit: 1, sort: "conviction" });
    expect(first.next).toMatchObject({ id: highNew, score: 90 });
  });

  it("filters by a case-insensitive question substring whose wildcards match literally, and by desk", async () => {
    const plain = await seed("ls5:", "2026-10-22T09:00:00Z", { question: "Who drinks Juniper Cola?" });
    const pct = await seed("ls5:", "2026-10-22T08:00:00Z", { question: "Does 50% of the Brand Beta crowd travel?" });
    const under = await seed("ls5:", "2026-10-22T07:00:00Z", {
      question: "Where should a juniper_bar open?",
      pillar: "location",
      job: "site_selection",
    });
    const list = async (search: string, pillar: string | null = null) =>
      (await listRuns(db, { hashPrefix: "ls5:", statuses: FINISHED, visible: SHOWCASES, limit: 10, search, pillar })).rows.map((r) => r.id);

    expect(await list("JUNIPER")).toEqual([plain, under]);
    expect(await list("50%")).toEqual([pct]);
    expect(await list("%")).toEqual([pct]);
    expect(await list("_")).toEqual([under]);
    expect(await list("juniper_b")).toEqual([under]);
    expect(await list("   ")).toEqual([plain, pct, under]);
    expect(await list("", "location")).toEqual([under]);
    expect(await list("juniper", "investment")).toEqual([plain]);
  });

  it("summarizes the matching runs per desk with the numbers they traced", async () => {
    await seed("ls6:", "2026-10-22T09:00:00Z", { report: report(80, { traced: [10, 10] }) });
    await seed("ls6:", "2026-10-22T08:00:00Z", { report: report(70, { traced: [6, 7] }), question: "Who is the Brand Beta crowd?" });
    await seed("ls6:", "2026-10-22T07:00:00Z", { pillar: "location", job: "site_selection", report: report(60, { traced: [3, 3] }) });
    await seed("ls6:", "2026-10-22T06:00:00Z", { status: "incomplete", pillar: null, job: null, report: null });
    await seed("ls6:", "2026-10-22T05:00:00Z", { status: "running", report: report(99, { traced: [50, 50] }) });

    expect(await summarizeRuns(db, { hashPrefix: "ls6:", statuses: FINISHED, visible: SHOWCASES })).toEqual({
      total: 4,
      byPillar: { investment: 2, location: 1, "": 1 },
      numbersTraced: { traced: 19, total: 20 },
      numbersTracedByPillar: { investment: { traced: 16, total: 17 }, location: { traced: 3, total: 3 }, "": { traced: 0, total: 0 } },
    });
    expect(await summarizeRuns(db, { hashPrefix: "ls6:", statuses: FINISHED, visible: SHOWCASES, search: "brand beta" })).toEqual({
      total: 1,
      byPillar: { investment: 1 },
      numbersTraced: { traced: 6, total: 7 },
      numbersTracedByPillar: { investment: { traced: 6, total: 7 } },
    });
    expect(await summarizeRuns(db, { hashPrefix: "ls6:", statuses: [], visible: SHOWCASES })).toEqual({
      total: 0,
      byPillar: {},
      numbersTraced: { traced: 0, total: 0 },
      numbersTracedByPillar: {},
    });
  });

  it("reads the displays of the metrics each run cites, in one query", async () => {
    const a = await seed("ls8:", "2026-10-22T09:00:00Z");
    const b = await seed("ls8:", "2026-10-22T08:00:00Z");
    const metric = (runId: string, id: string, display: string | null, badge = "MEASURED") => ({
      runId,
      id,
      key: "affinity",
      label: `Juniper Cola ${id}`,
      value: display === null ? null : 0.5,
      display,
      badge,
      reason: display === null ? "not_measured" : null,
    });
    await db.insert(metricsTable).values([
      metric(a, "M1", "0.42"),
      metric(a, "M2", "+0.18"),
      metric(b, "M1", null, "UNAVAILABLE"),
    ]);

    const displays = await listMetricDisplays(db, new Map([[a, ["M2", "M9"]], [b, ["M1"]], ["no-such-run", ["M1"]]]));
    expect(Object.fromEntries(displays)).toEqual({
      [a]: { M2: { label: "Juniper Cola M2", display: "+0.18", badge: "MEASURED" } },
      [b]: { M1: { label: "Juniper Cola M1", display: null, badge: "UNAVAILABLE" } },
    });
    expect((await listMetricDisplays(db, new Map([[a, []]]))).size).toBe(0);
  });

  it("validates the page size and the prefix before touching the database", async () => {
    for (const limit of [0, RUN_LIST_MAX + 1, 2.5]) {
      await expect(listRuns(db, { hashPrefix: "ls7:", statuses: FINISHED, visible: SHOWCASES, limit })).rejects.toThrow(RangeError);
    }
    await expect(listRuns(db, { hashPrefix: "", statuses: FINISHED, visible: SHOWCASES, limit: 5 })).rejects.toThrow(RangeError);
    await expect(summarizeRuns(db, { hashPrefix: "", statuses: FINISHED, visible: SHOWCASES })).rejects.toThrow(RangeError);
    expect(await listRuns(db, { hashPrefix: "ls7:", statuses: [], visible: SHOWCASES, limit: 5 })).toEqual({ rows: [], next: null });
    const tooMany = { showcases: true, ids: Array.from({ length: RUN_VISIBLE_IDS_MAX + 1 }, (_, i) => `run-${i}`) };
    await expect(listRuns(db, { hashPrefix: "ls7:", statuses: FINISHED, visible: tooMany, limit: 5 })).rejects.toThrow(RangeError);
    await expect(summarizeRuns(db, { hashPrefix: "ls7:", statuses: FINISHED, visible: tooMany })).rejects.toThrow(RangeError);
  });

  it("shows only showcases and the runs named by id, never another visitor's runs (D31)", async () => {
    const curated = await seed("ls9:", "2026-10-22T09:00:00Z", { pillar: "audience", job: "audience_discovery" });
    const mine = await seed("ls9:", "2026-10-22T08:00:00Z", { isShowcase: false });
    const theirs = await seed("ls9:", "2026-10-22T07:00:00Z", { isShowcase: false, pillar: "location", job: "site_selection" });
    const list = async (visible: { showcases: boolean; ids: readonly string[] }) =>
      (await listRuns(db, { hashPrefix: "ls9:", statuses: FINISHED, visible, limit: 10 })).rows.map((r) => r.id);
    const summary = (visible: { showcases: boolean; ids: readonly string[] }) =>
      summarizeRuns(db, { hashPrefix: "ls9:", statuses: FINISHED, visible });

    expect(await list(SHOWCASES)).toEqual([curated]);
    expect(await list({ showcases: true, ids: [mine, mine, "no-such-run"] })).toEqual([curated, mine]);
    expect(await list({ showcases: false, ids: [theirs] })).toEqual([theirs]);
    expect(await list({ showcases: false, ids: [] })).toEqual([]);
    expect(await summary({ showcases: true, ids: [mine] })).toMatchObject({ total: 2, byPillar: { audience: 1, investment: 1 } });
    expect((await summary({ showcases: false, ids: [] })).total).toBe(0);
    // A showcase still has to match the prefix and a finished status.
    await seed("other9:", "2026-10-22T10:00:00Z");
    await seed("ls9:", "2026-10-22T11:00:00Z", { status: "running" });
    expect(await list(SHOWCASES)).toEqual([curated]);
  });
});
