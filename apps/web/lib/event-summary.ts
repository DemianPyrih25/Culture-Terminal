import { TOOL_MNEMONIC, type RunEvent } from "@ct/contracts";

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

/** One line for the live event log. */
export function summarizeEvent(event: RunEvent): string {
  switch (event.type) {
    case "run.created":
      return clip(`"${event.question}" · ${event.mode} · ${event.lane} lane · model ${event.model}`);
    case "clerk":
      return clip(`CLERK compiled ${event.intent.mnemonic} (${event.intent.job}, ${event.ms} ms)`);
    case "resolve":
      return clip(event.entities.map((e) => `${e.mention}: ${e.match}${e.ref ? ` → ${e.ref}` : ""}`).join(" · "));
    case "needs_input":
      return clip(`Pick one for "${event.mention}" (${event.candidates.length} candidates)`);
    case "plan":
      return `${event.plan.hypotheses.length} hypotheses, ${event.plan.steps.length} steps`;
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
        ])}`,
      );
    case "qloo":
      return clip(
        `${event.endpoint}${event.filterType ? ` ${event.filterType}` : ""} · ${event.cache.toUpperCase()} · ${event.ms} ms`,
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
      return clip(`Draft ${event.attempt}: ${event.draft.headline}`);
    case "validation":
      return `${event.ok ? "Passed" : "Rejected"} (attempt ${event.attempt}) · ${event.numbersTraced.traced}/${event.numbersTraced.total} numbers traced · ${event.issues.length} issue${event.issues.length === 1 ? "" : "s"}`;
    case "report.final":
      return clip(
        `${event.report.verdict.headline} · confidence ${event.report.verdict.confidence.score} ${event.report.verdict.confidence.band}`,
      );
    case "ghost":
      return clip(`GHOST: ${event.answer.headline}`);
    case "usage":
      return `$${event.llmUsd.toFixed(2)} · Qloo ${event.qloo.network} network / ${event.qloo.cached} cached / ${event.qloo.reused} reused`;
    case "error":
      return clip(`${event.code}: ${event.message}`);
    case "run.end":
      return clip(`${event.status} after ${formatElapsed(event.elapsedMs)}${event.reason ? ` · ${event.reason}` : ""}`);
    default: {
      const unreachable: never = event;
      return String(unreachable);
    }
  }
}
