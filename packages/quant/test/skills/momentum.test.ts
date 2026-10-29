import {
  digestFits,
  ModelDigest,
  type DatasetOf,
  type InsightsFilterType,
  type InsightsResponse,
  type QlooApi,
  type QlooCallMeta,
  type QlooParams,
  type QlooResult,
  type QlooTrendingPoint,
} from "@ct/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SKILL_LIMITATIONS } from "../../src/limitations";
import { estimateMomentumCalls, momentumSkill, trendingParams, TRENDING_TAKE, windowText } from "../../src/skills/momentum";
import {
  analyseSeries,
  isoWeekStart,
  momentumLabel,
  plottedWeeks,
  readPoints,
  resampleWeekly,
  scaleBreakStart,
  trendOf,
  TRENDING_WINDOW,
} from "../../src/skills/momentum/series";
import { BudgetError, FETCHED_AT, fakeProbe, fakeRun, FakeRegistry, registerInvented, type FakeLedger, type Invented } from "./support/fakes";

// Invented entities only (D29). Series are built week by week from the window start, two points a
// week that share the week's value (the step shape G11 saw), newest first as Qloo sends them.

/**
 * The real ledger's rule, which the fake does not enforce: every metric with a value and every
 * dataset cites evidence, every cited evidence id exists, and every finding cites metrics that exist.
 */
function expectEvidenceChain(ledger: FakeLedger): void {
  const evidence = new Set<string>(ledger.evidences.map((e) => e.id));
  for (const m of ledger.metrics) {
    if (m.value !== null) expect(m.evidenceIds.length, `${m.id} ${m.key} has a value but no evidence`).toBeGreaterThan(0);
    for (const id of m.evidenceIds) expect(evidence.has(id), `${m.id} cites missing ${id}`).toBe(true);
  }
  for (const d of ledger.datasets) {
    expect(d.evidenceIds.length, `${d.id} cites no evidence`).toBeGreaterThan(0);
    for (const id of d.evidenceIds) expect(evidence.has(id), `${d.id} cites missing ${id}`).toBe(true);
  }
  const metrics = new Set<string>(ledger.metrics.map((m) => m.id));
  for (const f of ledger.findings) for (const id of f.metricIds) expect(metrics.has(id), `${f.id} cites missing ${id}`).toBe(true);
}

/** Every ledger a test's skill runs wrote to; each is checked once the test ends. */
const ledgers: FakeLedger[] = [];

const DAY = 86_400_000;
const NOW = "2026-10-22T00:00:00.000Z";

function trendingPoints(weekly: readonly number[], start = TRENDING_WINDOW.start): QlooTrendingPoint[] {
  const t0 = Date.parse(`${start}T00:00:00Z`);
  const points = weekly.flatMap((pct, w) =>
    [0, 3].map((d) => ({
      date: new Date(t0 + (w * 7 + d) * DAY).toISOString().slice(0, 10),
      population_percentile: pct,
      population_rank: String(Math.round((1 - pct) * 100_000) + 1),
    })),
  );
  return points.reverse();
}

const linear = (from: number, step: number, weeks = 26) => Array.from({ length: weeks }, (_, w) => from + step * w);
const RISING = linear(0.3, 0.004);
const DECLINING = linear(0.7, -0.003);
const FLAT = Array.from({ length: 26 }, (_, w) => [0.5, 0.51, 0.49][w % 3]!);
const PLACEHOLDER = Array.from({ length: 26 }, () => 0.42);

const ALPHA: Invented = { id: "ent-alpha-01", name: "Brand Alpha", category: null };
const BETA: Invented = { id: "ent-beta-02", name: "Brand Beta", category: null };
const SHOW: Invented = { id: "ent-show-03", name: "Show Lantern", category: null };
const NOVA: Invented = { id: "ent-nova-09", name: "Artist Nova", category: null };
const SAGE: Invented = { id: "ent-sage-11", name: "Person Sage", category: null };

interface TrendingCall {
  params: QlooParams;
}

/** A Qloo double that answers /v2/trending from a table; ids in `fail` throw a Qloo client error. */
function trendingQloo(table: Record<string, QlooTrendingPoint[]>, options: { budget?: number; fail?: Record<string, string> } = {}) {
  const calls: TrendingCall[] = [];
  let attempts = 0;
  const meta = (): QlooCallMeta => ({
    qlooCallId: `qc-${calls.length}`,
    requestId: `req-synthetic-${calls.length}`,
    cache: "miss",
    fetchedAt: FETCHED_AT,
    ms: 5,
    stale: false,
    originRunId: null,
  });
  const unused = async (): Promise<never> => {
    throw new Error("unused Qloo endpoint");
  };
  const api: QlooApi = {
    search: unused,
    entities: unused,
    tags: unused,
    audiences: unused,
    insights: async <F extends InsightsFilterType>(): Promise<QlooResult<InsightsResponse<F>>> => unused(),
    trending: async (params) => {
      attempts += 1;
      if (options.budget !== undefined && attempts > options.budget) throw new BudgetError("run cap reached");
      const id = (params["signal.interests.entities"] as readonly string[])[0] ?? "";
      const code = options.fail?.[id];
      if (code !== undefined) throw Object.assign(new Error(`synthetic ${code}`), { code });
      calls.push({ params });
      return { data: { results: { trending: table[id] ?? [] } }, meta: meta() };
    },
  };
  return { api, calls };
}

function setup(
  table: Record<string, QlooTrendingPoint[]>,
  entities: [Invented, "brand" | "tv_show" | "artist" | "person"][],
  options: { budget?: number; fail?: Record<string, string> } = {},
) {
  const registry = new FakeRegistry();
  for (const [e, type] of entities) registerInvented(registry, e, type);
  const qloo = trendingQloo(table, options);
  const run = fakeRun(qloo.api, registry);
  ledgers.push(run.ledger);
  return { ...run, calls: qloo.calls };
}

function input(entities: string[], type: "brand" | "tv_show" = "brand", step_id: string | null = "S4") {
  return momentumSkill.input.parse({ entities, type, trigger_finding_id: null, step_id });
}

function momentumDataset(run: ReturnType<typeof setup>): DatasetOf<"Momentum"> {
  const d = run.ledger.datasets[0];
  if (d?.kind !== "Momentum") throw new Error("expected a Momentum dataset");
  return d;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
});
afterEach(() => {
  vi.useRealTimers();
  for (const ledger of ledgers.splice(0)) expectEvidenceChain(ledger);
});

describe("momentum series pipeline", () => {
  it("reads points oldest first inside the window, skips bad ones and rescales 0–100 points one by one", () => {
    const points: QlooTrendingPoint[] = [
      { date: "2025-05-02", population_percentile: 40, population_rank: "12" },
      { date: "2025-10-03", population_percentile: 90, population_rank: "3" },
      { date: "not a date", population_percentile: 50, population_rank: "7" },
      { date: "2025-04-04T00:00:00Z", population_percentile: 30, population_rank: "20" },
      { date: "2025-03-28", population_percentile: 10, population_rank: "50" },
      { date: "2025-06-06", population_percentile: 0.45, population_rank: "9" },
      { date: "2025-06-13", population_percentile: 140, population_rank: "1" },
      { date: "2025-06-20", population_percentile: -0.1, population_rank: "1" },
    ];
    // A 0–1 point next to 0–100 points keeps its value: only points above 1 are divided by 100.
    expect(readPoints(points, TRENDING_WINDOW)).toEqual([
      { date: "2025-04-04", pct: 0.3, raw: 30 },
      { date: "2025-05-02", pct: 0.4, raw: 40 },
      { date: "2025-06-06", pct: 0.45, raw: 0.45 },
    ]);
    expect(readPoints([{ date: "2025-04-04", population_percentile: 0.3, population_rank: "20" }], TRENDING_WINDOW)).toEqual([
      { date: "2025-04-04", pct: 0.3, raw: 0.3 },
    ]);
  });

  it("resamples to ISO-week medians dated by their Monday", () => {
    expect(isoWeekStart("2025-04-01")).toBe("2025-03-31");
    expect(isoWeekStart("2025-04-06")).toBe("2025-03-31");
    expect(isoWeekStart("2025-04-07")).toBe("2025-04-07");
    const weeks = resampleWeekly([
      { date: "2025-04-01", pct: 0.2 },
      { date: "2025-04-03", pct: 0.4 },
      { date: "2025-04-06", pct: 0.9 },
      { date: "2025-04-08", pct: 0.5 },
    ]);
    expect(weeks).toEqual([
      { date: "2025-03-31", pct: 0.4 },
      { date: "2025-04-07", pct: 0.5 },
    ]);
  });

  it("breaks only where the raw scale changes with a >5× gap between segment medians, never on one stray point", () => {
    expect(scaleBreakStart([40, 41, 42, 40, 0.5, 0.52, 0.51, 0.5])).toBe(4);
    expect(scaleBreakStart([0.5, 0.52, 0.5, 48, 50, 51])).toBe(3);
    // On one scale a >5× move is a real move (a low-percentile breakout), never a break.
    expect(scaleBreakStart([0.05, 0.05, 0.06, 0.05, 0.5, 0.52, 0.51, 0.5])).toBe(0);
    expect(scaleBreakStart([0.1, 0.1, 0.1, 9, 0.1, 0.1, 0.1])).toBe(0);
    expect(scaleBreakStart([0.3, 0.32, 0.31])).toBe(0);
    expect(scaleBreakStart([0, 40, 40])).toBe(0);
  });

  it("labels Rising and Declining only with |Δ| ≥ 0.02 and p < 0.1, otherwise Flat", () => {
    expect(momentumLabel(0.02, 0.05)).toBe("rising");
    expect(momentumLabel(0.019, 0.01)).toBe("flat");
    expect(momentumLabel(0.3, 0.1)).toBe("flat");
    expect(momentumLabel(-0.02, 0.09)).toBe("declining");
    expect(momentumLabel(-0.5, 0.2)).toBe("flat");
  });

  it("measures Δpct_26w with Theil–Sen over weeks and Mann–Kendall on the weekly medians", () => {
    const a = analyseSeries(trendingPoints(RISING));
    expect(a).toMatchObject({ rawPoints: 52, distinctValues: 26, scaleBreak: false, noSignal: null });
    expect(a.weeks).toHaveLength(26);
    expect(a.trend?.delta26w).toBeCloseTo(0.104, 9);
    expect(a.trend?.tau).toBe(1);
    expect(a.trend?.p).toBeLessThan(0.001);
    expect(a.trend?.label).toBe("rising");
    expect(analyseSeries(trendingPoints(DECLINING)).trend?.label).toBe("declining");
    expect(analyseSeries(trendingPoints(FLAT)).trend?.label).toBe("flat");
  });

  it("pulls in only an outlier week and marks it for a caret, drawing every other week as measured", () => {
    // A clean linear series has extremes but no outliers: no carets, no altered weeks.
    const clean = analyseSeries(trendingPoints(RISING)).trend!;
    expect(clean.plotted.filter((p) => p.clipped)).toEqual([]);
    expect(clean.plotted.map((p) => p.value)).toEqual(RISING);
    // A step is not an outlier either: the higher weeks sit on the p95 bound, so nothing is pulled in.
    expect(plottedWeeks([...Array.from({ length: 22 }, () => 0.3), 0.31, 0.31, 0.31, 0.31]).some((p) => p.clipped)).toBe(false);

    const weekly = [...RISING];
    weekly[10] = 0.99;
    const trend = analyseSeries(trendingPoints(weekly)).trend!;
    expect(trend.plotted[10]).toEqual({ value: expect.any(Number) as number, clipped: true });
    expect(trend.plotted[10]!.value).toBeLessThan(0.99);
    expect(trend.plotted.filter((p) => p.clipped)).toHaveLength(1);
    expect(trend.plotted[0]).toEqual({ value: weekly[0], clipped: false });
    expect(trend.plotted[25]).toEqual({ value: weekly[25], clipped: false });
    expect(trend.plotted[12]).toEqual({ value: weekly[12], clipped: false });
    // One outlier week cannot swing the Theil–Sen slope.
    expect(trend.delta26w).toBeCloseTo(0.104, 2);
  });

  it("shows NO SIGNAL for no points, a placeholder, two distinct values or fewer than eight weeks", () => {
    expect(analyseSeries([]).noSignal).toBe("no_points");
    expect(analyseSeries(trendingPoints(PLACEHOLDER))).toMatchObject({ noSignal: "flatline", distinctValues: 1, trend: null });
    const twoLevels = Array.from({ length: 26 }, (_, w) => (w < 13 ? 0.4 : 0.45));
    expect(analyseSeries(trendingPoints(twoLevels)).noSignal).toBe("flatline");
    expect(analyseSeries(trendingPoints(linear(0.3, 0.01, 7)))).toMatchObject({ noSignal: "too_short", trend: null });
    expect(analyseSeries(trendingPoints(linear(0.3, 0.01, 8))).noSignal).toBeNull();
    expect(trendOf([{ date: "2025-03-31", pct: 0.4 }, { date: "2025-04-07", pct: 0.4 }])).toBeNull();
  });

  it("reads only the latest segment after a change of scale, at its own 0–1 values", () => {
    // Ten weeks on the 0–100 scale (40 to 49), then sixteen on 0–1 rising from 0.5 to 0.575.
    const weekly = [...linear(40, 1, 10), ...linear(0.5, 0.005, 16)];
    const a = analyseSeries(trendingPoints(weekly));
    expect(a.scaleBreak).toBe(true);
    expect(a).toMatchObject({ rawPoints: 32, distinctValues: 16 });
    expect(a.weeks).toHaveLength(16);
    expect(a.weeks[0]).toEqual({ date: "2025-06-09", pct: 0.5 });
    expect(a.trend?.delta26w).toBeCloseTo(0.13, 9);
    expect(a.trend?.label).toBe("rising");
  });

  it("reads a low-percentile breakout on one scale as a move, not a scale break", () => {
    const low = Array.from({ length: 13 }, (_, w) => 0.01 + 0.0005 * (w % 3));
    const high = Array.from({ length: 13 }, (_, w) => 0.08 + 0.001 * (w % 3));
    const a = analyseSeries(trendingPoints([...low, ...high]));
    expect(a.scaleBreak).toBe(false);
    expect(a.weeks).toHaveLength(26);
    expect(a.trend?.delta26w).toBeGreaterThan(0.02);
    expect(a.trend?.label).toBe("rising");
  });
});

describe("momentum: calls and metrics", () => {
  it("asks /v2/trending once per brand or TV show over the frozen window with its own type", async () => {
    const run = setup({ [ALPHA.id]: trendingPoints(RISING), [SHOW.id]: trendingPoints(FLAT) }, [
      [ALPHA, "brand"],
      [SHOW, "tv_show"],
    ]);
    await momentumSkill.run(input(["R1", "R2"]), run.ctx);
    expect(run.calls.map((c) => c.params)).toEqual([
      {
        "filter.type": "urn:entity:brand",
        "signal.interests.entities": [ALPHA.id],
        "filter.start_date": "2025-04-01",
        "filter.end_date": "2025-09-30",
        take: TRENDING_TAKE,
      },
      {
        "filter.type": "urn:entity:tv_show",
        "signal.interests.entities": [SHOW.id],
        "filter.start_date": "2025-04-01",
        "filter.end_date": "2025-09-30",
        take: 50,
      },
    ]);
    expect(run.ledger.evidences.map((e) => e.status)).toEqual(["ok", "ok"]);
  });

  it("writes four STALE metrics per trend with the window, peer ranks by Δ and one freshness metric", async () => {
    const run = setup(
      { [ALPHA.id]: trendingPoints(RISING), [BETA.id]: trendingPoints(DECLINING), [SHOW.id]: trendingPoints(FLAT) },
      [
        [ALPHA, "brand"],
        [BETA, "brand"],
        [SHOW, "tv_show"],
      ],
    );
    const result = await momentumSkill.run(input(["R1", "R2", "R3"]), run.ctx);

    expect(result.status).toBe("ok");
    expect(result.flags).toEqual(["TRENDING_HISTORICAL_WINDOW"]);
    const metrics = run.ledger.metrics;
    expect(metrics).toHaveLength(3 * 4 + 1);
    for (const m of metrics) {
      expect(m.badge).toBe("STALE");
      expect(m.window).toEqual(TRENDING_WINDOW);
    }
    const byKey = (key: string, ref: string) => metrics.find((m) => m.key === key && m.subjectRefs[0] === ref);
    expect(byKey("mom.delta_26w", "R1")).toMatchObject({
      formulaId: "mom.delta_26w",
      unit: "delta",
      display: "+0.104 · rank 1 of 3",
      n: 26,
      comparator: "WITHIN_CALL",
      evidenceIds: ["E1"],
    });
    expect(byKey("mom.delta_26w", "R2")?.display).toBe("-0.078 · rank 3 of 3");
    expect(byKey("mom.delta_26w", "R3")?.display).toMatch(/ · rank 2 of 3$/);
    expect(byKey("mom.mann_kendall_tau", "R1")).toMatchObject({ formulaId: "mom.mann_kendall", value: 1, display: "+1.00 (a steady rise)" });
    expect(byKey("mom.mann_kendall_p", "R1")).toMatchObject({ formulaId: "mom.mann_kendall", display: "<0.001 (very unlikely to be chance)" });
    expect(byKey("mom.label", "R1")).toMatchObject({ formulaId: "mom.label", value: 1, display: "Rising" });
    expect(byKey("mom.label", "R2")).toMatchObject({ value: -1, display: "Declining" });
    expect(byKey("mom.label", "R3")).toMatchObject({ value: 0, display: "Flat" });

    // Twelve whole months after the window: F = e^-1, which also weighs every STALE conf.
    const fresh = metrics.find((m) => m.key === "mom.freshness");
    expect(fresh).toMatchObject({ formulaId: "mom.freshness", display: "0.37 · 12 months after the window", evidenceIds: ["E1", "E2", "E3"] });
    expect(fresh?.value).toBeCloseTo(Math.exp(-1), 12);
    expect(fresh?.conf).toBeNull();
    expect(byKey("mom.label", "R1")?.conf).toBeCloseTo(Math.exp(-1) * (1 - 1 / Math.sqrt(26)), 12);
  });

  it("builds the Momentum dataset: STALE badge text, weekly points, carets, trends and peer ranks", async () => {
    const weekly = [...RISING];
    weekly[5] = 0.95;
    const run = setup({ [ALPHA.id]: trendingPoints(weekly), [BETA.id]: trendingPoints(DECLINING) }, [
      [ALPHA, "brand"],
      [BETA, "brand"],
    ]);
    await momentumSkill.run(input(["R1", "R2"]), run.ctx);
    const d = momentumDataset(run);
    expect(d.title).toBe("Momentum · Brand Alpha and Brand Beta");
    expect(d.formulaIds).toEqual(["mom.delta_26w", "mom.mann_kendall", "mom.label", "mom.freshness"]);
    expect(d.evidenceIds).toEqual(["E1", "E2"]);
    expect(d.payload).toMatchObject({
      window: TRENDING_WINDOW,
      badge: "STALE",
      badgeText: "HISTORICAL · QLOO TRENDING · 2025-04-01..2025-09-30",
    });
    const [alpha, beta] = d.payload.series;
    expect(alpha).toMatchObject({ ref: "R1", type: "brand", state: "ok", reason: null, trend: "rising", peerRank: { rank: 1, of: 2 }, scaleBreak: false });
    expect(alpha?.points).toHaveLength(26);
    // Only the outlier week is pulled in to the p95 bound and gets a caret; the rest are measured medians.
    expect(alpha?.points[0]).toEqual({ date: "2025-03-31", pct: 0.3, clipped: false });
    expect(alpha?.points[12]).toEqual({ date: "2025-06-23", pct: RISING[12], clipped: false });
    expect(alpha?.points[5]?.clipped).toBe(true);
    expect(alpha?.points[5]?.pct).toBeLessThan(0.95);
    expect(alpha?.points.filter((p) => p.clipped)).toHaveLength(1);
    expect(beta).toMatchObject({ trend: "declining", peerRank: { rank: 2, of: 2 } });
  });

  it("gives a single trend no peer rank", async () => {
    const run = setup({ [ALPHA.id]: trendingPoints(RISING) }, [[ALPHA, "brand"]]);
    await momentumSkill.run(input(["R1"]), run.ctx);
    expect(run.ledger.metrics.find((m) => m.key === "mom.delta_26w")?.display).toBe("+0.104");
    expect(momentumDataset(run).payload.series[0]?.peerRank).toBeNull();
  });
});

describe("momentum: no signal, unavailable types, budget and failures", () => {
  it("shows placeholder and short series as NO SIGNAL, never Flat, with a finding citing their labels", async () => {
    const run = setup(
      { [ALPHA.id]: trendingPoints(RISING), [BETA.id]: trendingPoints(PLACEHOLDER), [SHOW.id]: trendingPoints(linear(0.4, 0.01, 5)) },
      [
        [ALPHA, "brand"],
        [BETA, "brand"],
        [SHOW, "tv_show"],
      ],
    );
    const result = await momentumSkill.run(input(["R1", "R2", "R3"]), run.ctx);

    expect(result.status).toBe("partial");
    expect(result.flags).toEqual(["TRENDING_HISTORICAL_WINDOW", "NO_TREND_SIGNAL"]);
    expect(run.ledger.evidences.map((e) => [e.status, e.flags])).toEqual([
      ["ok", ["TRENDING_HISTORICAL_WINDOW"]],
      ["empty", ["TRENDING_HISTORICAL_WINDOW", "NO_TREND_SIGNAL"]],
      ["empty", ["TRENDING_HISTORICAL_WINDOW", "NO_TREND_SIGNAL"]],
    ]);
    expect(run.ledger.evidences[1]?.summary).toContain("too few distinct values");
    expect(run.ledger.evidences[2]?.summary).toContain("fewer than eight weeks");
    const labels = run.ledger.metrics.filter((m) => m.key === "mom.label");
    expect(labels.map((m) => [m.subjectRefs[0], m.badge, m.reason, m.display])).toEqual([
      ["R1", "STALE", null, "Rising"],
      ["R2", "UNAVAILABLE", "no_signal", "not measured"],
      ["R3", "UNAVAILABLE", "no_signal", "not measured"],
    ]);
    expect(run.ledger.metrics.filter((m) => m.key === "mom.delta_26w").map((m) => m.subjectRefs[0])).toEqual(["R1"]);

    const [finding] = run.ledger.findings;
    expect(finding).toMatchObject({ kind: "NO_TREND_SIGNAL", metricIds: [labels[1]!.id, labels[2]!.id], suggestion: null });
    expect(finding?.text).toContain("Brand Beta and Show Lantern");
    expect(finding?.text).toContain("not flat");

    const series = momentumDataset(run).payload.series;
    expect(series.map((s) => [s.state, s.reason, s.trend, s.delta26w])).toEqual([
      ["ok", null, "rising", expect.any(Number)],
      ["no_signal", "no_signal", null, null],
      ["no_signal", "no_signal", null, null],
    ]);
    expect(series[1]?.points.every((p) => p.pct === 0.42 && !p.clipped)).toBe(true);
    expect(series[0]?.peerRank).toBeNull();
  });

  it("makes no call for artists and persons and records them as UNAVAILABLE with a reason", async () => {
    const run = setup({ [ALPHA.id]: trendingPoints(RISING) }, [
      [ALPHA, "brand"],
      [NOVA, "artist"],
      [SAGE, "person"],
    ]);
    const result = await momentumSkill.run(input(["R1", "R2", "R3"]), run.ctx);
    expect(run.calls).toHaveLength(1);
    expect(result.status).toBe("partial");
    expect(result.forModel.notices).toContain("Qloo trending has data for brands and TV shows only: R2 (artist), R3 (person) not measured.");
    const artist = run.ledger.metrics.find((m) => m.subjectRefs[0] === "R2");
    expect(artist).toMatchObject({ key: "mom.label", badge: "UNAVAILABLE", reason: "unavailable", evidenceIds: [], window: TRENDING_WINDOW });
    expect(momentumDataset(run).payload.series.map((s) => [s.ref, s.state, s.reason, s.points.length])).toEqual([
      ["R1", "ok", null, 26],
      ["R2", "unavailable", "unavailable", 0],
      ["R3", "unavailable", "unavailable", 0],
    ]);
    expect(run.ledger.findings).toEqual([]);
  });

  it("answers an artists-only call as empty without a call, evidence or dataset", async () => {
    const run = setup({}, [[NOVA, "artist"]]);
    const result = await momentumSkill.run(input(["R1"]), run.ctx);
    expect(result.status).toBe("empty");
    expect(run.calls).toHaveLength(0);
    expect(run.ledger.evidences).toHaveLength(0);
    expect(run.ledger.datasets).toHaveLength(0);
    expect(run.ledger.metrics).toEqual([expect.objectContaining({ badge: "UNAVAILABLE", reason: "unavailable" })]);
    expect(result.flags).toEqual([]);
  });

  it("keeps what came back when the budget refuses later calls", async () => {
    const run = setup({ [ALPHA.id]: trendingPoints(RISING), [BETA.id]: trendingPoints(DECLINING) }, [
      [ALPHA, "brand"],
      [BETA, "brand"],
    ], { budget: 1 });
    const result = await momentumSkill.run(input(["R1", "R2"]), run.ctx);
    expect(result.status).toBe("partial");
    expect(result.flags).toEqual(["TRENDING_HISTORICAL_WINDOW", "BUDGET_TRUNCATED"]);
    expect(run.ledger.evidences).toHaveLength(1);
    expect(run.ledger.metrics.find((m) => m.subjectRefs[0] === "R2")).toMatchObject({ badge: "UNAVAILABLE", reason: "budget_truncated" });
    expect(momentumDataset(run).payload.series[1]).toMatchObject({ state: "unavailable", reason: "budget_truncated", points: [] });
    // The digest agrees with the dataset: a refused call is unavailable, never NO SIGNAL.
    expect(result.forModel.top_rows[1]?.values).toMatchObject({ state: "unavailable", reason: "budget_truncated" });
  });

  it("reports a fully truncated call as partial with nothing in the ledger but explained absences", async () => {
    const run = setup({ [ALPHA.id]: trendingPoints(RISING) }, [[ALPHA, "brand"]], { budget: 0 });
    const result = await momentumSkill.run(input(["R1"]), run.ctx);
    expect(result.status).toBe("partial");
    expect(result.flags).toEqual(["BUDGET_TRUNCATED"]);
    expect(run.ledger.evidences).toHaveLength(0);
    expect(run.ledger.datasets).toHaveLength(0);
    expect(run.ledger.metrics).toEqual([expect.objectContaining({ key: "mom.label", reason: "budget_truncated" })]);
    expect(result.forModel.top_rows[0]?.values).toMatchObject({ state: "unavailable", reason: "budget_truncated" });
  });

  it("keeps a failed call as a gap next to good series, and fails outright when every call failed", async () => {
    const run = setup({ [ALPHA.id]: trendingPoints(RISING) }, [
      [ALPHA, "brand"],
      [BETA, "brand"],
    ], { fail: { [BETA.id]: "qloo_unavailable" } });
    const result = await momentumSkill.run(input(["R1", "R2"]), run.ctx);
    expect(result.status).toBe("partial");
    expect(result.flags).toEqual(["TRENDING_HISTORICAL_WINDOW", "CANDIDATES_UNSCORED"]);
    expect(result.forModel.notices).toContain("1 trending call failed (qloo_unavailable); not measured.");
    expect(momentumDataset(run).payload.series[1]).toMatchObject({ state: "unavailable", reason: "error" });
    expect(result.forModel.top_rows[1]?.values).toMatchObject({ state: "unavailable", reason: "error" });

    const all = setup({}, [[BETA, "brand"]], { fail: { [BETA.id]: "qloo_unavailable" } });
    await expect(momentumSkill.run(input(["R1"]), all.ctx)).rejects.toThrow("synthetic qloo_unavailable");
    expect(all.ledger.evidences).toHaveLength(0);

    const bug = setup({ [ALPHA.id]: trendingPoints(RISING) }, [
      [ALPHA, "brand"],
      [BETA, "brand"],
    ], { fail: { [BETA.id]: "qloo_param" } });
    await expect(momentumSkill.run(input(["R1", "R2"]), bug.ctx)).rejects.toThrow("synthetic qloo_param");
  });
});

describe("momentum: inputs, estimate, digest", () => {
  it("leaves out refs the registry does not know and errors when none is left", async () => {
    const run = setup({ [ALPHA.id]: trendingPoints(RISING) }, [[ALPHA, "brand"]]);
    const result = await momentumSkill.run(input(["R1", "R7"]), run.ctx);
    expect(result.forModel.notices).toContain("R7 is not in the registry; left out.");
    expect(momentumDataset(run).payload.series.map((s) => s.ref)).toEqual(["R1"]);

    const none = setup({}, []);
    const error = await momentumSkill.run(input(["R4"]), none.ctx);
    expect(error.status).toBe("error");
    expect(error.forModel.notices).toEqual(["R4 is not in the registry; left out. Resolve the entities first."]);
  });

  it("trends an entity as its registered type and says so when the input type differs", async () => {
    const run = setup({ [SHOW.id]: trendingPoints(RISING) }, [[SHOW, "tv_show"]]);
    const result = await momentumSkill.run(input(["R1"], "brand"), run.ctx);
    expect(run.calls[0]?.params["filter.type"]).toBe("urn:entity:tv_show");
    expect(result.forModel.notices).toContain("R1 (Show Lantern) is a tv_show, so it was trended as a tv_show, not a brand.");
  });

  it("counts one call per uncached brand or TV show, cached and untrendable ones free", async () => {
    const registry = new FakeRegistry();
    for (const [e, type] of [[ALPHA, "brand"], [BETA, "brand"], [SHOW, "tv_show"], [NOVA, "artist"]] as const) registerInvented(registry, e, type);
    const cold = fakeProbe(() => false);
    expect(await momentumSkill.estimateCalls(input(["R1", "R2", "R3", "R4"]), cold, registry)).toBe(3);
    expect(cold.asked.map((a) => [a.path, a.params["filter.type"]])).toEqual([
      ["/v2/trending", "urn:entity:brand"],
      ["/v2/trending", "urn:entity:brand"],
      ["/v2/trending", "urn:entity:tv_show"],
    ]);
    const warm = fakeProbe((_, p) => (p["signal.interests.entities"] as readonly string[])[0] !== BETA.id);
    expect(await estimateMomentumCalls(input(["R1", "R2", "R3", "R4"]), warm, registry)).toBe(1);
    expect(await momentumSkill.estimateCalls(input(["R4"]), cold, registry)).toBe(0);
    expect(trendingParams({ entityId: ALPHA.id, type: "brand" })).toEqual(cold.asked[0]?.params);
  });

  it("fits four long-named series into the digest, names the window first and leaks no Qloo ids", async () => {
    const long = (e: Invented): Invented => ({ ...e, name: `${e.name} Heritage Trading Company Limited of Somewhere` });
    const entities = [ALPHA, BETA, SHOW, { id: "ent-delta-04", name: "Brand Delta", category: null }].map(long);
    const run = setup(
      Object.fromEntries(entities.map((e, i) => [e.id, trendingPoints(i === 3 ? PLACEHOLDER : linear(0.2 + 0.1 * i, 0.002 * (i - 1)))])),
      entities.map((e, i) => [e, i === 2 ? "tv_show" : "brand"] as [Invented, "brand" | "tv_show"]),
    );
    const result = await momentumSkill.run(input(["R1", "R2", "R3", "R4"]), run.ctx);
    const digest = ModelDigest.parse(result.forModel);
    expect(digestFits(digest, { tool: "momentum", step: "S4" })).toBe(true);
    expect(digest.metrics.map((m) => m.id)).toEqual(run.ledger.metrics.map((m) => m.id));
    expect(digest.notices[0]).toBe(`Trending window ${windowText()} is historical: every momentum figure describes that past window, not today; name the window with {{WINDOW}} and do not write the badge word.`);
    expect(digest.dataset_ids).toEqual(["D1"]);
    expect(digest.top_rows[0]?.values).toMatchObject({ type: "brand", state: "ok", delta_metric: expect.stringMatching(/^M\d+$/) as string });
    expect(digest.top_rows[3]?.values).toMatchObject({ state: "no_signal", reason: "too few distinct values (a placeholder series)" });
    expect(JSON.stringify(digest)).not.toContain("ent-");
  });

  it("returns its fixed method limitation", () => {
    expect(momentumSkill.limitations(["NO_TREND_SIGNAL"])).toEqual([...SKILL_LIMITATIONS.momentum]);
    expect(momentumSkill.mnemonic).toBe("MOM");
  });
});
