import "server-only";
import { createAnthropic, type AnthropicLike } from "@ct/agent";
import type { Mode } from "@ct/contracts";
import { getDb, type Db } from "@ct/db";
import { createPgQlooStore, createQlooClient, qlooClientOptionsFromEnv, type QlooClient } from "@ct/qloo";
import {
  agentRunHourlyCapFromEnv,
  agentRunMaxActiveFromEnv,
  fakeRunHourlyCapFromEnv,
  fakeRunMaxActiveFromEnv,
  fakeRunRetentionMsFromEnv,
  fakeRunSecondsFromEnv,
  llmDailyUsdCapFromEnv,
  qlooDisabledFromEnv,
} from "./config";
import { EventBus } from "./event-bus";
import { log } from "./log";
import { readMode, writeMode } from "./mode";
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
  /** Null once ANTHROPIC_API_KEY was found unset. */
  anthropic?: AnthropicLike | null;
  /** The mode last read from or written to kv. */
  mode?: Mode;
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

/** The current mode from kv; the last known one when the read fails. */
export async function getMode(): Promise<Mode> {
  const s = slots();
  try {
    s.mode = await readMode(getDatabase());
  } catch (err) {
    log.warn({ err }, "could not read the mode; using the last known one");
  }
  return lastKnownMode();
}

/** Switches the mode for this process at once and stores it for the others. */
export async function setMode(mode: Mode, reason: string): Promise<void> {
  slots().mode = mode;
  log.warn({ mode, reason }, "mode changed");
  try {
    await writeMode(getDatabase(), mode, reason);
  } catch (err) {
    log.error({ err, mode }, "could not store the mode");
  }
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
    agent: { qloo: getQlooClient, anthropic: getAnthropic, mode: getMode },
    agentHourlyCap: agentRunHourlyCapFromEnv(),
    agentMaxActive: agentRunMaxActiveFromEnv(),
    llmDailyUsdCap: llmDailyUsdCapFromEnv(),
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
