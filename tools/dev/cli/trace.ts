// The live trace of an agent run as compact text: one line per event (a plan adds one per hypothesis
// and step, a CHECKER result one per issue). Metric and evidence events are not printed: the ledger
// is summarised with the report and its receipt.
import { compileMnemonic, type EventInput, type EventInputOf, type Intent, type ResolvedMention } from "@ct/contracts";
import { formatBytes, formatCount, formatFixed2, formatMs, formatTokens, formatUsd, idList, NONE, publicChip, qlooChip } from "./format";
import type { CliIo } from "./io";
import { clean, truncate } from "./table";

const NOTE_MAX = 140;

/** What the trace remembers between events: which tool each tool call is, for the Qloo chips. */
export interface TraceState {
  tools: Map<string, string>;
}

export const newTraceState = (): TraceState => ({ tools: new Map() });

const oneLine = (s: string, max: number): string => truncate(clean(s).replace(/\s+/g, " ").trim(), max);

function mentionText(m: Intent["mentions"][number]): string {
  return `${m.text} <${m.entity_type}${m.role === "secondary" ? "" : `, ${m.role}`}>`;
}

function resolveChip(m: ResolvedMention): string {
  if (m.match === "exact") {
    const pop = m.popularity === null ? "" : `, pop ${formatFixed2(m.popularity)}`;
    return `${m.mention} → ${m.ref ?? NONE} (exact${pop})`;
  }
  return `${m.mention} ✗ ${m.match} (${m.alternatives.length} candidate${m.alternatives.length === 1 ? "" : "s"})`;
}

function candidateList(e: EventInputOf<"needs_input">): string {
  return e.candidates
    .map((c) => [c.name, c.disambiguation, c.popularity === null ? null : `pop ${formatFixed2(c.popularity)}`].filter((p) => p !== null).join(", "))
    .join("; ");
}

/** The lines one event prints; empty for metric and evidence events. */
export function formatEvent(event: EventInput, state: TraceState): string[] {
  switch (event.type) {
    case "run.created":
      return [
        `RUN      ${event.model} · ${event.mode} · lane ${event.lane} · caps ${event.limits.qlooCalls} Qloo calls, ${formatUsd(event.limits.usdHard)} LLM` +
          (event.parentRunId === null ? "" : ` · child of ${event.parentRunId}`),
      ];
    case "run.queued":
      return [`QUEUED   position ${event.position} · ${event.ahead} ahead · gives up in ${event.waitSMax} s`];
    case "clerk": {
      const { intent } = event;
      const geo = [intent.geo.metro, intent.geo.area, intent.geo.unsupported_place].filter((g) => g !== null);
      const lines = [
        `CLERK    ${intent.job} (${intent.pillar}) · ${compileMnemonic(intent)} · ${intent.mentions.map(mentionText).join(", ") || "no names"}` +
          (geo.length > 0 ? ` · ${geo.join(", ")}` : "") +
          ` · ${formatMs(event.ms)}`,
      ];
      if (!intent.safety.allowed) lines.push(`         refused: ${intent.safety.category ?? "unsafe"}`);
      else if (intent.safety.reframe !== null) lines.push(`         reframed: ${oneLine(intent.safety.reframe, NOTE_MAX)}`);
      return lines;
    }
    case "resolve":
      return [`RESOLVE  ${event.entities.map(resolveChip).join(" · ")}`];
    case "needs_input":
      return [`NEEDS    '${event.mention}' (${event.entityType}) is ${event.reason}: ${candidateList(event) || "no candidates"}`];
    case "plan": {
      const estimates = new Map<string, number>(event.estimates.map((e) => [e.stepId, e.calls]));
      return [
        `PLAN     ${oneLine(event.plan.restated_question, NOTE_MAX)}`,
        ...event.plan.hypotheses.map((h) => `         ${h.id} ${oneLine(h.statement, NOTE_MAX)} → ${h.test_tool}`),
        ...event.plan.steps.map((s) => {
          const calls = estimates.get(s.id);
          return `         ${s.id} ${s.tool}${calls === undefined ? "" : ` (~${calls} calls)`}: ${oneLine(s.purpose, NOTE_MAX)}`;
        }),
      ];
    }
    case "note":
      return [`note     ${oneLine(event.text, NOTE_MAX)}`];
    case "tool.start": {
      state.tools.set(event.toolCallId, event.tool);
      const step = event.stepId === null ? "" : ` ${event.stepId}`;
      const trigger = event.triggerFindingId === null ? "" : ` ← ${event.triggerFindingId}`;
      const estimate = event.estimatedCalls === null ? "" : ` · est ${event.estimatedCalls} calls`;
      return [`▶ ${event.tool}${step} [${event.phase}]${trigger}${estimate}`];
    }
    case "tool.end": {
      const flags = event.flags.length === 0 ? "" : ` · flags ${event.flags.join(", ")}`;
      const error = event.error === null ? "" : ` · ${event.error.code}: ${event.error.message}`;
      const ids = [...event.evidenceIds, ...event.metricIds, ...event.datasetIds, ...event.findingIds];
      return [`■ ${event.tool} ${event.status} ${formatMs(event.ms)} · ${idList(ids)}${flags}${error}`];
    }
    case "qloo": {
      // Gate and scan bookkeeping calls belong to no tool call.
      const tool = event.toolCallId === null ? "no tool" : (state.tools.get(event.toolCallId) ?? event.toolCallId);
      return [`  qloo [${tool}] ${qlooChip(event)}`];
    }
    case "public": {
      const tool = event.toolCallId === null ? "no tool" : (state.tools.get(event.toolCallId) ?? event.toolCallId);
      return [`  ${event.source} [${tool}] ${publicChip(event)}`];
    }
    case "finding": {
      const f = event.finding;
      const suggestion = f.suggestion === null ? "" : ` → ${f.suggestion.tool}`;
      return [`◆ ${f.id} ${f.kind} (${f.severity}) ${oneLine(f.text, NOTE_MAX)}${suggestion}`];
    }
    case "fallback":
      return [`CODE FALLBACK ${event.from} → ${event.to}: ${oneLine(event.reason, NOTE_MAX)}`];
    case "pivot":
      return [`ANALYST PIVOT ${event.triggerFindingId} → ${event.tool} (${event.toolCallId})`];
    case "metric":
    case "evidence":
      return [];
    case "dataset.ready":
      return [`▣ ${event.datasetId} ${event.kind} "${event.title}" ${formatBytes(event.bytes)}${event.inline === null ? " (fetched on demand)" : ""}`];
    case "report.draft":
      return [`DRAFT    attempt ${event.attempt}: ${oneLine(event.draft.headline, NOTE_MAX)}`];
    case "validation": {
      const { traced, total } = event.numbersTraced;
      const head = `CHECKER  ${event.ok ? "✓" : "✗"} ${traced}/${total} numbers traced (attempt ${event.attempt})` +
        (event.adviceTerms > 0 ? ` · ${event.adviceTerms} advice term(s)` : "");
      return [head, ...event.issues.map((i) => `         ${i.rule} ${i.action}: ${oneLine(i.message, NOTE_MAX)}${i.path === null ? "" : ` (${i.path})`}`)];
    }
    case "report.final":
      return [`REPORT   final · ${event.report.verdict.signal} · confidence ${event.report.verdict.confidence.band}`];
    case "ghost":
      return [
        `GHOST    overlap@5 ${formatFixed2(event.diff.overlapAt5)} · resolvability ${formatFixed2(event.diff.resolvability)} · ` +
          `${event.diff.unsourcedNumericClaims} unsourced number(s)`,
      ];
    case "usage":
      return [
        `usage    ${formatUsd(event.llmUsd)} · ${formatTokens(event.tokens)} · Qloo ${formatCount(event.qloo.network)} network / ` +
          `${formatCount(event.qloo.cached)} cached / ${formatCount(event.qloo.reused)} reused · ${formatMs(event.elapsedMs)}`,
      ];
    case "context.ai": {
      const b = event.block;
      const what = b.status === "ok" ? `${b.items.length} item(s)` + (b.presenceMarkets.length > 0 ? ` · present in ${b.presenceMarkets.join(", ")}` : "") : (b.note ?? b.status);
      return [`AI CTX   ${b.status} · ${oneLine(what, NOTE_MAX)}${b.cached ? " · cached" : ""} · ${formatUsd(event.usd)} · ${formatMs(event.ms)}` +
        (b.droppedForNumbers > 0 ? ` · ${b.droppedForNumbers} dropped for numbers` : "")];
    }
    case "context.web": {
      const b = event.block;
      const what = b.status === "ok" ? `${b.items.length} item(s) from ${b.searches} search(es)` : (b.note ?? b.status);
      return [`WEB CTX  ${b.status} · ${oneLine(what, NOTE_MAX)}${b.cached ? " · cached" : ""} · ${formatUsd(event.usd)} · ${formatMs(event.ms)}` +
        (b.droppedForNumbers > 0 ? ` · ${b.droppedForNumbers} dropped for numbers` : "")];
    }
    case "error":
      return [`ERROR    ${event.code}: ${event.message}${event.retryable ? " (retryable)" : ""}`];
    case "run.end":
      return [`END      ${event.status} · ${formatMs(event.elapsedMs)}${event.reason === null ? "" : ` · ${event.reason}`}`];
  }
}

export interface TracePrinter {
  emit(event: EventInput): void;
  /** The picker of a needs_input run, if one was emitted. */
  needsInput(): EventInputOf<"needs_input"> | null;
}

/** Prints each event as it arrives, prefixed with the seconds since the run started. */
export function createTracePrinter(io: CliIo, now: () => number): TracePrinter {
  const started = now();
  const state = newTraceState();
  let picker: EventInputOf<"needs_input"> | null = null;
  return {
    emit(event) {
      if (event.type === "needs_input") picker = event;
      const stamp = `${((now() - started) / 1000).toFixed(1).padStart(6)}s `;
      const lines = formatEvent(event, state);
      lines.forEach((line, i) => io.out(i === 0 ? stamp + line : " ".repeat(stamp.length) + line));
    },
    needsInput: () => picker,
  };
}
