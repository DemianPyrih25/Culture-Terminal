// GET /api/runs against a real Postgres in a throwaway database: the route handler, the runs repo
// and the stored ledger together. Skips only when no database is reachable. Invented entities only.
// The seeded briefs are showcases unless a test says otherwise; user runs are listed only by id (D31).
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Metric, Report } from "@ct/contracts";
import { createRun, insertLedgerSnapshot, type NewRun } from "@ct/db";
import { buildFakeScript } from "../server/fake-script";
import { questionHash } from "../server/question-hash";
import { ledgerOf } from "./support/agent";
import { createTestDatabase, databaseAvailable, type TestDatabase } from "./support/test-db";

vi.mock("server-only", () => ({}));

const available = await databaseAvailable();
const g = globalThis as { __ctContainer?: unknown };

interface ListBody {
  runs: Record<string, unknown>[];
  next: string | null;
  total: number;
  pillars: Record<string, number>;
  numbersTraced: { traced: number; total: number };
  pillarsTraced: Record<string, { traced: number; total: number }>;
}

describe.skipIf(!available)("GET /api/runs against Postgres", () => {
  let t: TestDatabase | undefined;
  const ids: Record<string, string> = {};
  let fakeReport: Report;
  /** The measured metric the seeded headline cites. */
  let cited: Metric;

  /** A run created `hoursAgo` hours ago, with its report's score set to `score` when it has one. */
  async function seed(name: string, hoursAgo: number, over: Partial<NewRun> & { score?: number } = {}): Promise<string> {
    const db = t!.db;
    const { score, ...columns } = over;
    const question = columns.question ?? `Who really competes with Juniper Cola, take ${name}?`;
    const report =
      columns.report === undefined ? null : score === undefined ? columns.report : withScore(columns.report as Report, score);
    const run = await createRun(db, {
      question,
      questionHash: questionHash(question, undefined, "live"),
      status: "completed",
      pillar: "investment",
      job: "brand_health",
      qlooNetwork: 11,
      qlooCached: 9,
      isShowcase: true,
      ...columns,
      report,
    });
    await db.$client`update runs set created_at = now() - make_interval(secs => ${hoursAgo * 3600}) where id = ${run.id}`;
    ids[name] = run.id;
    return run.id;
  }

  const withScore = (report: Report, score: number): Report => ({
    ...report,
    verdict: { ...report.verdict, confidence: { ...report.verdict.confidence, score, band: score >= 75 ? "HIGH" : score >= 50 ? "MED" : "LOW" } },
  });

  async function list(query = ""): Promise<{ status: number; body: ListBody }> {
    const http = await import("../server/http");
    const res = await http.listRecentRuns(new Request(`http://test.local/api/runs${query}`));
    return { status: res.status, body: (await res.json()) as ListBody };
  }

  beforeAll(async () => {
    t = await createTestDatabase();
    const fake = buildFakeScript({ runId: "seed", startedAt: Date.now(), durationMs: 1000 });
    const ledger = ledgerOf(fake.steps.map((s) => s.input));
    const measured = ledger.metrics.find((m) => m.value !== null);
    if (measured === undefined) throw new Error("the test run's ledger has no measured metric to cite");
    cited = measured;
    // The headline cites a metric of the run's own ledger, whatever the test run's headline says.
    fakeReport = { ...fake.report, verdict: { ...fake.report.verdict, headline: `Juniper Cola is a taste island {{${cited.id}}}` } };

    const top = await seed("top", 1, { report: fakeReport, score: 90 });
    await insertLedgerSnapshot(t.db, top, ledger);
    await seed("mid", 2, { report: fakeReport, score: 70 });
    await seed("partial", 3, { status: "incomplete", report: null, pillar: null, job: null, qlooNetwork: 2, qlooCached: 0 });
    await seed("place", 4, {
      report: fakeReport,
      score: 80,
      pillar: "location",
      job: "site_selection",
      question: "Where should a juniper bar open in Austin?",
    });
    await seed("running", 0.5, { status: "running" });
    await seed("failed", 0.6, { status: "failed" });
    // A test run: completed with a note, but never a brief.
    const testRun = await createRun(t.db, {
      question: "Test run: Juniper Cola",
      questionHash: "fake:seed",
      status: "completed",
      isShowcase: true,
      report: fakeReport,
    });
    ids.test = testRun.id;
    // Two visitors' own runs: neither is a showcase.
    await seed("mine", 0.2, { report: fakeReport, score: 60, isShowcase: false, question: "Who drinks Brand Beta, mine?" });
    await seed("theirs", 0.3, {
      report: fakeReport,
      score: 65,
      isShowcase: false,
      pillar: "audience",
      job: "audience_discovery",
      question: "Who drinks Brand Beta, theirs?",
    });
  }, 60_000);

  afterEach(() => {
    delete g.__ctContainer;
  });

  afterAll(async () => {
    await t?.dispose();
  }, 30_000);

  const useDb = () => {
    g.__ctContainer = { db: t!.db };
  };

  it("lists finished agent briefs newest first, never test runs or runs still going, with the counts", async () => {
    useDb();
    const { status, body } = await list();
    expect(status).toBe(200);
    expect(body.runs.map((r) => r.runId)).toEqual([ids.top, ids.mid, ids.partial, ids.place]);
    expect(body.next).toBeNull();
    const traced = fakeReport.receipt.numbersTraced;
    expect(body.total).toBe(4);
    expect(body.pillars).toEqual({ investment: 2, location: 1, marketing: 0, audience: 0 });
    expect(body.numbersTraced).toEqual({ traced: 3 * traced.traced, total: 3 * traced.total });
    expect(body.pillarsTraced).toEqual({
      investment: { traced: 2 * traced.traced, total: 2 * traced.total },
      location: traced,
      marketing: { traced: 0, total: 0 },
      audience: { traced: 0, total: 0 },
    });

    const [top, , partial] = body.runs;
    expect(top).toMatchObject({
      question: "Who really competes with Juniper Cola, take top?",
      pillar: "investment",
      job: "brand_health",
      jobLabel: "Real competitors",
      status: "completed",
      signal: fakeReport.verdict.signal,
      headline: fakeReport.verdict.headline,
      confidence: { score: 90, band: "HIGH" },
      numbersTraced: traced,
      // Network and cached calls, and the calls the receipt reused from a parent, as the brief page counts them.
      sources: 20 + fakeReport.receipt.qlooReused,
    });
    // The metric the headline cites comes with the display the run's ledger stored for it.
    expect(top?.metrics).toEqual({ [cited.id]: { label: cited.label, display: cited.display, badge: cited.badge } });
    expect(partial).toMatchObject({ status: "incomplete", signal: null, headline: null, confidence: null, jobLabel: null, metrics: {}, sources: 2 });
  });

  it("pages with next, newest first or by conviction, without repeats or gaps", async () => {
    useDb();
    const walk = async (base: string) => {
      const seen: unknown[] = [];
      let next: string | null = null;
      do {
        const { status, body }: { status: number; body: ListBody } = await list(`${base}${next === null ? "" : `&before=${next}`}`);
        expect(status).toBe(200);
        expect(body.runs.length).toBeLessThanOrEqual(1);
        seen.push(...body.runs.map((r) => r.runId));
        next = body.next;
      } while (next !== null);
      return seen;
    };
    expect(await walk("?limit=1")).toEqual([ids.top, ids.mid, ids.partial, ids.place]);
    expect(await walk("?limit=1&sort=conviction")).toEqual([ids.top, ids.place, ids.mid, ids.partial]);
  });

  it("searches the question text and narrows the page to one desk, keeping the desk counts", async () => {
    useDb();
    const juniper = await list("?q=JUNIPER%20BAR");
    expect(juniper.body.runs.map((r) => r.runId)).toEqual([ids.place]);
    expect(juniper.body.total).toBe(1);
    expect((await list("?q=100%25")).body.runs).toEqual([]);
    const location = await list("?pillar=location");
    expect(location.body.runs.map((r) => r.runId)).toEqual([ids.place]);
    expect(location.body.pillars).toMatchObject({ investment: 2, location: 1 });
  });

  it("lists another visitor's run only to the browser that names it, and counts only what it shows", async () => {
    useDb();
    const mine = await list(`?ids=${ids.mine}`);
    expect(mine.status).toBe(200);
    expect(mine.body.runs.map((r) => r.runId)).toEqual([ids.mine, ids.top, ids.mid, ids.partial, ids.place]);
    expect(mine.body.total).toBe(5);
    expect(mine.body.pillars).toEqual({ investment: 3, location: 1, marketing: 0, audience: 0 });

    const both = await list(`?ids=${ids.theirs},${ids.mine}&pillar=audience`);
    expect(both.body.runs.map((r) => r.runId)).toEqual([ids.theirs]);
    expect(both.body.pillars).toMatchObject({ investment: 3, audience: 1 });

    // A test run, or a run still going, stays out even when named.
    const named = await list(`?ids=${ids.test},${ids.running}`);
    expect(named.body.runs.map((r) => r.runId)).toEqual([ids.top, ids.mid, ids.partial, ids.place]);
    // A search never reaches past what the browser may see.
    expect((await list("?q=Brand%20Beta")).body.runs).toEqual([]);
  });

  it("reads any run by id as a follow-up's parent, saying when POST /api/runs would refuse it", async () => {
    const { getFollowUpParent } = await import("../server/run-list");
    const db = t!.db;
    expect(await getFollowUpParent(db, ids.theirs!)).toEqual({ question: "Who drinks Brand Beta, theirs?", blocked: null });
    expect(await getFollowUpParent(db, ids.running!)).toEqual({
      question: "Who really competes with Juniper Cola, take running?",
      blocked: "running",
    });
    expect(await getFollowUpParent(db, ids.test!)).toMatchObject({ blocked: "test_run" });
    // Failed, or ended without a note: nothing to follow up on.
    expect(await getFollowUpParent(db, ids.failed!)).toMatchObject({ blocked: "no_note" });
    expect(await getFollowUpParent(db, ids.partial!)).toMatchObject({ blocked: "no_note" });
    expect(await getFollowUpParent(db, "run-not-there-0001")).toBeNull();
    expect(await getFollowUpParent(db, "not a run id")).toBeNull();
  });

  it("finds the completed showcase brief of a starter's question, never a visitor's run or a test run", async () => {
    const { questionKey, showcaseRunsByQuestion } = await import("../server/run-list");
    const found = await showcaseRunsByQuestion(t!.db);
    expect(found.get(questionKey("  WHO really competes with Juniper Cola,   take top? "))).toBe(ids.top);
    expect(found.get(questionKey("Where should a juniper bar open in Austin?"))).toBe(ids.place);
    expect([...found.values()].sort()).toEqual([ids.top, ids.mid, ids.place].sort());
  });

  it("answers 400 to a bad parameter, naming it", async () => {
    useDb();
    for (const [query, path] of [
      ["?limit=0", "limit"],
      ["?sort=popular", "sort"],
      ["?before=garbage!", "before"],
      ["?ids=not%20a%20run", "ids"],
    ] as const) {
      const { status, body } = await list(query);
      expect(status).toBe(400);
      expect((body as unknown as { issues: { path: string }[] }).issues.map((i) => i.path)).toContain(path);
    }
  });
});
