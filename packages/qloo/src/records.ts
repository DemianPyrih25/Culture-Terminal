import type { CacheStatus, EventInputOf, QlooPath } from "@ct/contracts";

/**
 * What the client knows about one call, success or failure. The agent turns it into the `qloo`
 * trace event ({@link qlooEventFrom}); the ledger reads provenance from it. Budget refusals and
 * validation errors throw before a call exists and produce no record.
 */
export interface QlooCallRecord {
  qlooCallId: string;
  toolCallId: string | null;
  runId: string | null;
  path: QlooPath;
  filterType: string | null;
  /** Canonical query values (lists comma-joined): the provenance query. */
  query: Record<string, string>;
  /** The same with long values shortened, for the trace. */
  paramsRedacted: Record<string, string>;
  /** `stale` only for the call whose own network attempt failed; a caller that waited on it is `coalesced`. */
  cache: CacheStatus;
  /** Served from an expired entry after a network failure (STALE_CACHE), whether this call led or waited. */
  stale: boolean;
  /** Wall time of the call, queueing and retries included. */
  ms: number;
  /**
   * x-qloo-request-id of the response behind the data or the failure, or a stable `local-…` id when
   * Qloo sent none (the same value as meta.requestId); null only when no response arrived.
   */
  requestId: string | null;
  /** HTTP status of the response behind the data (a cached one included); null when none arrived. */
  status: number | null;
  rows: number | null;
  /** Age of the served response when it came from the cache or another caller's fetch. */
  cacheAgeMs: number | null;
  /** The run that fetched the served response, when it was not this call. */
  originRunId: string | null;
  /** When the served response was fetched from Qloo (ISO); null when the call failed. */
  fetchedAt: string | null;
  error: string | null;
}

export type QlooEvent = EventInputOf<"qloo">;

/** The exact payload of the contracts `qloo` SSE event for a call. */
export function qlooEventFrom(record: QlooCallRecord): QlooEvent {
  return {
    type: "qloo",
    qlooCallId: record.qlooCallId,
    toolCallId: record.toolCallId,
    endpoint: record.path,
    filterType: record.filterType,
    paramsRedacted: { ...record.paramsRedacted },
    cache: record.cache,
    ms: Math.max(0, record.ms),
    requestId: record.requestId,
    status: record.status,
    rows: record.rows,
    cacheAgeMs: record.cacheAgeMs === null ? null : Math.max(0, record.cacheAgeMs),
    originRunId: record.originRunId,
    error: record.error,
  };
}
