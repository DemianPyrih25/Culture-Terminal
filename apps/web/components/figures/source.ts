import type { Evidence } from "@ct/contracts";
import type { FigureSource } from "./figure-frame";

/**
 * The figure source line from the evidence behind a dataset (A/Figure frame): endpoints, request
 * count and whether code computed the plotted numbers, e.g.
 * "Source: Qloo /v2/insights · 8 requests · computed in code", with the first request id.
 */
export function sourceFromEvidence(
  evidence: readonly Evidence[],
  opts: { computed?: boolean; href?: string | null } = {},
): FigureSource {
  const paths = [...new Set(evidence.flatMap((e) => e.provenance.requests.map((r) => r.path)))];
  const requests = new Set(evidence.flatMap((e) => e.qlooCallIds)).size;
  const parts = [
    paths.length > 0 ? `Source: Qloo ${paths.join(" + ")}` : "Source: Culture Terminal analysis",
    ...(requests > 0 ? [`${requests} ${requests === 1 ? "request" : "requests"}`] : []),
    ...((opts.computed ?? true) ? ["computed in code"] : []),
  ];
  return { text: parts.join(" · "), requestId: evidence[0]?.requestIds[0] ?? null, href: opts.href ?? null };
}
