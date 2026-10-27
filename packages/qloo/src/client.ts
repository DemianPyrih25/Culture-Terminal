import { randomBytes } from "node:crypto";
import type {
  CacheProbe,
  CacheStatus,
  InsightsFilterType,
  InsightsResponse,
  Lane,
  Mode,
  Phase,
  Pillar,
  ProvenanceRequest,
  QlooApi,
  QlooAudiencesResponse,
  QlooEntitiesResponse,
  QlooParams,
  QlooResult,
  QlooSearchResponse,
  QlooTagsResponse,
  QlooTrendingResponse,
  RunLimits,
} from "@ct/contracts";
import pLimit, { type LimitFunction } from "p-limit";
import type { QlooPath } from "./allowlist";
import {
  BudgetGates,
  type BudgetScope,
  DEFAULT_DAILY_FRESH_CAP,
  monthFloorFor,
  type QlooBudgetWarning,
  type Reservation,
} from "./budget";
import { type CacheEntry, canServeStale, isSuccessStatus, ResponseCache } from "./cache";
import { type CacheNamespace, canonicalize, redactParams } from "./canonical";
import {
  BudgetError,
  QlooAuthError,
  QlooBadRequestError,
  QlooError,
  QlooNetworkError,
  QlooParamError,
  QlooRateLimitError,
  QlooResponseError,
  QlooServerError,
} from "./errors";
import { type Now, RequestLimiter, realNow, realSleep, RUN_CONCURRENCY, type Sleep } from "./limiter";
import { type QlooLogger, SILENT_LOGGER } from "./logger";
import { provenanceRequest } from "./provenance";
import { MOCK_QUOTA_KV_KEY, QUOTA_KV_KEY, type QuotaSnapshot, QuotaTracker } from "./quota";
import type { QlooCallRecord } from "./records";
import { responseSchema, rowCount } from "./schemas";
import type { QlooEnv, QlooStore } from "./store";
import { audienceCatalogueKvKey, readAudienceCatalogue, type AudienceCatalogueRead } from "./audience-catalogue";
import { sanitizeQlooText } from "./trim";
import type { CanonicalRequest, Transport, TransportResponse } from "./transport-types";
import { ERROR_TTL_MS, successTtlMs } from "./ttl";
import { validateRequest } from "./validate";

/**
 * The Qloo client (PLAN §5.1): the only path to Qloo. Per call: validate → canonicalise → cache
 * (L1, L2) → single-flight → budget gates → limiter → fetch with retries → classify → store → log.
 * Every call, network or cache, yields a QlooCallRecord for the trace and one qloo_calls row.
 */

export interface QlooClientOptions {
  transport: Transport;
  /** "prod" and "dev" call Qloo; "mock" uses synthetic data under its own cache namespace. */
  env: QlooEnv;
  /** Base URL of the live API, for "copy as curl". */
  baseUrl: string;
  /** Label on every call-log row (QLOO_TAG); the per-tag cap counts it. */
  tag: string;
  /** Network calls allowed for `tag` over all time (QLOO_TAG_CAP); null disables the gate. Mock mode ignores it. */
  tagCap: number | null;
  /** Global requests per second (QLOO_RPS). */
  rps: number;
  store: QlooStore;
  /** Prod fresh-call cap per UTC day, split 60/40 between the public and judge lanes. */
  dailyFreshCap?: number;
  /** Metro locality ids whose urn:tag fingerprints are pinned (D25). */
  pinnedLocalities?: ReadonlySet<string>;
  /** Called with "replay_only" after three straight 401/403, or when prod drops below its month floor. */
  onModeChange?: (mode: Mode) => void;
  logger?: QlooLogger;
  /** Overrides the month floor (default: prod 2,000, dev and mock 38,000). */
  monthFloor?: number;
  /** Global requests in flight (default 6). */
  concurrency?: number;
  /** Requests in flight per run (default 4). */
  runConcurrency?: number;
  cache?: { maxEntries?: number; maxBytes?: number; l1TtlMs?: number };
  now?: Now;
  sleep?: Sleep;
  /** Uniform [0, 1) for retry jitter. */
  random?: () => number;
}

/** A run as the client sees it. Call forRun once per run: the run's budgets live on the returned object. */
export interface RunScope {
  runId: string;
  lane: Lane;
  pillar: Pillar;
  limits: RunLimits;
  phase: () => Phase;
  onCall?: (record: QlooCallRecord) => void;
  onWarn?: (warning: QlooBudgetWarning) => void;
  signal?: AbortSignal;
}

export interface StandaloneOptions {
  /** Desk for the audience allowlist; null (the default) allows the union of the desks. */
  pillar?: Pillar | null;
  onCall?: (record: QlooCallRecord) => void;
  signal?: AbortSignal;
}

/** The Qloo surface a skill gets: the contracts QlooApi plus the cache probe for estimateCalls. */
export type QlooTool = QlooApi & CacheProbe;

export interface RunQloo {
  /** Calls made through the returned API are attributed to this tool call (null for bookkeeping calls). */
  forTool(toolCallId: string | null): QlooTool;
  /** Network calls charged to this run so far. */
  networkUsed(): number;
  /** Network calls made in the follow-up phase. */
  followupNetworkUsed(): number;
  provenance(qlooCallId: string): ProvenanceRequest | null;
  call(qlooCallId: string): QlooCallRecord | null;
}

export interface QlooClient {
  readonly env: QlooEnv;
  readonly baseUrl: string;
  readonly monthFloor: number;
  forRun(scope: RunScope): RunQloo;
  standalone(options?: StandaloneOptions): RunQloo;
  quota(): QuotaSnapshot;
  /** Makes sure the answer to this request is cached (fetching it if needed) and pins it so it never expires. */
  pin(path: QlooPath, params: QlooParams): Promise<void>;
  /**
   * The pinned audience catalogue of this environment (kv, D21), read now: a run reads it once at
   * start. Missing or malformed values read as no segments; a failed read rejects. Optional so test
   * doubles need not implement it: a client without it offers no audiences.
   */
  audienceCatalogue?(): Promise<AudienceCatalogueRead>;
  /** Waits for every background write: call-log rows, L2 entries, counters and the quota snapshot. */
  flush(): Promise<void>;
}

const MAX_ATTEMPTS = 3;
const MAX_BACKOFF_MS = 8_000;
const BASE_BACKOFF_MS = 300;
const AUTH_ERRORS_TO_REPLAY_ONLY = 3;
const RETRY_STATUSES: ReadonlySet<number> = new Set([500, 502, 503, 504]);
/** Records kept per scope for provenance lookups; long-lived standalone scopes drop the oldest. */
const MAX_RECORDS_PER_SCOPE = 2_000;

interface ScopeState extends BudgetScope {
  readonly pillar: Pillar | null;
  readonly signal: AbortSignal | undefined;
  readonly onCall: ((record: QlooCallRecord) => void) | undefined;
  readonly limit: LimitFunction;
  readonly records: Map<string, QlooCallRecord>;
}

type Outcome =
  | { kind: "cache"; entry: CacheEntry }
  | { kind: "network"; entry: CacheEntry; httpStatus: number; monthRemaining: number | null }
  | { kind: "stale"; entry: CacheEntry; httpStatus: number | null; monthRemaining: number | null };

/** How a flight failed, so its leader and followers can each log and react correctly. Never escapes the client. */
class FlightFailure extends Error {
  constructor(
    readonly error: unknown,
    /** The leader's call reached the transport. */
    readonly network: boolean,
    readonly httpStatus: number | null,
    /** x-qloo-request-id of the last response, when one arrived and carried it. */
    readonly requestId: string | null,
    readonly monthRemaining: number | null,
    /** The leader's own run was cancelled: followers retry on their own. */
    readonly leaderAborted: boolean,
  ) {
    super("qloo flight failed");
  }
}

type Verdict =
  | { kind: "ok"; json: unknown }
  | { kind: "retry"; error: QlooError }
  | { kind: "bad_request" }
  | { kind: "auth"; status: 401 | 403 }
  | { kind: "fatal"; error: QlooError };

type FetchResult = { kind: "ok"; response: TransportResponse; json: unknown } | { kind: "bad_request"; response: TransportResponse };

interface AttemptProgress {
  /** Some attempt reached the transport, so the call counts against the budget. */
  attempted: boolean;
  /** HTTP status of the last response, if any arrived. */
  lastStatus: number | null;
  /** x-qloo-request-id of the last response. */
  lastRequestId: string | null;
}

const utf8 = new TextDecoder();
const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const newCallId = (): string => `qc_${randomBytes(8).toString("hex")}`;
const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * The receipt id of a response: x-qloo-request-id, or a stable local id when Qloo sent none. The
 * record, the trace event, the call log and the ledger all use this one value.
 */
const receiptId = (requestId: string | null, key: string): string => requestId ?? `local-${key.slice(0, 16)}`;

/** Network errors worth a retry or a stale answer; a body over the size cap would come back the same. */
const isTransientNetworkError = (err: unknown): boolean => err instanceof QlooNetworkError && err.reason !== "too_large";

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

export function createQlooClient(options: QlooClientOptions): QlooClient {
  return new QlooClientImpl(options);
}

class QlooClientImpl implements QlooClient {
  readonly env: QlooEnv;
  readonly baseUrl: string;
  readonly monthFloor: number;
  private readonly transport: Transport;
  private readonly store: QlooStore;
  private readonly logger: QlooLogger;
  private readonly now: Now;
  private readonly sleep: Sleep;
  private readonly random: () => number;
  private readonly namespace: CacheNamespace;
  private readonly pinnedLocalities: ReadonlySet<string>;
  private readonly runConcurrency: number;
  private readonly limiter: RequestLimiter;
  private readonly cache: ResponseCache;
  private readonly quotaTracker: QuotaTracker;
  private readonly budget: BudgetGates;
  private readonly flights = new Map<string, Promise<Outcome>>();
  private readonly pending = new Set<Promise<unknown>>();
  private pinScope: ScopeState | null = null;

  constructor(private readonly options: QlooClientOptions) {
    this.env = options.env;
    this.baseUrl = options.baseUrl;
    this.monthFloor = options.monthFloor ?? monthFloorFor(options.env);
    this.transport = options.transport;
    this.store = options.store;
    this.logger = options.logger ?? SILENT_LOGGER;
    this.now = options.now ?? realNow;
    this.sleep = options.sleep ?? realSleep;
    this.random = options.random ?? Math.random;
    this.namespace = options.env === "mock" ? "mock-v1" : "v1";
    this.pinnedLocalities = options.pinnedLocalities ?? new Set();
    this.runConcurrency = options.runConcurrency ?? RUN_CONCURRENCY;
    const track = (write: Promise<unknown>) => this.track(write);
    this.limiter = new RequestLimiter({ rps: options.rps, concurrency: options.concurrency, now: this.now, sleep: this.sleep });
    this.cache = new ResponseCache({
      store: this.store,
      now: this.now,
      logger: this.logger,
      track,
      maxEntries: options.cache?.maxEntries,
      maxBytes: options.cache?.maxBytes,
      l1TtlMs: options.cache?.l1TtlMs,
    });
    this.quotaTracker = new QuotaTracker({
      store: this.store,
      kvKey: options.env === "mock" ? MOCK_QUOTA_KV_KEY : QUOTA_KV_KEY,
      now: this.now,
      logger: this.logger,
      track,
    });
    this.budget = new BudgetGates({
      env: options.env,
      tag: options.tag,
      tagCap: options.tagCap,
      dailyFreshCap: options.dailyFreshCap ?? DEFAULT_DAILY_FRESH_CAP,
      monthFloor: this.monthFloor,
      store: this.store,
      quota: this.quotaTracker,
      now: this.now,
      logger: this.logger,
      onModeChange: (mode) => this.changeMode(mode),
      track,
    });
    // Start loading the persisted quota so quota() is populated early; the gates await it anyway.
    void this.quotaTracker.load();
  }

  forRun(scope: RunScope): RunQloo {
    return this.runQloo(
      this.scopeState({
        runId: scope.runId,
        lane: scope.lane,
        pillar: scope.pillar,
        limits: scope.limits,
        phase: scope.phase,
        onCall: scope.onCall,
        onWarn: scope.onWarn,
        signal: scope.signal,
      }),
    );
  }

  standalone(options: StandaloneOptions = {}): RunQloo {
    return this.runQloo(
      this.scopeState({
        runId: null,
        lane: null,
        pillar: options.pillar ?? null,
        limits: null,
        phase: () => "scan",
        onCall: options.onCall,
        onWarn: undefined,
        signal: options.signal,
      }),
    );
  }

  quota(): QuotaSnapshot {
    return this.quotaTracker.snapshot();
  }

  async audienceCatalogue(): Promise<AudienceCatalogueRead> {
    return readAudienceCatalogue(await this.store.getKv(audienceCatalogueKvKey(this.env)));
  }

  async pin(path: QlooPath, params: QlooParams): Promise<void> {
    validateRequest(path, params, { pillar: null });
    const request = canonicalize(path, params, this.namespace);
    let entry = (await this.cache.lookup(request.key)).fresh;
    if (entry === null) {
      this.pinScope ??= this.scopeState({
        runId: null,
        lane: null,
        pillar: null,
        limits: null,
        phase: () => "scan",
        onCall: undefined,
        onWarn: undefined,
        signal: undefined,
      });
      await this.call(this.pinScope, null, path, params);
      entry = (await this.cache.lookup(request.key)).fresh;
    }
    if (entry === null) throw new QlooError("qloo_pin", `nothing cached to pin for ${path}`);
    if (!isSuccessStatus(entry.status)) throw new QlooBadRequestError(entry.status, errorDetail(entry.body), true);
    await this.cache.pin(entry);
  }

  async flush(): Promise<void> {
    this.quotaTracker.persistNow();
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }

  // Scopes -----------------------------------------------------------------------------------------

  private scopeState(init: {
    runId: string | null;
    lane: Lane | null;
    pillar: Pillar | null;
    limits: RunLimits | null;
    phase: () => Phase;
    onCall: ((record: QlooCallRecord) => void) | undefined;
    onWarn: ((warning: QlooBudgetWarning) => void) | undefined;
    signal: AbortSignal | undefined;
  }): ScopeState {
    return {
      ...init,
      network: 0,
      followup: 0,
      warned: false,
      limit: pLimit(this.runConcurrency),
      records: new Map(),
    };
  }

  private runQloo(scope: ScopeState): RunQloo {
    return {
      forTool: (toolCallId) => this.tool(scope, toolCallId),
      networkUsed: () => scope.network,
      followupNetworkUsed: () => scope.followup,
      provenance: (qlooCallId) => {
        const record = scope.records.get(qlooCallId);
        return record ? provenanceRequest(record) : null;
      },
      call: (qlooCallId) => scope.records.get(qlooCallId) ?? null,
    };
  }

  private tool(scope: ScopeState, toolCallId: string | null): QlooTool {
    return {
      search: (params) => this.call<QlooSearchResponse>(scope, toolCallId, "/search", params),
      entities: (entityIds) => this.call<QlooEntitiesResponse>(scope, toolCallId, "/entities", { entity_ids: entityIds }),
      tags: (params) => this.call<QlooTagsResponse>(scope, toolCallId, "/v2/tags", params),
      audiences: (params) => this.call<QlooAudiencesResponse>(scope, toolCallId, "/v2/audiences", params),
      insights: async <F extends InsightsFilterType>(
        filterType: F,
        params: QlooParams,
      ): Promise<QlooResult<InsightsResponse<F>>> => {
        if (Object.hasOwn(params, "filter.type")) {
          throw new QlooParamError("filter.type is the first argument of insights() and must not be repeated in params", "filter.type");
        }
        return this.call<InsightsResponse<F>>(scope, toolCallId, "/v2/insights", { ...params, "filter.type": filterType });
      },
      trending: (params) => this.call<QlooTrendingResponse>(scope, toolCallId, "/v2/trending", params),
      has: (path, params) => this.has(scope, path, params),
    };
  }

  // The call pipeline --------------------------------------------------------------------------------

  private async has(scope: ScopeState, path: QlooPath, params: QlooParams): Promise<boolean> {
    validateRequest(path, params, { pillar: scope.pillar });
    const request = canonicalize(path, params, this.namespace);
    if (this.flights.has(request.key)) return true;
    return (await this.cache.lookup(request.key)).fresh !== null;
  }

  private async call<T>(
    scope: ScopeState,
    toolCallId: string | null,
    path: QlooPath,
    params: QlooParams,
  ): Promise<QlooResult<T>> {
    scope.signal?.throwIfAborted();
    validateRequest(path, params, { pillar: scope.pillar });
    const request = canonicalize(path, params, this.namespace);
    const qlooCallId = newCallId();
    const started = this.now();
    for (;;) {
      const existing = this.flights.get(request.key);
      const lead = existing === undefined;
      let outcome: Outcome;
      try {
        // A waiter's own cancellation ends its wait; the leader's request carries on for the others.
        outcome = await (lead ? this.startFlight(scope, request) : untilAborted(existing, scope.signal));
      } catch (err) {
        const failure = err instanceof FlightFailure ? err : new FlightFailure(err, false, null, null, null, false);
        if (!lead) {
          scope.signal?.throwIfAborted();
          // The leader's run was cancelled or out of budget: that says nothing about this caller.
          if (failure.leaderAborted || failure.error instanceof BudgetError) continue;
          this.logFailure(scope, toolCallId, qlooCallId, request, started, "coalesced", failure, false);
        } else if (failure.network) {
          this.logFailure(scope, toolCallId, qlooCallId, request, started, "miss", failure, true);
        }
        throw failure.error;
      }
      return this.deliver<T>(scope, toolCallId, qlooCallId, request, started, outcome, lead);
    }
  }

  /** Registers the flight before its first await, so a concurrent identical request always joins it. */
  private startFlight(scope: ScopeState, request: CanonicalRequest): Promise<Outcome> {
    const flight = this.runFlight(scope, request);
    this.flights.set(request.key, flight);
    const clear = () => {
      if (this.flights.get(request.key) === flight) this.flights.delete(request.key);
    };
    void flight.then(clear, clear);
    return flight;
  }

  private async runFlight(scope: ScopeState, request: CanonicalRequest): Promise<Outcome> {
    const found = await this.cache.lookup(request.key);
    if (found.fresh) return { kind: "cache", entry: found.fresh };
    return this.fetchFresh(scope, request, found.expired);
  }

  private async fetchFresh(scope: ScopeState, request: CanonicalRequest, expired: CacheEntry | null): Promise<Outcome> {
    let reservation: Reservation;
    try {
      reservation = await this.budget.reserve(scope);
    } catch (err) {
      throw new FlightFailure(err, false, null, null, null, scope.signal?.aborted === true);
    }
    // Written by fetchWithRetry as attempts happen; read after it settles.
    const progress: AttemptProgress = { attempted: false, lastStatus: null, lastRequestId: null };
    try {
      const result = await scope.limit(() => this.fetchWithRetry(request, scope.signal, progress));
      const monthRemaining = result.response.headers.monthRemaining;
      if (result.kind === "bad_request") {
        const entry = this.entryFrom(request, result.response, ERROR_TTL_MS, scope.runId);
        this.cache.store(entry);
        return { kind: "network", entry, httpStatus: result.response.status, monthRemaining };
      }
      const parsed = responseSchema(request.path, request.filterType).safeParse(result.json);
      if (!parsed.success) {
        throw new QlooResponseError(
          `Qloo ${request.path} response does not match the expected shape: ${parsed.error.issues[0]?.message ?? "invalid"}`,
          { cause: parsed.error },
        );
      }
      const entry = this.entryFrom(request, result.response, successTtlMs(request, { pinnedLocalities: this.pinnedLocalities }), scope.runId);
      this.cache.store(entry);
      return { kind: "network", entry, httpStatus: result.response.status, monthRemaining };
    } catch (err) {
      if (err instanceof FlightFailure) throw err;
      const aborted = scope.signal?.aborted === true;
      const monthRemaining = this.quotaTracker.snapshot().monthRemaining;
      const transient = err instanceof QlooRateLimitError || err instanceof QlooServerError || isTransientNetworkError(err);
      if (!aborted && progress.attempted && transient && expired !== null && canServeStale(expired, this.now())) {
        this.logger.warn({ path: request.path, err: errorText(err) }, "qloo network failed; serving a stale cached answer");
        return { kind: "stale", entry: expired, httpStatus: progress.lastStatus, monthRemaining };
      }
      throw new FlightFailure(err, progress.attempted, progress.lastStatus, progress.lastRequestId, monthRemaining, aborted);
    } finally {
      if (progress.attempted) reservation.commit();
      else reservation.release();
    }
  }

  private async fetchWithRetry(
    request: CanonicalRequest,
    signal: AbortSignal | undefined,
    progress: AttemptProgress,
  ): Promise<FetchResult> {
    let lastError: QlooError | null = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      signal?.throwIfAborted();
      let response: TransportResponse | null = null;
      try {
        response = await this.limiter.run(() => {
          progress.attempted = true;
          return this.transport(request, signal);
        }, signal);
      } catch (err) {
        if (signal?.aborted) throw signal.reason;
        // The same request brings back the same oversized body: a retry would only spend another call.
        if (err instanceof QlooNetworkError && !isTransientNetworkError(err)) throw err;
        lastError =
          err instanceof QlooNetworkError
            ? err
            : new QlooNetworkError("network", `Qloo transport failed: ${errorText(err)}`, { cause: err });
      }
      let secondReset: number | null = null;
      if (response !== null) {
        progress.lastStatus = response.status;
        progress.lastRequestId = response.headers.requestId;
        this.quotaTracker.observe(response.headers);
        const verdict = classify(response, attempt);
        // Any answer below 500 other than 401/403 shows the key was accepted, which ends an auth streak.
        if (verdict.kind !== "auth" && response.status < 500) this.quotaTracker.recordKeyAccepted();
        switch (verdict.kind) {
          case "ok":
            this.quotaTracker.recordSuccess();
            return { kind: "ok", response, json: verdict.json };
          case "bad_request":
            return { kind: "bad_request", response };
          case "auth":
            this.authFailed(verdict.status);
            throw new QlooAuthError(verdict.status);
          case "fatal":
            throw verdict.error;
          case "retry":
            lastError = verdict.error;
            secondReset = response.headers.secondReset;
            break;
        }
      }
      if (attempt < MAX_ATTEMPTS) await this.sleep(this.backoffMs(attempt - 1, secondReset), signal);
    }
    throw lastError ?? new QlooNetworkError("network", "Qloo request failed");
  }

  /** max(secondReset·1000, 300·2^n)·U(0.8, 1.2), capped at 8 s (SPEC §5.1 step 8). */
  private backoffMs(retry: number, secondReset: number | null): number {
    const base = Math.max((secondReset ?? 0) * 1000, BASE_BACKOFF_MS * 2 ** retry);
    return Math.min(MAX_BACKOFF_MS, Math.round(base * (0.8 + 0.4 * this.random())));
  }

  /**
   * Every rejection at or past the threshold asks for replay-only again: the streak survives restarts
   * (it is part of the persisted quota snapshot), and live mode may have been switched back on with
   * the same bad key. The mode change is idempotent.
   */
  private authFailed(status: 401 | 403): void {
    const streak = this.quotaTracker.recordAuthError();
    this.logger.error({ status, streak }, "qloo rejected the API key");
    if (streak >= AUTH_ERRORS_TO_REPLAY_ONLY) this.changeMode("replay_only");
  }

  private changeMode(mode: Mode): void {
    this.logger.error({ mode }, "qloo client requests a mode change");
    try {
      this.options.onModeChange?.(mode);
    } catch (err) {
      this.logger.error({ err: errorText(err) }, "qloo onModeChange callback threw");
    }
  }

  private entryFrom(
    request: CanonicalRequest,
    response: TransportResponse,
    ttlMs: number | null,
    runId: string | null,
  ): CacheEntry {
    const fetchedAt = this.now();
    return {
      key: request.key,
      path: request.path,
      query: request.query,
      status: response.status,
      body: response.body,
      requestId: response.headers.requestId,
      fetchedAt,
      expiresAt: ttlMs === null ? null : fetchedAt + ttlMs,
      pinned: ttlMs === null,
      originRunId: runId,
    };
  }

  // Delivery and logging ------------------------------------------------------------------------------

  private deliver<T>(
    scope: ScopeState,
    toolCallId: string | null,
    qlooCallId: string,
    request: CanonicalRequest,
    started: number,
    outcome: Outcome,
    lead: boolean,
  ): QlooResult<T> {
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
      qlooCallId,
      toolCallId,
      runId: scope.runId,
      path: request.path,
      filterType: request.filterType,
      query: request.query,
      paramsRedacted: redactParams(request.query),
      cache,
      stale: outcome.kind === "stale",
      ms: Math.max(0, now - started),
      requestId: receiptId(entry.requestId, entry.key),
      status: entry.status,
      cacheAgeMs: cache === "miss" ? null : Math.max(0, now - entry.fetchedAt),
      originRunId: cache === "miss" ? null : entry.originRunId,
      fetchedAt: new Date(entry.fetchedAt).toISOString(),
    };
    const httpStatus = network ? outcome.httpStatus : null;
    const monthRemaining = network ? outcome.monthRemaining : null;

    if (!isSuccessStatus(entry.status)) {
      const error = new QlooBadRequestError(entry.status, errorDetail(entry.body), outcome.kind === "cache");
      this.finish(scope, { ...base, rows: null, error: error.message }, request.key, network, httpStatus, monthRemaining);
      throw error;
    }
    const data = JSON.parse(utf8.decode(entry.body)) as T;
    const record: QlooCallRecord = { ...base, rows: rowCount(data), error: null };
    this.finish(scope, record, request.key, network, httpStatus, monthRemaining);
    return {
      data,
      meta: {
        qlooCallId,
        requestId: base.requestId,
        cache,
        fetchedAt: base.fetchedAt,
        ms: base.ms,
        stale: base.stale,
        originRunId: base.originRunId,
      },
    };
  }

  private logFailure(
    scope: ScopeState,
    toolCallId: string | null,
    qlooCallId: string,
    request: CanonicalRequest,
    started: number,
    cache: "miss" | "coalesced",
    failure: FlightFailure,
    network: boolean,
  ): void {
    const record: QlooCallRecord = {
      qlooCallId,
      toolCallId,
      runId: scope.runId,
      path: request.path,
      filterType: request.filterType,
      query: request.query,
      paramsRedacted: redactParams(request.query),
      cache,
      stale: false,
      ms: Math.max(0, this.now() - started),
      // Null only when no response arrived (events.ts).
      requestId: failure.httpStatus === null ? null : receiptId(failure.requestId, request.key),
      status: failure.httpStatus,
      rows: null,
      cacheAgeMs: null,
      originRunId: null,
      fetchedAt: null,
      error: errorText(failure.error),
    };
    this.finish(scope, record, request.key, network, network ? failure.httpStatus : null, network ? failure.monthRemaining : null);
  }

  private finish(
    scope: ScopeState,
    record: QlooCallRecord,
    cacheKey: string,
    network: boolean,
    httpStatus: number | null,
    monthRemaining: number | null,
  ): void {
    scope.records.set(record.qlooCallId, record);
    if (scope.records.size > MAX_RECORDS_PER_SCOPE) {
      const oldest = scope.records.keys().next();
      if (!oldest.done) scope.records.delete(oldest.value);
    }
    try {
      scope.onCall?.(record);
    } catch (err) {
      this.logger.warn({ err: errorText(err) }, "qloo onCall callback threw");
    }
    this.logger.debug(
      { qlooCallId: record.qlooCallId, runId: record.runId, path: record.path, cache: record.cache, ms: record.ms },
      "qloo call",
    );
    const row = {
      id: record.qlooCallId,
      ts: new Date(this.now()),
      env: this.env,
      tag: this.options.tag,
      runId: record.runId,
      path: record.path,
      filterType: record.filterType,
      params: record.query,
      cacheKey,
      cacheStatus: record.cache,
      httpStatus,
      ms: record.ms,
      requestId: record.requestId,
      monthRemaining,
      error: record.error,
    };
    const write = network ? this.budget.logNetworkCall(() => this.store.logCalls([row])) : this.store.logCalls([row]);
    this.track(write.catch((err: unknown) => this.logger.warn({ err: errorText(err) }, "qloo call log write failed")));
  }

  private track(write: Promise<unknown>): void {
    const tracked = write.then(
      () => undefined,
      (err: unknown) => this.logger.warn({ err: errorText(err) }, "qloo background write failed"),
    );
    this.pending.add(tracked);
    void tracked.then(() => this.pending.delete(tracked));
  }
}

/** PLAN §5.1 step 8. A 200 carrying error_msg is Qloo's rate-limit answer, not data. */
function classify(response: TransportResponse, attempt: number): Verdict {
  const status = response.status;
  if (status >= 200 && status < 300) {
    let json: unknown;
    try {
      json = JSON.parse(utf8.decode(response.body));
    } catch (err) {
      return { kind: "fatal", error: new QlooResponseError(`Qloo answered HTTP ${status} with a body that is not JSON`, { cause: err }) };
    }
    if (isRecord(json) && "error_msg" in json) {
      return { kind: "retry", error: new QlooRateLimitError(status, attempt) };
    }
    return { kind: "ok", json };
  }
  if (status === 401 || status === 403) return { kind: "auth", status };
  if (status === 429) return { kind: "retry", error: new QlooRateLimitError(status, attempt) };
  if (RETRY_STATUSES.has(status)) return { kind: "retry", error: new QlooServerError(status, attempt) };
  if (status >= 400 && status < 500) return { kind: "bad_request" };
  return { kind: "fatal", error: new QlooServerError(status, attempt) };
}

/** A short, sanitised reason from a 4xx body, if it has one. */
function errorDetail(body: Uint8Array): string | null {
  try {
    const json: unknown = JSON.parse(utf8.decode(body));
    if (!isRecord(json)) return null;
    const nested = isRecord(json.error) ? json.error.message : json.error;
    const text = [json.message, nested, json.detail].find((v): v is string => typeof v === "string" && v.trim() !== "");
    return text === undefined ? null : sanitizeQlooText(text, 200);
  } catch {
    return null;
  }
}
