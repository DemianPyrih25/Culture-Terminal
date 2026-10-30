import { randomBytes } from "node:crypto";
import type {
  CacheStatus,
  CensusAcsData,
  CensusGeo,
  OsmCountQuery,
  OsmCounts,
  OsmPlace,
  OsmPlacesQuery,
  PublicCallMeta,
  PublicDataApi,
  PublicResult,
  SecCompany,
  SecCompanyFacts,
} from "@ct/contracts";
import { DAY_MS, ERROR_TTL_MS, type Now, RequestLimiter, realNow, realSleep, SILENT_LOGGER, type Sleep } from "@ct/qloo";
import {
  type PublicCallRecord,
  type PublicDataClient,
  type PublicDataClientOptions,
  PublicDataError,
  type PublicLogger,
  publicProvenanceRequest,
  type PublicRequest,
  type PublicRunScope,
  type PublicStore,
  type PublicTransport,
  type PublicTransportResponse,
  type RunPublic,
} from "./api";
import { canServeStale, isSuccessStatus, type PublicCacheEntry, PublicResponseCache } from "./cache";
import { namespaceFor, publicCacheKey, redactPublicParams } from "./canonical";
import {
  DEFAULT_OSM_DAILY_MAX,
  DEFAULT_OSM_RPS,
  OSM_CONCURRENCY,
  OSM_MAX_ATTEMPTS,
  OSM_MAX_RETRY_AFTER_MS,
  OSM_RETRY_STATUSES,
  OSM_RETRY_WAIT_MS,
  osmCountsSpec,
  osmDailyKvKey,
  osmPlacesSpec,
  type OverpassTarget,
  overpassTarget,
} from "./osm/client";
import { OverpassRuntimeError } from "./osm/parse";
import { acsData, assertAllowedVariables, canonicalGeo, censusReference, censusRequest, parseAcsRows, validateAcsTable } from "./census";
import {
  normalizeTicker,
  padCik,
  parseCompanyFacts,
  parseTickerMap,
  reduceCompanyFacts,
  SEC_TICKERS_REFERENCE,
  secFactsReference,
  secFactsRequest,
  secTickersRequest,
  validateTickerMap,
} from "./sec";

/**
 * The public-data client: the only path to SEC EDGAR, US Census and OpenStreetMap (Overpass) data, with
 * the Qloo client's guarantees. Per call: canonicalise → cache (L1, L2) → single-flight → limiter (per source) → fetch
 * with retries → classify → keep → log. Every call, network or cache, yields a PublicCallRecord (the
 * `public` event and provenance) and one public_calls row. Public calls never touch Qloo budgets.
 *
 * TTLs: the SEC ticker map and company facts 7 days; Census ACS pinned (a published vintage never
 * changes); OpenStreetMap counts and names 30 days; a 4xx answer 1 day; 429, 5xx, an SEC 403 block, a
 * Census key redirect and an Overpass runtime error are never stored. OpenStreetMap has its own policy
 * (osm/client.ts): one request at a time, 1 s apart, two attempts, and a daily request cap.
 */

/** SEC ticker map and company facts. */
export const SEC_TTL_MS = 7 * DAY_MS;
/** SEC asks for at most 10 requests per second; we stay at half. */
export const DEFAULT_SEC_RPS = 5;
export const DEFAULT_CENSUS_RPS = 5;
/** Requests in flight per source. */
const SOURCE_CONCURRENCY = 4;
const MAX_ATTEMPTS = 3;
const MAX_BACKOFF_MS = 8_000;
const BASE_BACKOFF_MS = 300;
const RETRY_STATUSES: ReadonlySet<number> = new Set([500, 502, 503, 504]);
const MAX_RECORDS_PER_SCOPE = 2_000;
/** ACS 5-year vintages tried, newest first, counted back from the current year. */
const VINTAGES_TRIED = 3;
/** A vintage found unpublished (404) is not tried again for this long. */
const MISSING_VINTAGE_MS = DAY_MS;

/** How one kind of call is fetched, kept and read. */
export interface CallSpec<T> {
  request: PublicRequest;
  reference: string;
  /** The reference read from the kept body when it depends on the answer (OpenStreetMap: its data date). */
  referenceFrom?(kept: unknown): string;
  /** TTL of a 2xx answer; null pins it. */
  ttlMs: number | null;
  /** Checks a 2xx JSON body (null for an empty body) and returns what the cache keeps. Throws when malformed. */
  keep(json: unknown): unknown;
  /** Reads the kept body (`json()` parses it). May throw a PublicDataError (e.g. not_found for an empty ACS answer). */
  read(json: () => unknown, entry: PublicCacheEntry): T;
  /** The error for a cached or fresh 4xx answer. */
  failure(status: number, detail: string | null): PublicDataError;
}

interface ScopeState {
  readonly runId: string | null;
  readonly signal: AbortSignal | undefined;
  readonly onCall: ((record: PublicCallRecord) => void) | undefined;
  readonly records: Map<string, PublicCallRecord>;
}

type Outcome =
  | { kind: "cache"; entry: PublicCacheEntry }
  | { kind: "network"; entry: PublicCacheEntry; httpStatus: number }
  | { kind: "stale"; entry: PublicCacheEntry; httpStatus: number | null };

/** How a flight failed, so its leader and followers can each log and react. Never escapes the client. */
class FlightFailure extends Error {
  constructor(
    readonly error: unknown,
    /** The leader's call reached the network. */
    readonly network: boolean,
    readonly httpStatus: number | null,
    /** The leader's own run was cancelled: followers retry on their own. */
    readonly leaderAborted: boolean,
  ) {
    super("public data flight failed");
  }
}

type Verdict =
  | { kind: "ok"; json: unknown }
  | { kind: "retry"; error: PublicDataError }
  | { kind: "client_error" }
  | { kind: "fatal"; error: PublicDataError };

type FetchResult = { kind: "ok"; response: PublicTransportResponse; json: unknown } | { kind: "client_error"; response: PublicTransportResponse };

interface AttemptProgress {
  attempted: boolean;
  lastStatus: number | null;
  /** The OpenStreetMap daily cap refused the request before it left: a stale copy may still answer. */
  capped: boolean;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const newCallId = (): string => `pc_${randomBytes(8).toString("hex")}`;
const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const SOURCE_NAME = { sec: "SEC EDGAR", census: "the Census Data API", osm: "the Overpass API (OpenStreetMap)" } as const;

/** Failures worth a retry's wait or a stale answer: network trouble, 429, 5xx, an SEC 403 block. */
const isTransient = (err: unknown): boolean =>
  err instanceof PublicDataError && (err.code === "unavailable" || err.code === "rate_limited");

/** Settles with `promise`, or rejects with the signal's reason as soon as the signal aborts. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted) return Promise.reject(signal.reason as Error);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason as Error);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.finally(() => signal.removeEventListener("abort", onAbort)).then(resolve, reject);
  });
}

export function createPublicDataClient(options: PublicDataClientOptions): PublicDataClient {
  return new PublicDataClientImpl(options);
}

class PublicDataClientImpl implements PublicDataClient {
  readonly env: PublicDataClient["env"];
  readonly configured: PublicDataClient["configured"];
  private readonly transport: PublicTransport;
  private readonly store: PublicStore;
  private readonly logger: PublicLogger;
  private readonly now: Now;
  private readonly sleep: Sleep;
  private readonly random: () => number;
  private readonly secUserAgent: string | null;
  private readonly osmUserAgent: string | null;
  private readonly osmTarget: OverpassTarget;
  private readonly osmDailyMax: number;
  private readonly osmQueryOptions: { long: boolean };
  /** Requests counted in this process when the store has no shared counter (or it failed). */
  private readonly localDailyCounts = new Map<string, number>();
  private readonly limiters: Record<"sec" | "census" | "osm", RequestLimiter>;
  private readonly cache: PublicResponseCache;
  private readonly flights = new Map<string, Promise<Outcome>>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly missingVintages = new Map<number, number>();
  private tickerIndex: { key: string; fetchedAt: number; map: Map<string, SecCompany> } | null = null;

  constructor(private readonly options: PublicDataClientOptions) {
    this.env = options.env;
    this.transport = options.transport;
    this.store = options.store;
    this.logger = options.logger ?? SILENT_LOGGER;
    this.now = options.now ?? realNow;
    this.sleep = options.sleep ?? realSleep;
    this.random = options.random ?? Math.random;
    this.secUserAgent = options.secUserAgent?.trim() || null;
    this.osmUserAgent = options.osmUserAgent?.trim() || null;
    this.osmTarget = overpassTarget(options.osmOverpassUrl);
    const dailyMax = options.osmDailyMax ?? DEFAULT_OSM_DAILY_MAX;
    if (!Number.isInteger(dailyMax) || dailyMax < 0) throw new RangeError(`osmDailyMax must be a whole number ≥ 0, got ${dailyMax}`);
    this.osmDailyMax = dailyMax;
    this.osmQueryOptions = { long: options.osmLongQueries === true };
    const mock = options.env === "mock";
    // A transport made by createPublicHttpTransport says whether it holds a Census key; others are trusted.
    const censusKeyed = (options.transport as { censusKeyed?: unknown }).censusKeyed !== false;
    this.configured = Object.freeze({ sec: mock || this.secUserAgent !== null, census: mock || censusKeyed, osm: mock || this.osmUserAgent !== null });
    const limiter = (rps: number, concurrency = SOURCE_CONCURRENCY) => new RequestLimiter({ rps, concurrency, now: this.now, sleep: this.sleep });
    this.limiters = {
      sec: limiter(options.rps?.sec ?? DEFAULT_SEC_RPS),
      census: limiter(options.rps?.census ?? DEFAULT_CENSUS_RPS),
      osm: limiter(options.rps?.osm ?? DEFAULT_OSM_RPS, OSM_CONCURRENCY),
    };
    this.cache = new PublicResponseCache({ store: this.store, now: this.now, logger: this.logger, track: (w) => this.track(w) });
  }

  forRun(scope: PublicRunScope): RunPublic {
    return this.runPublic({ runId: scope.runId, onCall: scope.onCall, signal: scope.signal, records: new Map() });
  }

  standalone(options: { onCall?: (record: PublicCallRecord) => void; signal?: AbortSignal } = {}): RunPublic {
    return this.runPublic({ runId: null, onCall: options.onCall, signal: options.signal, records: new Map() });
  }

  async flush(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }

  private runPublic(scope: ScopeState): RunPublic {
    return {
      forTool: (toolCallId) => this.api(scope, toolCallId),
      provenance: (publicCallId) => {
        const record = scope.records.get(publicCallId);
        return record ? publicProvenanceRequest(record) : null;
      },
      call: (publicCallId) => scope.records.get(publicCallId) ?? null,
    };
  }

  private api(scope: ScopeState, toolCallId: string | null): PublicDataApi {
    return {
      secTicker: async (ticker) => this.secTicker(scope, toolCallId, ticker),
      secCompanyFacts: async (cik) => this.call(scope, toolCallId, this.factsSpec(padCik(cik))),
      censusAcs: async (geo) => this.censusAcs(scope, toolCallId, geo),
      osmCounts: async (q: OsmCountQuery): Promise<PublicResult<OsmCounts>> =>
        this.call(scope, toolCallId, osmCountsSpec(this.osmTarget, q, this.osmQueryOptions)),
      osmPlaces: async (q: OsmPlacesQuery): Promise<PublicResult<OsmPlace[]>> =>
        this.call(scope, toolCallId, osmPlacesSpec(this.osmTarget, q, this.osmQueryOptions)),
    };
  }

  // The reads ------------------------------------------------------------------------------------------

  private secTicker(scope: ScopeState, toolCallId: string | null, ticker: string): Promise<PublicResult<SecCompany | null>> {
    const wanted = normalizeTicker(ticker);
    return this.call(scope, toolCallId, {
      request: secTickersRequest(),
      reference: SEC_TICKERS_REFERENCE,
      ttlMs: SEC_TTL_MS,
      keep: (json) => {
        validateTickerMap(json);
        return json;
      },
      read: (json, entry) => {
        // The map is about 10,000 rows: parse it once per cached copy, not once per lookup.
        if (this.tickerIndex === null || this.tickerIndex.key !== entry.key || this.tickerIndex.fetchedAt !== entry.fetchedAt) {
          this.tickerIndex = { key: entry.key, fetchedAt: entry.fetchedAt, map: parseTickerMap(json()) };
        }
        return this.tickerIndex.map.get(wanted) ?? null;
      },
      failure: (status, detail) => httpFailure("sec", status, detail, "the SEC ticker map"),
    });
  }

  private factsSpec(cik: string): CallSpec<SecCompanyFacts> {
    const reference = secFactsReference(cik);
    return {
      request: secFactsRequest(cik),
      reference,
      ttlMs: SEC_TTL_MS,
      keep: (json) => reduceCompanyFacts(json),
      read: (json) => parseCompanyFacts(json(), cik),
      failure: (status, detail) =>
        status === 404
          ? new PublicDataError("not_found", `SEC EDGAR has no XBRL company facts for ${reference}`, { source: "sec", status })
          : httpFailure("sec", status, detail, `company facts for ${reference}`),
    };
  }

  private censusSpec(vintage: number, geo: CensusGeo): CallSpec<CensusAcsData> {
    const request = censusRequest(vintage, geo);
    assertAllowedVariables(request.query.get ?? "");
    const reference = censusReference(vintage, geo);
    const g = canonicalGeo(geo);
    const place = g.kind === "zcta" ? `ZCTA ${g.zctas.join(", ")}` : `the tracts of county ${g.state}${g.county}`;
    return {
      request,
      reference,
      ttlMs: null,
      keep: (json) => {
        validateAcsTable(json, geo);
        return json;
      },
      read: (json) => {
        const rows = parseAcsRows(json(), geo);
        if (rows.length === 0) {
          throw new PublicDataError("not_found", `the ACS 5-year ${vintage} estimates have no rows for ${place}`, { source: "census", status: 204 });
        }
        return acsData(vintage, rows);
      },
      failure: (status, detail) =>
        status === 404
          ? new PublicDataError("not_found", `the ACS 5-year ${vintage} estimates are not published`, { source: "census", status })
          : httpFailure("census", status, detail, `ACS 5-year ${vintage}`),
    };
  }

  /**
   * The newest ACS 5-year vintage that answers: the year before this one, then earlier years. A vintage
   * found unpublished (404) is skipped for a day; every vintage is pinned once fetched.
   */
  private async censusAcs(scope: ScopeState, toolCallId: string | null, geo: CensusGeo): Promise<PublicResult<CensusAcsData>> {
    const g = canonicalGeo(geo);
    const now = this.now();
    const newest = new Date(now).getUTCFullYear() - 1;
    const years = Array.from({ length: VINTAGES_TRIED }, (_, i) => newest - i);
    const candidates = years.filter((y, i) => i === years.length - 1 || now - (this.missingVintages.get(y) ?? -Infinity) >= MISSING_VINTAGE_MS);
    let lastError: unknown = null;
    for (const year of candidates) {
      try {
        return await this.call(scope, toolCallId, this.censusSpec(year, g));
      } catch (err) {
        if (err instanceof PublicDataError && err.code === "not_found" && err.status === 404) {
          this.missingVintages.set(year, this.now());
          lastError = err;
          continue;
        }
        throw err;
      }
    }
    throw new PublicDataError("not_found", `no ACS 5-year vintage from ${years.at(-1)} to ${newest} is published`, {
      source: "census",
      status: 404,
      cause: lastError,
    });
  }

  // The call pipeline ----------------------------------------------------------------------------------------

  private async call<T>(scope: ScopeState, toolCallId: string | null, spec: CallSpec<T>): Promise<PublicResult<T>> {
    scope.signal?.throwIfAborted();
    const request = spec.request;
    if (request.source === "sec" && this.env !== "mock" && this.secUserAgent === null) {
      throw new PublicDataError("not_configured", "SEC_USER_AGENT is not set: SEC EDGAR requires a User-Agent naming the product and a contact email", { source: "sec" });
    }
    if (request.source === "osm" && this.env !== "mock" && this.osmUserAgent === null) {
      throw new PublicDataError("not_configured", "OSM_USER_AGENT is not set: the Overpass API usage policy asks for a User-Agent naming the product and a contact", { source: "osm" });
    }
    const key = publicCacheKey(request, namespaceFor(this.env));
    const publicCallId = newCallId();
    const started = this.now();
    for (;;) {
      const existing = this.flights.get(key);
      const lead = existing === undefined;
      let outcome: Outcome;
      try {
        // A waiter's own cancellation ends its wait; the leader's request carries on for the others.
        outcome = await (lead ? this.startFlight(scope, key, spec) : untilAborted(existing, scope.signal));
      } catch (err) {
        const failure = err instanceof FlightFailure ? err : new FlightFailure(err, false, null, false);
        if (!lead) {
          scope.signal?.throwIfAborted();
          // The leader's run was cancelled: that says nothing about this caller.
          if (failure.leaderAborted) continue;
          this.logFailure(scope, toolCallId, publicCallId, key, spec, started, "coalesced", failure, false);
        } else if (failure.network) {
          this.logFailure(scope, toolCallId, publicCallId, key, spec, started, "miss", failure, true);
        }
        throw failure.error;
      }
      return this.deliver(scope, toolCallId, publicCallId, key, spec, started, outcome, lead);
    }
  }

  /** Registers the flight before its first await, so a concurrent identical request always joins it. */
  private startFlight<T>(scope: ScopeState, key: string, spec: CallSpec<T>): Promise<Outcome> {
    const flight = this.runFlight(scope, key, spec);
    this.flights.set(key, flight);
    const clear = () => {
      if (this.flights.get(key) === flight) this.flights.delete(key);
    };
    void flight.then(clear, clear);
    return flight;
  }

  private async runFlight<T>(scope: ScopeState, key: string, spec: CallSpec<T>): Promise<Outcome> {
    const found = await this.cache.lookup(key);
    if (found.fresh) return { kind: "cache", entry: found.fresh };
    return this.fetchFresh(scope, key, spec, found.expired);
  }

  private async fetchFresh<T>(scope: ScopeState, key: string, spec: CallSpec<T>, expired: PublicCacheEntry | null): Promise<Outcome> {
    const progress: AttemptProgress = { attempted: false, lastStatus: null, capped: false };
    try {
      const result = await this.fetchWithRetry(spec.request, scope.signal, progress);
      if (result.kind === "client_error") {
        const entry = this.entryFrom(key, spec, result.response.status, encoder.encode(shortBody(result.response.body)), ERROR_TTL_MS, scope.runId);
        this.cache.store(entry);
        return { kind: "network", entry, httpStatus: result.response.status };
      }
      let kept: unknown;
      try {
        kept = spec.keep(result.json);
      } catch (err) {
        throw new PublicDataError(
          "invalid_response",
          `${SOURCE_NAME[spec.request.source]} answered with a body that does not have the expected shape (${errorText(err).slice(0, 160)})`,
          { source: spec.request.source, status: result.response.status, cause: err },
        );
      }
      const entry = this.entryFrom(key, spec, result.response.status, encoder.encode(JSON.stringify(kept)), spec.ttlMs, scope.runId, kept);
      this.cache.store(entry);
      return { kind: "network", entry, httpStatus: result.response.status };
    } catch (err) {
      if (err instanceof FlightFailure) throw err;
      const aborted = scope.signal?.aborted === true;
      if (!aborted && (progress.attempted || progress.capped) && isTransient(err) && expired !== null && canServeStale(expired, this.now())) {
        this.logger.warn({ source: spec.request.source, path: spec.request.path, err: errorText(err) }, "public data network failed; serving a stale cached answer");
        return { kind: "stale", entry: expired, httpStatus: progress.lastStatus };
      }
      throw new FlightFailure(err, progress.attempted, progress.lastStatus, aborted);
    }
  }

  private async fetchWithRetry(request: PublicRequest, signal: AbortSignal | undefined, progress: AttemptProgress): Promise<FetchResult> {
    let lastError: PublicDataError | null = null;
    const limiter = this.limiters[request.source];
    const osm = request.source === "osm";
    const attempts = osm ? OSM_MAX_ATTEMPTS : MAX_ATTEMPTS;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      signal?.throwIfAborted();
      let response: PublicTransportResponse | null = null;
      if (osm && this.env !== "mock") {
        try {
          await this.countOsmRequest();
        } catch (err) {
          progress.capped = !progress.attempted;
          throw err;
        }
      }
      try {
        response = await limiter.run(() => {
          progress.attempted = true;
          return this.transport(request, signal);
        }, signal);
      } catch (err) {
        if (signal?.aborted) throw signal.reason;
        if (err instanceof PublicDataError && err.code === "not_configured") {
          // Refused before any request left (no key or User-Agent): nothing reached the network.
          progress.attempted = false;
          throw err;
        }
        // An oversized or refused request comes back the same: a retry would only add load.
        if (err instanceof PublicDataError && err.code !== "unavailable") throw err;
        // Overpass: no answer after a 45 s wait is not worth a second one (a stale copy may answer).
        if (osm) {
          throw err instanceof PublicDataError
            ? err
            : new PublicDataError("unavailable", `request to ${SOURCE_NAME.osm} failed (${errorText(err).slice(0, 120)})`, { source: "osm", cause: err });
        }
        lastError =
          err instanceof PublicDataError
            ? err
            : new PublicDataError("unavailable", `request to ${SOURCE_NAME[request.source]} failed (${errorText(err).slice(0, 120)})`, {
                source: request.source,
                cause: err,
              });
      }
      if (response !== null) {
        progress.lastStatus = response.status;
        const verdict = classify(request, response, attempt);
        switch (verdict.kind) {
          case "ok":
            return { kind: "ok", response, json: verdict.json };
          case "client_error":
            return { kind: "client_error", response };
          case "fatal":
            throw verdict.error;
          case "retry":
            lastError = verdict.error;
            break;
        }
      }
      if (attempt < attempts) {
        const wait = osm ? osmRetryWaitMs(response) : this.backoffMs(attempt - 1);
        // Overpass asked for a longer pause than a run can afford: fail now (a stale copy may answer).
        if (wait === null) break;
        await this.sleep(wait, signal);
      }
    }
    throw lastError ?? new PublicDataError("unavailable", `${SOURCE_NAME[request.source]} did not answer`, { source: request.source });
  }

  /**
   * Counts one Overpass network request toward OSM_DAILY_MAX (whole deploy, UTC day) and refuses it past
   * the cap. The shared kv counter is used when the store has one; if it fails the process counts alone.
   */
  private async countOsmRequest(): Promise<void> {
    const key = osmDailyKvKey(this.now());
    let n: number;
    try {
      if (this.store.incrementCounter === undefined) throw new Error("no shared counter");
      n = await this.store.incrementCounter(key, 1);
    } catch (err) {
      if (this.store.incrementCounter !== undefined) {
        this.logger.warn({ err: errorText(err) }, "OpenStreetMap daily counter not reachable; counting in this process");
      }
      n = (this.localDailyCounts.get(key) ?? 0) + 1;
      this.localDailyCounts.set(key, n);
      if (this.localDailyCounts.size > 3) this.localDailyCounts.delete(this.localDailyCounts.keys().next().value as string);
    }
    if (n > this.osmDailyMax) {
      throw new PublicDataError(
        "rate_limited",
        `the OpenStreetMap request cap for today (${this.osmDailyMax} Overpass requests) is reached; it resets at 00:00 UTC`,
        { source: "osm" },
      );
    }
  }

  /** 300·2^n ms · U(0.8, 1.2), capped at 8 s. */
  private backoffMs(retry: number): number {
    return Math.min(MAX_BACKOFF_MS, Math.round(BASE_BACKOFF_MS * 2 ** retry * (0.8 + 0.4 * this.random())));
  }

  private entryFrom<T>(
    key: string,
    spec: CallSpec<T>,
    status: number,
    body: Uint8Array,
    ttlMs: number | null,
    runId: string | null,
    kept?: unknown,
  ): PublicCacheEntry {
    const fetchedAt = this.now();
    return {
      key,
      source: spec.request.source,
      path: spec.request.path,
      query: { ...spec.request.query },
      status,
      body,
      reference: this.referenceFor(key, spec, kept),
      fetchedAt,
      expiresAt: ttlMs === null ? null : fetchedAt + ttlMs,
      pinned: ttlMs === null,
      originRunId: runId,
    };
  }

  /** The call's reference; synthetic answers carry `mock-<hash>` so they never pass for a real filing or table. */
  private referenceFor<T>(key: string, spec: CallSpec<T>, kept?: unknown): string {
    if (this.env === "mock") return `mock-${key.slice(0, 16)}`;
    return kept !== undefined && spec.referenceFrom ? spec.referenceFrom(kept) : spec.reference;
  }

  // Delivery and logging ------------------------------------------------------------------------------------

  private deliver<T>(
    scope: ScopeState,
    toolCallId: string | null,
    publicCallId: string,
    key: string,
    spec: CallSpec<T>,
    started: number,
    outcome: Outcome,
    lead: boolean,
  ): PublicResult<T> {
    const now = this.now();
    const entry = outcome.entry;
    const network = lead && outcome.kind !== "cache";
    // "stale" is the leader's failed network call; a follower waited for free, so it is coalesced (stale stays true).
    let cache: CacheStatus;
    if (!lead && outcome.kind !== "cache") cache = "coalesced";
    else if (outcome.kind === "network") cache = "miss";
    else if (outcome.kind === "stale") cache = "stale";
    else cache = scope.runId !== null && entry.originRunId !== null && entry.originRunId !== scope.runId ? "reused" : "hit";
    if (outcome.kind === "cache") this.cache.recordHit(entry.key);

    const base = {
      publicCallId,
      toolCallId,
      runId: scope.runId,
      source: spec.request.source,
      endpoint: spec.request.endpoint,
      host: spec.request.host,
      path: spec.request.path,
      query: { ...spec.request.query },
      paramsRedacted: traceParams(spec.request),
      ...requestBody(spec.request),
      cache,
      stale: outcome.kind === "stale",
      ms: Math.max(0, now - started),
      reference: entry.reference ?? this.referenceFor(key, spec),
      status: entry.status,
      cacheAgeMs: cache === "miss" ? null : Math.max(0, now - entry.fetchedAt),
      originRunId: cache === "miss" ? null : entry.originRunId,
      fetchedAt: new Date(entry.fetchedAt).toISOString(),
    };
    const httpStatus = network ? outcome.httpStatus : null;

    let data: T;
    try {
      if (!isSuccessStatus(entry.status)) throw spec.failure(entry.status, decoder.decode(entry.body) || null);
      data = spec.read(() => JSON.parse(decoder.decode(entry.body)) as unknown, entry);
    } catch (err) {
      const error =
        err instanceof PublicDataError
          ? err
          : new PublicDataError("invalid_response", `the cached ${SOURCE_NAME[spec.request.source]} answer could not be read`, {
              source: spec.request.source,
              cause: err,
            });
      this.finish(scope, { ...base, error: error.message }, key, network, httpStatus);
      throw error;
    }
    this.finish(scope, { ...base, error: null }, key, network, httpStatus);
    const meta: PublicCallMeta = {
      publicCallId,
      source: base.source,
      endpoint: base.endpoint,
      reference: base.reference,
      cache,
      fetchedAt: base.fetchedAt,
      ms: base.ms,
      stale: base.stale,
      originRunId: base.originRunId,
    };
    return { data, meta };
  }

  private logFailure<T>(
    scope: ScopeState,
    toolCallId: string | null,
    publicCallId: string,
    key: string,
    spec: CallSpec<T>,
    started: number,
    cache: "miss" | "coalesced",
    failure: FlightFailure,
    network: boolean,
  ): void {
    const record: PublicCallRecord = {
      publicCallId,
      toolCallId,
      runId: scope.runId,
      source: spec.request.source,
      endpoint: spec.request.endpoint,
      host: spec.request.host,
      path: spec.request.path,
      query: { ...spec.request.query },
      paramsRedacted: traceParams(spec.request),
      ...requestBody(spec.request),
      cache,
      stale: false,
      ms: Math.max(0, this.now() - started),
      // Null only when no response arrived.
      reference: failure.httpStatus === null ? null : this.referenceFor(key, spec),
      status: failure.httpStatus,
      cacheAgeMs: null,
      originRunId: null,
      fetchedAt: null,
      error: errorText(failure.error),
    };
    this.finish(scope, record, key, network, network ? failure.httpStatus : null);
  }

  private finish(scope: ScopeState, record: PublicCallRecord, cacheKey: string, network: boolean, httpStatus: number | null): void {
    scope.records.set(record.publicCallId, record);
    if (scope.records.size > MAX_RECORDS_PER_SCOPE) {
      const oldest = scope.records.keys().next();
      if (!oldest.done) scope.records.delete(oldest.value);
    }
    try {
      scope.onCall?.(record);
    } catch (err) {
      this.logger.warn({ err: errorText(err) }, "public data onCall callback threw");
    }
    this.logger.debug(
      { publicCallId: record.publicCallId, runId: record.runId, source: record.source, path: record.path, cache: record.cache, ms: record.ms },
      "public data call",
    );
    const write = this.store.logCalls([
      {
        id: record.publicCallId,
        ts: new Date(this.now()),
        env: this.env,
        tag: this.options.tag,
        runId: record.runId,
        source: record.source,
        path: record.path,
        params: record.paramsRedacted,
        cacheKey,
        cacheStatus: record.cache,
        httpStatus: network ? httpStatus : null,
        ms: record.ms,
        reference: record.reference,
        error: record.error,
      },
    ]);
    this.track(write.catch((err: unknown) => this.logger.warn({ err: errorText(err) }, "public data call log write failed")));
  }

  private track(write: Promise<unknown>): void {
    const tracked = write.then(
      () => undefined,
      (err: unknown) => this.logger.warn({ err: errorText(err) }, "public data background write failed"),
    );
    this.pending.add(tracked);
    void tracked.then(() => this.pending.delete(tracked));
  }
}

/** The trace and call-log params: the shortened query, or a POST's trace summary. */
function traceParams(request: PublicRequest): Record<string, string> {
  return request.method === "POST" && request.trace !== undefined ? { ...request.trace } : redactPublicParams(request.query);
}

/** method and body for a call record (absent for GET, so SEC and Census records keep their shape). */
function requestBody(request: PublicRequest): { method?: "POST"; body?: string } {
  return request.method === "POST" ? { method: "POST", ...(request.body === undefined ? {} : { body: request.body }) } : {};
}

/** Wait before the OpenStreetMap retry: Retry-After when given (null past 10 s: not worth a run's time), else 5 s. */
function osmRetryWaitMs(response: PublicTransportResponse | null): number | null {
  const after = response?.retryAfterS;
  if (after === undefined || after === null || !Number.isFinite(after) || after < 0) return OSM_RETRY_WAIT_MS;
  const ms = Math.ceil(after * 1000);
  return ms > OSM_MAX_RETRY_AFTER_MS ? null : Math.max(ms, 1_000);
}

/**
 * Overpass: 429 (too many requests from this address) and 502/503/504 (the instance is at capacity) get
 * one retry and are never stored; a 200 whose body carries a runtime-error remark is a failure (partial
 * data), never stored and never retried; another 4xx is a query the server rejects, stored a day.
 */
function classifyOsm(response: PublicTransportResponse, attempt: number): Verdict {
  const { status } = response;
  const name = SOURCE_NAME.osm;
  if (status >= 200 && status < 300) {
    let json: unknown;
    try {
      json = JSON.parse(response.body) as unknown;
    } catch (err) {
      return { kind: "fatal", error: new PublicDataError("invalid_response", `${name} answered HTTP ${status} with a body that is not JSON`, { source: "osm", status, cause: err }) };
    }
    const remark = (json as { remark?: unknown } | null)?.remark;
    if (typeof remark === "string" && /error/i.test(remark)) {
      const why = new OverpassRuntimeError(remark.replace(/\s+/g, " ").slice(0, 160));
      return { kind: "fatal", error: new PublicDataError("unavailable", `${name} could not finish the query (${why.message})`, { source: "osm", status, cause: why }) };
    }
    return { kind: "ok", json };
  }
  if (status === 429) {
    return { kind: "retry", error: new PublicDataError("rate_limited", `${name} rate-limited the request (HTTP 429) after ${attempt} attempt(s)`, { source: "osm", status }) };
  }
  if (OSM_RETRY_STATUSES.has(status)) {
    return { kind: "retry", error: new PublicDataError("unavailable", `${name} is busy (HTTP ${status}) after ${attempt} attempt(s)`, { source: "osm", status }) };
  }
  if (status >= 400 && status < 500) return { kind: "client_error" };
  return { kind: "fatal", error: new PublicDataError("unavailable", `${name} answered HTTP ${status}`, { source: "osm", status }) };
}

/**
 * Status classes. SEC: 403 is its block for an undeclared User-Agent or too many requests (retried,
 * never stored); 404 an unknown CIK (stored a day). Census: a redirect or 401/403 means the key is
 * missing or invalid (never stored); 204 an empty answer. 429 and 5xx are retried and never stored.
 * OpenStreetMap: classifyOsm.
 */
function classify(request: PublicRequest, response: PublicTransportResponse, attempt: number): Verdict {
  const { status } = response;
  const source = request.source;
  if (source === "osm") return classifyOsm(response, attempt);
  if (status >= 200 && status < 300) {
    if (response.body.trim() === "") {
      if (source === "census") return { kind: "ok", json: null };
      return { kind: "fatal", error: new PublicDataError("invalid_response", `SEC EDGAR answered HTTP ${status} with an empty body`, { source, status }) };
    }
    try {
      return { kind: "ok", json: JSON.parse(response.body) as unknown };
    } catch (err) {
      return {
        kind: "fatal",
        error: new PublicDataError("invalid_response", `${SOURCE_NAME[source]} answered HTTP ${status} with a body that is not JSON`, { source, status, cause: err }),
      };
    }
  }
  if (source === "census" && ((status >= 300 && status < 400) || status === 401 || status === 403)) {
    return {
      kind: "fatal",
      error: new PublicDataError("not_configured", `the Census Data API refused the request (HTTP ${status}): CENSUS_API_KEY is missing or invalid`, { source, status }),
    };
  }
  if (source === "sec" && status === 403) {
    return {
      kind: "retry",
      error: new PublicDataError(
        "unavailable",
        `SEC EDGAR refused the request (HTTP 403) after ${attempt} attempt(s): it blocks requests without a declared User-Agent or above its rate limit`,
        { source, status },
      ),
    };
  }
  if (status === 429) {
    return { kind: "retry", error: new PublicDataError("rate_limited", `${SOURCE_NAME[source]} rate-limited the request (HTTP 429) after ${attempt} attempt(s)`, { source, status }) };
  }
  if (RETRY_STATUSES.has(status)) {
    return { kind: "retry", error: new PublicDataError("unavailable", `${SOURCE_NAME[source]} failed (HTTP ${status}) after ${attempt} attempt(s)`, { source, status }) };
  }
  if (status >= 400 && status < 500) return { kind: "client_error" };
  return { kind: "fatal", error: new PublicDataError("unavailable", `${SOURCE_NAME[source]} answered HTTP ${status}`, { source, status }) };
}

/** The error for a stored or fresh 4xx other than the not-found cases each spec names. */
function httpFailure(source: "sec" | "census" | "osm", status: number, detail: string | null, what: string): PublicDataError {
  const reason = detail === null ? "" : `: ${detail}`;
  if (status === 404) return new PublicDataError("not_found", `${SOURCE_NAME[source]} has no ${what} (HTTP 404)`, { source, status });
  return new PublicDataError("bad_request", `${SOURCE_NAME[source]} rejected the request for ${what} (HTTP ${status})${reason}`, { source, status });
}

/** A 4xx body kept for the error message: one short line of plain text, never anything key-like. */
function shortBody(body: string): string {
  const text = body.replace(/<[^>]*>/g, " ").replace(/[^\x20-\x7e]+/g, " ").replace(/\s+/g, " ").trim();
  if (/key=/i.test(text)) return "";
  return text.slice(0, 160);
}
