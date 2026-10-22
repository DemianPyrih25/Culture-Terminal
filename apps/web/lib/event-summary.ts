import { TOOL_MNEMONIC, type EventOf, type RunEvent, type TokenUsage } from "@ct/contracts";
import { proseText, type MetricsById } from "./report-text";

const MAX = 140;

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX ? `${flat.slice(0, MAX - 1)}…` : flat;
}

const list = (ids: readonly string[]) => (ids.length ? ids.join(" ") : "");

/** Formats a duration as m:ss, or h:mm:ss past an hour. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** A cache age for chips: 45s, 12m, 3h, 2d. */
export function formatAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86_400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86_400)}d`;
}

/** The first characters of a request id, enough to match it against the receipt. */
export function shortRequestId(requestId: string | null): string {
  if (requestId === null) return "no response";
  return requestId.length > 10 ? `${requestId.slice(0, 8)}…` : requestId;
}

/** The trace chip for how a Qloo call was served: MISS, CACHE 3h, STALE, COALESCED, REUSED from #A1F3. */
export function cacheChip(event: EventOf<"qloo">): string {
  switch (event.cache) {
    case "miss":
      return "MISS";
    case "hit":
      return event.cacheAgeMs === null ? "CACHE" : `CACHE ${formatAge(event.cacheAgeMs)}`;
    case "stale":
      return "STALE";
    case "coalesced":
      return "COALESCED";
    case "reused":
      return event.originRunId ? `REUSED from #${event.originRunId.slice(0, 4).toUpperCase()}` : "REUSED";
  }
}

function formatTokens(usage: TokenUsage): string {
  const total = usage.input + usage.output + usage.cacheRead + usage.cacheCreation;
  const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  return `${k(total)} tokens${usage.cacheRead > 0 ? ` (${k(usage.cacheRead)} cached)` : ""}`;
}

/**
 * One line for the live event log. `metrics` (the run's metrics so far) lets prose with {{M#}}
 * tokens, like the final headline, read as plain text.
 */
export function summarizeEvent(event: RunEvent, metrics: MetricsById = {}): string {
  switch (event.type) {
    case "run.created":
      return clip(
        `"${event.question}" · ${event.mode} · ${event.lane} lane · model ${event.model}${
          event.parentRunId ? ` · follows ${event.parentRunId}` : ""
        }`,
      );
    case "clerk": {
      const { intent } = event;
      const refused = intent.safety.allowed ? "" : ` · refused (${intent.safety.category ?? "unsafe"})`;
      return clip(`CLERK compiled ${intent.mnemonic} · ${intent.pillar} / ${intent.job}${refused} · ${event.ms} ms`);
    }
    case "resolve":
      return clip(event.entities.map((e) => `${e.mention}: ${e.match}${e.ref ? ` → ${e.ref}` : ""}`).join(" · "));
    case "needs_input": {
      const options = event.candidates
        .map((c) => (c.disambiguation ? `${c.name} (${c.disambiguation})` : c.name))
        .join(" · ");
      return clip(`Pick one for "${event.mention}" (${event.reason}): ${options || "no candidates"}`);
    }
    case "plan": {
      const { hypotheses, steps } = event.plan;
      return clip(
        `${hypotheses.length} hypotheses, ${steps.length} steps · ${hypotheses.map((h) => `${h.id} ${h.statement}`).join(" · ")}`,
      );
    }
    case "note":
      return clip(event.text);
    case "tool.start":
      return clip(
        `${TOOL_MNEMONIC[event.tool]} ${event.tool} · ${event.phase}${event.stepId ? ` · ${event.stepId}` : ""}${
          event.triggerFindingId ? ` · from ${event.triggerFindingId}` : ""
        }`,
      );
    case "tool.end":
      return clip(
        `${TOOL_MNEMONIC[event.tool]} ${event.status} in ${event.ms} ms ${list([
          ...event.evidenceIds,
          ...event.metricIds,
          ...event.datasetIds,
          ...event.findingIds,
        ])}${event.error ? ` · ${event.error.code}: ${event.error.message}` : ""}`,
      );
    case "qloo":
      return clip(
        `${event.endpoint}${event.filterType ? ` ${event.filterType}` : ""} · ${cacheChip(event)} · ${event.ms} ms · req ${shortRequestId(
          event.requestId,
        )}${event.rows !== null ? ` · ${event.rows} rows` : ""}${event.error ? ` · ${event.error}` : ""}`,
      );
    case "finding":
      return clip(`${event.finding.id} ${event.finding.kind}: ${event.finding.text}`);
    case "fallback":
      return clip(`CODE FALLBACK ${event.from} → ${event.to}: ${event.reason}`);
    case "pivot":
      return `ANALYST PIVOT on ${event.triggerFindingId} → ${event.tool}`;
    case "metric":
      return clip(`${event.metric.id} ${event.metric.label} = ${event.metric.display} [${event.metric.badge}]`);
    case "evidence":
      return clip(`${event.evidence.id} ${event.evidence.skill}: ${event.evidence.summary}`);
    case "dataset.ready":
      return clip(`${event.datasetId} ${event.kind} "${event.title}"`);
    case "report.draft":
      return clip(`Draft ${event.attempt}: ${proseText(event.draft.headline, metrics)}`);
    case "validation":
      return `${event.ok ? "✓ Passed" : "✗ Rejected"} (attempt ${event.attempt}) · ${event.numbersTraced.traced}/${event.numbersTraced.total} numbers traced · ${event.issues.length} issue${event.issues.length === 1 ? "" : "s"}`;
    case "report.final": {
      const { verdict, receipt, dataFreshness } = event.report;
      const traced = receipt.numbersTraced;
      return clip(
        `${proseText(verdict.headline, metrics, dataFreshness.trendWindow)} · signal ${verdict.signal} · ${traced.traced}/${traced.total} numbers traced · confidence ${verdict.confidence.score} ${verdict.confidence.band}`,
      );
    }
    case "ghost":
      return clip(`GHOST: ${event.answer.headline}`);
    case "usage":
      return clip(
        `$${event.llmUsd.toFixed(2)} · ${formatTokens(event.tokens)} · Qloo ${event.qloo.network} network / ${event.qloo.cached} cached / ${event.qloo.reused} reused`,
      );
    case "error":
      return clip(`${event.code}: ${event.message}${event.retryable ? " · retryable" : ""}`);
    case "run.end":
      return clip(`${event.status} after ${formatElapsed(event.elapsedMs)}${event.reason ? ` · ${event.reason}` : ""}`);
    default: {
      const unreachable: never = event;
      return String(unreachable);
    }
  }
}
