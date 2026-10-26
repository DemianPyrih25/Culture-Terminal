import "server-only";
import { MarketId, MetroId, type LocalityApi, type MarketLocality } from "@ct/contracts";
import { getKv, type Queryable } from "@ct/db";
import { resolveQlooEnv } from "@ct/qloo";
import { z } from "zod";
import { log } from "./log";

/**
 * The pinned Qloo locality per market (PLAN §3.2 kv "metro locality UUIDs"; D29: the ids live only
 * in kv, never in git). tools/dev/localities.ts pins them, Austin by a person's pick because its
 * name is ambiguous: `{"nashville": {"entityId": "…", "label": "Nashville"}, …}`. Skills read them through
 * SkillCtx.localities for metro, city and market contexts and the lift map's filter.location.
 *
 * A missing, partial or malformed value is said in the logs (at startup and in each run that looks a
 * market up) and on /status, by market id and count only: a locality id never leaves this module.
 */

export const LOCALITIES_KV_KEY = "metro_localities";
/**
 * Synthetic locality ids (QLOO_MOCK=1) live under a key of their own, as the quota snapshot does
 * (qloo.quota.mock), so a mock pin never stands in for a live one in the shared database.
 * tools/dev/localities.ts writes both.
 */
export const MOCK_LOCALITIES_KV_KEY = "metro_localities.mock";

/** The key this process reads: the mock key on synthetic Qloo data, as the container's client runs. */
export function localitiesKvKey(env: NodeJS.ProcessEnv = process.env): string {
  return resolveQlooEnv(env) === "mock" ? MOCK_LOCALITIES_KV_KEY : LOCALITIES_KV_KEY;
}

/** The markets every run needs pinned: the gazetteer metros, which the run's MARKETS list names. */
export const REQUIRED_LOCALITY_MARKETS: readonly MarketId[] = MetroId.options;

const StoredLocalities = z.record(MarketId, z.strictObject({ entityId: z.string().min(1), label: z.string().min(1) }));
type Pins = Readonly<Record<string, MarketLocality>>;

/**
 * complete: every required market is pinned. partial: some are not. missing: kv holds no value.
 * malformed: the value does not parse, so every lookup fails.
 */
export type LocalityCoverageState = "complete" | "partial" | "missing" | "malformed";

/** How far the pins cover the markets: market ids and counts only, never a locality id. */
export interface LocalityCoverage {
  state: LocalityCoverageState;
  /** The markets that must be pinned (REQUIRED_LOCALITY_MARKETS), in order. */
  required: readonly MarketId[];
  /** Of `required`, the ones without a pin, in order: all of them when the value is missing or malformed. */
  missing: MarketId[];
  /** Markets pinned in all, required or not; 0 when the value is missing or malformed. */
  pinned: number;
}

/** A stored value as pins (null when malformed) and its coverage of `required`. */
function readPins(raw: unknown, required: readonly MarketId[]): { pins: Pins | null; coverage: LocalityCoverage } {
  const none = (state: "missing" | "malformed"): LocalityCoverage => ({ state, required, missing: [...required], pinned: 0 });
  if (raw === undefined) return { pins: {}, coverage: none("missing") };
  const parsed = StoredLocalities.safeParse(raw);
  if (!parsed.success) return { pins: null, coverage: none("malformed") };
  const pins = parsed.data;
  const missing = required.filter((id) => !Object.hasOwn(pins, id));
  return {
    pins,
    coverage: { state: missing.length === 0 ? "complete" : "partial", required, missing, pinned: Object.keys(pins).length },
  };
}

/** The coverage of a stored kv value (undefined when there is none). */
export function localityCoverage(raw: unknown, required: readonly MarketId[] = REQUIRED_LOCALITY_MARKETS): LocalityCoverage {
  return readPins(raw, required).coverage;
}

/** The coverage of the pins under `key` now; rejects when kv cannot be read. */
export async function readLocalityCoverage(db: Queryable, key: string = localitiesKvKey()): Promise<LocalityCoverage> {
  return localityCoverage(await getKv(db, key));
}

const EFFECT = "metro, city and market contexts and the lift map's city filter are not measured there";

/** Logs a coverage of `key` that is not complete, with `context` (e.g. the run id): market ids and counts only. */
export function logLocalityCoverage(coverage: LocalityCoverage, context: Record<string, unknown> = {}, key: string = localitiesKvKey()): void {
  const fields = { ...context, key, missing: coverage.missing, pinned: coverage.pinned };
  switch (coverage.state) {
    case "complete":
      return;
    case "missing":
      log.warn(fields, `kv "${key}" is not set: ${EFFECT}`);
      return;
    case "partial":
      log.warn(fields, `kv "${key}" pins only some markets: ${EFFECT}`);
      return;
    case "malformed":
      log.error(fields, `kv "${key}" is malformed: every locality lookup fails`);
      return;
  }
}

/**
 * One run's view of the pins: kv is read once, on the first lookup, and shared by every skill of
 * the run; a coverage that is not complete is logged then, once, with `context` (the run id). A
 * market without a pin resolves null without a log of its own (a run asks for every market it might
 * offer); a failed or malformed read rejects, so skills report a failed lookup rather than a missing pin.
 */
export function kvLocalities(db: Queryable, context: Record<string, unknown> = {}, key: string = localitiesKvKey()): LocalityApi {
  let loaded: Promise<Pins> | null = null;
  const load = async () => {
    const { pins, coverage } = readPins(await getKv(db, key), REQUIRED_LOCALITY_MARKETS);
    logLocalityCoverage(coverage, context, key);
    if (pins === null) throw new Error(`kv "${key}" is malformed`);
    return pins;
  };
  return {
    market: async (id) => {
      loaded ??= load();
      const pins = await loaded;
      // Own keys only: a market id such as "constructor" must not find Object.prototype's.
      return Object.hasOwn(pins, id) ? (pins[id] ?? null) : null;
    },
  };
}
