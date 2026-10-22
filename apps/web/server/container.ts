import "server-only";
import { getDb, type Db } from "@ct/db";
import {
  fakeRunHourlyCapFromEnv,
  fakeRunMaxActiveFromEnv,
  fakeRunRetentionMsFromEnv,
  fakeRunSecondsFromEnv,
} from "./config";
import { EventBus } from "./event-bus";
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

export function getRunManager(): RunManager {
  const s = slots();
  return (s.runs ??= new RunManager({
    db: getDatabase(),
    bus: getEventBus(),
    fakeRunSeconds: fakeRunSecondsFromEnv(),
    maxActive: fakeRunMaxActiveFromEnv(),
    hourlyCap: fakeRunHourlyCapFromEnv(),
    retentionMs: fakeRunRetentionMsFromEnv(),
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
