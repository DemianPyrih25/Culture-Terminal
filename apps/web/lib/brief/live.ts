import { isPublicDataTool, tokenizeProse, type Phase, type RunState, type ToolCallState } from "@ct/contracts";
import { filterLabel, formatClock, formatUsd, formatUtcDateTime, formatUtcTime, plural, TOOL_DATA_LABEL } from "./format";
import { lastTs, refText, refsForCalls, refsIn, requestRef, sourceName, type Ledger, type LedgerCall } from "./ledger";
import type { BriefLive, IncomingRequest, Meter, StageRole, StageState, StageView, TraceNote } from "./types";

/**
 * The live parts of a brief being written (A03): the stage strip, the progress line, the budget
 * meters, incoming requests and the numbers-traced note. All of it is derived from the run's events;
 * `now` only drives the clocks.
 */

const STAGE_LABEL: Readonly<Record<StageRole, string>> = {
  clerk: "Clerk",
  analyst: "Analyst",
  quant: "Quant",
  checker: "Checker",
};

function stage(role: StageRole, state: StageState, word: string): StageView {
  const shown = state === "done" ? "✓" : word;
  return { role, label: STAGE_LABEL[role], state, word: shown, text: `${STAGE_LABEL[role]} ${shown}` };
}

/** An event of this type has been applied. */
export const happened = (state: RunState, type: RunState["timeline"][number]["type"]) => state.timeline.some((t) => t.type === type);

/** The latest draft has a CHECKER verdict. */
export function checkedDraft(state: RunState): RunState["validation"] {
  const v = state.validation;
  if (v === null || state.draftAttempt === null) return v;
  return v.attempt >= state.draftAttempt ? v : null;
}

/**
 * Clerk ✓ · Analyst writing · Quant computing · Checker queued. Each role moves queued → active → done
 * as its events arrive; Quant idles between tools and the Analyst while the Checker reads its draft.
 * A run that ends early marks what had started as stopped.
 */
export function stageStrip(state: RunState): StageView[] {
  const ended = state.ended !== null;
  const final = state.report !== null;
  const refused = state.status === "refused" || state.intent?.safety.allowed === false;
  const running = state.toolCalls.some((t) => t.status === "running");
  const toolsEnded = state.toolCalls.some((t) => t.status !== "running");
  const checked = checkedDraft(state);

  let clerk: StageView;
  if (state.intent) clerk = refused ? stage("clerk", "failed", "refused") : stage("clerk", "done", "");
  else if (state.lastSeq > 0) clerk = ended ? stage("clerk", "failed", "stopped") : stage("clerk", "active", "reading");
  else clerk = stage("clerk", "queued", "queued");

  let analyst: StageView;
  if (final || checked?.ok) analyst = stage("analyst", "done", "");
  else if (state.draft !== null && checked && !checked.ok) analyst = stage("analyst", "active", "repairing");
  else if (state.draft !== null) analyst = stage("analyst", "idle", "drafted");
  else if (state.plan !== null) analyst = stage("analyst", "active", "writing");
  else if (state.intent && !refused && state.needsInput === null && (happened(state, "resolve") || state.toolCalls.length > 0)) {
    analyst = stage("analyst", "active", "planning");
  } else analyst = stage("analyst", "queued", "queued");

  let quant: StageView;
  if (running) quant = stage("quant", "active", "computing");
  else if (final || (state.draft !== null && toolsEnded)) quant = stage("quant", "done", "");
  else if (toolsEnded) quant = stage("quant", "idle", "waiting");
  else quant = stage("quant", "queued", "queued");

  let checker: StageView;
  if (final || checked?.ok) checker = stage("checker", "done", "");
  else if (state.draft !== null && checked && !checked.ok) checker = stage("checker", "idle", "sent back");
  else if (state.draft !== null) checker = stage("checker", "active", "checking");
  else checker = stage("checker", "queued", "queued");

  if (!ended || final) return [clerk, analyst, quant, checker];
  // The run stopped without a brief: anything still going stopped with it.
  const stop = (s: StageView): StageView =>
    s.state === "active" || s.state === "idle" ? stage(s.role, "failed", "stopped") : s.state === "queued" ? stage(s.role, "queued", "not run") : s;
  return [stop(clerk), stop(analyst), stop(quant), stop(checker)];
}

/**
 * A tool's band on the progress bar: the opening scan, the ANALYST's first wave, or its follow-ups.
 * A PIVOT is announced before its tool.start, and is always a follow-up.
 */
const phaseOf = (state: RunState, t: ToolCallState): Phase => t.phase ?? (t.pivot ? "followup" : state.plan === null ? "scan" : "wave1");

/**
 * The ANALYST's follow-up turn (late planned steps included) has ended and nothing runs: the next
 * response can only be submit_report (turn 3), so no more Qloo calls will come. After wave 1 the
 * ANALYST may still ask for follow-ups, so that wait still counts as gathering.
 */
export function followUpsDone(state: RunState): boolean {
  if (state.toolCalls.some((t) => t.status === "running")) return false;
  return state.toolCalls.some((t) => phaseOf(state, t) === "followup");
}

/** A tool call's lookups that arrived: its Qloo calls and its SEC or Census calls (Part 9). */
function callIdsOf(t: ToolCallState): string[] {
  return [...t.qlooCallIds, ...(t.publicCallIds ?? [])];
}

/** Every lookup that arrived, Qloo and public. */
function lookupCount(state: RunState): number {
  return state.qloo.chips.length + (state.publicCalls?.chips.length ?? 0);
}

/**
 * Lookups (Qloo, SEC, Census) that arrived, and the ones the run still expects: the progress line's "7 of ~12 sources".
 * A plan step expects its estimate until its tools end, then what they made; a running tool its own
 * estimate. There is no estimate before the plan (it would only echo the calls seen) or once no more
 * calls can come.
 */
export function sourceCounts(state: RunState): { received: number; expected: number | null } {
  const received = lookupCount(state);
  if (state.plan === null || state.draft !== null || followUpsDone(state)) return { received, expected: null };
  const steps = new Map(state.plan.estimates.map((e) => [e.stepId, { estimate: e.calls, calls: 0, started: false, running: false }]));
  let expected = state.qloo.chips.filter((c) => c.toolCallId === null).length + (state.publicCalls?.chips ?? []).filter((c) => c.toolCallId === null).length;
  for (const t of state.toolCalls) {
    const running = t.status === "running";
    const arrived = callIdsOf(t).length;
    const calls = running ? Math.max(t.estimatedCalls ?? 0, arrived) : arrived;
    const step = t.stepId === null ? undefined : steps.get(t.stepId);
    if (step === undefined) expected += calls;
    else Object.assign(step, { calls: step.calls + calls, started: true, running: step.running || running });
  }
  for (const s of steps.values()) expected += s.started && !s.running ? s.calls : Math.max(s.estimate, s.calls);
  return { received, expected: Math.max(expected, received) };
}

/** The progress line's words for where the run is. */
export function progressLabel(state: RunState): string {
  if (state.report !== null) return "Brief ready";
  if (state.ended !== null) return "Stopped";
  if (state.intent === null) return "Reading the question";
  if (state.needsInput !== null) return "Waiting for a pick";
  if (!happened(state, "resolve") && state.toolCalls.length === 0) return "Matching names";
  const checked = checkedDraft(state);
  if (checked?.ok) return "Assembling the brief";
  if (state.draft !== null) return checked ? "Repairing the draft" : "Checking every number";
  if (state.toolCalls.some((t) => t.status === "running")) return "Gathering evidence";
  if (state.plan === null) return "Writing priors";
  return followUpsDone(state) ? "Writing the answer" : "Gathering evidence";
}

/** Where each stage sits on the progress bar. The tool bands fill as their calls arrive. */
const BAR_READ = 0.05;
const BAR_BAND: Readonly<Record<Phase, readonly [number, number]>> = { scan: [0.1, 0.25], wave1: [0.3, 0.55], followup: [0.55, 0.75] };
const BAR_DRAFTED = 0.85;
const BAR_CHECKED = 0.95;

/**
 * How far one band's tools are through their calls, 0–1. Each tool counts the calls that arrived
 * against its estimate (one more than it has while it runs without one) and is whole once it ends.
 * A tool that starts late adds to the total, so the band keeps the highest value it reached at any
 * of its events: it never moves back.
 */
function bandFill(ledger: Ledger, tools: readonly ToolCallState[]): number {
  const seqOf = (id: string) => ledger.callById.get(id)?.seq ?? Number.POSITIVE_INFINITY;
  const fillAt = (seq: number) => {
    let done = 0;
    let total = 0;
    for (const t of tools) {
      if (t.startedSeq !== null && t.startedSeq > seq) continue;
      const calls = callIdsOf(t).filter((id) => seqOf(id) <= seq).length;
      const expected = Math.max(t.estimatedCalls ?? calls + 1, calls, 1);
      total += expected;
      done += t.endedSeq !== null && t.endedSeq <= seq ? expected : calls;
    }
    return total === 0 ? 0 : done / total;
  };
  const seqs = new Set([ledger.state.lastSeq]);
  for (const t of tools) for (const seq of [t.startedSeq, t.endedSeq, ...callIdsOf(t).map(seqOf)]) if (seq !== null && Number.isFinite(seq)) seqs.add(seq);
  let best = 0;
  for (const seq of seqs) best = Math.max(best, fillAt(seq));
  return best;
}

/**
 * The progress bar, 0–1, by stage: the question read, the opening scan, the plan, the ANALYST's
 * waves, the draft, the CHECKER's pass, the brief. Only events move it, and only forward.
 */
export function progressFraction(ledger: Ledger): number {
  const { state } = ledger;
  if (state.report !== null) return 1;
  if (checkedDraft(state)?.ok) return BAR_CHECKED;
  if (state.draft !== null) return BAR_DRAFTED;
  const band = (phase: Phase): number | null => {
    const tools = state.toolCalls.filter((t) => phaseOf(state, t) === phase);
    if (tools.length === 0) return null;
    const [from, to] = BAR_BAND[phase];
    return from + (to - from) * bandFill(ledger, tools);
  };
  const reached = band("followup") ?? band("wave1") ?? (state.plan !== null ? BAR_BAND.wave1[0] : band("scan"));
  if (reached !== null) return reached;
  if (happened(state, "resolve")) return BAR_BAND.scan[0];
  return state.intent !== null ? BAR_READ : 0;
}

/** Run time so far: the recorded elapsed time once ended, else the wall clock since the first event. */
export function elapsedMs(state: RunState, now: number): number {
  if (state.ended) return state.ended.elapsedMs;
  if (state.createdAt === null) return 0;
  return Math.max(0, now - Date.parse(state.createdAt));
}

function meter(label: string, used: number, limit: number | null, text: string, warnAt: number | null): Meter {
  const fraction = limit && limit > 0 ? Math.min(1, Math.max(0, used / limit)) : 0;
  return { label, used, limit, text, fraction, warn: warnAt !== null && used >= warnAt };
}

/** Requests n/limit (network calls against the run cap), model cost against its cap, time against the hard stop. */
export function meters(state: RunState, now: number): BriefLive["meters"] {
  const limits = state.limits;
  const network = state.qloo.network;
  const usd = state.usage?.llmUsd ?? 0;
  const elapsed = elapsedMs(state, now);
  const hardS = limits ? Math.round(limits.hardMs / 1000) : null;
  return {
    requests: meter("Requests", network, limits?.qlooCalls ?? null, limits ? `${network} / ${limits.qlooCalls}` : String(network), limits?.qlooWarnAt ?? null),
    cost: meter("Model cost", usd, limits?.usdHard ?? null, limits ? `${formatUsd(usd)} / ${formatUsd(limits.usdHard)}` : formatUsd(usd), limits?.usdNudge ?? null),
    time: meter("Time", elapsed / 1000, hardS, hardS !== null ? `${formatClock(elapsed)} / ${hardS} s` : formatClock(elapsed), limits ? limits.softMs / 1000 : null),
  };
}

function tsOfSeq(state: RunState, seq: number | null): string | null {
  if (seq === null) return null;
  return state.timeline.find((t) => t.seq === seq)?.ts ?? null;
}

const MAX_INCOMING = 6;

/** "Qloo /v2/insights · brand ← R1 Juniper Cola", "SEC EDGAR /api/xbrl/companyfacts ← R1 Juniper Cola". */
function chipText(ledger: Ledger, chip: LedgerCall, word: string): string {
  const refs = refsForCalls(ledger, [chip.id]).slice(0, 2).map((r) => refText(ledger, r));
  const what = [filterLabel(chip.filterType), refs.length > 0 ? `← ${refs.join(", ")}` : null].filter(Boolean).join(" ");
  return [`${sourceName(chip.source)} ${chip.endpoint}`, what || null, word].filter(Boolean).join(" · ");
}

function chipTrace(ledger: Ledger, chip: LedgerCall): string {
  const ref = requestRef(ledger, chip.id);
  const parts = [`${chip.source === "qloo" ? "req" : "ref"} ${ref.shortRequestId}`];
  if (chip.rows !== null) parts.push(plural(chip.rows, "row"));
  parts.push(chip.cache === "miss" ? `${Math.round(chip.ms)} ms` : ref.cacheLabel);
  return parts.join(" · ");
}

/**
 * The margin's incoming requests: for each running tool, the one in flight (fetching, with its
 * timer), the rest of its estimate (queued) and its latest calls; then the latest calls of finished
 * tools. A call that arrived is complete, so it reads received wherever it sits (its stamp flashes as
 * it lands). Newest activity first.
 */
export function incomingRequests(ledger: Ledger, now: number): IncomingRequest[] {
  const { state } = ledger;
  const rows: IncomingRequest[] = [];
  const estimates = new Map((state.plan?.estimates ?? []).map((e) => [e.stepId, e.calls]));
  const running = state.toolCalls.filter((t) => t.status === "running");
  const byTool = (t: ToolCallState) => callIdsOf(t).flatMap((id) => ledger.callById.get(id) ?? []).sort((a, b) => a.seq - b.seq);

  for (const tool of [...running].reverse()) {
    const arrived = byTool(tool);
    const expected = tool.estimatedCalls ?? (tool.stepId ? estimates.get(tool.stepId) ?? null : null);
    const pending = expected === null ? 1 : Math.max(0, expected - arrived.length);
    const last = arrived.at(-1);
    if (pending > 0) {
      const since = last?.ts ?? tsOfSeq(state, tool.startedSeq);
      const waited = since ? Math.max(0, now - Date.parse(since)) : 0;
      const subjects = refsIn(tool.args).slice(0, 2).map((r) => refText(ledger, r));
      const what = [TOOL_DATA_LABEL[tool.tool], subjects.length > 0 ? `← ${subjects.join(", ")}` : null].filter(Boolean).join(" ");
      rows.push({
        key: `${tool.toolCallId}:fetching`,
        state: "fetching",
        toolCallId: tool.toolCallId,
        tool: tool.tool,
        text: [last ? `${sourceName(last.source)} ${last.endpoint}` : isPublicDataTool(tool.tool) ? "Public data" : "Qloo", what, "fetching"].join(" · "),
        trace: `fetching · ${formatClock(waited)}`,
        count: 1,
        sourceIndex: null,
      });
    }
    if (pending > 1) {
      rows.push({
        key: `${tool.toolCallId}:queued`,
        state: "queued",
        toolCallId: tool.toolCallId,
        tool: tool.tool,
        text: `${isPublicDataTool(tool.tool) ? "Public data" : "Qloo"} · ${TOOL_DATA_LABEL[tool.tool]} · queued`,
        trace: `${pending - 1} more queued`,
        count: pending - 1,
        sourceIndex: null,
      });
    }
    for (const chip of arrived.slice(-2).reverse()) {
      rows.push({
        key: chip.id,
        state: "received",
        toolCallId: tool.toolCallId,
        tool: tool.tool,
        text: chipText(ledger, chip, ""),
        trace: chipTrace(ledger, chip),
        count: 1,
        sourceIndex: chip.index,
      });
    }
  }

  const runningIds = new Set(running.map((t) => t.toolCallId));
  const done = ledger.calls.filter((chip) => chip.toolCallId === null || !runningIds.has(chip.toolCallId));
  for (const chip of done.slice(-3).reverse()) {
    if (rows.length >= MAX_INCOMING) break;
    const tool = chip.toolCallId ? ledger.toolCalls.get(chip.toolCallId) ?? null : null;
    rows.push({
      key: chip.id,
      state: "received",
      toolCallId: chip.toolCallId,
      tool: tool?.tool ?? null,
      text: chipText(ledger, chip, ""),
      trace: chipTrace(ledger, chip),
      count: 1,
      sourceIndex: chip.index,
    });
  }
  return rows.slice(0, MAX_INCOMING);
}

/**
 * An evidence digest (report.incomplete): the ANALYST never submitted, so no CHECKER read its prose
 * and its 0/0 numbers traced is not a pass. A report with nothing traced and no CHECKER verdict is
 * read the same way.
 */
export function uncheckedDigest(state: RunState): boolean {
  const report = state.report;
  return report !== null && (report.incomplete || (report.receipt.numbersTraced.total === 0 && state.validation === null));
}

/** The run ended with no report: whatever was still to come never will. */
export const stoppedEarly = (state: RunState): boolean => state.ended !== null && state.report === null;

/**
 * The numbers the latest draft cites as the CHECKER counts them: every {{M#}} occurrence in its
 * prose, except a metric that arrived without a value. The CHECKER also counts any bare number it
 * finds, so the count is an estimate; 0 before the draft, when nothing says which numbers the prose
 * will cite.
 */
export function draftNumbers(state: RunState): number {
  const d = state.draft;
  if (d === null) return 0;
  const texts = [
    d.headline,
    d.thesis,
    ...d.hypothesis_verdicts.map((v) => v.note),
    ...d.arguments.flatMap((a) => [a.qloo_fact, a.our_read]),
    ...d.exhibits.flatMap((e) => [e.title, e.caption]),
    ...d.bear_case.map((b) => b.text),
    ...d.recommendations.map((r) => r.action),
    ...d.next_moves.flatMap((m) => [m.label, m.question]),
    ...d.open_questions,
  ];
  let n = 0;
  for (const text of texts) for (const s of tokenizeProse(text)) if (s.kind === "metric" && state.metrics[s.id]?.value !== null) n += 1;
  return n;
}

/**
 * "27/27 numbers traced · Checker · 0 advice terms · <date>", "0 of ~27 numbers traced · Checker
 * running · 7 sources in, 2 cited" once a draft says which numbers it cites, or "Numbers traced after
 * the check · Checker queued · …" before. `citedSources` counts the lookups the footnotes cite.
 */
export function traceNote(state: RunState, citedSources: number): TraceNote {
  if (uncheckedDigest(state)) {
    return { state: "skipped", headline: "Not checked", detail: "The analysis did not finish; there is no prose to trace" };
  }
  const checked = checkedDraft(state);
  const v = state.report ? (state.validation ?? null) : checked;
  const traced = state.report?.receipt.numbersTraced ?? v?.numbersTraced ?? null;
  const at = lastTs(state, "validation") ?? lastTs(state, "report.final");
  if (traced && (state.report !== null || v?.ok)) {
    const advice = v?.adviceTerms ?? 0;
    return {
      state: "passed",
      headline: `${traced.traced}/${traced.total} numbers traced`,
      detail: [`Checker · ${advice} advice ${advice === 1 ? "term" : "terms"}`, at ? formatUtcDateTime(at) : null].filter(Boolean).join(" · "),
    };
  }
  if (v && !v.ok) {
    return {
      state: "rejected",
      headline: `${v.numbersTraced.traced}/${v.numbersTraced.total} numbers traced`,
      detail: `Checker sent draft ${v.attempt} back · ${v.issues.length} ${v.issues.length === 1 ? "issue" : "issues"}`,
    };
  }
  if (stoppedEarly(state)) return { state: "stopped", headline: "Not checked", detail: "Checker did not run" };
  const numbers = draftNumbers(state);
  const headline = numbers > 0 ? `0 of ~${numbers} numbers traced` : "Numbers traced after the check";
  const sources = `${plural(lookupCount(state), "source")} in, ${citedSources} cited`;
  if (state.draft !== null) return { state: "checking", headline, detail: `Checker running · ${sources}` };
  return { state: "pending", headline, detail: `Checker queued · ${sources}` };
}

/** The live block, or null once the run has ended. */
export function buildLive(ledger: Ledger, now: number): BriefLive | null {
  const { state } = ledger;
  if (state.ended !== null) return null;
  const { received, expected } = sourceCounts(state);
  const elapsed = elapsedMs(state, now);
  const fraction = progressFraction(ledger);
  return {
    stages: stageStrip(state),
    progress: {
      label: progressLabel(state),
      sourcesIn: received,
      sourcesExpected: expected,
      count: expected !== null ? `· ${received} of ~${expected} sources` : `· ${received} ${received === 1 ? "source" : "sources"}`,
      elapsedMs: elapsed,
      clock: formatClock(elapsed),
      fraction,
    },
    meters: meters(state, now),
    incoming: incomingRequests(ledger, now),
    since: state.createdAt ? `Being written · since ${formatUtcTime(state.createdAt)}` : null,
    cancellable: state.status === "queued" || state.status === "running",
  };
}
