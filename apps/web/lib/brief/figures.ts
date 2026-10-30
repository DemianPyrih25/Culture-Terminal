import type { DatasetEnvelope, EvidenceId, LocationMethod } from "@ct/contracts";
import { filterLabel, plural } from "./format";
import { requestsForEvidence, sourceName, type Ledger } from "./ledger";
import type { FigureLegend, FigureSource, LegendSeries, SourceEndpoint } from "./types";

/** Figure helpers: legend data per dataset kind, short column codes and the source line. */

const isLetter = (c: string) => /\p{L}/u.test(c);

/** A two-or-three letter code: initials for several words ("Juniper Cola" → "JC"), the first three letters for one ("Kestrel" → "KES"). */
function codeFor(label: string): string {
  const words = label
    .split(/[\s\-–—/&·.,]+/)
    .map((w) => [...w].filter((c) => isLetter(c) || /\d/.test(c)).join(""))
    .filter((w) => w.length > 0);
  if (words.length >= 2) return words.slice(0, 3).map((w) => w.charAt(0)).join("").toUpperCase();
  const word = words[0] ?? label;
  return word.slice(0, 3).toUpperCase();
}

/** Unique short codes for labels, in order: a repeated code gains letters from its label, then a digit. */
export function shortCodes(labels: readonly string[]): string[] {
  const used = new Set<string>();
  return labels.map((label) => {
    let code = codeFor(label);
    if (used.has(code)) {
      const letters = [...label].filter(isLetter).join("").toUpperCase();
      for (let len = code.length + 1; len <= Math.min(letters.length, 5) && used.has(code); len++) code = letters.slice(0, len);
      let i = 2;
      const stem = code;
      while (used.has(code)) code = `${stem}${i++}`;
    }
    used.add(code);
    return code;
  });
}

function seriesOf(items: readonly { key: string; label: string }[]): LegendSeries[] {
  return items.map((item, i) => ({ key: item.key, label: item.label, role: i === 0 ? "subject" : "comparison" }));
}

/** Legend data for a figure: its series (subject first), a heatmap ramp and matrix column codes. */
export function figureLegend(dataset: DatasetEnvelope | null): FigureLegend {
  const empty: FigureLegend = { series: [], ramp: null, codes: [] };
  if (!dataset) return empty;
  switch (dataset.kind) {
    case "Matrix": {
      const { payload } = dataset;
      const values = payload.cells.flat().flatMap((c) => (c.value === null ? [] : [c.value]));
      const codes = shortCodes(payload.cols.map((c) => c.label));
      const target = payload.cols.find((c) => c.key === payload.targetKey);
      return {
        series: target ? [{ key: target.key, label: target.label, role: "subject" }] : [],
        ramp: values.length > 0 ? { min: Math.min(...values), max: Math.max(...values), label: payload.valueLabel } : null,
        codes: payload.cols.map((c, i) => ({ key: c.key, code: codes[i] ?? c.key, label: c.label })),
      };
    }
    case "Bars":
      return { ...empty, series: seriesOf(dataset.payload.series) };
    case "Momentum":
      return { ...empty, series: seriesOf(dataset.payload.series.map((s) => ({ key: s.ref, label: s.label }))) };
    case "Slope":
      return {
        ...empty,
        series: dataset.payload.lines
          .filter((l) => l.highlight)
          .map((l) => ({ key: l.key, label: l.label, role: "subject" as const })),
      };
    case "Quadrant": {
      const groups = [...new Set(dataset.payload.points.map((p) => p.group).filter((g): g is string => g !== null))];
      return { ...empty, series: groups.map((g) => ({ key: g, label: g, role: "other" as const })) };
    }
    case "GeoLift":
      return {
        ...empty,
        series: [
          { key: "concept", label: dataset.payload.concept.label, role: "subject" },
          { key: "baseline", label: dataset.payload.baseline.label, role: "comparison" },
        ],
      };
    case "Slate":
      return { ...empty, series: [{ key: dataset.payload.seed.ref, label: dataset.payload.seed.label, role: "subject" }] };
    case "Position":
      return { ...empty, series: [{ key: dataset.payload.subject.ref, label: dataset.payload.subject.label, role: "subject" }] };
    case "TasteMap": {
      const target = dataset.payload.points.find((p) => p.target);
      return { ...empty, series: target ? [{ key: target.key, label: target.label, role: "subject" }] : [] };
    }
    case "Ranked":
    case "Supply":
    case "Scorecard":
      return empty;
  }
}

/** A figure's ⓘ link: its first formula's entry on /method, or /method itself before the dataset names one. */
export function methodHrefFor(formulaIds: readonly string[]): string {
  const first = formulaIds[0];
  return first ? `/method#${encodeURIComponent(first)}` : "/method";
}

/**
 * "Source: Qloo /v2/insights · 8 requests · computed in code", with the endpoints and the first request id.
 * Public data names its source: "Source: SEC EDGAR /api/xbrl/companyfacts · 2 requests · computed in code",
 * "Source: US Census Bureau /data/acs/acs5 · …"; a figure from both reads "Qloo /v2/tags + US Census Bureau …".
 * A location figure names the place it reads and how (A06): "Source: Qloo /v2/insights · location ← East
 * Nashville · 3 requests · read by POINT · computed in code".
 */
export function figureSource(
  ledger: Ledger,
  evidenceIds: readonly EvidenceId[],
  line: string | null,
  location: { place: string | null; method: LocationMethod | null } | null = null,
): FigureSource {
  const requests = requestsForEvidence(ledger, evidenceIds);
  const endpoints = new Map<SourceEndpoint, string[]>();
  const bySource = new Map<string, SourceEndpoint[]>();
  for (const r of requests) {
    if (r.endpoint === null) continue;
    const labels = endpoints.get(r.endpoint) ?? [];
    const f = filterLabel(r.filterType);
    if (f && !labels.includes(f)) labels.push(f);
    endpoints.set(r.endpoint, labels);
    const name = sourceName(r.source);
    const list = bySource.get(name) ?? [];
    if (!list.includes(r.endpoint)) list.push(r.endpoint);
    bySource.set(name, list);
  }
  const first = requests[0] ?? null;
  const where = bySource.size > 0 ? [...bySource].map(([name, paths]) => `${name} ${paths.join(" + ")}`).join(" + ") : "Culture Terminal analysis";
  const parts = [`Source: ${where}`];
  if (location?.place) parts.push(`location ← ${location.place}`);
  if (requests.length > 0) parts.push(plural(requests.length, "request"));
  if (location?.method) parts.push(`read by ${location.method}`);
  parts.push("computed in code");
  return {
    text: parts.join(" · "),
    place: location?.place ?? null,
    endpoints: [...endpoints].map(([path, filterLabels]) => ({ path, filterLabels })),
    requestCount: requests.length,
    computedInCode: true,
    requestId: first?.requestId ?? null,
    shortRequestId: first ? first.shortRequestId : null,
    line,
  };
}
