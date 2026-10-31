import { OSM_QUERY_LIMITS, type OsmCountQuery, type OsmCounts, type OsmPlace, type OsmPlacesQuery } from "@ct/contracts";
import { DAY_MS } from "@ct/qloo";
import { PublicDataError, type PublicRequest } from "../api";
import type { CallSpec } from "../client";
import { KeptCounts, KeptPlaces, osmReference, parseCounts, parsePlaces } from "./parse";
import { countsQuery, type OsmQueryOptions, placesQuery } from "./query";

/**
 * OpenStreetMap through the Overpass API (Part 11 design §3.1, D46): the call specs the public-data client
 * runs, and the policy numbers. Counts, names and city references are cached 30 days. Requests go one at
 * a time, at least 1 s apart, at most OSM_DAILY_MAX a UTC day for the whole deploy (counted in kv
 * `osm.count.<YYYY-MM-DD>`), with one retry on 429/502/503/504 (after Retry-After, at most 10 s, or 5 s;
 * a timeout or network failure is not retried) and a stale cached copy served when that fails. Well inside the public instance's usage policy (under
 * 10,000 requests and 1 GB a day, an identifying User-Agent, no parallel heavy queries).
 *
 * One tool call's OpenStreetMap requests share one deadline (OSM_CALL_DEADLINE_MS from its first request):
 * queueing, every attempt, the retry wait and the optional fallback instance (OSM_OVERPASS_FALLBACK_URL)
 * all end by then. A busy public instance otherwise held one answer for about 90 s.
 */

export const OSM_TTL_MS = 30 * DAY_MS;
export const DEFAULT_OSM_OVERPASS_URL = "https://overpass-api.de/api/interpreter";
export const DEFAULT_OSM_DAILY_MAX = 2000;
/** One request start per second, one request in flight per process. */
export const DEFAULT_OSM_RPS = 1;
export const OSM_CONCURRENCY = 1;
/** Two attempts: the first and one retry. */
export const OSM_MAX_ATTEMPTS = 2;
export const OSM_RETRY_WAIT_MS = 5_000;
/** A longer Retry-After is not waited for inside a run: the call fails (a stale copy may answer). */
export const OSM_MAX_RETRY_AFTER_MS = 10_000;
/**
 * The query asks Overpass for at most 25 s of work, but a busy public instance first holds a request
 * in its queue (about 30 s was seen live), so the transport waits 45 s. A request that times out is
 * not retried: a second long wait would cost the run more than a stale copy or an honest gap. Inside a
 * run the call deadline (OSM_CALL_DEADLINE_MS) ends it much sooner; the 45 s cap applies where none is set.
 */
export const OSM_TIMEOUT_MS = 45_000;
/**
 * Wall time for all the OpenStreetMap requests of one tool call together (queue, attempts, retry wait,
 * fallback). Past it a stale cached copy answers, or the step ends as unavailable and the answer says so.
 */
export const OSM_CALL_DEADLINE_MS = 12_000;
/** With a fallback instance set, the primary's attempts end this long before the deadline, so the fallback gets a fair try. */
export const OSM_FALLBACK_RESERVE_MS = 5_000;
/** No retry or fallback attempt starts with less time than this left before the deadline. */
export const OSM_MIN_ATTEMPT_MS = 2_000;
export const OSM_RETRY_STATUSES: ReadonlySet<number> = new Set([429, 502, 503, 504]);
/** kv key prefix of the daily request counter; /status reads `osm.count.<YYYY-MM-DD>`. */
export const OSM_DAILY_KV_PREFIX = "osm.count.";

/** The kv key of the UTC day containing `nowMs`. */
export const osmDailyKvKey = (nowMs: number): string => `${OSM_DAILY_KV_PREFIX}${new Date(nowMs).toISOString().slice(0, 10)}`;

export interface OverpassTarget {
  /** The full endpoint URL requests are POSTed to. */
  url: string;
  /** host[:port], as provenance names it. */
  host: string;
  path: string;
}

/** OSM_OVERPASS_URL (or OSM_OVERPASS_FALLBACK_URL, named by `name`), checked: an http(s) URL without credentials, query or fragment. */
export function overpassTarget(raw: string = DEFAULT_OSM_OVERPASS_URL, name = "OSM_OVERPASS_URL"): OverpassTarget {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(`${name} must be an http(s) URL, e.g. https://overpass-api.de/api/interpreter`);
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new Error(`${name} must be an http(s) URL with no credentials, query or fragment`);
  }
  const path = url.pathname === "" ? "/" : url.pathname;
  return { url: `${url.protocol}//${url.host}${path}`, host: url.host, path };
}

/** OSM_OVERPASS_FALLBACK_URL, checked like the primary; null when unset. It must name another endpoint than the primary. */
export function overpassFallbackTarget(raw: string | null | undefined, primary: OverpassTarget): OverpassTarget | null {
  const text = raw?.trim() || null;
  if (text === null) return null;
  const target = overpassTarget(text, "OSM_OVERPASS_FALLBACK_URL");
  if (target.host === primary.host && target.path === primary.path) throw new Error("OSM_OVERPASS_FALLBACK_URL must name another Overpass endpoint than OSM_OVERPASS_URL");
  return target;
}

function overpassRequest(target: OverpassTarget, built: ReturnType<typeof countsQuery>): PublicRequest {
  return {
    source: "osm",
    endpoint: "/api/interpreter",
    host: target.host,
    path: target.path,
    query: {},
    method: "POST",
    body: built.ql,
    trace: built.trace,
    osm: built.plan,
  };
}

function osmFailure(status: number, detail: string | null): PublicDataError {
  const reason = detail ? `: ${detail}` : "";
  return new PublicDataError("bad_request", `the Overpass API rejected the query (HTTP ${status})${reason}`, { source: "osm", status });
}

/** One counts request (≤8 shapes × ≤24 types): counts per shape and type, with the data's date. */
export function osmCountsSpec(target: OverpassTarget, q: OsmCountQuery, options: OsmQueryOptions = {}): CallSpec<OsmCounts> {
  const built = countsQuery(q, options);
  const plan = built.plan as Extract<typeof built.plan, { kind: "counts" }>;
  return {
    request: overpassRequest(target, built),
    reference: osmReference(null),
    referenceFrom: (kept) => osmReference((kept as { osmBase: string | null }).osmBase),
    ttlMs: OSM_TTL_MS,
    keep: (json) => KeptCounts.parse(parseCounts(json, plan)),
    read: (json) => {
      const kept = KeptCounts.parse(json());
      // A kept body always answers the query it was stored for (same canonical text, same key).
      for (const pair of plan.pairs) {
        if (kept.counts[pair.shape.id]?.[pair.typeKey] === undefined) throw new Error(`the cached answer lacks ${pair.shape.id}/${pair.typeKey}`);
      }
      return kept;
    },
    failure: osmFailure,
  };
}

/** One names request (≤4 types in one shape, ≤80 named places). */
export function osmPlacesSpec(target: OverpassTarget, q: OsmPlacesQuery, options: OsmQueryOptions = {}): CallSpec<OsmPlace[]> {
  const built = placesQuery(q, options);
  const plan = built.plan as Extract<typeof built.plan, { kind: "places" }>;
  return {
    request: overpassRequest(target, built),
    reference: osmReference(null),
    referenceFrom: (kept) => osmReference((kept as { osmBase: string | null }).osmBase),
    ttlMs: OSM_TTL_MS,
    keep: (json) => KeptPlaces.parse(parsePlaces(json, plan.types)),
    read: (json) => KeptPlaces.parse(json()).places.slice(0, Math.min(plan.limit, OSM_QUERY_LIMITS.places)),
    failure: osmFailure,
  };
}
