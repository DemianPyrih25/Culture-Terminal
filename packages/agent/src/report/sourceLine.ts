import { isPublicProvenanceRequest, PUBLIC_SOURCE_LABEL, type DatasetEnvelope, type Evidence } from "@ct/contracts";
import { formatAge, formatUtc, timeRange } from "./format";
import { evidenceSource } from "./publicData";

/**
 * The source line under every exhibit (SPEC §7.2):
 * "Source: Qloo /v2/insights (urn:entity:brand) · req 9f2a… · fetched <ts> · cache 3h · Culture Terminal analysis".
 * Several endpoints are joined with " + ", and "+N" after the request id counts the other calls. SEC and
 * Census evidence names its source, host and path and its reference in full (a CIK or an ACS query,
 * never a key): "Source: SEC EDGAR data.sec.gov/api/xbrl/companyfacts/CIK0000000001.json · ref CIK0000000001 · …".
 */

const ANALYSIS = "Culture Terminal analysis";
export const SCORECARD_SOURCE =
  `Source: the AI's expectations, recorded before any data, checked against the cited Qloo figures · ${ANALYSIS}`;

export function exhibitSourceLine(dataset: DatasetEnvelope, evidence: readonly Evidence[], now: number): string {
  if (dataset.kind === "Scorecard") return SCORECARD_SOURCE;
  return sourceLine(evidence, now);
}

export function sourceLine(evidence: readonly Evidence[], now: number): string {
  const first = evidence[0];
  if (!first) return `Source: ${ANALYSIS}`;

  // Qloo endpoint → filter types, and public source → host and path, in first-seen order.
  const endpoints = new Map<string, Set<string>>();
  const publicWhere = new Map<string, Set<string>>();
  for (const e of evidence) {
    for (const r of e.provenance.requests) {
      if (isPublicProvenanceRequest(r)) {
        const label = PUBLIC_SOURCE_LABEL[r.source];
        publicWhere.set(label, (publicWhere.get(label) ?? new Set<string>()).add(`${r.host}${r.path}`));
        continue;
      }
      const types = endpoints.get(r.path) ?? new Set<string>();
      const filterType = r.query["filter.type"];
      if (filterType) types.add(filterType);
      endpoints.set(r.path, types);
    }
  }
  const qloo = [...endpoints].map(([path, types]) => (types.size > 0 ? `${path} (${[...types].join(", ")})` : path)).join(" + ");
  const where = [
    ...(endpoints.size > 0 ? [`Qloo ${qloo}`] : []),
    ...[...publicWhere].map(([label, paths]) => `${label} ${[...paths].join(" + ")}`),
  ].join(" + ");

  const calls = new Set(evidence.flatMap((e) => e.qlooCallIds)).size;
  const more = calls > 1 ? ` +${calls - 1}` : "";
  // A Qloo request id is shortened; a public reference (a CIK, an ACS query) is what a reader looks up, so it is kept whole.
  const req =
    evidenceSource(first) === "qloo" ? `req ${(first.requestIds[0] ?? "").slice(0, 4)}…${more}` : `ref ${first.requestIds[0] ?? ""}${more}`;

  const fetched = timeRange(evidence.map((e) => e.fetchedAt));
  const cachedRange = timeRange(evidence.filter((e) => e.cached).map((e) => e.fetchedAt));
  const cache = cachedRange
    ? `cache ${formatAge(now - Date.parse(cachedRange.from))}${evidence.every((e) => e.cached) ? "" : " (partial)"}`
    : "live";

  const fetchedAt = `fetched ${formatUtc(fetched?.from ?? first.fetchedAt)}`;
  return [`Source: ${where}`, req, fetchedAt, cache, ANALYSIS].join(" · ");
}
