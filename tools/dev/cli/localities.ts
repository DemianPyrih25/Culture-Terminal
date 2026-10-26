// Market locality pins for the dev CLIs (PLAN §3.2 kv "metro locality UUIDs", D29): the kv value
// apps/web/server/localities.ts reads, the LocalityApi run-skill hands to skills, and the rule that
// picks a market's locality out of a /search answer. Locality ids live in the database kv only:
// nothing here prints them or writes them to a file.
import { MarketId, type LocalityApi, type MarketLocality, type QlooParams, type QlooSearchEntity } from "@ct/contracts";
import { getKv, setKv, type Queryable } from "@ct/db";
import type { QlooEnv } from "@ct/qloo";
import { normaliseName } from "@ct/quant";
import { z } from "zod";
import type { Market } from "./markets";

/** The kv key apps/web/server/localities.ts reads (live Qloo: dev and prod). */
export const LOCALITIES_KV_KEY = "metro_localities";
/**
 * Synthetic locality ids (QLOO_MOCK=1) go to a key of their own, as the quota snapshot does
 * (qloo.quota.mock), so a mock pin never stands in for a live one in the shared database.
 */
export const MOCK_LOCALITIES_KV_KEY = "metro_localities.mock";

export function localitiesKvKey(env: QlooEnv): string {
  return env === "mock" ? MOCK_LOCALITIES_KV_KEY : LOCALITIES_KV_KEY;
}

/** The stored shape, as apps/web/server/localities.ts validates it: `{ "<market id>": { entityId, label } }`. */
export const StoredLocalities = z.record(MarketId, z.strictObject({ entityId: z.string().min(1), label: z.string().min(1) }));
export type StoredLocalities = z.infer<typeof StoredLocalities>;

/** The kv rows the locality tools read and write; the database's kv table, or a map in memory. */
export interface KvStore {
  /** Where the values live, for the header line. */
  label: string;
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

export function pgKv(db: Queryable, label = "postgres"): KvStore {
  return { label, get: (key) => getKv(db, key), set: (key, value) => setKv(db, key, value) };
}

export function memoryKv(initial: Readonly<Record<string, unknown>> = {}): KvStore & { values: Map<string, unknown> } {
  const values = new Map<string, unknown>(Object.entries(initial));
  return {
    label: "memory (nothing persists)",
    values,
    get: async (key) => structuredClone(values.get(key)),
    set: async (key, value) => {
      values.set(key, structuredClone(value));
    },
  };
}

/** A kv value under the localities key that is not in the stored shape; nothing is written over it. */
export class MalformedPinsError extends Error {
  override readonly name = "MalformedPinsError";
}

/** The pins stored under `key`: empty when the key is absent; throws MalformedPinsError when the value is not in the stored shape. */
export async function readPins(kv: KvStore, key: string): Promise<StoredLocalities> {
  const raw = await kv.get(key);
  if (raw === undefined) return {};
  const parsed = StoredLocalities.safeParse(raw);
  if (!parsed.success) {
    throw new MalformedPinsError(`kv "${key}" is malformed (expected {"<market id>": {"entityId": "…", "label": "…"}}); fix or delete it`);
  }
  return parsed.data;
}

/** A market's pin, own keys only: a market id such as "constructor" must not find Object.prototype's. */
export function pinOf(pins: StoredLocalities, id: string): MarketLocality | null {
  return Object.hasOwn(pins, id) ? (pins[id] ?? null) : null;
}

/**
 * The pins as skills read them, the way apps/web/server/localities.ts serves a run: kv is read once,
 * on the first lookup; a market without a pin resolves null and a failed or malformed read rejects.
 */
export function kvLocalityApi(kv: KvStore, key: string): LocalityApi {
  let loaded: Promise<StoredLocalities> | null = null;
  return {
    market: async (id) => {
      loaded ??= readPins(kv, key);
      return pinOf(await loaded, id);
    },
  };
}

// Resolving a market's locality ------------------------------------------------------------------------

export const LOCALITY_TYPE = "urn:entity:locality";
/** Enough results to see every exact tie: a common town name exists in many states. */
export const LOCALITY_SEARCH_TAKE = 10;
const OTHER_RESULTS_SHOWN = 5;

export function localitySearchParams(market: Pick<Market, "query">): QlooParams {
  return { query: market.query.trim(), types: LOCALITY_TYPE, take: LOCALITY_SEARCH_TAKE };
}

export type ChoiceReason = "deliberate" | "ambiguous" | "outside_state";

export type LocalityMatch =
  /** One exact name in the market's state: pinned without asking. */
  | { kind: "unique"; result: QlooSearchEntity; choices: QlooSearchEntity[] }
  /** A person picks one of `choices` (exact names only; in the state when any is). */
  | { kind: "choose"; reason: ChoiceReason; choices: QlooSearchEntity[] }
  /** No locality with the exact name; `others` are shown for context and are never pickable. */
  | { kind: "not_found"; others: QlooSearchEntity[] };

/**
 * True when one comma-separated part of the disambiguation is the state's name ("Tennessee, United
 * States" names Tennessee; "West Virginia, United States" does not name Virginia).
 */
export function namesState(disambiguation: string | null | undefined, stateName: string): boolean {
  if (disambiguation === null || disambiguation === undefined) return false;
  const state = normaliseName(stateName);
  return state !== "" && disambiguation.split(",").some((part) => normaliseName(part) === state);
}

/**
 * The config rule for a market (config/metros.json): exact normalised name and the locality type
 * only (D20), narrowed to the localities whose disambiguation names the market's state. One such
 * locality is pinned; two or more, none in the state, or a deliberate market (`pin: deliberate`)
 * go to a person. Popularity is shown in the listing but never used to choose.
 */
export function classifyLocality(market: Pick<Market, "query" | "stateName" | "deliberate">, results: readonly QlooSearchEntity[]): LocalityMatch {
  const wanted = normaliseName(market.query);
  const seen = new Set<string>();
  const distinct: QlooSearchEntity[] = [];
  for (const r of results) {
    if (seen.has(r.entity_id)) continue;
    seen.add(r.entity_id);
    distinct.push(r);
  }
  const exact = wanted === "" ? [] : distinct.filter((r) => r.types.includes(LOCALITY_TYPE) && normaliseName(r.name) === wanted);
  if (exact.length === 0) return { kind: "not_found", others: distinct.slice(0, OTHER_RESULTS_SHOWN) };
  const inState = exact.filter((r) => namesState(r.disambiguation, market.stateName));
  const choices = inState.length > 0 ? inState : exact;
  if (market.deliberate) return { kind: "choose", reason: "deliberate", choices };
  if (inState.length === 1 && inState[0] !== undefined) return { kind: "unique", result: inState[0], choices };
  return { kind: "choose", reason: inState.length > 1 ? "ambiguous" : "outside_state", choices };
}
