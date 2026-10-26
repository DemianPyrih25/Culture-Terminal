// Fakes for /status: the sources server/status.ts reads, and a finished report for the page. Invented
// numbers only; no question, entity or request id appears anywhere in a status reading.
import type { Lane, Mode, RunStatus } from "@ct/contracts";
import type { LaneBudget, ModeDecision } from "../../server/breakers";
import type { LocalityCoverage } from "../../server/localities";
import type { QlooView, StatusLimits, StatusReport, StatusSources } from "../../server/status";

export const NOW = Date.parse("2026-10-23T12:00:00.000Z");
export const TODAY = "2026-10-23";

// Canaries: invented private values a test plants in a source to show they never reach a reading or
// the page (D31). None is a real entity, request id or key.
export const CANARY_ENTITY = "Canary Fizz Soda";
export const CANARY_QUESTION = `How loved is ${CANARY_ENTITY}?`;
export const CANARY_REQUEST_ID = "canary-request-0001";
// Built at runtime: a key-shaped literal would trip the secret scanner it imitates.
export const CANARY_API_KEY = ["canary", "anthropic", "key", "0001"].join("-");

export const BUDGETS: Record<Lane, LaneBudget> = {
  public: { economyAt: 0.49, replayAt: 0.79, cap: 0.84 },
  judge: { economyAt: 1, replayAt: 1.35, cap: 1.4 },
};

export const LIMITS: StatusLimits = {
  llmDailyUsdCap: 1.4,
  hourlyCap: { public: 20, judge: 20 },
  slots: { public: 3, judge: 1 },
  fakeHourlyCap: 60,
  qlooDailyFreshCap: 1900,
  qlooDisabled: false,
};

export function decision(lane: Lane, mode: Mode = "live", over: Partial<ModeDecision> = {}): ModeDecision {
  return { lane, mode, breaker: null, reason: null, message: null, until: null, ...over };
}

export function qlooView(over: Partial<QlooView> = {}, quota: Partial<QlooView["quota"]> = {}): QlooView {
  return {
    env: "prod",
    monthFloor: 2000,
    ...over,
    quota: {
      monthLimit: 50_000,
      monthRemaining: 41_000,
      monthReset: "2026-11-05T19:00:00.000Z",
      capturedAt: "2026-10-23T11:58:00.000Z",
      lastSuccessAt: "2026-10-23T11:58:00.000Z",
      consecutiveAuthErrors: 0,
      day: TODAY,
      todayNetwork: 30,
      ...quota,
    },
  };
}

/** Every market a run needs is pinned (market ids and counts only: a coverage never holds a locality id). */
export const LOCALITIES: LocalityCoverage = { state: "complete", required: ["nashville", "austin"], missing: [], pinned: 2 };

const LIVE_RECENT: RunStatus[] = ["completed", "completed", "failed", "incomplete", "completed"];
const TEST_RECENT: RunStatus[] = ["running", "cancelled", "completed"];

export interface FakeSources extends StatusSources {
  /** Names of the async reads made, in call order. */
  reads: string[];
}

/** Sources of a healthy prod server; `over` replaces any of them. */
export function fakeSources(over: Partial<StatusSources> = {}): FakeSources {
  const reads: string[] = [];
  const track =
    <A extends unknown[], T>(name: string, fn: (...args: A) => Promise<T>) =>
    (...args: A): Promise<T> => {
      reads.push(name);
      return fn(...args);
    };
  let clock = NOW;
  const base: StatusSources = {
    now: () => (clock += 5),
    version: () => "0.0.0-test",
    uptimeS: () => 3_700,
    limits: () => LIMITS,
    anthropicConfigured: () => true,
    runManager: () => ({ activeCount: () => 1, isAccepting: () => true }),
    migrations: () => ({ applied: true, skipped: false, journal: { count: 2, latest: "0001_invented_step" } }),
    override: () => null,
    budget: (lane) => BUDGETS[lane],
    lastKnownMode: () => "live",
    pingDb: track("ping", async () => true),
    storedMode: track("stored", async () => ({ mode: "live" as const, reason: null, since: null })),
    decide: track("decide", async () => ({ public: decision("public"), judge: decision("judge") })),
    llmUsd: track("llm", async (_day: string, lane: Lane | "all") => (lane === "all" ? 0.12 : lane === "public" ? 0.1 : 0.02)),
    qlooFresh: track("fresh", async (_day: string, lane: Lane | "all") => (lane === "all" ? 120 : lane === "public" ? 100 : 20)),
    laneRunsSince: track("lane runs", async (lane: Lane) => (lane === "public" ? 4 : 1)),
    runsSince: track("runs", async () => 6),
    recentStatuses: track("recent", async (prefix: string) => (prefix.startsWith("fake") ? TEST_RECENT : LIVE_RECENT)),
    qlooCache: track("cache", async () => ({ total: 400, served: 300, sampled: false })),
    localities: track("localities", async () => LOCALITIES),
    qloo: track("qloo", async () => qlooView()),
  };
  return { ...base, ...over, reads };
}

/** A finished reading of a healthy prod server, for the page. */
export function statusReport(over: Partial<StatusReport> = {}): StatusReport {
  return {
    readAt: "2026-10-23T12:00:00.000Z",
    readMs: 42,
    version: "0.0.0-test",
    uptimeS: 3_700,
    mode: {
      stored: { mode: "live", reason: null, since: null },
      override: null,
      lanes: { public: decision("public"), judge: decision("judge") },
    },
    live: { state: "live", blocks: [], message: null },
    breakers: [
      { key: "stored", level: "clear" },
      { key: "override", level: "clear" },
      { key: "llm_spend", level: "clear" },
      { key: "qloo_floor", level: "clear" },
      { key: "qloo_daily", level: "clear" },
      { key: "qloo_auth", level: "clear" },
      { key: "live_hourly", level: "clear" },
      { key: "qloo_switch", level: "clear" },
      { key: "draining", level: "clear" },
    ],
    llm: { configured: true, todayUsd: 0.12, laneUsd: { public: 0.1, judge: 0.02 }, capUsd: 1.4, budgets: BUDGETS },
    runs: {
      accepting: true,
      activeHere: 1,
      slots: { public: 3, judge: 1 },
      recentLimit: 20,
      lanes: { public: { lastHour: 4, hourlyCap: 20 }, judge: { lastHour: 1, hourlyCap: 20 } },
      test: { lastHour: 6, hourlyCap: 60 },
      recent: { live: LIVE_RECENT, test: TEST_RECENT },
    },
    qloo: {
      configured: true,
      disabled: false,
      env: "prod",
      today: { network: 120, cap: 1900, enforced: true, lanes: { public: { used: 100, cap: 1140 }, judge: { used: 20, cap: 760 } } },
      month: { remaining: 41_000, limit: 50_000, floor: 2000, resetsAt: "2026-11-05T19:00:00.000Z", capturedAt: "2026-10-23T11:58:00.000Z" },
      cache: { total: 400, served: 300, sampled: false },
      lastSuccessAt: "2026-10-23T11:58:00.000Z",
      authErrors: 0,
      authErrorsTrip: 3,
    },
    db: { ok: true, latencyMs: 4 },
    migrations: { state: "applied", journal: { count: 2, latest: "0001_invented_step" } },
    localities: LOCALITIES,
    ...over,
  };
}
