import type { CacheStatus, NumbersTraced, PublicEndpoint, PublicSource, QlooPath, Receipt, TokenUsage } from "@ct/contracts";

/**
 * The run receipt (PLAN §7): Qloo calls by how they were served, endpoints, wall time, LLM spend,
 * tokens and numbers traced. Qloo counts come from the run's call log, which also covers calls
 * outside evidence bundles (the resolution gate).
 */

/** One Qloo call of the run; `RunState.qloo.chips` (the `qloo` events) has this shape. */
export interface ReceiptQlooCall {
  qlooCallId: string;
  endpoint: QlooPath;
  filterType: string | null;
  cache: CacheStatus;
  /** Rows the response carried (null when none arrived); confidence counts thin results from it. */
  rows?: number | null;
}

/** One SEC or Census call of the run (the `public` events): it costs no Qloo call and counts apart. */
export interface ReceiptPublicCall {
  publicCallId: string;
  source: PublicSource;
  endpoint: PublicEndpoint;
}

export interface ReceiptUsage {
  elapsedMs: number;
  llmUsd: number;
  tokens: TokenUsage;
}

/**
 * How each cache status counts in the receipt and the usage meter. A stale call made its own network
 * attempt before an expired entry was served (it is charged to the run's cap and the quota), so it
 * counts as network, as the qloo_calls repo counts it (QLOO_NETWORK_CACHE_STATUSES: miss, stale).
 */
export const QLOO_CALL_BUCKET: Readonly<Record<CacheStatus, "network" | "cached" | "reused">> = {
  miss: "network",
  hit: "cached",
  stale: "network",
  coalesced: "cached",
  reused: "reused",
};

export function buildReceipt(args: {
  calls: readonly ReceiptQlooCall[];
  /** SEC and Census calls; absent or empty when the note used none. */
  publicCalls?: readonly ReceiptPublicCall[];
  usage: ReceiptUsage;
  numbersTraced: NumbersTraced;
  models: Receipt["models"];
  economy: boolean;
}): Receipt {
  const calls = [...new Map(args.calls.map((c) => [c.qlooCallId, c])).values()];
  const counts = { network: 0, cached: 0, reused: 0 };
  const endpoints = new Map<string, Receipt["endpoints"][number]>();
  for (const c of calls) {
    counts[QLOO_CALL_BUCKET[c.cache]] += 1;
    const key = `${c.endpoint}|${c.filterType ?? ""}`;
    const row = endpoints.get(key) ?? { path: c.endpoint, filterType: c.filterType, calls: 0 };
    row.calls += 1;
    endpoints.set(key, row);
  }
  return {
    qlooNetwork: counts.network,
    qlooCached: counts.cached,
    qlooReused: counts.reused,
    endpoints: [...endpoints.values()],
    publicEndpoints: publicEndpoints(args.publicCalls ?? []),
    ms: Math.max(0, Math.round(args.usage.elapsedMs)),
    usd: Math.max(0, args.usage.llmUsd),
    tokens: args.usage.tokens,
    numbersTraced: args.numbersTraced,
    models: args.models,
    economy: args.economy,
  };
}

/** SEC and Census calls by endpoint, in first-call order; each call id counts once. */
function publicEndpoints(calls: readonly ReceiptPublicCall[]): Receipt["publicEndpoints"] {
  const rows = new Map<PublicEndpoint, Receipt["publicEndpoints"][number]>();
  for (const c of new Map(calls.map((call) => [call.publicCallId, call])).values()) {
    const row = rows.get(c.endpoint) ?? { source: c.source, endpoint: c.endpoint, calls: 0 };
    row.calls += 1;
    rows.set(c.endpoint, row);
  }
  return [...rows.values()];
}
