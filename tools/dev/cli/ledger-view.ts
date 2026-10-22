// Text views of a run's ledger and Qloo usage for the dev CLIs: metrics with ids and display values,
// the evidence bundles with the x-qloo-request-id of every call behind them, findings with their
// suggested pivots, every Qloo call with its receipt, and the quota meter. A number traces as
// M# → E# (METRICS) → request ids and call numbers (EVIDENCE) → the call's row (QLOO CALLS).
import type { Evidence, Finding, Metric } from "@ct/contracts";
import type { QlooCallRecord, QuotaSnapshot } from "@ct/qloo";
import { cacheLabel, formatCount, formatMs, idList, metricValue, NONE, shortFilterType } from "./format";
import { displayWidth, renderTable } from "./table";

const WIDTH = 110;

export function renderMetrics(metrics: readonly Metric[], indent = "  "): string[] {
  if (metrics.length === 0) return [`${indent}(none)`];
  return renderTable(
    [{ header: "id" }, { header: "value", max: 32 }, { header: "badge" }, { header: "key" }, { header: "evidence" }, { header: "label", max: 90 }],
    metrics.map((m) => [m.id, metricValue(m), m.badge, m.key, idList(m.evidenceIds), m.label]),
    { indent },
  );
}

/** qlooCallId → its 1-based row number in the QLOO CALLS table. */
export function callNumbers(records: readonly QlooCallRecord[]): Map<string, number> {
  return new Map(records.map((r, i) => [r.qlooCallId, i + 1]));
}

/** qlooCallId → the evidence bundles that cite the call. */
export function evidenceByCall(evidence: readonly Evidence[]): Map<string, string[]> {
  const byCall = new Map<string, string[]>();
  for (const e of evidence) {
    for (const id of e.qlooCallIds) {
      const ids = byCall.get(id) ?? [];
      if (!ids.includes(e.id)) ids.push(e.id);
      byCall.set(id, ids);
    }
  }
  return byCall;
}

/** `items` after `prefix`, joined by " · " and wrapped to `width` without splitting an item. */
function wrapItems(prefix: string, items: readonly string[], width: number): string[] {
  const lines: string[] = [];
  const pad = " ".repeat(displayWidth(prefix));
  let line = prefix;
  items.forEach((item, i) => {
    if (i > 0 && displayWidth(line) + 3 + displayWidth(item) > width) {
      lines.push(line);
      line = pad + item;
    } else {
      line += (i === 0 ? "" : " · ") + item;
    }
  });
  return [...lines, line];
}

/**
 * One row per evidence bundle, then the request id of each of its calls with the call's number in
 * the QLOO CALLS table ("#3 <request id>"), so every number's E# leads to its x-qloo-request-ids.
 */
export function renderEvidence(evidence: readonly Evidence[], calls: ReadonlyMap<string, number>, indent = "  "): string[] {
  if (evidence.length === 0) return [`${indent}(none)`];
  const [header = "", ...rows] = renderTable(
    [{ header: "id" }, { header: "skill" }, { header: "status" }, { header: "source" }, { header: "calls", align: "right" }, { header: "purpose", max: 70 }],
    evidence.map((e) => [e.id, e.skill, e.status, e.cached ? "cache" : "network", String(e.qlooCallIds.length), e.purpose]),
    { indent },
  );
  const pad = `${indent}    `;
  return [
    header,
    ...rows.flatMap((row, i) => {
      const e = evidence[i];
      if (e === undefined) return [row];
      const requests = e.qlooCallIds.map((id, j) => `#${calls.get(id) ?? "?"} ${e.requestIds[j] ?? NONE}`);
      return [row, ...wrapItems(`${pad}req `, requests, WIDTH)];
    }),
  ];
}

export function renderFindings(findings: readonly Finding[], indent = "  "): string[] {
  if (findings.length === 0) return [`${indent}(none)`];
  return findings.flatMap((f) => {
    const metrics = f.metricIds.length > 0 ? ` [${f.metricIds.join(" ")}]` : "";
    const lines = [`${indent}${f.id} ${f.kind} (${f.severity})${metrics}: ${f.text}`];
    if (f.suggestion !== null) lines.push(`${indent}   → ${f.suggestion.tool}: ${f.suggestion.reason}`);
    return lines;
  });
}

/**
 * One row per Qloo call, in the order they finished, with the evidence bundles that cite it and the
 * x-qloo-request-id its answer carried.
 */
export function renderCalls(records: readonly QlooCallRecord[], evidence: ReadonlyMap<string, readonly string[]> = new Map(), indent = "  "): string[] {
  if (records.length === 0) return [`${indent}(no Qloo calls)`];
  return renderTable(
    [
      { header: "#", align: "right" },
      { header: "tool" },
      { header: "evidence" },
      { header: "endpoint" },
      { header: "filter type" },
      { header: "cache" },
      { header: "ms", align: "right" },
      { header: "rows", align: "right" },
      { header: "status", align: "right" },
      { header: "request id" },
      { header: "error", max: 60 },
    ],
    records.map((r, i) => [
      String(i + 1),
      r.toolCallId ?? NONE,
      idList(evidence.get(r.qlooCallId) ?? []),
      r.path,
      shortFilterType(r.filterType),
      cacheLabel(r.cache),
      formatMs(r.ms),
      r.rows === null ? NONE : String(r.rows),
      r.status === null ? NONE : String(r.status),
      r.requestId ?? NONE,
      r.error ?? "",
    ]),
    { indent },
  );
}

export interface QuotaView {
  /** Calls this run sent to the network (miss or stale). */
  network: number;
  /** Calls served without a network call (hit, reused, coalesced). */
  cached: number;
  quota: QuotaSnapshot;
  monthFloor: number;
  env: string;
  tag: string;
  tagCap: number | null;
  /** Network calls ever logged for the tag in this environment, or null when the store could not say. */
  tagUsed: number | null;
  /** Live calls the Qloo kit CLI made outside @ct/qloo (kit-parity), or null when it was not run. */
  kitCalls?: number | null;
}

export function renderQuota(view: QuotaView, indent = "  "): string[] {
  const { quota } = view;
  const month =
    quota.monthRemaining === null
      ? "unknown (no Qloo response seen yet)"
      : `${formatCount(quota.monthRemaining)}${quota.monthLimit === null ? "" : ` of ${formatCount(quota.monthLimit)}`}`;
  const captured = quota.capturedAt === null ? "" : ` (as of ${quota.capturedAt})`;
  const headroom = quota.monthRemaining === null ? "" : `, ${formatCount(Math.max(0, quota.monthRemaining - view.monthFloor))} above it`;
  const tag =
    view.tagCap === null
      ? `${view.tag}: no per-tag cap in ${view.env} mode`
      : `${view.tag}: ${view.tagUsed === null ? "?" : formatCount(view.tagUsed)} of ${formatCount(view.tagCap)} network calls used`;
  const kit =
    view.kitCalls === undefined || view.kitCalls === null
      ? []
      : [`${indent}kit CLI       ${formatCount(view.kitCalls)} live call(s) outside @ct/qloo, logged under tag ${view.tag}`];
  return [
    `${indent}this run      ${formatCount(view.network)} network · ${formatCount(view.cached)} cached`,
    ...kit,
    `${indent}today         ${formatCount(quota.todayNetwork)} network (${quota.day}, this environment)`,
    `${indent}month left    ${month}${captured}`,
    `${indent}dev floor     stops at ${formatCount(view.monthFloor)}${headroom}`,
    `${indent}tag           ${tag}`,
  ];
}
