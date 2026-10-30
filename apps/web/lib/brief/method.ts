import type { IntentReadAs, RunState, ToolCallState } from "@ct/contracts";
import { AGE_BUCKET_LABEL, METRO_LABEL } from "@ct/contracts/values";
import { DESK_LABEL, filterLabel, JOB_LABEL, MATCH_LABEL, plural, TOOL_LABEL } from "./format";
import { cacheLabel, refText, refsForCalls, shortReference, type Ledger } from "./ledger";
import { stoppedEarly, uncheckedDigest } from "./live";
import type {
  BriefMethod,
  BriefSource,
  BriefSources,
  CheckerLine,
  Interpretation,
  ReadAs,
  MethodCall,
  MethodFallback,
  MethodPivot,
  MethodStep,
  StepStatus,
} from "./types";

/**
 * Mechanics last: how the brief was made (CLERK's reading, the plan steps joined with the tool calls
 * that ran them, ANALYST PIVOT and CODE FALLBACK lines, the CHECKER line) and every lookup: Qloo
 * requests and, from Part 9, SEC EDGAR and US Census requests.
 */

/** A call still running when the run ended stopped with it (run.end leaves tool calls as they were). */
function call(t: ToolCallState, ended: boolean): MethodCall {
  return {
    toolCallId: t.toolCallId,
    status: t.status === "running" && ended ? "stopped" : t.status,
    ms: t.ms,
    requests: t.qlooCallIds.length,
    estimate: t.estimatedCalls,
    error: t.error ? t.error.message : null,
  };
}

/**
 * A step's status: running while any call runs, else the last call's outcome; planned before any
 * call. Once the run has ended, a step never called is not_run and one still running is stopped.
 */
function stepStatus(calls: readonly ToolCallState[], ended: boolean): StepStatus {
  if (calls.length === 0) return ended ? "not_run" : "planned";
  if (calls.some((c) => c.status === "running")) return ended ? "stopped" : "running";
  return (calls.at(-1) as ToolCallState).status as StepStatus;
}

const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);

function estimateOf(calls: readonly ToolCallState[]): number | null {
  const known = calls.flatMap((c) => (c.estimatedCalls === null ? [] : [c.estimatedCalls]));
  return known.length > 0 ? sum(known) : null;
}

/** Opening scan first, then the plan in its order, then follow-ups and unplanned calls in start order. */
export function methodSteps(state: RunState): MethodStep[] {
  const steps: Omit<MethodStep, "n">[] = [];
  const used = new Set<string>();
  const estimates = new Map((state.plan?.estimates ?? []).map((e) => [e.stepId, e.calls]));
  const ended = state.ended !== null;
  const row = (origin: MethodStep["origin"], calls: ToolCallState[], extra: Partial<MethodStep> & Pick<MethodStep, "tool">) => {
    for (const c of calls) used.add(c.toolCallId);
    const first = calls[0];
    steps.push({
      stepId: null,
      origin,
      toolLabel: TOOL_LABEL[extra.tool],
      purpose: null,
      phase: first?.phase ?? null,
      estimate: estimateOf(calls),
      actual: sum(calls.map((c) => c.qlooCallIds.length)),
      publicActual: sum(calls.map((c) => c.publicCallIds?.length ?? 0)),
      status: stepStatus(calls, ended),
      calls: calls.map((c) => call(c, ended)),
      pivot: calls.some((c) => c.pivot),
      triggerFindingId: first?.triggerFindingId ?? null,
      ...extra,
    });
  };

  for (const t of state.toolCalls) if (t.phase === "scan") row("scan", [t], { tool: t.tool });
  for (const step of state.plan?.plan.steps ?? []) {
    const calls = state.toolCalls.filter((t) => !used.has(t.toolCallId) && t.stepId === step.id);
    row("plan", calls, {
      tool: step.tool,
      stepId: step.id as MethodStep["stepId"],
      purpose: step.purpose,
      estimate: estimates.get(step.id as NonNullable<MethodStep["stepId"]>) ?? estimateOf(calls),
    });
  }
  for (const t of state.toolCalls) {
    if (used.has(t.toolCallId)) continue;
    const finding = t.triggerFindingId ? state.findings.find((f) => f.id === t.triggerFindingId) : undefined;
    row("followup", [t], { tool: t.tool, purpose: finding ? `Follow-up on ${finding.id}: ${finding.text}` : null });
  }
  return steps.map((s, i) => ({ ...s, n: i + 1 }));
}

export function methodPivots(state: RunState): MethodPivot[] {
  return state.pivots.map((p) => {
    const finding = state.findings.find((f) => f.id === p.triggerFindingId) ?? null;
    return {
      toolCallId: p.toolCallId,
      tool: p.tool,
      toolLabel: TOOL_LABEL[p.tool],
      triggerFindingId: p.triggerFindingId,
      finding: finding?.text ?? null,
      line: `ANALYST PIVOT · ${p.triggerFindingId} → ${TOOL_LABEL[p.tool]}${finding ? `: ${finding.text}` : ""}`,
    };
  });
}

export function methodFallbacks(state: RunState): MethodFallback[] {
  return state.fallbacks.map((f) => ({
    from: f.from,
    to: f.to,
    reason: f.reason,
    toolCallId: f.toolCallId,
    line: `CODE FALLBACK · ${f.from} → ${f.to}: ${f.reason}`,
  }));
}

/** "sales", "sales and prices", "sales, prices and rents". */
function listText(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/**
 * D41: a question read as the nearest job, as the chip and the plain sentence at the top of the answer
 * (ANSWER_QUALITY §8). Null when the job fits the question as asked.
 */
export function readAsOf(intent: NonNullable<RunState["intent"]>): ReadAs | null {
  // Optional for intents built before Part 9 that bypassed StoredIntent.
  const readAs = intent.read_as as IntentReadAs | undefined;
  if (!readAs?.nearest) return null;
  const jobLabel = JOB_LABEL[intent.job];
  const notCovered = [...new Set(readAs.not_covered.map((s) => s.trim()).filter((s) => s !== ""))];
  const line =
    notCovered.length > 0
      ? `Read as ${jobLabel}, the closest question Culture Terminal answers. Not covered: ${listText(notCovered)}; there is no data on ${notCovered.length === 1 ? "it" : "them"} here.`
      : `Read as ${jobLabel}, the closest question Culture Terminal answers. Part of the question is not covered.`;
  return { jobLabel, notCovered, chip: `Read as: ${jobLabel}`, line };
}

/** CLERK's reading of the question: what the A02 "Understood as" row shows. */
export function interpretation(state: RunState): Interpretation | null {
  const intent = state.intent;
  if (!intent) return null;
  const { geo, constraints } = intent;
  const scope = [
    geo.metro ? METRO_LABEL[geo.metro] : geo.unsupported_place,
    geo.area,
    constraints.ages.length > 0 ? `ages ${constraints.ages.map((a) => AGE_BUCKET_LABEL[a]).join(", ")}` : null,
    constraints.domains.length > 0 ? constraints.domains.join(", ").replace(/_/g, " ") : null,
    constraints.concepts.length > 0 ? constraints.concepts.join(", ") : null,
    constraints.sponsor_categories.length > 0 ? constraints.sponsor_categories.join(", ").replace(/_/g, " ") : null,
  ].filter((s): s is string => s !== null && s !== "");
  const gate = state.resolves.filter((r) => r.source === "gate");
  const exact = gate.filter((r) => r.match === "exact").length;
  const names =
    gate.length === 0
      ? null
      : exact === gate.length
        ? gate.length === 1
          ? "the name matched exactly"
          : gate.length === 2
            ? "both names matched exactly"
            : `all ${gate.length} names matched exactly`
        : `${exact} of ${gate.length} names matched exactly`;
  return {
    deskLabel: DESK_LABEL[intent.pillar],
    jobLabel: JOB_LABEL[intent.job],
    mnemonic: intent.mnemonic,
    subjects: intent.mentions.map((m) => m.text),
    scope: scope.length > 0 ? scope.join(" · ") : null,
    area: geo.area !== null && geo.area.trim() !== "" ? geo.area.trim() : null,
    detail: [`${DESK_LABEL[intent.pillar]} lens`, names].filter(Boolean).join(" · "),
    assumptions: intent.assumptions,
    reframe: intent.safety.reframe,
    readAs: readAsOf(intent),
    resolves: state.resolves.map((r) => ({
      mention: r.mention,
      entityType: r.entityType,
      match: r.match,
      matchLabel: MATCH_LABEL[r.match],
      name: r.name,
      applied: r.match === "exact",
    })),
    ms: state.clerkMs,
  };
}

/**
 * "27/27 numbers traced · 0 advice terms" once checked; the state of the check otherwise. An evidence
 * digest is "skipped" (no CHECKER read it), and a run that ended before the check is "stopped".
 */
export function checkerLine(state: RunState): CheckerLine {
  const v = state.validation;
  const warnings = state.report?.warnings.length ?? v?.issues.filter((i) => i.action === "warn").length ?? 0;
  if (uncheckedDigest(state)) {
    return { state: "skipped", traced: null, total: null, adviceTerms: null, attempt: v?.attempt ?? null, warnings, line: null };
  }
  const traced = state.report?.receipt.numbersTraced ?? v?.numbersTraced ?? null;
  const current = v !== null && (state.draftAttempt === null || v.attempt >= state.draftAttempt);
  const status: CheckerLine["state"] =
    state.report !== null || (current && v?.ok)
      ? "passed"
      : current && v && !v.ok
        ? "rejected"
        : stoppedEarly(state)
          ? "stopped"
          : state.draft !== null
            ? "checking"
            : "queued";
  const advice = v?.adviceTerms ?? null;
  return {
    state: status,
    traced: traced?.traced ?? null,
    total: traced?.total ?? null,
    adviceTerms: advice,
    attempt: v?.attempt ?? null,
    warnings,
    line:
      traced && (status === "passed" || status === "rejected")
        ? `${traced.traced}/${traced.total} numbers traced · ${advice ?? 0} advice ${advice === 1 ? "term" : "terms"}`
        : null,
  };
}

/** "$0.012" under a dollar (a fraction of a cent reads "under $0.01"), "$1.20" above. */
function usdText(usd: number): string {
  if (usd <= 0) return "$0";
  if (usd < 0.01) return "under $0.01";
  return `$${usd < 1 ? usd.toFixed(3).replace(/0$/, "") : usd.toFixed(2)}`;
}

/**
 * The receipt's context line (R4, R5): "Context: AI $0.012 · web $0.041 (3 searches)", from the report's
 * receipt; null when the run had no side calls (runs stored before Part 11, or both turned off).
 */
export function contextReceiptLine(state: Pick<RunState, "report">): string | null {
  const c = state.report?.receipt.context;
  if (!c) return null;
  return `Context: AI ${usdText(c.aiUsd)} · web ${usdText(c.webUsd)} (${plural(c.webSearches, "search", "searches")})`;
}

export function buildMethod(state: RunState): BriefMethod {
  const steps = methodSteps(state);
  const publicCalls = state.publicCalls ?? { network: 0, cached: 0, reused: 0, chips: [] };
  const total = state.qloo.chips.length + publicCalls.chips.length;
  const cached = state.qloo.cached + state.qloo.reused + publicCalls.cached + publicCalls.reused;
  return {
    line: `${plural(steps.length, "step")} · ${plural(total, "request")}, ${cached} cached · computed in code, then traced`,
    steps,
    pivots: methodPivots(state),
    fallbacks: methodFallbacks(state),
    interpretation: interpretation(state),
    checker: checkerLine(state),
    models: {
      clerk: state.report?.receipt.models.clerk ?? null,
      analyst: state.report?.receipt.models.analyst ?? state.model,
    },
    context: contextReceiptLine(state),
    requests: {
      total,
      network: state.qloo.network + publicCalls.network,
      cached: state.qloo.cached + publicCalls.cached,
      reused: state.qloo.reused + publicCalls.reused,
    },
  };
}

/**
 * Every lookup in arrival order, Qloo and public (SEC EDGAR, US Census); `footnotes` is filled in once
 * the footnotes are numbered. A public lookup's `requestId` is its reference (a CIK, or the Census
 * dataset, vintage and geography).
 */
export function buildSources(ledger: Ledger): BriefSources {
  const { state } = ledger;
  const items: BriefSource[] = ledger.calls.map((call, i) => {
    const tool = call.toolCallId ? (ledger.toolCalls.get(call.toolCallId) ?? null) : null;
    return {
      n: i + 1,
      qlooCallId: call.id,
      source: call.source,
      host: call.host,
      toolCallId: call.toolCallId,
      tool: tool?.tool ?? null,
      endpoint: call.endpoint,
      filterType: call.filterType,
      filterLabel: filterLabel(call.filterType),
      refs: refsForCalls(ledger, [call.id]).map((r) => refText(ledger, r)),
      params: Object.entries(call.paramsRedacted),
      rows: call.rows,
      ms: call.ms,
      status: call.status,
      error: call.error,
      cache: call.cache,
      cacheAgeMs: call.cacheAgeMs,
      cacheLabel: cacheLabel(call.cache, call.cacheAgeMs, call.ts, call.originRunId),
      originRunId: call.originRunId,
      requestId: call.requestId,
      shortRequestId: shortReference(call.source, call.requestId),
      at: call.ts,
      evidenceIds: ledger.evidenceByCall.get(call.id) ?? [],
      footnotes: [],
    };
  });
  const endpoints = new Map<string, BriefSources["endpoints"][number]>();
  for (const call of ledger.calls) {
    const key = `${call.endpoint} ${call.filterType ?? ""}`;
    const e = endpoints.get(key) ?? { path: call.endpoint, filterType: call.filterType, filterLabel: filterLabel(call.filterType), calls: 0 };
    e.calls += 1;
    endpoints.set(key, e);
  }
  const publicCalls = state.publicCalls ?? { cached: 0, reused: 0 };
  const cached = state.qloo.cached + state.qloo.reused + publicCalls.cached + publicCalls.reused;
  return {
    line: `${plural(items.length, "request")} · ${cached} cached · ${plural(new Set(ledger.calls.map((c) => c.endpoint)).size, "endpoint")}`,
    items,
    endpoints: [...endpoints.values()],
  };
}
