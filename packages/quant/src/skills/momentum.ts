import {
  ANALYST_TOOLS,
  entityTypeUrn,
  TrendingType,
  type CacheProbe,
  type Comparator,
  type DatasetId,
  type DigestRow,
  type EntityRegistry,
  type EntityType,
  type EvidenceId,
  type Finding,
  type Flag,
  type Metric,
  type MetricUnit,
  type MomentumSeries,
  type MomentumTrend,
  type NoValueReason,
  type QlooCallMeta,
  type QlooParams,
  type QlooTrendingResponse,
  type RegisteredEntity,
  type SkillCtx,
  type SkillFor,
  type SkillResult,
  type SkillStatus,
  type ToolInput,
  type TrendWindow,
} from "@ct/contracts";
import { freshness, metricConfidence, windowAgeMonths } from "../badges";
import { noTrendSignalFinding } from "../findings";
import type { FormulaId } from "../formulas";
import { SKILL_LIMITATIONS } from "../limitations";
import { addSkillEvidence, attemptAllKeepingFailures, countUncached, type Attempt } from "./common";
import { skillErrorResult, skillResult, type DigestTarget } from "./digest";
import { displayRanks, fixed2, rankText, safeFullName, safeName } from "./format";
import { analyseSeries, LABEL_MAX_P, TRENDING_WINDOW, type NoSignalCause, type SeriesAnalysis } from "./momentum/series";

/**
 * S4 momentum (SPEC §5.3 S4, probe G11): one /v2/trending call per brand or TV show over the frozen
 * historical window, ISO-week medians of the step-shaped series, the flatline and scale-break
 * guards, then Theil–Sen Δpct_26w, Mann–Kendall τ and p and a label. Every number is STALE with its
 * window (D19); NO SIGNAL is never Flat; artists and persons have no trending data and are
 * UNAVAILABLE without a call.
 */

type MomentumInput = ToolInput<"momentum">;

export { TRENDING_WINDOW } from "./momentum/series";
export const TRENDING_TAKE = 50;
const TRENDING_TYPES: ReadonlySet<EntityType> = new Set(TrendingType.options);
/** Client errors that are bugs in the request, not a gap to report: they always propagate. */
const CALLER_BUGS: ReadonlySet<string> = new Set(["qloo_param", "qloo_no_signal"]);

export const MOM_FORMULA_IDS: readonly FormulaId[] = ["mom.delta_26w", "mom.mann_kendall", "mom.label", "mom.freshness"];

/** "2025-04-01..2025-09-30", the window format of the limitations and the data disclaimer. */
export function windowText(window: TrendWindow = TRENDING_WINDOW): string {
  return `${window.start}..${window.end}`;
}

export function isTrendable(type: EntityType): boolean {
  return TRENDING_TYPES.has(type);
}

/** The trending request for one entity: its own type, the frozen window (pinned in the cache, D25), take 50. */
export function trendingParams(entity: Pick<RegisteredEntity, "entityId" | "type">): QlooParams {
  return {
    "filter.type": entityTypeUrn(entity.type),
    "signal.interests.entities": [entity.entityId],
    "filter.start_date": TRENDING_WINDOW.start,
    "filter.end_date": TRENDING_WINDOW.end,
    take: TRENDING_TAKE,
  };
}

/** Network calls a momentum input would cost now: one per registered brand or TV show, cached ones free. */
export async function estimateMomentumCalls(input: MomentumInput, probe: CacheProbe, registry: EntityRegistry): Promise<number> {
  const requests = input.entities.map((ref) => {
    const e = registry.entity(ref);
    return e !== null && isTrendable(e.type) ? trendingParams(e) : null;
  });
  return countUncached(probe, "/v2/trending", requests);
}

// Per-entity outcomes ------------------------------------------------------------------------------------

type TrendingAttempt = Attempt<{ data: QlooTrendingResponse; meta: QlooCallMeta }>;

/** What one requested entity came to. */
type Outcome =
  | { kind: "series"; entity: RegisteredEntity; meta: QlooCallMeta; analysis: SeriesAnalysis }
  | { kind: "gap"; entity: RegisteredEntity; reason: Extract<NoValueReason, "unavailable" | "budget_truncated" | "error"> };

function outcomeOf(entity: RegisteredEntity, attempt: TrendingAttempt | undefined): Outcome {
  if (attempt === undefined || attempt.kind === "skipped") return { kind: "gap", entity, reason: "unavailable" };
  if (attempt.kind === "truncated") return { kind: "gap", entity, reason: "budget_truncated" };
  if (attempt.kind === "failed") return { kind: "gap", entity, reason: "error" };
  return { kind: "series", entity, meta: attempt.value.meta, analysis: analyseSeries(attempt.value.data.results.trending) };
}

const hasTrend = (o: Outcome): o is Extract<Outcome, { kind: "series" }> & { analysis: { trend: NonNullable<SeriesAnalysis["trend"]> } } =>
  o.kind === "series" && o.analysis.trend !== null;

const NO_SIGNAL_TEXT: Readonly<Record<NoSignalCause, string>> = {
  no_points: "no points in the window",
  flatline: "too few distinct values (a placeholder series)",
  too_short: "fewer than eight weeks of data",
};

const LABEL_VALUE: Readonly<Record<MomentumTrend, number>> = { rising: 1, flat: 0, declining: -1 };
const LABEL_TEXT: Readonly<Record<MomentumTrend, string>> = { rising: "Rising", flat: "Flat", declining: "Declining" };

// Ledger ---------------------------------------------------------------------------------------------------

interface MomentumRun {
  ctx: SkillCtx;
  flags: Set<Flag>;
  evidenceIds: EvidenceId[];
  metrics: Metric[];
  findings: Finding[];
  notices: string[];
  /** Freshness F of the window as of this run (FORMULAS mom.freshness); the weight of every STALE conf. */
  freshness: number | null;
}

interface StaleMetricSpec {
  key: string;
  label: string;
  subjectRefs: readonly string[];
  /** Null records an explained absence: UNAVAILABLE with `reason`, never 0. */
  value: number | null;
  reason: NoValueReason;
  display: string;
  unit: MetricUnit;
  formulaId: FormulaId;
  evidenceIds: readonly EvidenceId[];
  n: number | null;
  comparator: Comparator | null;
}

/**
 * Adds a momentum metric: STALE with the trending window when present (CHECKER V8), UNAVAILABLE
 * otherwise. addSkillMetric offers no STALE, so this sets the window itself; conf uses the window's
 * freshness as of this run.
 */
function addStaleMetric(run: MomentumRun, spec: StaleMetricSpec): Metric {
  const present = spec.value !== null;
  const badge = present ? "STALE" : "UNAVAILABLE";
  const metric = run.ctx.ledger.addMetric({
    key: spec.key,
    label: spec.label,
    subjectRefs: [...spec.subjectRefs],
    value: spec.value,
    reason: present ? null : spec.reason,
    display: present ? spec.display : "not measured",
    unit: spec.unit,
    badge,
    formulaId: spec.formulaId,
    evidenceIds: [...spec.evidenceIds],
    n: spec.n,
    conf: metricConfidence(badge, spec.n, run.freshness),
    comparator: spec.comparator,
    window: TRENDING_WINDOW,
  });
  run.metrics.push(metric);
  return metric;
}

/** "+0.104", "-0.078"; a value that rounds to zero prints unsigned. */
function signed(x: number, digits: number): string {
  const text = x.toFixed(digits);
  if (Number(text) === 0) return (0).toFixed(digits);
  return x > 0 ? `+${text}` : text;
}

function pText(p: number): string {
  return p < 0.001 ? "<0.001" : p.toFixed(3);
}

/** Mann–Kendall τ in words (Q1 of the Part 9 close-out): how steady the direction is, not how large the change. */
export function tauWords(tau: number): string {
  const size = Math.abs(tau);
  if (size >= 0.6) return tau > 0 ? "a steady rise" : "a steady fall";
  if (size >= 0.3) return tau > 0 ? "a mostly steady rise" : "a mostly steady fall";
  return "no steady direction";
}

/** The Mann–Kendall p-value in words; the label rule reads below 0.1 as a consistent direction. */
export function pWords(p: number): string {
  if (p < 0.01) return "very unlikely to be chance";
  if (p < LABEL_MAX_P) return "unlikely to be chance";
  return "could be chance";
}

function recordEvidence(run: MomentumRun, outcome: Extract<Outcome, { kind: "series" }>): EvidenceId | null {
  const { entity, analysis, meta } = outcome;
  const flags: Flag[] = ["TRENDING_HISTORICAL_WINDOW"];
  if (analysis.noSignal !== null) flags.push("NO_TREND_SIGNAL");
  const shape =
    (analysis.scaleBreak ? "after a scale break, the latest segment: " : "") +
    `${analysis.rawPoints} points (${analysis.distinctValues} distinct values), ${analysis.weeks.length} ISO weeks`;
  const evidence = addSkillEvidence(run.ctx.ledger, {
    skill: "momentum",
    purpose: `Qloo trending for ${safeName(entity.name)} (${entity.type}), ${windowText()}`,
    calls: [meta],
    status: analysis.noSignal === null ? "ok" : "empty",
    summary:
      analysis.trend !== null
        ? `${shape}; ${LABEL_TEXT[analysis.trend.label]}.`
        : `${shape}; no trend signal: ${NO_SIGNAL_TEXT[analysis.noSignal ?? "no_points"]}.`,
    flags,
  });
  if (evidence === null) return null;
  run.evidenceIds.push(evidence.id);
  return evidence.id;
}

interface EntityMetrics {
  delta: Metric | null;
  tau: Metric | null;
  p: Metric | null;
  label: Metric;
}

/**
 * Four STALE metrics for an entity with a trend (Δpct_26w with its peer rank, τ, p, the label);
 * one UNAVAILABLE label with the reason for any other.
 */
function addEntityMetrics(
  run: MomentumRun,
  outcome: Outcome,
  evidenceId: EvidenceId | null,
  peerRank: { rank: number; of: number } | null,
): EntityMetrics {
  const { entity } = outcome;
  const name = safeName(entity.name);
  const subjectRefs = [entity.ref];
  const evidenceIds = evidenceId === null ? [] : [evidenceId];
  const labelSpec = {
    key: "mom.label",
    label: `momentum label of ${name}`,
    subjectRefs,
    unit: "score" as const,
    formulaId: "mom.label" as const,
    evidenceIds,
    comparator: null,
  };

  if (!hasTrend(outcome)) {
    const reason: NoValueReason = outcome.kind === "gap" ? outcome.reason : "no_signal";
    return {
      delta: null,
      tau: null,
      p: null,
      label: addStaleMetric(run, { ...labelSpec, value: null, reason, display: "", n: null }),
    };
  }

  const { trend, weeks } = outcome.analysis;
  const n = weeks.length;
  const rank = peerRank === null ? "" : ` · rank ${rankText(peerRank.rank, peerRank.of)}`;
  const delta = addStaleMetric(run, {
    key: "mom.delta_26w",
    label: `26-week momentum of ${name} (change in trending percentile)`,
    subjectRefs,
    value: trend.delta26w,
    reason: "no_signal",
    display: `${signed(trend.delta26w, 3)}${rank}`,
    unit: "delta",
    formulaId: "mom.delta_26w",
    evidenceIds,
    n,
    comparator: "WITHIN_CALL",
  });
  const tau = addStaleMetric(run, {
    key: "mom.mann_kendall_tau",
    label: `trend strength of ${name}'s weekly series (how steadily it rose or fell)`,
    subjectRefs,
    value: trend.tau,
    reason: "no_signal",
    display: `${signed(trend.tau, 2)} (${tauWords(trend.tau)})`,
    unit: "stat",
    formulaId: "mom.mann_kendall",
    evidenceIds,
    n,
    comparator: null,
  });
  const p = addStaleMetric(run, {
    key: "mom.mann_kendall_p",
    label: `trend p-value of ${name}'s weekly series (how likely the direction is chance)`,
    subjectRefs,
    value: trend.p,
    reason: "no_signal",
    display: `${pText(trend.p)} (${pWords(trend.p)})`,
    unit: "stat",
    formulaId: "mom.mann_kendall",
    evidenceIds,
    n,
    comparator: null,
  });
  const label = addStaleMetric(run, {
    ...labelSpec,
    value: LABEL_VALUE[trend.label],
    reason: "no_signal",
    display: LABEL_TEXT[trend.label],
    n,
  });
  return { delta, tau, p, label };
}

/** One freshness metric for the window, once any trending response came back. */
function addFreshnessMetric(run: MomentumRun, subjectRefs: readonly string[], asOf: string): Metric {
  const months = windowAgeMonths(TRENDING_WINDOW, asOf);
  return addStaleMetric(run, {
    key: "mom.freshness",
    label: `freshness of the trending window ${windowText()} (1 = just ended)`,
    subjectRefs,
    value: run.freshness,
    reason: "not_measured",
    display: `${run.freshness === null ? "" : fixed2(run.freshness)}${months === null ? "" : ` · ${months} months after the window`}`,
    unit: "score",
    formulaId: "mom.freshness",
    evidenceIds: run.evidenceIds,
    n: null,
    comparator: null,
  });
}

function seriesOf(outcome: Outcome, peerRank: { rank: number; of: number } | null): MomentumSeries {
  const base = {
    ref: outcome.entity.ref,
    label: safeFullName(outcome.entity.name),
    type: outcome.entity.type,
    trend: null,
    delta26w: null,
    tau: null,
    p: null,
    peerRank: null,
  };
  if (outcome.kind === "gap") return { ...base, state: "unavailable", reason: outcome.reason, points: [], scaleBreak: false };
  const { analysis } = outcome;
  if (!hasTrend(outcome)) {
    return {
      ...base,
      state: "no_signal",
      reason: "no_signal",
      points: analysis.weeks.map((w) => ({ date: w.date, pct: w.pct, clipped: false })),
      scaleBreak: analysis.scaleBreak,
    };
  }
  const { trend } = outcome.analysis;
  return {
    ...base,
    state: "ok",
    reason: null,
    trend: trend.label,
    points: analysis.weeks.map((w, i) => {
      const drawn = trend.plotted[i];
      return { date: w.date, pct: drawn?.value ?? w.pct, clipped: drawn?.clipped ?? false };
    }),
    delta26w: trend.delta26w,
    tau: trend.tau,
    p: trend.p,
    peerRank,
    scaleBreak: analysis.scaleBreak,
  };
}

/** "Momentum · Brand Alpha and Brand Beta". */
function datasetTitle(outcomes: readonly Outcome[]): string {
  const names = outcomes.map((o) => safeName(o.entity.name));
  const shown = names.length <= 2 ? names.join(" and ") : `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
  return `Momentum · ${shown}`;
}

/**
 * Digest rows name the metrics that hold an entity's values rather than repeating them, so the model
 * cites the STALE tokens (with {{WINDOW}}) instead of typing a number.
 */
function digestRow(outcome: Outcome, metrics: EntityMetrics, peerRank: { rank: number; of: number } | null): DigestRow {
  const values: DigestRow["values"] = { type: outcome.entity.type, label_metric: metrics.label.id };
  if (hasTrend(outcome)) {
    values.state = "ok";
    values.trend = outcome.analysis.trend.label;
    values.delta_metric = metrics.delta?.id ?? null;
    values.tau_metric = metrics.tau?.id ?? null;
    values.p_metric = metrics.p?.id ?? null;
    values.weeks = outcome.analysis.weeks.length;
    values.peer_rank = peerRank === null ? null : rankText(peerRank.rank, peerRank.of);
    if (outcome.analysis.scaleBreak) values.scale_break = "latest segment kept";
  } else {
    // As in the Momentum dataset: NO SIGNAL only for a series that came back; a call never made,
    // refused or failed is unavailable, with its reason.
    values.state = outcome.kind === "gap" ? "unavailable" : "no_signal";
    values.reason = outcome.kind === "gap" ? outcome.reason : NO_SIGNAL_TEXT[outcome.analysis.noSignal ?? "no_points"];
  }
  return { ref: outcome.entity.ref, name: safeName(outcome.entity.name), values };
}

function statusOf(outcomes: readonly Outcome[]): SkillStatus {
  const trended = outcomes.filter(hasTrend).length;
  if (outcomes.some((o) => o.kind === "gap" && o.reason === "budget_truncated")) return "partial";
  if (trended === outcomes.length) return "ok";
  return trended > 0 ? "partial" : "empty";
}

// The skill --------------------------------------------------------------------------------------------------

async function runMomentum(input: MomentumInput, ctx: SkillCtx): Promise<SkillResult> {
  const out: DigestTarget = { tool: "momentum", step: input.step_id };
  const notices: string[] = [];
  const entities: RegisteredEntity[] = [];
  for (const ref of input.entities) {
    const e = ctx.registry.entity(ref);
    if (e === null) notices.push(`${ref} is not in the registry; left out.`);
    else entities.push(e);
  }
  if (entities.length === 0) return skillErrorResult(out, [...notices, "Resolve the entities first."].join(" "));

  for (const e of entities) {
    if (isTrendable(e.type) && e.type !== input.type) {
      notices.push(`${e.ref} (${safeName(e.name)}) is a ${e.type}, so it was trended as a ${e.type}, not a ${input.type}.`);
    }
  }
  const untrendable = entities.filter((e) => !isTrendable(e.type));
  if (untrendable.length > 0) {
    notices.push(
      `Qloo trending has data for brands and TV shows only: ${untrendable.map((e) => `${e.ref} (${e.type})`).join(", ")} not measured.`,
    );
  }

  const attempts = await attemptAllKeepingFailures(
    entities.map((e) => (isTrendable(e.type) ? () => ctx.qloo.trending(trendingParams(e)) : null)),
    ctx.signal,
  );
  const failures = attempts.flatMap((a) => (a.kind === "failed" ? [a] : []));
  const bug = failures.find((f) => CALLER_BUGS.has(f.code));
  if (bug !== undefined) throw bug.error;
  // With nothing to record there is no evidence to keep: the error goes to the caller.
  if (failures.length > 0 && !attempts.some((a) => a.kind === "ok" || a.kind === "truncated")) throw failures[0]!.error;

  const asOf = new Date().toISOString();
  const run: MomentumRun = {
    ctx,
    flags: new Set(),
    evidenceIds: [],
    metrics: [],
    findings: [],
    notices,
    freshness: freshness(TRENDING_WINDOW, asOf),
  };
  const outcomes = entities.map((e, i) => outcomeOf(e, attempts[i]));
  if (failures.length > 0) {
    const codes = [...new Set(failures.map((f) => f.code))].join(", ");
    notices.push(`${failures.length} trending ${failures.length === 1 ? "call" : "calls"} failed (${codes}); not measured.`);
  }

  // Peer rank by Δ among entities with a trend (1 = strongest gain); a single trend has no peers.
  const deltas = outcomes.map((o) => (hasTrend(o) ? o.analysis.trend.delta26w : null));
  const trended = deltas.filter((d) => d !== null).length;
  const ranks = displayRanks(deltas);
  const peerRanks = ranks.map((r) => (r === null || trended < 2 ? null : { rank: r, of: trended }));

  const series = outcomes.filter((o): o is Extract<Outcome, { kind: "series" }> => o.kind === "series");
  const evidenceByRef = new Map<string, EvidenceId | null>(series.map((o) => [o.entity.ref, recordEvidence(run, o)]));
  const rows: DigestRow[] = [];
  outcomes.forEach((o, i) => {
    const metrics = addEntityMetrics(run, o, evidenceByRef.get(o.entity.ref) ?? null, peerRanks[i] ?? null);
    rows.push(digestRow(o, metrics, peerRanks[i] ?? null));
  });

  const noSignal = outcomes.filter((o) => o.kind === "series" && o.analysis.trend === null);
  if (series.length > 0) {
    run.flags.add("TRENDING_HISTORICAL_WINDOW");
    addFreshnessMetric(run, series.map((o) => o.entity.ref), asOf);
  }
  if (noSignal.length > 0) {
    run.flags.add("NO_TREND_SIGNAL");
    const draft = noTrendSignalFinding({ names: noSignal.map((o) => safeName(o.entity.name)) });
    if (draft !== null) {
      const labels = run.metrics.filter((m) => m.key === "mom.label" && noSignal.some((o) => m.subjectRefs[0] === o.entity.ref));
      run.findings.push(ctx.ledger.addFinding({ ...draft, metricIds: labels.map((m) => m.id) }));
    }
  }
  if (outcomes.some((o) => o.kind === "gap" && o.reason === "budget_truncated")) run.flags.add("BUDGET_TRUNCATED");
  if (failures.length > 0) run.flags.add("CANDIDATES_UNSCORED");

  const datasetIds: DatasetId[] = [];
  if (series.length > 0) {
    const dataset = ctx.ledger.addDataset({
      kind: "Momentum",
      title: datasetTitle(outcomes),
      evidenceIds: [...run.evidenceIds],
      formulaIds: [...MOM_FORMULA_IDS],
      payload: {
        window: TRENDING_WINDOW,
        badgeText: `HISTORICAL · QLOO TRENDING · ${windowText()}`,
        badge: "STALE",
        series: outcomes.map((o, i) => seriesOf(o, peerRanks[i] ?? null)),
      },
    });
    datasetIds.push(dataset.id);
    // First, so it is the last notice a tight digest drops.
    notices.unshift(`Trending window ${windowText()} is historical: every momentum figure describes that past window, not today; name the window with {{WINDOW}} and do not write the badge word.`);
  }

  return skillResult(
    {
      status: statusOf(outcomes),
      evidenceIds: run.evidenceIds,
      datasetIds,
      metrics: run.metrics,
      rows,
      findings: run.findings,
      flags: run.flags,
      registered: [],
      notices,
    },
    out,
  );
}

/** S4 momentum (MOM). */
export const momentumSkill: SkillFor<"momentum"> = {
  id: "momentum",
  mnemonic: "MOM",
  kitWorkflows: ANALYST_TOOLS.momentum.kitWorkflows,
  input: ANALYST_TOOLS.momentum.input,
  estimateCalls: (input, probe, registry) => estimateMomentumCalls(input, probe, registry),
  run: runMomentum,
  // The method bullet only: buildLimitations writes each raised flag's sentence from FLAG_TEXT,
  // and the trending window's own sentence from the Momentum dataset's window.
  limitations: () => [...SKILL_LIMITATIONS.momentum],
};
