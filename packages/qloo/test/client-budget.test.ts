import { DEFAULT_RUN_LIMITS, type Mode, type Phase, type RunLimits } from "@ct/contracts";
import { describe, expect, it } from "vitest";
import type { QlooBudgetWarning } from "../src/budget";
import { BudgetError, type BudgetGate } from "../src/errors";
import { QUOTA_KV_KEY, utcDay } from "../src/quota";
import { createMemoryQlooStore, type QlooCallLogRow } from "../src/store";
import { fakeTransport, harness, runScope, START } from "./support/fakes";

const HOUR = 3_600_000;
const limits = (over: Partial<RunLimits>): RunLimits => ({ ...DEFAULT_RUN_LIMITS, ...over });
const names = (n: number) => Array.from({ length: n }, (_, i) => `Brand Fixture ${String.fromCharCode(65 + i)}`);

async function gateOf(p: Promise<unknown>): Promise<BudgetGate | null> {
  try {
    await p;
    return null;
  } catch (err) {
    if (err instanceof BudgetError) return err.gate;
    throw err;
  }
}

function priorRows(n: number, over: Partial<QlooCallLogRow> = {}): QlooCallLogRow[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `prior-${i}`,
    ts: new Date(START),
    env: "dev",
    tag: "test-agent",
    runId: null,
    path: "/search",
    filterType: null,
    params: { query: `prior ${i}` },
    cacheKey: `prior-key-${i}`,
    cacheStatus: "miss",
    httpStatus: 200,
    ms: 1,
    requestId: null,
    monthRemaining: null,
    error: null,
    ...over,
  }));
}

describe("run cap and follow-up cap", () => {
  it("refuses network calls beyond the run cap but keeps serving the cache", async () => {
    const h = harness();
    const run = h.client.forRun(runScope({ limits: limits({ qlooCalls: 2, qlooWarnAt: 2 }) }));
    const qloo = run.forTool(null);
    const [a, b, c] = names(3);
    await qloo.search({ query: a ?? "" });
    await qloo.search({ query: b ?? "" });
    expect(await gateOf(qloo.search({ query: c ?? "" }))).toBe("run_cap");
    expect((await qloo.search({ query: a ?? "" })).meta.cache).toBe("hit");
    expect(run.networkUsed()).toBe(2);
    expect(h.transport.requests).toHaveLength(2);
  });

  it("warns once at qlooWarnAt", async () => {
    const warnings: QlooBudgetWarning[] = [];
    const h = harness();
    const qloo = h.client
      .forRun(runScope({ limits: limits({ qlooCalls: 5, qlooWarnAt: 3 }), onWarn: (w) => warnings.push(w) }))
      .forTool(null);
    for (const name of names(5)) await qloo.search({ query: name });
    expect(warnings).toEqual([{ runId: "run-alpha", used: 3, warnAt: 3, cap: 5 }]);
  });

  it("holds follow-ups to their sub-cap and counts them separately", async () => {
    let phase: Phase = "wave1";
    const h = harness();
    const run = h.client.forRun(runScope({ limits: limits({ followupCalls: 2 }), phase: () => phase }));
    const qloo = run.forTool(null);
    const [a, b, c, d] = names(4);
    await qloo.search({ query: a ?? "" });
    phase = "followup";
    await qloo.search({ query: b ?? "" });
    await qloo.search({ query: c ?? "" });
    expect(await gateOf(qloo.search({ query: d ?? "" }))).toBe("followup_cap");
    expect(run.networkUsed()).toBe(3);
    expect(run.followupNetworkUsed()).toBe(2);
  });

  it("checks the run cap before the follow-up cap", async () => {
    const h = harness();
    const qloo = h.client
      .forRun(runScope({ limits: limits({ qlooCalls: 1, qlooWarnAt: 1, followupCalls: 1 }), phase: () => "followup" }))
      .forTool(null);
    const [a, b] = names(2);
    await qloo.search({ query: a ?? "" });
    expect(await gateOf(qloo.search({ query: b ?? "" }))).toBe("run_cap");
  });

  it("gives the budget back when a call is cancelled before it is sent", async () => {
    const h = harness();
    const controller = new AbortController();
    controller.abort();
    const run = h.client.forRun(runScope({ signal: controller.signal }));
    await expect(run.forTool(null).search({ query: "Brand Alpha" })).rejects.toMatchObject({ name: "AbortError" });
    expect(run.networkUsed()).toBe(0);
    expect(h.transport.requests).toHaveLength(0);
  });
});

describe("per-tag dev cap", () => {
  it("counts this tag's network calls in the store, across processes", async () => {
    const store = createMemoryQlooStore();
    await store.logCalls([
      ...priorRows(2),
      ...priorRows(5, { tag: "other-agent", id: "other" }).map((r, i) => ({ ...r, id: `other-${i}` })),
      ...priorRows(5, { env: "mock" }).map((r, i) => ({ ...r, id: `mock-${i}` })),
      ...priorRows(5, { cacheStatus: "hit" }).map((r, i) => ({ ...r, id: `hit-${i}` })),
    ]);
    const h = harness({ store, tagCap: 3 });
    const qloo = h.client.standalone().forTool(null);
    const [a, b] = names(2);
    await qloo.search({ query: a ?? "" });
    expect(await gateOf(qloo.search({ query: b ?? "" }))).toBe("tag_cap");
    await h.client.flush();

    const next = harness({ store, tagCap: 3 });
    expect(await gateOf(next.client.standalone().forTool(null).search({ query: b ?? "" }))).toBe("tag_cap");
    expect(next.transport.requests).toHaveLength(0);
  });

  it("holds under concurrency", async () => {
    const h = harness({ tagCap: 3 });
    const qloo = h.client.standalone().forTool(null);
    const results = await Promise.allSettled(names(6).map((query) => qloo.search({ query })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    expect(h.transport.requests).toHaveLength(3);
  });

  it("never applies in mock mode, where calls cost nothing", async () => {
    const store = createMemoryQlooStore();
    await store.logCalls(priorRows(5, { env: "mock" }));
    const h = harness({ store, env: "mock", tagCap: 2 });
    const qloo = h.client.standalone().forTool(null);
    for (const name of names(3)) await qloo.search({ query: name });
    expect(h.transport.requests).toHaveLength(3);
  });

  it("is off when tagCap is null", async () => {
    const store = createMemoryQlooStore();
    await store.logCalls(priorRows(500));
    const h = harness({ store, tagCap: null });
    await h.client.standalone().forTool(null).search({ query: "Brand Alpha" });
    expect(h.transport.requests).toHaveLength(1);
  });
});

describe("daily lane cap (prod)", () => {
  it("splits the daily fresh cap 60/40 between public and judge lanes", async () => {
    const h = harness({ env: "prod", dailyFreshCap: 10, monthFloor: 0 });
    const judge = h.client.forRun(runScope({ runId: "run-judge", lane: "judge" })).forTool(null);
    const pub = h.client.forRun(runScope({ runId: "run-public", lane: "public" })).forTool(null);
    const all = names(12);
    for (const name of all.slice(0, 4)) await judge.search({ query: name });
    expect(await gateOf(judge.search({ query: all[4] ?? "" }))).toBe("daily_lane_cap");
    for (const name of all.slice(4, 10)) await pub.search({ query: name });
    expect(await gateOf(pub.search({ query: all[10] ?? "" }))).toBe("daily_lane_cap");
    await h.client.flush();
    const day = utcDay(START);
    expect(await h.store.freshCalls({ day, lane: "judge" })).toBe(4);
    expect(await h.store.freshCalls({ day, lane: "public" })).toBe(6);
    expect(await h.store.freshCalls({ day, lane: "all" })).toBe(10);
    expect(await gateOf(h.client.standalone().forTool(null).search({ query: all[11] ?? "" }))).toBe("daily_lane_cap");
  });

  it("holds the day's total when standalone calls share it with the lanes", async () => {
    const h = harness({ env: "prod", dailyFreshCap: 10, monthFloor: 0 });
    const loose = h.client.standalone().forTool(null);
    const pub = h.client.forRun(runScope({ runId: "run-public", lane: "public" })).forTool(null);
    const judge = h.client.forRun(runScope({ runId: "run-judge", lane: "judge" })).forTool(null);
    const all = names(12);
    for (const name of all.slice(0, 5)) await loose.search({ query: name });
    // The public lane is under its share of 6, but the day's 10 are spent.
    for (const name of all.slice(5, 10)) await pub.search({ query: name });
    expect(await gateOf(pub.search({ query: all[10] ?? "" }))).toBe("daily_lane_cap");
    expect(await gateOf(judge.search({ query: all[11] ?? "" }))).toBe("daily_lane_cap");
    expect(h.transport.requests).toHaveLength(10);
    await h.client.flush();
    expect(await h.store.freshCalls({ day: utcDay(START), lane: "all" })).toBe(10);
  });

  it("counts usage in dev without gating it, and leaves mock calls out", async () => {
    const dev = harness({ dailyFreshCap: 1 });
    const qloo = dev.client.forRun(runScope()).forTool(null);
    for (const name of names(3)) await qloo.search({ query: name });
    await dev.client.flush();
    expect(await dev.store.freshCalls({ day: utcDay(START), lane: "public" })).toBe(3);

    const mock = harness({ env: "mock" });
    await mock.client.forRun(runScope()).forTool(null).search({ query: "Brand Alpha" });
    await mock.client.flush();
    expect(await mock.store.freshCalls({ day: utcDay(START), lane: "all" })).toBe(0);
  });
});

describe("month floor", () => {
  it("stops development below 32,000 remaining without changing the mode", async () => {
    const modes: Mode[] = [];
    const h = harness({ onModeChange: (m) => modes.push(m), transport: fakeTransport(() => ({ headers: { monthRemaining: 31_999 } })) });
    const qloo = h.client.standalone().forTool(null);
    const [a, b] = names(2);
    await qloo.search({ query: a ?? "" });
    expect(await gateOf(qloo.search({ query: b ?? "" }))).toBe("month_floor");
    expect(modes).toEqual([]);
    expect(h.client.monthFloor).toBe(32_000);
  });

  it("switches prod to replay_only below 2,000 remaining, once", async () => {
    const modes: Mode[] = [];
    const h = harness({ env: "prod", onModeChange: (m) => modes.push(m), transport: fakeTransport(() => ({ headers: { monthRemaining: 1_999 } })) });
    const qloo = h.client.standalone().forTool(null);
    const [a, b, c] = names(3);
    await qloo.search({ query: a ?? "" });
    expect(await gateOf(qloo.search({ query: b ?? "" }))).toBe("month_floor");
    expect(await gateOf(qloo.search({ query: c ?? "" }))).toBe("month_floor");
    expect(modes).toEqual(["replay_only"]);
  });

  it("loads the persisted snapshot before the first network call", async () => {
    const store = createMemoryQlooStore();
    await store.setKv(QUOTA_KV_KEY, {
      monthLimit: 50_000,
      monthRemaining: 30_000,
      monthReset: null,
      capturedAt: new Date(START).toISOString(),
      lastSuccessAt: null,
      consecutiveAuthErrors: 0,
      day: utcDay(START),
      todayNetwork: 7,
    });
    const h = harness({ store });
    expect(await gateOf(h.client.standalone().forTool(null).search({ query: "Brand Alpha" }))).toBe("month_floor");
    expect(h.client.quota()).toMatchObject({ monthRemaining: 30_000, todayNetwork: 7 });
  });

  it("lets calls through again once the monthly window resets, and reads the new count", async () => {
    const store = createMemoryQlooStore();
    await store.setKv(QUOTA_KV_KEY, {
      monthLimit: 50_000,
      monthRemaining: 1_990,
      monthReset: new Date(START + HOUR).toISOString(),
      capturedAt: new Date(START - HOUR).toISOString(),
      lastSuccessAt: null,
      consecutiveAuthErrors: 0,
      day: utcDay(START),
      todayNetwork: 0,
    });
    const modes: Mode[] = [];
    const h = harness({ store, env: "prod", onModeChange: (m) => modes.push(m) });
    const qloo = h.client.standalone().forTool(null);
    const [a, b] = names(2);
    expect(await gateOf(qloo.search({ query: a ?? "" }))).toBe("month_floor");
    expect(modes).toEqual(["replay_only"]);
    h.clock.advance(HOUR);
    expect((await qloo.search({ query: b ?? "" })).meta.cache).toBe("miss");
    expect(h.client.quota()).toMatchObject({ monthRemaining: 45_000, monthReset: new Date(START + HOUR + HOUR).toISOString() });
    expect(h.transport.requests).toHaveLength(1);
  });
});

describe("gate order", () => {
  it("reports the first failing gate: tag cap before daily cap before month floor", async () => {
    const store = createMemoryQlooStore();
    await store.logCalls(priorRows(3, { env: "prod" }));
    await store.addFreshCalls({ day: utcDay(START), lanes: ["public", "all"], count: 100 });
    await store.setKv(QUOTA_KV_KEY, {
      monthLimit: 50_000,
      monthRemaining: 10,
      monthReset: null,
      capturedAt: null,
      lastSuccessAt: null,
      consecutiveAuthErrors: 0,
      day: utcDay(START),
      todayNetwork: 0,
    });
    const run = (tagCap: number | null, dailyFreshCap: number) =>
      harness({ store, env: "prod", tagCap, dailyFreshCap }).client.forRun(runScope()).forTool(null).search({ query: "Brand Alpha" });
    expect(await gateOf(run(3, 10))).toBe("tag_cap");
    expect(await gateOf(run(null, 10))).toBe("daily_lane_cap");
    expect(await gateOf(run(null, 1_000))).toBe("month_floor");
  });
});

describe("quota snapshot", () => {
  it("tracks headers and today's calls and persists them to kv", async () => {
    const h = harness({ transport: fakeTransport(() => ({ headers: { monthRemaining: 44_321, monthLimit: 50_000, monthReset: 60 } })) });
    const qloo = h.client.standalone().forTool(null);
    for (const name of names(3)) await qloo.search({ query: name });
    await h.client.flush();
    const saved = h.store.kv.get(QUOTA_KV_KEY);
    expect(saved).toMatchObject({
      monthRemaining: 44_321,
      monthLimit: 50_000,
      monthReset: new Date(START + 60_000).toISOString(),
      todayNetwork: 3,
      consecutiveAuthErrors: 0,
      lastSuccessAt: new Date(START).toISOString(),
    });
    expect(h.client.quota()).toEqual(saved);
  });

  it("keeps mock headers out of the live snapshot", async () => {
    const h = harness({ env: "mock" });
    await h.client.standalone().forTool(null).search({ query: "Brand Alpha" });
    await h.client.flush();
    expect(h.store.kv.has(QUOTA_KV_KEY)).toBe(false);
    expect(h.store.kv.has("qloo.quota.mock")).toBe(true);
  });
});
