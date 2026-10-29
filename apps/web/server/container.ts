import "server-only";
import { createAnthropic, type AnthropicLike } from "@ct/agent";
import type { GeoApi, Lane, Mode } from "@ct/contracts";
import { getDb, listPublicFigureNames, type Db } from "@ct/db";
import { createGeo } from "@ct/geo";
import { createPgPublicStore, createPublicDataClient, publicDataOptionsFromEnv, type PublicDataClient } from "@ct/publicdata";
import { createPgQlooStore, createQlooClient, qlooClientOptionsFromEnv, type QlooClient } from "@ct/qloo";
import { judgeTokenFromEnv } from "./access";
import { findAlreadyHave, type AnswerCache } from "./answer-cache";
import { ModeService, qlooUsageReader, spendPolicyFromEnv } from "./breakers";
import {
  agentRunDailyCapFromEnv,
  agentRunHourlyCapFromEnv,
  agentRunMaxActiveFromEnv,
  fakeRunHourlyCapFromEnv,
  fakeRunMaxActiveFromEnv,
  fakeRunRetentionMsFromEnv,
  fakeRunSecondsFromEnv,
  judgeRunDailyCapFromEnv,
  judgeRunHourlyCapFromEnv,
  judgeRunMaxActiveFromEnv,
  llmDailyUsdCapFromEnv,
  modeOverrideFromEnv,
  qlooDailyFreshCapFromEnv,
  qlooDisabledFromEnv,
} from "./config";
import { desModeFrom } from "./des/mode";
import { DesService } from "./des/service";
import { vettedPersonFrom } from "./des/vetted";
import { EventBus } from "./event-bus";
import { todayLlmUsd } from "./llm-spend";
import { log } from "./log";
import { readStoredMode, writeMode, type StoredModeValue } from "./mode";
import { RunManager } from "./run-manager";

/**
 * Process-wide singletons, created on first use. They live on globalThis because Next.js can load
 * this module more than once (one copy per route bundle, plus instrumentation, plus dev reloads),
 * and the run that POST /api/runs starts must publish on the same bus the stream route listens to.
 */
interface Slots {
  db?: Db;
  bus?: EventBus;
  runs?: RunManager;
  qloo?: QlooClient;
  /** SEC EDGAR and US Census (Part 9). */
  publicdata?: PublicDataClient;
  /** Null once ANTHROPIC_API_KEY was found unset. */
  anthropic?: AnthropicLike | null;
  /** The mode last read from or written to kv. */
  mode?: Mode;
  /** The stored mode with its reason, as last read or written. */
  stored?: StoredModeValue;
  modes?: ModeService;
  answers?: AnswerCache;
  /** The DES tearsheet service (P1 #1). */
  des?: DesService;
  /** The gazetteer its skill context carries, made on first use. */
  desGeo?: GeoApi;
}

const KEY = "__ctContainer";
type GlobalWithSlots = typeof globalThis & { [KEY]?: Slots };

function slots(): Slots {
  const g = globalThis as GlobalWithSlots;
  return (g[KEY] ??= {});
}

export function getDatabase(): Db {
  const s = slots();
  return (s.db ??= getDb());
}

export function getEventBus(): EventBus {
  const s = slots();
  return (s.bus ??= new EventBus());
}

/**
 * The one Qloo client of the process (PLAN §5.1): its cache, limiter and budgets are shared by every
 * run. QLOO_MOCK=1 needs no key. Throws when live Qloo is configured without a key; the caller
 * decides what that refuses, and the next call tries again.
 */
export function getQlooClient(): QlooClient {
  const s = slots();
  return (s.qloo ??= createQlooClient(
    qlooClientOptionsFromEnv(process.env, {
      store: createPgQlooStore(getDatabase()),
      logger: log.child({ component: "qloo" }),
      onModeChange: (mode) => {
        void setMode(mode, "qloo");
      },
    }),
  ));
}

/** The Qloo client if one was created, without creating it: shutdown flushes only a client that exists. */
export function peekQlooClient(): QlooClient | undefined {
  return slots().qloo;
}

/**
 * The one SEC EDGAR and US Census client of the process (Part 9, PLAN §5.2): its cache (the shared
 * public_cache table), limiters and call log are shared by every run. QLOO_MOCK=1 answers both from the
 * invented mock transport. SEC_USER_AGENT unset leaves SEC not configured (its tool says the data is
 * unavailable); CENSUS_API_KEY unset does the same for Census. Throws only on a malformed SEC_USER_AGENT;
 * the caller decides what that turns off, and the next call tries again.
 */
export function getPublicDataClient(): PublicDataClient {
  const s = slots();
  return (s.publicdata ??= createPublicDataClient(
    publicDataOptionsFromEnv(process.env, {
      store: createPgPublicStore(getDatabase()),
      logger: log.child({ component: "publicdata" }),
    }),
  ));
}

/** The public-data client if one was created, without creating it: shutdown flushes only a client that exists. */
export function peekPublicDataClient(): PublicDataClient | undefined {
  return slots().publicdata;
}

/** The Anthropic client, or null without ANTHROPIC_API_KEY: live runs are then refused, test runs still work. */
export function getAnthropic(): AnthropicLike | null {
  const s = slots();
  if (s.anthropic === undefined) {
    const key = process.env.ANTHROPIC_API_KEY?.trim();
    s.anthropic = key ? createAnthropic(key) : null;
    if (!key) log.warn("ANTHROPIC_API_KEY is not set: live runs are refused, test runs still work");
  }
  return s.anthropic;
}

/** The mode last seen, without a database read (live until something says otherwise). */
export function lastKnownMode(): Mode {
  return slots().mode ?? "live";
}

/** The stored mode from kv with its reason; the last known one when the read fails. */
export async function getStoredMode(): Promise<StoredModeValue> {
  const s = slots();
  try {
    s.stored = await readStoredMode(getDatabase());
    s.mode = s.stored.mode;
  } catch (err) {
    log.warn({ err }, "could not read the mode; using the last known one");
  }
  return s.stored ?? { mode: lastKnownMode(), reason: null, since: null };
}

/** The current mode from kv; the last known one when the read fails. */
export async function getMode(): Promise<Mode> {
  return (await getStoredMode()).mode;
}

/**
 * Switches the mode for this process at once and stores it for the others. False when it could not
 * be stored: this process keeps it, but the others and a restart do not see it.
 */
export async function setMode(mode: Mode, reason: string): Promise<boolean> {
  const s = slots();
  s.mode = mode;
  s.stored = { mode, reason, since: new Date().toISOString() };
  log.warn({ mode, reason }, "mode changed");
  try {
    await writeMode(getDatabase(), mode, reason);
    return true;
  } catch (err) {
    log.error({ err, mode }, "could not store the mode");
    return false;
  }
}

/** Kept here for callers that import it from the container; it lives with the breakers. */
export { spendPolicyFromEnv };

/** The mode machine (breakers.ts) on this process's database, Qloo client and environment. */
export function getModeService(): ModeService {
  const s = slots();
  return (s.modes ??= new ModeService(
    {
      override: () => modeOverrideFromEnv(),
      stored: getStoredMode,
      todayUsd: (now) => todayLlmUsd(getDatabase(), now),
      qloo: qlooUsageReader({
        disabled: qlooDisabledFromEnv(),
        client: getQlooClient,
        db: getDatabase,
        dailyCap: qlooDailyFreshCapFromEnv(),
      }),
    },
    spendPolicyFromEnv(),
  ));
}

/** A lane's mode as the breakers decide it now. */
export function laneMode(lane: Lane) {
  return getModeService().decide(lane);
}

/** The answer cache (D26) on this process's database. */
export function getAnswerCache(): AnswerCache {
  const s = slots();
  return (s.answers ??= { find: (question) => findAlreadyHave(getDatabase(), question) });
}

/**
 * The DES tearsheet service (P1 #1) on this process's Qloo client and mode machine; $0 LLM. A person
 * is looked up when curated, or when CLERK marked them a public figure in a brief that ran.
 */
export function getDesService(): DesService {
  const s = slots();
  return (s.des ??= new DesService({
    qloo: getQlooClient,
    qlooEnabled: !qlooDisabledFromEnv(),
    mode: (lane) => desModeFrom(getModeService(), lane),
    geo: () => (s.desGeo ??= createGeo()),
    vettedPerson: vettedPersonFrom(() => listPublicFigureNames(getDatabase())),
  }));
}

export function getRunManager(): RunManager {
  const s = slots();
  return (s.runs ??= new RunManager({
    db: getDatabase(),
    bus: getEventBus(),
    fakeRunSeconds: fakeRunSecondsFromEnv(),
    fakeMaxActive: fakeRunMaxActiveFromEnv(),
    hourlyCap: fakeRunHourlyCapFromEnv(),
    retentionMs: fakeRunRetentionMsFromEnv(),
    agent: { qloo: getQlooClient, publicdata: getPublicDataClient, anthropic: getAnthropic, mode: laneMode },
    agentHourlyCap: agentRunHourlyCapFromEnv(),
    judgeHourlyCap: judgeRunHourlyCapFromEnv(),
    agentDailyCap: agentRunDailyCapFromEnv(),
    judgeDailyCap: judgeRunDailyCapFromEnv(),
    agentMaxActive: agentRunMaxActiveFromEnv(),
    // A closed judge lane holds no slot.
    judgeMaxActive: judgeTokenFromEnv() ? judgeRunMaxActiveFromEnv() : 0,
    llmDailyUsdCap: llmDailyUsdCapFromEnv(),
    llmLaneUsdCap: { public: getModeService().budget("public").cap, judge: getModeService().budget("judge").cap },
    qlooEnabled: !qlooDisabledFromEnv(),
  }));
}

export interface Container {
  db: Db;
  bus: EventBus;
  runs: RunManager;
}

export function getContainer(): Container {
  return { db: getDatabase(), bus: getEventBus(), runs: getRunManager() };
}
