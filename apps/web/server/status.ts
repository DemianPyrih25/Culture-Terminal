import "server-only";
import { readFileSync } from "node:fs";
import path from "node:path";
import { MarketId, type Lane, type Mode, type RunStatus } from "@ct/contracts";
import { countQlooCallsByCache, countRunsSince, getKv, getQlooUsage, pingDb, recentRunStatuses, type Queryable } from "@ct/db";
import { LANE_SHARE, MOCK_QUOTA_KV_KEY, QUOTA_KV_KEY, QuotaSnapshot, utcDay, type QlooClient, type QlooEnv } from "@ct/qloo";
import { z } from "zod";
import metros from "../../../config/metros.json";
import { QLOO_RUN_MARGIN, type LaneBudget, type ModeDecision } from "./breakers";
import {
  agentRunHourlyCapFromEnv,
  agentRunMaxActiveFromEnv,
  fakeRunHourlyCapFromEnv,
  judgeRunHourlyCapFromEnv,
  judgeRunMaxActiveFromEnv,
  llmDailyUsdCapFromEnv,
  modeOverrideFromEnv,
  qlooDailyFreshCapFromEnv,
  qlooDisabledFromEnv,
} from "./config";
import {
  getAnthropic,
  getDatabase,
  getModeService,
  getQlooClient,
  getRunManager,
  getStoredMode,
  lastKnownMode,
} from "./container";
import { LLM_USD_METRIC } from "./llm-spend";
import { localitiesKvKey, localityCoverage, type LocalityCoverage } from "./localities";
import { log } from "./log";
import type { StoredModeValue } from "./mode";
import { QUESTION_HASH_PREFIX } from "./question-hash";
import { countLaneRunsSince } from "./run-counts";
import { judgeTokenFromEnv } from "./access";
import { FAKE_HASH_PREFIX, laneSlots } from "./run-manager";
import { migrationsApplied, resolveMigrationsDir } from "./startup";
import { appVersion } from "./version";

/**
 * /status (PLAN Part 7, P1 item 13): one reading of the service for the people running it. Each
 * lane's mode and the breaker behind it, every breaker's state, today's LLM spend against the lanes'
 * thresholds, runs in the last hour against their caps, Qloo calls today and the month's quota
 * against its floor, today's cache hit rate, the latest runs' outcomes, and the database, migrations
 * and version, and whether kv pins every market's locality. It composes what the mode machine
 * (breakers.ts), the container, llm-spend, the run manager, the Qloo client, localities.ts and @ct/db
 * already expose; it changes none of them. Statuses and counts
 * only: no question, entity, request id or secret ever leaves here (D31). Every read is bounded and
 * may fail on its own: a part that could not be read is null, never an error.
 */

/** Latest runs whose outcomes are shown, per kind. */
export const RECENT_RUNS = 20;
/** A reading is reused this long, so a page reloaded in a loop costs the database one reading. */
export const STATUS_REUSE_MS = 5_000;
/** Each read gives up after this and reports null (a read that hangs must not hang the page). */
const READ_TIMEOUT_MS = 3_000;
/**
 * 401/403 answers in a row after which the Qloo client stores replay only (SPEC §11.6, "three in a
 * row"). @ct/qloo keeps its own constant (AUTH_ERRORS_TO_REPLAY_ONLY, not exported; change request).
 */
export const QLOO_AUTH_ERRORS_TRIP = 3;
/** PLAN §10.3: warnings at 50% and 80% of the Qloo quota and of LLM spend. */
const HALF = 0.5;
const HIGH = 0.8;
const HOUR_MS = 3_600_000;

/**
 * How near a breaker is to stopping something: clear, past 50% or 80% of its budget, a streak that has
 * begun but not reached its trip point (a count, not a share: the Qloo key's rejections), stepped down
 * to economy, tripped, bypassed (MODE_OVERRIDE), not enforced here, or not read.
 */
export type StatusLevel = "clear" | "half" | "high" | "warn" | "stepped" | "tripped" | "bypassed" | "off" | "unknown";

/**
 * Everything that can stop or step down live analysis, in the order the page lists them: the mode
 * machine's breakers first (breakers.ts names them so), then the Qloo client's key streak, the hourly
 * cap, the QLOO_DISABLED switch and a restart's drain.
 */
export const BREAKER_KEYS = [
  "stored",
  "override",
  "llm_spend",
  "qloo_floor",
  "qloo_daily",
  "qloo_auth",
  "live_hourly",
  "qloo_switch",
  "draining",
] as const;
export type BreakerKey = (typeof BREAKER_KEYS)[number];

export interface BreakerState {
  key: BreakerKey;
  level: StatusLevel;
}

/**
 * What stops or holds back a live question on this server, most fundamental first: setup and restart
 * (no run at all), a paused lane, the hourly cap (wait), then QLOO_DISABLED (runs, without evidence).
 */
export type LiveBlock = "no_database" | "draining" | "no_anthropic" | "no_qloo" | "replay_only" | "live_hourly" | "qloo_disabled";

/**
 * What a public live question gets: written live (Sonnet) or in economy (Haiku); limited, while the
 * hourly cap is used or while Qloo calls are switched off (runs answer as insufficient evidence);
 * paused by a breaker; unavailable on this server (setup, restart).
 */
export type LiveState = "live" | "economy" | "limited" | "paused" | "unavailable";

/** A lane's decision as the page shows it (breakers.ts ModeDecision). */
export type LaneDecision = Pick<ModeDecision, "mode" | "breaker" | "reason" | "message" | "until">;

export interface StatusReport {
  /** When this reading was taken (ISO) and how long it took. */
  readAt: string;
  readMs: number;
  version: string;
  uptimeS: number;
  mode: {
    /** kv "mode" with who set it and when (reason and since null when not stored). */
    stored: StoredModeValue;
    /** MODE_OVERRIDE, which bypasses every breaker; null when unset. */
    override: Mode | null;
    /** Each lane's mode as the breakers decide it now; null when it could not be decided. */
    lanes: Record<Lane, LaneDecision> | null;
  };
  /** The public lane, which steps down first, as a visitor meets it. */
  live: { state: LiveState; blocks: LiveBlock[]; message: string | null };
  breakers: BreakerState[];
  llm: {
    /** An Anthropic API key is set (never the key itself). */
    configured: boolean;
    /** Today's (UTC) spend across lanes and per lane; null when it could not be read. */
    todayUsd: number | null;
    laneUsd: Record<Lane, number | null>;
    capUsd: number;
    /** Today's spend at which each lane steps down to economy, then pauses (breakers.ts laneBudget). */
    budgets: Record<Lane, LaneBudget>;
  };
  runs: {
    /** This process takes new runs (false while it drains for a restart); null when unknown. */
    accepting: boolean | null;
    /** Runs in progress in this process, live and test. */
    activeHere: number | null;
    /** Live runs one process holds at once, per lane. */
    slots: Record<Lane, number>;
    /** How many of the latest runs `recent` reads (RECENT_RUNS). */
    recentLimit: number;
    /** Live runs per lane in the last hour, counted in the database, against the lane's cap. */
    lanes: Record<Lane, HourCount>;
    test: HourCount;
    /** Statuses of the latest live and test runs, newest first. */
    recent: { live: RunStatus[] | null; test: RunStatus[] | null };
  };
  qloo: QlooStatus;
  db: { ok: boolean; latencyMs: number | null };
  migrations: { state: "applied" | "pending" | "skipped"; journal: MigrationJournal | null };
  /**
   * kv metro_localities against the map cities every run needs (localities.ts) and every market in
   * config/metros.json: market ids and counts, never a locality id. Null when it could not be read.
   */
  localities: LocalityStatus | null;
}

/**
 * The locality pins on /status. The coverage fields are the map cities every run needs
 * (REQUIRED_LOCALITY_MARKETS); `markets` is the same kv value against every market in
 * config/metros.json, which share, slate and the place search read.
 */
export interface LocalityStatus extends LocalityCoverage {
  markets: {
    /** Markets in config/metros.json. */
    total: number;
    /** Of those, the ones kv does not pin, in config order: all of them when the value is missing or malformed. */
    missing: MarketId[];
  };
}

export interface HourCount {
  /** Runs started in the last hour by every process, whatever their status. */
  lastHour: number | null;
  hourlyCap: number;
}

export type QlooStatus = { configured: false; disabled: boolean } | QlooConfigured;

export interface QlooConfigured {
  configured: true;
  /** QLOO_DISABLED=1: no Qloo call at all, runs take the fail-closed path. */
  disabled: boolean;
  env: QlooEnv;
  today: {
    /**
     * Fresh (network) calls today: the stored counter across servers, or this server's own count if
     * higher; in mock mode this server's count only.
     */
    network: number;
    cap: number;
    /** The daily cap holds in prod only. */
    enforced: boolean;
    lanes: Record<Lane, { used: number | null; cap: number }>;
  };
  month: { remaining: number | null; limit: number | null; floor: number; resetsAt: string | null; capturedAt: string | null };
  /** Today's calls served without the network (hit, reused, coalesced); null when the log could not be read. */
  cache: QlooCacheCount | null;
  lastSuccessAt: string | null;
  authErrors: number;
  authErrorsTrip: number;
}

export interface QlooCacheCount {
  /** Calls counted, and of those the ones served without a network call. */
  total: number;
  served: number;
  /** True when the rate covers only the latest calls; the SQL count covers every call, so it is false. */
  sampled: boolean;
}

export interface MigrationJournal {
  count: number;
  latest: string | null;
}

/** The env-derived limits the reading is measured against. */
export interface StatusLimits {
  llmDailyUsdCap: number;
  hourlyCap: Record<Lane, number>;
  slots: Record<Lane, number>;
  fakeHourlyCap: number;
  qlooDailyFreshCap: number;
  qlooDisabled: boolean;
}

/** The part of the Qloo client status reads. */
export interface QlooView {
  env: QlooEnv;
  monthFloor: number;
  quota: QuotaSnapshot;
}

/** Everything status reads; tests pass fakes, the page the defaults (defaultStatusSources). */
export interface StatusSources {
  now(): number;
  version(): string;
  uptimeS(): number;
  limits(): StatusLimits;
  anthropicConfigured(): boolean;
  /** This process's run manager; throws when it cannot be made (no database configured). */
  runManager(): { activeCount(): number; isAccepting(): boolean };
  migrations(): { applied: boolean; skipped: boolean; journal: MigrationJournal | null };
  /** MODE_OVERRIDE as it is now. */
  override(): Mode | null;
  /** Each lane's spend thresholds (pure: the mode machine's policy). */
  budget(lane: Lane): LaneBudget;
  /** The mode without a database read, for when the database is down. */
  lastKnownMode(): Mode;
  pingDb(): Promise<boolean>;
  storedMode(): Promise<StoredModeValue>;
  /** Both lanes' decisions from one read of the breakers' inputs. */
  decide(): Promise<Record<Lane, ModeDecision>>;
  /** usage_daily for the UTC day: LLM USD and fresh Qloo calls, per lane or "all". */
  llmUsd(day: string, lane: Lane | "all"): Promise<number>;
  qlooFresh(day: string, lane: Lane | "all"): Promise<number>;
  laneRunsSince(lane: Lane, sinceMs: number): Promise<number>;
  runsSince(hashPrefix: string, sinceMs: number): Promise<number>;
  recentStatuses(hashPrefix: string, limit: number): Promise<RunStatus[]>;
  qlooCache(env: QlooEnv, since: Date): Promise<QlooCacheCount>;
  /** kv metro_localities' coverage of the map cities every run needs and of every config market. */
  localities(): Promise<LocalityStatus>;
  /**
   * The Qloo client's view; null when it cannot be configured (live Qloo without a key). The stored
   * snapshot may be read only when `storedReadable` (the database answered the ping).
   */
  qloo(storedReadable: boolean): Promise<QlooView | null>;
}

// Reads -------------------------------------------------------------------------------------------------

/** Settles like `promise`, or with `fallback` after `ms`. */
async function within<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** One read: its value, or null when it fails or runs past READ_TIMEOUT_MS. */
function attempt<T>(what: string, read: () => Promise<T>): Promise<T | null> {
  const settled = (async () => read())().catch((err: unknown) => {
    log.warn({ err, what }, "status: read failed");
    return null;
  });
  return within(settled, READ_TIMEOUT_MS, null);
}

/** Statuses of the latest runs whose question_hash starts with `hashPrefix`, newest first. */
export async function readRecentStatuses(db: Queryable, hashPrefix: string, limit: number): Promise<RunStatus[]> {
  return recentRunStatuses(db, { hashPrefix, limit });
}

/** Calls logged in `env` since `since`, and how many were served without the network (an SQL count). */
export async function readQlooCache(db: Queryable, env: QlooEnv, since: Date): Promise<QlooCacheCount> {
  const { total, network } = await countQlooCallsByCache(db, { env, since });
  return { total, served: total - network, sampled: false };
}

/** Every market in config/metros.json, in config order (the map cities are markets too). */
export const CONFIG_MARKETS: readonly MarketId[] = metros.markets.map((m) => MarketId.parse(m.id));

/**
 * The pins under `key`, read once, against the map cities every run needs and against every config
 * market. Rejects when kv cannot be read.
 */
export async function readLocalityStatus(db: Queryable, key: string = localitiesKvKey(), markets: readonly MarketId[] = CONFIG_MARKETS): Promise<LocalityStatus> {
  const raw = await getKv(db, key);
  const all = localityCoverage(raw, markets);
  return { ...localityCoverage(raw), markets: { total: markets.length, missing: all.missing } };
}

const Journal = z.object({ entries: z.array(z.object({ tag: z.string() })) });
let journalRead: { journal: MigrationJournal | null } | undefined;

/** The Drizzle journal this server migrates from: how many migrations and the latest tag. Read once. */
function readJournal(): MigrationJournal | null {
  if (journalRead) return journalRead.journal;
  let journal: MigrationJournal | null = null;
  try {
    const dir = resolveMigrationsDir();
    if (dir) {
      const file = path.join(/*turbopackIgnore: true*/ dir, "meta", "_journal.json");
      const parsed = Journal.safeParse(JSON.parse(readFileSync(file, "utf8")));
      if (parsed.success) journal = { count: parsed.data.entries.length, latest: parsed.data.entries.at(-1)?.tag ?? null };
    }
  } catch (err) {
    log.warn({ err }, "status: the migrations journal could not be read");
  }
  journalRead = { journal };
  return journal;
}

/** What readQlooView needs: the process's client, and the stored quota snapshot of an environment. */
export interface QlooViewDeps {
  client(): Pick<QlooClient, "env" | "monthFloor" | "quota">;
  readStored(env: QlooEnv): Promise<unknown>;
}

const defaultQlooViewDeps: QlooViewDeps = {
  client: getQlooClient,
  readStored: (env) => getKv(getDatabase(), env === "mock" ? MOCK_QUOTA_KV_KEY : QUOTA_KV_KEY),
};

/**
 * A snapshot with nothing in it: the client's defaults. A client still loading its stored snapshot
 * shows these (one this read made, or one an earlier read in the same reading made, such as the mode
 * machine's), and so does a client that has seen nothing yet; either way the stored copy says as much.
 */
function untouched(quota: QuotaSnapshot): boolean {
  return (
    quota.capturedAt === null &&
    quota.lastSuccessAt === null &&
    quota.consecutiveAuthErrors === 0 &&
    quota.monthRemaining === null &&
    quota.todayNetwork === 0
  );
}

/**
 * The Qloo client's view, null when no client can be made. While the client's own snapshot is
 * untouched, the stored one is read instead (bounded, and only when `storedReadable`).
 */
export async function readQlooView(storedReadable: boolean, deps: QlooViewDeps = defaultQlooViewDeps): Promise<QlooView | null> {
  let client: ReturnType<QlooViewDeps["client"]>;
  try {
    client = deps.client();
  } catch {
    return null;
  }
  const view = { env: client.env, monthFloor: client.monthFloor };
  const own = client.quota();
  if (!storedReadable || !untouched(own)) return { ...view, quota: own };
  // A read that throws, even before its promise (no database configured), leaves the client's own.
  const read = (async () => deps.readStored(client.env))().catch(() => undefined);
  const raw = await within(read, READ_TIMEOUT_MS / 2, undefined);
  const stored = QuotaSnapshot.safeParse(raw);
  return { ...view, quota: stored.success ? stored.data : own };
}

/** The process's container, mode machine, config and database. */
export function defaultStatusSources(): StatusSources {
  return {
    now: () => Date.now(),
    version: () => appVersion(),
    uptimeS: () => Math.round(process.uptime()),
    limits: () => ({
      llmDailyUsdCap: llmDailyUsdCapFromEnv(),
      hourlyCap: { public: agentRunHourlyCapFromEnv(), judge: judgeRunHourlyCapFromEnv() },
      slots: laneSlots(agentRunMaxActiveFromEnv(), judgeTokenFromEnv() ? judgeRunMaxActiveFromEnv() : 0),
      fakeHourlyCap: fakeRunHourlyCapFromEnv(),
      qlooDailyFreshCap: qlooDailyFreshCapFromEnv(),
      qlooDisabled: qlooDisabledFromEnv(),
    }),
    anthropicConfigured: () => getAnthropic() !== null,
    runManager: () => getRunManager(),
    migrations: () => ({ applied: migrationsApplied(), skipped: process.env.RUN_MIGRATIONS === "0", journal: readJournal() }),
    override: () => modeOverrideFromEnv(),
    budget: (lane) => getModeService().budget(lane),
    lastKnownMode,
    pingDb: () => pingDb(getDatabase()),
    storedMode: getStoredMode,
    decide: () => getModeService().decideAll(),
    llmUsd: (day, lane) => getQlooUsage(getDatabase(), { day, lane, metric: LLM_USD_METRIC }),
    qlooFresh: (day, lane) => getQlooUsage(getDatabase(), { day, lane }),
    laneRunsSince: (lane, sinceMs) => countLaneRunsSince(getDatabase(), lane, sinceMs),
    runsSince: (hashPrefix, sinceMs) => countRunsSince(getDatabase(), { hashPrefix, sinceMs }),
    recentStatuses: (hashPrefix, limit) => readRecentStatuses(getDatabase(), hashPrefix, limit),
    qlooCache: (env, since) => readQlooCache(getDatabase(), env, since),
    localities: () => readLocalityStatus(getDatabase()),
    qloo: (storedReadable) => readQlooView(storedReadable),
  };
}

// Composition --------------------------------------------------------------------------------------------

/** Clear below half of the budget, then past 50% and past 80%; tripped when `tripped`. */
export function shareLevel(used: number | null, budget: number | null, tripped: boolean): StatusLevel {
  if (used === null) return "unknown";
  if (tripped) return "tripped";
  if (budget === null || !(budget > 0)) return "unknown";
  const share = used / budget;
  return share >= HIGH ? "high" : share >= HALF ? "half" : "clear";
}

/** A mode as a breaker level: live is clear, economy a step down, replay only tripped. */
const MODE_LEVEL: Readonly<Record<Mode, StatusLevel>> = { live: "clear", economy: "stepped", replay_only: "tripped" };

/**
 * Every breaker's state, from what was read. The mode machine decides each lane's mode and names only
 * the breaker that set it; this says where each one stands, measured on the public lane, which steps
 * down first (its thresholds are never above the judge lane's).
 */
export function breakersOf(input: {
  mode: StatusReport["mode"];
  llm: StatusReport["llm"];
  runs: StatusReport["runs"];
  qloo: QlooStatus;
  qlooDisabled: boolean;
}): BreakerState[] {
  const { mode, llm, runs, qloo } = input;
  const spend = llm.todayUsd;
  const budget = llm.budgets.public;
  const hour = runs.lanes.public;
  const level: Record<BreakerKey, StatusLevel> = {
    stored: MODE_LEVEL[mode.stored.mode],
    override: mode.override === null ? "clear" : mode.override === "live" ? "bypassed" : MODE_LEVEL[mode.override],
    llm_spend:
      spend === null
        ? "unknown"
        : spend >= budget.replayAt
          ? "tripped"
          : spend >= budget.economyAt
            ? "stepped"
            : shareLevel(spend, llm.capUsd, false),
    qloo_floor: "unknown",
    qloo_daily: "unknown",
    qloo_auth: "unknown",
    live_hourly: shareLevel(hour.lastHour, hour.hourlyCap, hour.lastHour !== null && hour.lastHour >= hour.hourlyCap),
    qloo_switch: input.qlooDisabled ? "tripped" : "clear",
    draining: runs.accepting === null ? "unknown" : runs.accepting ? "clear" : "tripped",
  };
  if (input.qlooDisabled) {
    // No Qloo call is made, so the mode machine applies no Qloo breaker (container qlooUsageNow).
    level.qloo_floor = "off";
    level.qloo_daily = "off";
    level.qloo_auth = "off";
  } else if (qloo.configured) {
    const { remaining, limit, floor } = qloo.month;
    // Measured against the calls usable before the floor, which is where the breaker trips.
    const used = remaining === null || limit === null ? null : limit - remaining;
    level.qloo_floor = remaining !== null && remaining < floor ? "tripped" : shareLevel(used, limit === null ? null : limit - floor, false);
    const { today } = qloo;
    if (!today.enforced) level.qloo_daily = "off";
    else {
      // breakers.ts: a lane steps down once a whole run (QLOO_RUN_MARGIN calls) no longer fits.
      const lane = today.lanes.public;
      const full = (lane.used !== null && lane.used + QLOO_RUN_MARGIN > lane.cap) || today.network + QLOO_RUN_MARGIN > today.cap;
      level.qloo_daily = shareLevel(today.network, today.cap, full);
    }
    // A streak is a count, not a share of a budget: begun is a warning, never "past 80%".
    level.qloo_auth = qloo.authErrors >= qloo.authErrorsTrip ? "tripped" : qloo.authErrors > 0 ? "warn" : "clear";
  }
  return BREAKER_KEYS.map((key) => ({ key, level: level[key] }));
}

const LIVE_BLOCK_STATE: Readonly<Record<LiveBlock, LiveState>> = {
  no_database: "unavailable",
  draining: "unavailable",
  no_anthropic: "unavailable",
  no_qloo: "unavailable",
  replay_only: "paused",
  live_hourly: "limited",
  qloo_disabled: "limited",
};

/** What stops a public live question, in LiveBlock order, the state that follows and the lane's message. */
export function liveOf(input: {
  dbOk: boolean;
  accepting: boolean | null;
  anthropic: boolean;
  /** A Qloo client can be made: the run manager refuses live runs without one, even with QLOO_DISABLED. */
  qlooConfigured: boolean;
  /** QLOO_DISABLED: runs take the fail-closed path and answer as insufficient evidence. */
  qlooDisabled: boolean;
  /** The public lane's mode: its decision, or the stored mode when it could not be decided. */
  mode: Mode;
  message: string | null;
  hourlyFull: boolean;
}): StatusReport["live"] {
  const blocks: LiveBlock[] = [];
  if (!input.dbOk) blocks.push("no_database");
  if (input.accepting === false) blocks.push("draining");
  if (!input.anthropic) blocks.push("no_anthropic");
  if (!input.qlooConfigured) blocks.push("no_qloo");
  if (input.mode === "replay_only") blocks.push("replay_only");
  if (input.hourlyFull) blocks.push("live_hourly");
  if (input.qlooDisabled) blocks.push("qloo_disabled");
  const first = blocks[0];
  const state: LiveState = first ? LIVE_BLOCK_STATE[first] : input.mode === "economy" ? "economy" : "live";
  return { state, blocks, message: input.mode === "live" ? null : input.message };
}

const roundUsd = (usd: number | null) => (usd === null ? null : Math.round(usd * 10_000) / 10_000);
const laneOf = (d: ModeDecision): LaneDecision => ({ mode: d.mode, breaker: d.breaker, reason: d.reason, message: d.message, until: d.until });

/** One reading of the service. Never throws: what could not be read is null. */
export async function readStatus(sources: StatusSources = defaultStatusSources()): Promise<StatusReport> {
  const started = sources.now();
  const day = utcDay(started);
  const dayStart = new Date(`${day}T00:00:00.000Z`);
  const limits = sources.limits();
  const quiet = <T>(fn: () => T, fallback: T): T => {
    try {
      return fn();
    } catch {
      return fallback;
    }
  };

  // No database configured (production without DATABASE_URL) leaves the process counters unknown.
  const manager = quiet<ReturnType<StatusSources["runManager"]> | null>(() => sources.runManager(), null);
  const migrations = sources.migrations();
  const anthropic = quiet(() => sources.anthropicConfigured(), false);
  const override = quiet(() => sources.override(), null);
  const budgetOf = (lane: Lane): LaneBudget => {
    const { economyAt, replayAt, cap } = sources.budget(lane);
    return { economyAt, replayAt, cap };
  };
  const budgets: Record<Lane, LaneBudget> = { public: budgetOf("public"), judge: budgetOf("judge") };

  // Timed from here, not from `started`: the setup above (the run manager, the journal, the
  // Anthropic client, all made on first use) is not the database's time.
  const pingStarted = sources.now();
  const dbOk = (await attempt("ping", () => sources.pingDb())) === true;
  const latencyMs = dbOk ? Math.round(sources.now() - pingStarted) : null;
  // With the database down every read below would only wait for its timeout.
  const read = <T>(what: string, fn: () => Promise<T>): Promise<T | null> => (dbOk ? attempt(what, fn) : Promise.resolve(null));

  const [stored, decided, todayUsd, publicUsd, judgeUsd, publicHour, judgeHour, testHour, liveRecent, testRecent, pins, view] =
    await Promise.all([
      read("stored mode", () => sources.storedMode()),
      read("lane modes", () => sources.decide()),
      read("llm today", () => sources.llmUsd(day, "all")),
      read("llm public", () => sources.llmUsd(day, "public")),
      read("llm judge", () => sources.llmUsd(day, "judge")),
      read("public runs", () => sources.laneRunsSince("public", HOUR_MS)),
      read("judge runs", () => sources.laneRunsSince("judge", HOUR_MS)),
      read("test runs", () => sources.runsSince(FAKE_HASH_PREFIX, HOUR_MS)),
      read("recent live runs", () => sources.recentStatuses(QUESTION_HASH_PREFIX, RECENT_RUNS)),
      read("recent test runs", () => sources.recentStatuses(FAKE_HASH_PREFIX, RECENT_RUNS)),
      read("localities", () => sources.localities()),
      attempt("qloo", () => sources.qloo(dbOk)),
    ]);

  let qloo: QlooStatus = { configured: false, disabled: limits.qlooDisabled };
  if (view) {
    // Mock calls never reach the daily counters, which have no environment column: in mock mode they
    // hold other environments' calls on a shared database, so only this server's own count is used.
    const counted = view.env !== "mock";
    const fresh = (lane: Lane | "all") => (counted ? read(`qloo ${lane}`, () => sources.qlooFresh(day, lane)) : Promise.resolve(null));
    const [freshAll, freshPublic, freshJudge, cache] = await Promise.all([
      fresh("all"),
      fresh("public"),
      fresh("judge"),
      read("qloo cache", () => sources.qlooCache(view.env, dayStart)),
    ]);
    const quota = view.quota;
    // A snapshot from an earlier day counts nothing for today.
    const ownToday = quota.day === day ? quota.todayNetwork : 0;
    const cap = limits.qlooDailyFreshCap;
    qloo = {
      configured: true,
      disabled: limits.qlooDisabled,
      env: view.env,
      today: {
        network: Math.max(freshAll ?? 0, ownToday),
        cap,
        enforced: view.env === "prod",
        lanes: {
          public: { used: freshPublic, cap: Math.floor(cap * LANE_SHARE.public) },
          judge: { used: freshJudge, cap: Math.floor(cap * LANE_SHARE.judge) },
        },
      },
      month: {
        remaining: quota.monthRemaining,
        limit: quota.monthLimit,
        floor: view.monthFloor,
        resetsAt: quota.monthReset,
        capturedAt: quota.capturedAt,
      },
      cache: cache && { total: cache.total, served: cache.served, sampled: cache.sampled },
      lastSuccessAt: quota.lastSuccessAt,
      authErrors: quota.consecutiveAuthErrors,
      authErrorsTrip: QLOO_AUTH_ERRORS_TRIP,
    };
  }

  const mode: StatusReport["mode"] = {
    // Named fields only, here as everywhere in the report: nothing a source adds passes through.
    stored: stored ? { mode: stored.mode, reason: stored.reason, since: stored.since } : { mode: sources.lastKnownMode(), reason: null, since: null },
    override,
    lanes: decided === null ? null : { public: laneOf(decided.public), judge: laneOf(decided.judge) },
  };
  const llm: StatusReport["llm"] = {
    configured: anthropic,
    todayUsd: roundUsd(todayUsd),
    laneUsd: { public: roundUsd(publicUsd), judge: roundUsd(judgeUsd) },
    capUsd: limits.llmDailyUsdCap,
    budgets,
  };
  const runs: StatusReport["runs"] = {
    accepting: manager ? quiet<boolean | null>(() => manager.isAccepting(), null) : null,
    activeHere: manager ? quiet<number | null>(() => manager.activeCount(), null) : null,
    slots: { public: limits.slots.public, judge: limits.slots.judge },
    recentLimit: RECENT_RUNS,
    lanes: {
      public: { lastHour: publicHour, hourlyCap: limits.hourlyCap.public },
      judge: { lastHour: judgeHour, hourlyCap: limits.hourlyCap.judge },
    },
    test: { lastHour: testHour, hourlyCap: limits.fakeHourlyCap },
    recent: { live: liveRecent, test: testRecent },
  };
  const breakers = breakersOf({ mode, llm, runs, qloo, qlooDisabled: limits.qlooDisabled });
  const publicDecision = mode.lanes?.public ?? null;
  const live = liveOf({
    dbOk,
    accepting: runs.accepting,
    anthropic,
    qlooConfigured: qloo.configured,
    qlooDisabled: limits.qlooDisabled,
    mode: publicDecision?.mode ?? override ?? mode.stored.mode,
    message: publicDecision?.message ?? null,
    hourlyFull: breakers.some((b) => b.key === "live_hourly" && b.level === "tripped"),
  });

  return {
    readAt: new Date(started).toISOString(),
    readMs: Math.max(0, Math.round(sources.now() - started)),
    version: sources.version(),
    uptimeS: sources.uptimeS(),
    mode,
    live,
    breakers,
    llm,
    runs,
    qloo,
    db: { ok: dbOk, latencyMs },
    migrations: {
      state: migrations.skipped ? "skipped" : migrations.applied ? "applied" : "pending",
      journal: migrations.journal && { count: migrations.journal.count, latest: migrations.journal.latest },
    },
    localities: pins && {
      state: pins.state,
      required: [...pins.required],
      missing: [...pins.missing],
      pinned: pins.pinned,
      markets: { total: pins.markets.total, missing: [...pins.markets.missing] },
    },
  };
}

const REUSE_KEY = "__ctStatusReading";
type GlobalWithReading = typeof globalThis & { [REUSE_KEY]?: { at: number; reading: Promise<StatusReport> } };

/**
 * The reading the page shows: a new one, or the last one while it is younger than STATUS_REUSE_MS.
 * The page is public, so a reload loop must not turn into a database load.
 */
export function currentStatus(now: number = Date.now(), read: () => Promise<StatusReport> = () => readStatus()): Promise<StatusReport> {
  const g = globalThis as GlobalWithReading;
  const last = g[REUSE_KEY];
  if (last && now - last.at >= 0 && now - last.at < STATUS_REUSE_MS) return last.reading;
  const reading = read();
  g[REUSE_KEY] = { at: now, reading };
  // readStatus does not throw; should it ever, the next request tries again.
  reading.catch(() => {
    if (g[REUSE_KEY]?.reading === reading) g[REUSE_KEY] = undefined;
  });
  return reading;
}
