// Number and chip formatting shared by the dev CLIs. A chip is the one-line text form of what the
// web trace shows as a pill: a Qloo call with its cache status and request id, a cost, a token count.
import type { CacheStatus, Metric, TokenUsage } from "@ct/contracts";

export const NONE = "—";

export function cacheLabel(cache: CacheStatus): string {
  return cache.toUpperCase();
}

export function formatMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

/** Cents, with a third digit below ten cents where a run's cost lives. */
export function formatUsd(usd: number): string {
  return `$${usd.toFixed(usd > 0 && usd < 0.1 ? 3 : 2)}`;
}

export function formatFixed2(x: number | null | undefined): string {
  return typeof x === "number" && Number.isFinite(x) ? x.toFixed(2) : NONE;
}

export function formatBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

export function formatTokens(t: TokenUsage): string {
  return `in ${formatCount(t.input)} · out ${formatCount(t.output)} · cache read ${formatCount(t.cacheRead)} · cache write ${formatCount(t.cacheCreation)}`;
}

/** "urn:entity:brand" → "brand"; other filter types as they are. */
export function shortFilterType(filterType: string | null): string {
  if (filterType === null) return NONE;
  return filterType.startsWith("urn:entity:") ? filterType.slice("urn:entity:".length) : filterType;
}

/** What a Qloo call chip needs: the fields shared by QlooCallRecord and the `qloo` event. */
export interface QlooChipInput {
  endpoint: string;
  filterType: string | null;
  cache: CacheStatus;
  ms: number;
  requestId: string | null;
  rows: number | null;
  error: string | null;
}

/** "/v2/insights brand MISS 312 ms req <id> · 20 rows". */
export function qlooChip(call: QlooChipInput): string {
  const type = call.filterType === null ? "" : ` ${shortFilterType(call.filterType)}`;
  const rows = call.rows === null ? "" : ` · ${call.rows} rows`;
  const error = call.error === null ? "" : ` · error: ${call.error}`;
  return `${call.endpoint}${type} ${cacheLabel(call.cache)} ${formatMs(call.ms)} req ${call.requestId ?? NONE}${rows}${error}`;
}

export interface PublicChipInput {
  endpoint: string;
  cache: QlooChipInput["cache"];
  ms: number;
  reference: string | null;
  error: string | null;
}

/** An SEC or Census call: endpoint, cache, time and the reference (CIK, Census vintage or mock-<hash>). */
export function publicChip(call: PublicChipInput): string {
  const error = call.error === null ? "" : ` · error: ${call.error}`;
  return `${call.endpoint} ${cacheLabel(call.cache)} ${formatMs(call.ms)} ref ${call.reference ?? NONE}${error}`;
}

/** A metric's value as the CLIs show it: the display string, or "—" with the reason it has none. */
export function metricValue(metric: Pick<Metric, "value" | "display" | "reason">): string {
  if (metric.value === null) return `${NONE} (${metric.reason ?? "unavailable"})`;
  return metric.display === "" ? String(metric.value) : metric.display;
}

/** "M3, M4, M5" or "—". */
export function idList(ids: readonly string[]): string {
  return ids.length === 0 ? NONE : ids.join(" ");
}
