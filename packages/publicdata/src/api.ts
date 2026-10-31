// The fixed @ct/publicdata API (Part 9 wave 1): types, the event and provenance helpers and the error
// class. The implementation lives in the sibling modules; index.ts re-exports everything.
import type {
  CacheStatus,
  EventInputOf,
  PublicDataApi,
  PublicDataErrorCode,
  OsmShape,
  OsmTypeQuery,
  PublicEndpoint,
  PublicProvenanceRequest,
  PublicSource,
} from "@ct/contracts";
import type { Now, QlooLogger, Sleep } from "@ct/qloo";

// Environment --------------------------------------------------------------------------------------

/** "mock" (QLOO_MOCK=1) answers from an invented, deterministic transport under its own cache namespace. */
export type PublicEnv = "dev" | "prod" | "mock";

/** The logger shape shared with @ct/qloo. */
export type PublicLogger = QlooLogger;

// Requests and transport ---------------------------------------------------------------------------

/**
 * One request as the client builds it. `query` is canonical (sorted when keyed) and never holds an API
 * key: the transport adds CENSUS_API_KEY itself, so the key is in neither the cache key nor provenance.
 * Canonical cache key: sha256Hex(`pd-v1|GET|<source>|<path>?<sorted qs>`), `mock-pd-v1` under mock. The
 * Overpass endpoint is the one POST (a read-only query in the form body): its key is
 * sha256Hex(`pd-v1|POST|osm|/api/interpreter|<QL>`).
 */
export interface PublicRequest {
  source: PublicSource;
  endpoint: PublicEndpoint;
  host: string;
  /** The concrete path, e.g. `/api/xbrl/companyfacts/CIK0000000001.json` or `/data/2023/acs/acs5`. */
  path: string;
  query: Readonly<Record<string, string>>;
  /** GET when absent. Only OpenStreetMap (Overpass) requests are POSTed. */
  method?: "GET" | "POST";
  /** The POST body's query text (canonical Overpass QL): part of the cache key and of provenance. */
  body?: string;
  /** What the trace and the call log show for a POST in place of its empty query (shapes, types). */
  trace?: Readonly<Record<string, string>>;
  /** What an Overpass request asks, in answer order. Never sent: the mock transport answers from it. */
  osm?: OsmRequestPlan;
}

/** The structured form of an Overpass request (the QL says the same thing in text). */
export type OsmRequestPlan =
  | { kind: "counts"; pairs: readonly { shape: OsmShape; typeKey: string }[] }
  | { kind: "places"; shape: OsmShape; types: readonly OsmTypeQuery[]; limit: number };

export interface PublicTransportResponse {
  status: number;
  /** The response body as text; empty for 204. */
  body: string;
  ms: number;
  /** The Retry-After header in seconds, when the response carried one (Overpass sends it with 429). */
  retryAfterS?: number | null;
}

/**
 * One attempt. The live transport sends SEC_USER_AGENT verbatim to SEC, adds the Census key to Census
 * queries, and POSTs Overpass queries with OSM_USER_AGENT.
 */
export type PublicTransport = (request: PublicRequest, signal?: AbortSignal) => Promise<PublicTransportResponse>;

// Call records --------------------------------------------------------------------------------------

/**
 * What the client knows about one call, success or failure: the `public` trace event comes from it
 * (publicEventFrom) and the ledger reads provenance from it (publicProvenanceRequest).
 */
export interface PublicCallRecord {
  publicCallId: string;
  toolCallId: string | null;
  runId: string | null;
  source: PublicSource;
  endpoint: PublicEndpoint;
  host: string;
  path: string;
  /** Canonical query without any key: the provenance query. */
  query: Record<string, string>;
  /** The same with long values (e.g. ZCTA lists) shortened, for the trace; for a POST, its trace summary. */
  paramsRedacted: Record<string, string>;
  /** GET when absent. */
  method?: "GET" | "POST";
  /** The POST body (Overpass QL) for provenance; absent for GET. */
  body?: string;
  cache: CacheStatus;
  /** Served from an expired entry after a network failure (STALE_CACHE). */
  stale: boolean;
  ms: number;
  /** PublicCallMeta.reference; null only when no response arrived. */
  reference: string | null;
  /** HTTP status of the response behind the data; null when none arrived. */
  status: number | null;
  cacheAgeMs: number | null;
  originRunId: string | null;
  /** When the served response was fetched (ISO); null when the call failed. */
  fetchedAt: string | null;
  error: string | null;
}

/** The `public` SSE event for a call record. */
export function publicEventFrom(record: PublicCallRecord): EventInputOf<"public"> {
  return {
    type: "public",
    publicCallId: record.publicCallId,
    toolCallId: record.toolCallId,
    source: record.source,
    endpoint: record.endpoint,
    paramsRedacted: record.paramsRedacted,
    cache: record.cache,
    ms: record.ms,
    status: record.status,
    reference: record.reference,
    cacheAgeMs: record.cacheAgeMs,
    originRunId: record.originRunId,
    error: record.error,
  };
}

/** The provenance request of a call that returned data; null for a failed call (no reference). */
export function publicProvenanceRequest(record: PublicCallRecord): PublicProvenanceRequest | null {
  if (record.reference === null) return null;
  return {
    source: record.source,
    method: record.method ?? "GET",
    host: record.host,
    path: record.path,
    query: { ...record.query },
    reference: record.reference,
    ...(record.body === undefined ? {} : { body: record.body }),
  };
}

// Errors ----------------------------------------------------------------------------------------------

/**
 * The one error type the client throws. Skills read it with the contracts' publicDataErrorCode (by
 * name and code), so they never import this package.
 */
export class PublicDataError extends Error {
  override readonly name = "PublicDataError";
  readonly code: PublicDataErrorCode;
  readonly source: PublicSource | null;
  readonly status: number | null;

  constructor(code: PublicDataErrorCode, message: string, options: { source?: PublicSource | null; status?: number | null; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.source = options.source ?? null;
    this.status = options.status ?? null;
  }
}

// Store -------------------------------------------------------------------------------------------------

/** One L2 cache row (public_cache). Bodies are stored gzip-compressed. */
export interface StoredPublicEntry {
  key: string;
  source: PublicSource;
  path: string;
  /** Canonical query without any key. */
  params: Record<string, string>;
  status: number;
  /** gzip-compressed response body. */
  body: Uint8Array;
  reference: string | null;
  fetchedAt: Date;
  /** Null for pinned entries (Census vintages). */
  expiresAt: Date | null;
  pinned: boolean;
  originRunId: string | null;
}

/** One public_calls row. */
export interface PublicCallLogRow {
  id: string;
  ts: Date;
  env: PublicEnv;
  tag: string | null;
  runId: string | null;
  source: PublicSource;
  path: string;
  params: Record<string, string>;
  cacheKey: string | null;
  cacheStatus: CacheStatus;
  httpStatus: number | null;
  ms: number | null;
  reference: string | null;
  error: string | null;
}

/**
 * Persistence behind the client: Postgres in the app, memory in tests. SEC and Census have no quota; the
 * one counter is OpenStreetMap's daily request count (kv `osm.count.<YYYY-MM-DD>`), shared by every
 * process on the database.
 */
export interface PublicStore {
  getEntry(key: string): Promise<StoredPublicEntry | null>;
  /** Inserts or refreshes an entry with the qloo_cache rules: pins stay, newer wins, a non-2xx never replaces a pin. */
  putEntry(entry: StoredPublicEntry): Promise<void>;
  recordHit(key: string): Promise<void>;
  pinEntry(key: string): Promise<boolean>;
  logCalls(rows: readonly PublicCallLogRow[]): Promise<void>;
  /**
   * Adds `by` to a numeric counter and returns the new value, atomically. A store without it (or one
   * that fails) leaves the client counting in its own process.
   */
  incrementCounter?(key: string, by?: number): Promise<number>;
}

// Client --------------------------------------------------------------------------------------------------

export interface PublicDataClientOptions {
  env: PublicEnv;
  transport: PublicTransport;
  store: PublicStore;
  /** Label on every call-log row (QLOO_TAG). */
  tag: string;
  /** SEC_USER_AGENT; null when unset: live SEC calls then throw PublicDataError("not_configured"). */
  secUserAgent: string | null;
  /**
   * OSM_USER_AGENT; null or absent leaves OpenStreetMap not configured outside mock: its calls throw
   * PublicDataError("not_configured") and `configured.osm` is false.
   */
  osmUserAgent?: string | null;
  /** OSM_OVERPASS_URL (default DEFAULT_OSM_OVERPASS_URL): its host and path are what requests and provenance name. */
  osmOverpassUrl?: string;
  /**
   * OSM_OVERPASS_FALLBACK_URL: tried once, inside the same deadline, when the primary fails or is too slow
   * (the transport must allow it too). Provenance names the instance that answered.
   */
  osmOverpassFallbackUrl?: string | null;
  /**
   * Wall time for all the OpenStreetMap requests made through one forTool() API together (default
   * OSM_CALL_DEADLINE_MS, 12 s); null for none. Off by default in mock and with osmLongQueries (the warm-up).
   */
  osmDeadlineMs?: number | null;
  /** OSM_DAILY_MAX: Overpass network requests per UTC day for the whole deploy (default 2000). */
  osmDailyMax?: number;
  /**
   * The warm-up only: county-union queries get Overpass's 180 s limit instead of 40 s (pair it with a
   * transport whose osmTimeoutMs is longer). The answers land under the same cache keys runs use.
   */
  osmLongQueries?: boolean;
  /** Requests per second per source (SEC ≤5, Census ≤5, OpenStreetMap 1 with one request in flight). */
  rps?: { sec?: number; census?: number; osm?: number };
  logger?: PublicLogger;
  now?: Now;
  sleep?: Sleep;
  /** Uniform [0, 1) for retry jitter. */
  random?: () => number;
}

/** A run as the client sees it. Call forRun once per run. */
export interface PublicRunScope {
  runId: string;
  /** Called once per call, network or cache: the agent emits the `public` event from it. */
  onCall?: (record: PublicCallRecord) => void;
  signal?: AbortSignal;
}

export interface RunPublic {
  /**
   * Calls made through the returned API are attributed to this tool call (null for bookkeeping calls).
   * Its OpenStreetMap requests share one deadline from the first (osmDeadlineMs): take one API per tool call.
   */
  forTool(toolCallId: string | null): PublicDataApi;
  /** For the agent ledger: `runQloo.provenance(id) ?? runPublic.provenance(id)`. */
  provenance(publicCallId: string): PublicProvenanceRequest | null;
  call(publicCallId: string): PublicCallRecord | null;
}

export interface PublicDataClient {
  readonly env: PublicEnv;
  /**
   * Which sources can be called, for /api/health: SEC needs SEC_USER_AGENT outside mock; Census needs
   * CENSUS_API_KEY outside mock (the Census Data API answers keyless requests with a redirect to its
   * missing-key page); OpenStreetMap needs OSM_USER_AGENT outside mock (the Overpass usage policy asks
   * for an identifying User-Agent).
   */
  readonly configured: Readonly<Record<PublicSource, boolean>>;
  forRun(scope: PublicRunScope): RunPublic;
  /** A scope outside any run (tools, scripts). */
  standalone(options?: { onCall?: (record: PublicCallRecord) => void; signal?: AbortSignal }): RunPublic;
  /** Waits for every background write (call-log rows, L2 entries). */
  flush(): Promise<void>;
}

export interface PublicDataEnvDeps {
  store: PublicStore;
  logger?: PublicLogger;
  /** Injectable fetch for the live transport (tests). */
  fetch?: typeof fetch;
}

