// Synthetic runs for the brief tests: the contracts fixture run and the web test run (a replay of the
// synthetic brand-health sample), both on invented entities (D29). Test files that import this mock
// "server-only" first (fake-script.ts). Expectations read the run's own data where they can, so a
// regenerated sample changes the numbers, not the tests.
import {
  AGE_BUCKET_LABEL,
  applyEvent,
  initialRunState,
  reduceRunEvents,
  stampEvent,
  type EventInput,
  type Report,
  type RunEvent,
  type RunState,
} from "@ct/contracts";
import { buildFakeScript, FAKE_QUESTION } from "../../server/fake-script";
import { fullRunInputs, report as fixtureReport, RUN_ID as FIXTURE_RUN, stampAll } from "../../../../packages/contracts/test/fixtures";
import { buildLedger, formatTrendWindow, inlineText, NOT_MEASURED, type BriefModel, type Inline } from "../../lib/brief";

export { FAKE_QUESTION, FIXTURE_RUN, fixtureReport, fullRunInputs, stampAll };

export const FAKE_RUN = "run-brief-fake-1";
export const FAKE_STARTED_AT = Date.UTC(2026, 9, 14, 9, 12, 0);
export const FAKE_DURATION_MS = 120_000;

/** The web test run as stored events, through run.end. */
export function fakeRunEvents(runId = FAKE_RUN): RunEvent[] {
  const script = buildFakeScript({ runId, startedAt: FAKE_STARTED_AT, durationMs: FAKE_DURATION_MS });
  const at = (fraction: number) => new Date(FAKE_STARTED_AT + fraction * FAKE_DURATION_MS).toISOString();
  return [
    ...script.steps.map((step, i) => stampEvent(step.input, { seq: i + 1, ts: at(step.at), runId })),
    stampEvent(
      { type: "run.end", status: "completed", elapsedMs: FAKE_DURATION_MS, reason: null },
      { seq: script.steps.length + 1, ts: at(1), runId },
    ),
  ];
}

export const fakeRunState = (): RunState => reduceRunEvents(FAKE_RUN, fakeRunEvents());

/** The contracts fixture run, optionally with a different report. */
export function fixtureRunEvents(report: Report = fixtureReport): RunEvent[] {
  const inputs: EventInput[] = fullRunInputs.map((input) => (input.type === "report.final" ? { type: "report.final", report } : input));
  return stampAll(inputs);
}

/** Every state along the events: states[i] is the state after events[i]. */
export function statesAlong(runId: string, events: readonly RunEvent[]): RunState[] {
  const out: RunState[] = [];
  let state = initialRunState(runId);
  for (const e of events) {
    state = applyEvent(state, e);
    out.push(state);
  }
  return out;
}

/** Events up to and including the nth one of this type. */
export function upTo(events: readonly RunEvent[], type: RunEvent["type"], nth = 1): RunEvent[] {
  let seen = 0;
  const i = events.findIndex((e) => e.type === type && ++seen === nth);
  if (i === -1) throw new Error(`no ${type} #${nth} in the events`);
  return events.slice(0, i + 1);
}

/** Events up to and including the nth Qloo call made by this tool call. */
export function upToCall(events: readonly RunEvent[], toolCallId: string, nth: number): RunEvent[] {
  let seen = 0;
  const i = events.findIndex((e) => e.type === "qloo" && e.toolCallId === toolCallId && ++seen === nth);
  if (i === -1) throw new Error(`no Qloo call #${nth} of ${toolCallId} in the events`);
  return events.slice(0, i + 1);
}

/** The events cut short by a run.end of this status, one second after the last of them. */
export function endedAs(
  events: readonly RunEvent[],
  status: Extract<EventInput, { type: "run.end" }>["status"],
  reason: string | null,
): RunEvent[] {
  const last = events.at(-1);
  if (!last) throw new Error("no events to end");
  const ts = new Date(Date.parse(last.ts) + 1000).toISOString();
  return [...events, stampEvent({ type: "run.end", status, elapsedMs: Date.parse(ts) - FAKE_STARTED_AT, reason }, { seq: last.seq + 1, ts, runId: last.runId })];
}

/**
 * Report prose as the brief prints it, worked out from the tokens: {{M#}} becomes the metric's
 * display ("not measured" when UNAVAILABLE), {{WINDOW}} the trending window, and an [E#] drops
 * out together with the space before it (its superscript sits on the word before).
 */
export function plainProse(text: string, state: RunState): string {
  const window = buildLedger(state).window;
  return text
    .replace(/\{\{(M\d+)\}\}/g, (_m, id: string) => {
      const metric = state.metrics[id as keyof RunState["metrics"]];
      if (!metric) return "not available";
      return metric.badge === "UNAVAILABLE" || metric.value === null ? NOT_MEASURED : metric.display;
    })
    .replace(/\{\{WINDOW\}\}/g, window ? formatTrendWindow(window) : "the trending window")
    .replace(/\s*\[E\d+\]/g, "");
}

/**
 * Digits a text piece prints outside the names the run registered (entity names, age buckets): a
 * number the reader cannot trace, since only metric pieces carry footnotes. Empty when there are none.
 */
export function untracedDigits(text: string, state: RunState): string[] {
  const names = [...buildLedger(state).refNames.values(), ...state.resolves.flatMap((r) => (r.name ? [r.name] : [])), ...Object.values(AGE_BUCKET_LABEL)];
  let rest = text;
  for (const name of names.sort((a, b) => b.length - a.length)) if (/\d/.test(name)) rest = rest.split(name).join(" ");
  return rest.match(/\d[\d.,%]*/g) ?? [];
}

/** Every prose block of a brief in reading order (answer, priors, key figures, figures, arguments, risks). */
export function proseBlocks(model: BriefModel): { where: string; inlines: Inline[] }[] {
  const out: { where: string; inlines: Inline[] }[] = [];
  if (model.answer.headline) out.push({ where: "headline", inlines: model.answer.headline });
  if (model.answer.thesis) out.push({ where: "thesis", inlines: model.answer.thesis });
  for (const p of model.priors.items) if (p.measured) out.push({ where: `prior ${p.id}`, inlines: p.measured });
  for (const f of model.evidence.figures) out.push({ where: `figure ${f.number}`, inlines: f.caption });
  for (const a of model.evidence.arguments) {
    out.push({ where: `${a.id} fact`, inlines: a.qlooFact });
    out.push({ where: `${a.id} read`, inlines: a.ourRead });
  }
  for (const c of model.risks.changes) out.push({ where: `change ${c.n}`, inlines: c.condition });
  return out;
}

/** Footnote numbers in the order a reader meets them, first appearance only. */
export function readingOrder(model: BriefModel): number[] {
  const seen: number[] = [];
  const meet = (n: number | null | undefined) => {
    if (n !== null && n !== undefined && !seen.includes(n)) seen.push(n);
  };
  const walk = (inlines: readonly Inline[] | null) => {
    for (const piece of inlines ?? []) if (piece.kind === "metric" || piece.kind === "cite") meet(piece.footnote);
  };
  walk(model.answer.headline);
  walk(model.answer.thesis);
  for (const p of model.priors.items) walk(p.measured);
  for (const k of model.evidence.keyFigures) meet(k.footnote);
  for (const f of model.evidence.figures) {
    walk(f.caption);
    meet(f.footnote);
    for (const n of f.location?.fallbackNotes ?? []) meet(n);
  }
  for (const a of model.evidence.arguments) {
    walk(a.qlooFact);
    walk(a.ourRead);
  }
  for (const c of model.risks.changes) {
    walk(c.condition);
    meet(c.now?.footnote);
  }
  return seen;
}

export const textOf = (inlines: readonly Inline[] | null) => inlineText(inlines);
