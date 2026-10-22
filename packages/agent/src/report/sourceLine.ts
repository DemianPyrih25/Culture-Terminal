import type { DatasetEnvelope, Evidence } from "@ct/contracts";
import { formatAge, formatUtc, timeRange } from "./format";

/**
 * The source line under every exhibit (SPEC §7.2):
 * "Source: Qloo /v2/insights (urn:entity:brand) · req 9f2a… · fetched <ts> · cache 3h · Culture Terminal analysis".
 * Several endpoints are joined with " + ", and "+N" after the request id counts the other calls.
 */

const ANALYSIS = "Culture Terminal analysis";
export const SCORECARD_SOURCE =
  `Source: ANALYST priors recorded before any data, judged against cited Qloo metrics · ${ANALYSIS}`;

export function exhibitSourceLine(dataset: DatasetEnvelope, evidence: readonly Evidence[], now: number): string {
  if (dataset.kind === "Scorecard") return SCORECARD_SOURCE;
  return sourceLine(evidence, now);
}

export function sourceLine(evidence: readonly Evidence[], now: number): string {
  const first = evidence[0];
  if (!first) return `Source: ${ANALYSIS}`;

  // Endpoint → filter types, in first-seen order.
  const endpoints = new Map<string, Set<string>>();
  for (const e of evidence) {
    for (const r of e.provenance.requests) {
      const types = endpoints.get(r.path) ?? new Set<string>();
      const filterType = r.query["filter.type"];
      if (filterType) types.add(filterType);
      endpoints.set(r.path, types);
    }
  }
  const where = [...endpoints]
    .map(([path, types]) => (types.size > 0 ? `${path} (${[...types].join(", ")})` : path))
    .join(" + ");

  const calls = new Set(evidence.flatMap((e) => e.qlooCallIds)).size;
  const req = `req ${(first.requestIds[0] ?? "").slice(0, 4)}…${calls > 1 ? ` +${calls - 1}` : ""}`;

  const fetched = timeRange(evidence.map((e) => e.fetchedAt));
  const cachedRange = timeRange(evidence.filter((e) => e.cached).map((e) => e.fetchedAt));
  const cache = cachedRange
    ? `cache ${formatAge(now - Date.parse(cachedRange.from))}${evidence.every((e) => e.cached) ? "" : " (partial)"}`
    : "live";

  const fetchedAt = `fetched ${formatUtc(fetched?.from ?? first.fetchedAt)}`;
  return [`Source: Qloo ${where}`, req, fetchedAt, cache, ANALYSIS].join(" · ");
}
