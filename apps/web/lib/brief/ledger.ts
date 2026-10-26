import { METRO_LABEL } from "@ct/contracts";
import type {
  CacheStatus,
  EvidenceId,
  Metric,
  QlooChip,
  QlooPath,
  RunState,
  RunEventType,
  ToolCallState,
  TrendWindow,
} from "@ct/contracts";
import {
  COMPARATOR_TEXT,
  filterLabel,
  formatCacheAge,
  formatTrendWindow,
  formatUtcShortDateTime,
  metricDirection,
  metricShortLabel,
  NO_VALUE_LABEL,
  NOT_MEASURED,
  plural,
  shortRequestId,
} from "./format";
import type { MetricView, RequestRef } from "./types";

/**
 * An index over one RunState for the brief: metrics, evidence and Qloo calls by id, the run's
 * entity names, and when each ledger item arrived. Built once per model.
 */
export interface Ledger {
  state: RunState;
  chips: Map<string, { chip: QlooChip; index: number }>;
  /** Qloo call id → the evidence bundles that used it. */
  evidenceByCall: Map<string, EvidenceId[]>;
  toolCalls: Map<string, ToolCallState>;
  /** R# → entity name, from the resolution gate and the datasets; T# → tag name, from the datasets. */
  refNames: Map<string, string>;
  /**
   * Place subjects → their names: metro and market ids ("austin" → "Austin"), gazetteer neighbourhoods
   * (from a lift map) and the area a Block DNA figure read. Metrics name places by id in `subjectRefs`.
   */
  placeNames: Map<string, string>;
  /** The trending window the note uses, if any. */
  window: TrendWindow | null;
  /** "<type> <key>" → seq of the latest event that carried it. */
  arrival: Map<string, number>;
}

const REF = /^R[1-9]\d*$/;
const TAG_REF = /^T[1-9]\d*$/;

/**
 * Walks plain JSON and records every `{ref: "R#", label}` pair it finds (axis items, points, series), and
 * every `{tagRef: "T#", label}` (Block DNA bars, tag rows).
 */
function collectRefLabels(value: unknown, out: Map<string, string>, depth = 0): void {
  if (depth > 8 || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectRefLabels(item, out, depth + 1);
    return;
  }
  const record = value as Record<string, unknown>;
  const label = record.label;
  if (typeof label === "string") {
    for (const ref of [record.ref, record.tagRef]) {
      if (typeof ref === "string" && (REF.test(ref) || TAG_REF.test(ref)) && !out.has(ref)) out.set(ref, label);
    }
  }
  for (const v of Object.values(record)) collectRefLabels(v, out, depth + 1);
}

/** Every R# string inside a value (tool arguments), in first-seen order. */
export function refsIn(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 6 || value === null || value === undefined) return out;
  if (typeof value === "string") {
    for (const part of value.split(",")) {
      const ref = part.trim();
      if (REF.test(ref) && !out.includes(ref)) out.push(ref);
    }
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) refsIn(item, out, depth + 1);
    return out;
  }
  if (typeof value === "object") for (const v of Object.values(value)) refsIn(v, out, depth + 1);
  return out;
}

/** Place names the datasets carry: lift map neighbourhoods, slate markets, metro axes and Block DNA areas. */
function collectPlaceNames(state: RunState, out: Map<string, string>): void {
  for (const [id, label] of Object.entries(METRO_LABEL)) out.set(id, label);
  for (const d of Object.values(state.datasets)) {
    const data = d.data;
    if (!data) continue;
    switch (data.kind) {
      case "GeoLift":
        for (const n of data.payload.neighbourhoods) out.set(n.id, n.name);
        break;
      case "Slate":
        for (const m of data.payload.markets) out.set(m.id, m.label);
        break;
      case "Bars":
        if (data.payload.method !== null) for (const s of data.payload.series) out.set(s.key, s.label);
        break;
      case "Matrix":
        for (const a of [...data.payload.rows, ...data.payload.cols]) if (a.group === "METRO" && !out.has(a.key)) out.set(a.key, a.label);
        break;
      default:
        break;
    }
  }
}

function metricWindow(state: RunState): TrendWindow | null {
  if (state.report?.dataFreshness.trendWindow) return state.report.dataFreshness.trendWindow;
  for (const m of Object.values(state.metrics)) if (m.window) return m.window;
  for (const d of Object.values(state.datasets)) if (d.data?.kind === "Momentum") return d.data.payload.window;
  return null;
}

export function buildLedger(state: RunState): Ledger {
  const chips = new Map<string, { chip: QlooChip; index: number }>();
  state.qloo.chips.forEach((chip, index) => chips.set(chip.qlooCallId, { chip, index }));

  const evidenceByCall = new Map<string, EvidenceId[]>();
  for (const e of Object.values(state.evidence)) {
    for (const id of e.qlooCallIds) {
      const list = evidenceByCall.get(id) ?? [];
      if (!list.includes(e.id)) list.push(e.id);
      evidenceByCall.set(id, list);
    }
  }

  const refNames = new Map<string, string>();
  for (const r of state.resolves) if (r.ref && r.name) refNames.set(r.ref, r.name);
  for (const d of Object.values(state.datasets)) if (d.data) collectRefLabels(d.data.payload, refNames);

  const placeNames = new Map<string, string>();
  collectPlaceNames(state, placeNames);

  const arrival = new Map<string, number>();
  for (const t of state.timeline) if (t.key !== null) arrival.set(`${t.type} ${t.key}`, t.seq);

  return {
    state,
    chips,
    evidenceByCall,
    toolCalls: new Map(state.toolCalls.map((t) => [t.toolCallId, t])),
    refNames,
    placeNames,
    window: metricWindow(state),
    arrival,
  };
}

/** The seq of the latest event of this type for this key, or +∞ when it never arrived. */
export function arrivedAt(ledger: Ledger, type: RunEventType, key: string): number {
  return ledger.arrival.get(`${type} ${key}`) ?? Number.POSITIVE_INFINITY;
}

/** The ts of the first event of a type (e.g. the plan), or null. */
export function firstTs(state: RunState, type: RunEventType): string | null {
  return state.timeline.find((t) => t.type === type)?.ts ?? null;
}

/** The ts of the latest event of a type, or null. */
export function lastTs(state: RunState, type: RunEventType): string | null {
  for (let i = state.timeline.length - 1; i >= 0; i--) {
    const t = state.timeline[i];
    if (t?.type === type) return t.ts;
  }
  return null;
}

const isLedgerRef = (ref: string) => REF.test(ref) || TAG_REF.test(ref);

/** "R1 Juniper Cola" when the name is known; a place by its name ("Austin"); any other subject unchanged. */
export function refText(ledger: Ledger, ref: string): string {
  const name = ledger.refNames.get(ref);
  if (name) return `${ref} ${name}`;
  return ledger.placeNames.get(ref) ?? ref;
}

/** The margin's short form: an R# or T# bare, a place by its name; null for an id the brief cannot name. */
function shortRef(ledger: Ledger, ref: string): string | null {
  return isLedgerRef(ref) ? ref : (ledger.placeNames.get(ref) ?? null);
}

// Metrics ---------------------------------------------------------------------------------------------

export function metricView(metric: Metric, window: TrendWindow | null): MetricView {
  const unavailable = metric.badge === "UNAVAILABLE" || metric.value === null;
  const stale = metric.badge === "STALE";
  const w = metric.window ?? (stale ? window : null);
  return {
    id: metric.id,
    label: metric.label,
    shortLabel: metricShortLabel(metric),
    text: unavailable ? NOT_MEASURED : metric.display,
    badge: metric.badge,
    unavailable,
    reason: metric.reason,
    reasonLabel: unavailable ? (metric.reason ? NO_VALUE_LABEL[metric.reason] : "not measured") : null,
    comparator: metric.comparator,
    comparatorLabel: metric.comparator ? COMPARATOR_TEXT[metric.comparator] : null,
    direction: unavailable ? null : metricDirection(metric),
    unit: metric.unit,
    formulaId: metric.formulaId,
    derived: metric.badge === "DERIVED",
    stale,
    window: stale && w ? formatTrendWindow(w) : null,
  };
}

// Qloo calls ------------------------------------------------------------------------------------------

/** "cached 2h", "live 13 Oct, 09:13", "reused from #A1F3", "stale cache 3h". */
export function cacheLabel(cache: CacheStatus, cacheAgeMs: number | null, at: string, originRunId: string | null): string {
  const age = cacheAgeMs !== null ? ` ${formatCacheAge(cacheAgeMs)}` : "";
  switch (cache) {
    case "miss":
      return `live ${formatUtcShortDateTime(at)}`;
    case "hit":
    case "coalesced":
      return `cached${age}`;
    case "stale":
      return `stale cache${age}`;
    case "reused":
      return originRunId ? `reused from #${originRunId.replace(/[^A-Za-z0-9]/g, "").slice(0, 4).toUpperCase()}` : `reused${age}`;
  }
}

/** A Qloo call as a footnote cites it; ledger data fills in what the run did not stream. */
export function requestRef(
  ledger: Ledger,
  qlooCallId: string,
  fallback: { requestId?: string; path?: QlooPath; query?: Record<string, string>; cached?: boolean; fetchedAt?: string } = {},
): RequestRef {
  const found = ledger.chips.get(qlooCallId);
  if (found) {
    const { chip, index } = found;
    return {
      qlooCallId,
      sourceIndex: index,
      requestId: chip.requestId,
      shortRequestId: shortRequestId(chip.requestId),
      endpoint: chip.endpoint,
      filterType: chip.filterType,
      filterLabel: filterLabel(chip.filterType),
      params: Object.entries(chip.paramsRedacted),
      rows: chip.rows,
      ms: chip.ms,
      cache: chip.cache,
      cacheLabel: cacheLabel(chip.cache, chip.cacheAgeMs, chip.ts, chip.originRunId),
    };
  }
  const filterType = fallback.query?.["filter.type"] ?? null;
  return {
    qlooCallId,
    sourceIndex: null,
    requestId: fallback.requestId ?? null,
    shortRequestId: shortRequestId(fallback.requestId ?? null),
    endpoint: fallback.path ?? null,
    filterType,
    filterLabel: filterLabel(filterType),
    params: Object.entries(fallback.query ?? {}),
    rows: null,
    ms: null,
    cache: null,
    cacheLabel: fallback.cached ? "cached" : fallback.fetchedAt ? `live ${formatUtcShortDateTime(fallback.fetchedAt)}` : "",
  };
}

/** The Qloo calls behind evidence bundles, in ledger order and without repeats. */
export function requestsForEvidence(ledger: Ledger, evidenceIds: readonly EvidenceId[]): RequestRef[] {
  const out: RequestRef[] = [];
  const seen = new Set<string>();
  for (const id of evidenceIds) {
    const e = ledger.state.evidence[id];
    if (!e) continue;
    e.qlooCallIds.forEach((callId, i) => {
      if (seen.has(callId)) return;
      seen.add(callId);
      const request = e.provenance.requests[i];
      out.push(
        requestRef(ledger, callId, {
          requestId: e.requestIds[i],
          path: request?.path,
          query: request?.query,
          cached: e.cached,
          fetchedAt: e.fetchedAt,
        }),
      );
    });
  }
  return out;
}

/** Subject refs for a set of requests: R# in their parameters, else in the arguments of the tool calls that made them. */
export function refsForCalls(ledger: Ledger, qlooCallIds: readonly string[]): string[] {
  const refs: string[] = [];
  for (const id of qlooCallIds) refsIn(ledger.chips.get(id)?.chip.paramsRedacted, refs);
  if (refs.length > 0) return refs;
  for (const id of qlooCallIds) {
    const toolCallId = ledger.chips.get(id)?.chip.toolCallId;
    const tool = toolCallId ? ledger.toolCalls.get(toolCallId) : undefined;
    if (tool) refsIn(tool.args, refs);
  }
  return refs;
}

/**
 * The sidenote head for a set of requests: "Qloo /v2/insights · brand ← R1 Juniper Cola · 20 rows", or
 * with `names: false` the margin's short form, "Qloo /v2/insights · brand ← R1 · 20 rows". `refs`
 * overrides the refs read from the requests (a metric names its own subjects).
 */
export function requestHead(
  ledger: Ledger,
  requests: readonly RequestRef[],
  refs?: readonly string[],
  { names = true }: { names?: boolean } = {},
): string | null {
  if (requests.length === 0) return null;
  const endpoints = [...new Set(requests.map((r) => r.endpoint).filter((p): p is QlooPath => p !== null))];
  const filters = [...new Set(requests.map((r) => r.filterLabel).filter((f): f is string => f !== null))];
  const subjects = (refs && refs.length > 0 ? [...refs] : refsForCalls(ledger, requests.map((r) => r.qlooCallId)))
    .slice(0, 3)
    .flatMap((r) => (names ? [refText(ledger, r)] : (shortRef(ledger, r) ?? [])));
  const rows = requests.reduce<number | null>((sum, r) => (r.rows === null ? sum : (sum ?? 0) + r.rows), null);
  const parts = [`Qloo ${endpoints.length > 0 ? endpoints.join(" + ") : "request"}`];
  const what = filters.length > 0 ? filters.slice(0, 3).join(", ") : null;
  if (what || subjects.length > 0) parts.push([what, subjects.length > 0 ? `← ${subjects.join(", ")}` : null].filter(Boolean).join(" "));
  if (rows !== null) parts.push(plural(rows, "row"));
  return parts.join(" · ");
}

/**
 * The mono trace line for requests: "req ab12…cd34 · cached 2h" for one, "8 requests · req
 * ab12…cd34 · cached 2h" for several (the cache label of the first, "partly cached" when mixed).
 */
export function requestTrace(requests: readonly RequestRef[]): string {
  const first = requests[0];
  if (!first) return "no request";
  const cache = (() => {
    if (requests.length === 1) return first.cacheLabel;
    const live = requests.filter((r) => r.cache === "miss" || r.cache === "stale").length;
    if (live === 0) return first.cacheLabel;
    if (live === requests.length) return first.cacheLabel;
    return "partly cached";
  })();
  const head = requests.length > 1 ? [`${requests.length} requests`] : [];
  return [...head, `req ${first.shortRequestId}`, cache].filter((s) => s !== "").join(" · ");
}

/** The longest short trace: one mono line of the 300 px margin at 1440, so it is never cut with "…". */
export const SHORT_TRACE_MAX = 40;

/**
 * The margin's trace (A/Sidenote): "req ab12…cd34 · cached 2h" or "req ab12…cd34 · live 13 Oct, 09:13"
 * for one request, "8 requests · req ab12…cd34" for several (the inspector lists them all).
 */
export function shortRequestTrace(requests: readonly RequestRef[]): string {
  const first = requests[0];
  if (!first) return "no request";
  const id = `req ${first.shortRequestId}`;
  if (requests.length > 1) return `${plural(requests.length, "request")} · ${id}`;
  const line = [id, first.cacheLabel].filter((s) => s !== "").join(" · ");
  return line.length <= SHORT_TRACE_MAX ? line : id;
}
