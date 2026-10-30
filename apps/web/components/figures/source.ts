import type { Evidence } from "@ct/contracts";
import { PUBLIC_SOURCE_LABEL } from "@ct/contracts/values";
import type { FigureSource } from "./figure-frame";

/** "Qloo", "SEC EDGAR", "US Census Bureau": a bundle's source as the line names it. */
const sourceName = (source: Evidence["source"] | undefined) => (source === undefined || source === "qloo" ? "Qloo" : PUBLIC_SOURCE_LABEL[source]);

/**
 * The figure source line from the evidence behind a dataset (A/Figure frame): endpoints, request
 * count and whether code computed the plotted numbers, e.g.
 * "Source: Qloo /v2/insights · 8 requests · computed in code", with the first request id. Public data
 * (Part 9) names its source and concrete path: "Source: SEC EDGAR /api/xbrl/companyfacts/CIK0000000001.json
 * · 1 request · computed in code"; a figure drawn from several sources joins them with "+".
 */
export function sourceFromEvidence(
  evidence: readonly Evidence[],
  opts: { computed?: boolean; href?: string | null } = {},
): FigureSource {
  const bySource = new Map<string, string[]>();
  for (const e of evidence) {
    const name = sourceName(e.source);
    const paths = bySource.get(name) ?? [];
    for (const r of e.provenance.requests) if (!paths.includes(r.path)) paths.push(r.path);
    bySource.set(name, paths);
  }
  const where = [...bySource].filter(([, paths]) => paths.length > 0).map(([name, paths]) => `${name} ${paths.join(" + ")}`);
  const requests = new Set(evidence.flatMap((e) => e.qlooCallIds)).size;
  const parts = [
    where.length > 0 ? `Source: ${where.join(" + ")}` : "Source: Culture Terminal analysis",
    ...(requests > 0 ? [`${requests} ${requests === 1 ? "request" : "requests"}`] : []),
    ...((opts.computed ?? true) ? ["computed in code"] : []),
  ];
  return { text: parts.join(" · "), requestId: evidence[0]?.requestIds[0] ?? null, href: opts.href ?? null };
}
