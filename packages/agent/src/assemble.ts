import {
  dataDisclaimer,
  FIXED_DISCLAIMERS,
  isId,
  isVerdictTag,
  JOB_PILLAR,
  makeId,
  Report,
  verdictTagWords,
  vizFor,
  type ArgumentId,
  type Badge,
  type Confidence,
  type DatasetEnvelope,
  type EntityRef,
  type Evidence,
  type Flag,
  type GhostAnswer,
  type GhostDiff,
  type Job,
  type Limitation,
  type Metric,
  type MetricId,
  type Mode,
  type Pillar,
  type ReportDraftShape,
  type ReportExhibit,
  type Strength,
  type SubmitPlanInputShape,
  type TrendWindow,
  type ValidationIssue,
} from "@ct/contracts";
import {
  argumentStrength,
  buildLimitations,
  computeConfidence,
  distinctBadges,
  freshness,
  metricConfidence,
  SKILL_LIMITATIONS,
} from "@ct/quant";
import { MIN_OK_EVIDENCE, type CheckResult } from "./checker";
import { indexSnapshot, type LedgerSnapshot } from "./ledger";
import { formatUtcDate, timeRange } from "./report/format";
import { pickKpis } from "./report/kpis";
import { POSITION_JOBS } from "./report/position";
import { isQlooEvidence, publicDisclaimers, readAsLimitation } from "./report/publicData";
import { buildReceipt, type ReceiptPublicCall, type ReceiptQlooCall, type ReceiptUsage } from "./report/receipt";
import { exhibitSourceLine } from "./report/sourceLine";
import { buildScorecard } from "./scorecard";
import { citedIds, draftProse, plainProse } from "./tokens";

export { buildCaseSummary, type CaseSummaryContext } from "./report/caseSummary";
export { POSITION_FAILED, POSITION_JOBS, recordPosition, type PositionContext } from "./report/position";
export type { ReceiptPublicCall, ReceiptQlooCall, ReceiptUsage } from "./report/receipt";

/**
 * ASSEMBLE (PLAN §4.1 step H, §7; D5, D9): code turns the checked draft into the Report. The model
 * wrote prose only; code picks the verdict signal (after V7), computes confidence, puts the
 * Hypothesis Scorecard first, picks KPIs and every exhibit's chart (VIZ_COMPAT), writes source
 * lines, limitations, disclaimers and the receipt. Ids the draft cites that do not exist (accepted
 * with warnings after the repair turn) are dropped here, so the Report only links to real records.
 */

/** Assembly was called out of order: a bug in the run manager, never a data condition. */
export class ReportAssemblyError extends Error {
  override readonly name = "ReportAssemblyError";
}

/** What both report builders need besides the draft. */
export interface ReportContext {
  runId: string;
  question: string;
  job: Job;
  mode: Mode;
  /** When the report is assembled (ISO); also the reference time for cache ages. */
  createdAt: string;
  plan: SubmitPlanInputShape | null;
  /**
   * The run's ledger, with the Scorecard recorded: `recordScorecard(ledger, plan, check.patchedDraft)`
   * before assembleReport, `recordScorecard(ledger, plan, null)` before buildIncompleteReport. A plan
   * with hypotheses and no Scorecard dataset throws ReportAssemblyError (it is always the first
   * exhibit, SPEC §7.2). On the investment desk, recordPosition adds the Taste Position card, which
   * follows the Scorecard.
   */
  ledger: LedgerSnapshot;
  /** Every Qloo call of the run, e.g. `RunState.qloo.chips`; `rows` counts thin results per call. */
  qlooCalls: readonly ReceiptQlooCall[];
  /** Every SEC and Census call of the run (the `public` events); none by default. */
  publicCalls?: readonly ReceiptPublicCall[];
  usage: ReceiptUsage;
  models: Report["receipt"]["models"];
  /** Secondary mentions dropped or unresolved at the gate (−15 each, §6.4). */
  droppedEntities: number;
  /** CODE FALLBACK events of the run (−10 each, §6.4). */
  codeFallbacks: number;
  ghost?: { answer: GhostAnswer; diff: GhostDiff } | null;
  /** Skill.limitations of the skills that ran; defaults to the fixed SKILL_LIMITATIONS of the skills in the ledger. */
  skillLimitations?: readonly string[];
  /** The question's primary target: the KPI strip prefers its own metrics. */
  subject?: EntityRef | null;
  /** The peers the question names (the gate's): head_to_head's similarity figure is the pair's. */
  peers?: readonly EntityRef[];
  /**
   * The question was read as its nearest job (D41, CLERK's read_as): what it asks that the data does not
   * cover, for the READ_AS_NEAREST_JOB limitation and its −5 confidence. Null or absent when the job fits.
   */
  readAs?: { notCovered: readonly string[] } | null;
}

export interface AssembleInput extends ReportContext {
  /**
   * The CHECKER result of the accepted draft: the patched draft, its issues and numbers traced. Its
   * rejections and warnings all become Report warnings (acceptedWarnings), whichever attempt it was.
   */
  check: CheckResult;
}

export interface IncompleteInput extends ReportContext {
  /** Why the ANALYST did not submit, e.g. "hard time limit reached"; shown in the thesis. */
  reason: string | null;
}

export const INCOMPLETE_HEADLINE = "Evidence digest: the analysis did not finish";
export const SCORECARD_CAPTION = "Priors the ANALYST wrote before any data, each judged against cited metrics.";
export const POSITION_CAPTION =
  "Where the subject stands against its peers on five axes, each with its peer rank and exhibit; no total is given.";

/** Exhibits code places itself, ahead of the draft's: the Scorecard, then the Taste Position card. */
const isLeadKind = (kind: DatasetEnvelope["kind"]): boolean => kind === "Scorecard" || kind === "Position";
/** The data line of a note that rests on no Qloo evidence (Qloo disabled, or nothing came back): SEC or Census lines stand apart. */
export const NO_DATA_DISCLAIMER = "Data: Qloo hackathon dataset; this run collected no Qloo evidence.";
/** A call with fewer rows than this is a thin result (THIN_RESULT, SPEC §6.4). */
export const THIN_RESULT_ROWS = 5;

// Quant seam adapters: the only calls into @ct/quant policy code, so a signature change is a one-line fix.

interface ConfidenceCounts {
  droppedEntities: number;
  codeFallbacks: number;
  coarseGeohash: boolean;
  staleMomentumCited: boolean;
  thinCalls: number;
  /** Results dropped by the quality gate across all evidence bundles (§6.4, −5 each). */
  qualityGateDrops: number;
  checkerWarnings: number;
  /**
   * The note's signal is insufficient_evidence, so it is always LOW (SPEC §6.4): V7 forced it (fewer
   * than MIN_OK_EVIDENCE ok Qloo bundles, or Qloo disabled), the ANALYST chose it, or the note is an
   * evidence digest.
   */
  insufficientEvidence: boolean;
  /** The question was read as its nearest job (D41): −5, once. */
  readAsNearestJob: boolean;
}

const scoreConfidence = (c: ConfidenceCounts): Confidence =>
  computeConfidence({
    droppedEntities: c.droppedEntities,
    codeFallbacks: c.codeFallbacks,
    coarseGeohash: c.coarseGeohash,
    staleMomentumCited: c.staleMomentumCited,
    thinResults: c.thinCalls,
    qualityGateDrops: c.qualityGateDrops,
    checkerWarnings: c.checkerWarnings,
    insufficientEvidence: c.insufficientEvidence,
    readAsNearestJob: c.readAsNearestJob,
  });

const limitationsFor = (args: {
  flags: readonly Flag[];
  pillar: Pillar;
  openQuestions: readonly string[];
  skillLimitations: readonly string[];
  window: TrendWindow | null;
  asOf: string;
}): Limitation[] => buildLimitations(args);

/**
 * A metric without a stored conf gets one here. A STALE metric's weight is the freshness of its
 * window at report time, so a recent window is not marked down to the default F of an unknown age.
 */
const strengthOf = (metrics: readonly Metric[], asOf: string): Strength =>
  argumentStrength(
    metrics.map(
      (m) => m.conf ?? metricConfidence(m.badge, m.n, m.badge === "STALE" && m.window ? freshness(m.window, asOf) : null),
    ),
  );

/**
 * Metric ids a draft cites, in order: its id lists, then the tokens in its prose. The KPI strip and
 * the Taste Position card read these first, so both show the figure the note argues from.
 */
export function draftCitedMetrics(draft: ReportDraftShape): MetricId[] {
  return citedIds(
    "M",
    [
      ...draft.hypothesis_verdicts.flatMap((v) => v.metric_ids),
      ...draft.arguments.flatMap((a) => a.metric_ids),
      ...draft.bear_case.flatMap((b) => b.metric_ids),
    ],
    draftProse(draft).map((f) => f.text),
  );
}

// Report builders ---------------------------------------------------------------------------------------

export function assembleReport(input: AssembleInput): Report {
  const { ledger, check } = input;
  const draft: ReportDraftShape = check.patchedDraft;
  const run = runFacts(input);
  const lookup = run.lookup;
  const metricsOf = (ids: readonly MetricId[]) => ids.flatMap((id) => lookup.metric(id) ?? []);
  const knownMetrics = (ids: readonly string[], texts: readonly string[]) =>
    citedIds("M", ids, texts).filter((id) => lookup.metric(id) !== undefined);
  const knownEvidence = (ids: readonly string[], texts: readonly string[]) =>
    citedIds("E", ids, texts).filter((id) => lookup.evidence(id) !== undefined);

  // Arguments are renumbered A1… by position; recommendations follow the mapping.
  const argumentIdMap = new Map<string, ArgumentId>();
  const reportArguments = draft.arguments.map((a, i) => {
    const id = makeId("A", i + 1);
    if (!argumentIdMap.has(a.id)) argumentIdMap.set(a.id, id);
    const metricIds = knownMetrics(a.metric_ids, [a.qloo_fact, a.our_read]);
    return {
      id,
      section: a.section,
      qlooFact: a.qloo_fact,
      ourRead: a.our_read,
      metricIds,
      evidenceIds: knownEvidence(a.evidence_ids, [a.qloo_fact, a.our_read]),
      strength: strengthOf(metricsOf(metricIds), input.createdAt),
    };
  });

  const seen = new Set<string>();
  const draftExhibits = draft.exhibits.flatMap((e) => {
    const dataset = isId("D", e.dataset_id) ? lookup.dataset(e.dataset_id) : undefined;
    if (!dataset || isLeadKind(dataset.kind) || seen.has(dataset.id)) return [];
    seen.add(dataset.id);
    return [{ dataset, title: e.title, caption: e.caption }];
  });

  const cited = draftCitedMetrics(draft).filter((id) => lookup.metric(id) !== undefined);
  const warnings = acceptedWarnings(check.issues);
  const confidence = scoreConfidence({
    ...run.counts,
    staleMomentumCited: metricsOf(cited).some((m) => m.badge === "STALE"),
    checkerWarnings: warnings.length,
    // Keyed on the final signal: the patched draft carries V7 (which also fires when Qloo is
    // disabled), and an ANALYST that chose insufficient_evidence itself gets the same LOW band.
    insufficientEvidence: run.counts.insufficientEvidence || draft.signal === "insufficient_evidence",
  });

  return Report.parse({
    ...run.header,
    incomplete: false,
    verdict: {
      headline: draft.headline,
      signal: draft.signal,
      tag: reportTag(draft.verdict_tag),
      thesis: draft.thesis,
      confidence,
      coverage: run.coverage,
    },
    scorecard: buildScorecard(input.plan, draft, ledger).rows,
    kpis: pickKpis(input.job, ledger.metrics, cited, { subject: input.subject ?? null, peers: input.peers ?? [] }),
    exhibits: run.exhibits(draftExhibits),
    arguments: reportArguments,
    bearCase: draft.bear_case.map((b) => ({ text: b.text, metricIds: knownMetrics(b.metric_ids, [b.text]) })),
    recommendations: draft.recommendations.map((r) => ({
      action: r.action,
      priority: r.priority,
      argumentIds: [...new Set(r.argument_ids.flatMap((id) => argumentIdMap.get(id) ?? []))],
    })),
    limitations: run.limitations([], draft.open_questions),
    disclaimers: run.disclaimers,
    ghost: input.ghost ?? null,
    // A child run cannot resolve this run's tokens; the CHECKER rejects them, this covers an accepted draft.
    nextMoves: draft.next_moves.map((m) => ({
      label: plainProse(m.label, lookup, run.window),
      question: plainProse(m.question, lookup, run.window),
    })),
    warnings,
    receipt: run.receipt(check.numbersTraced),
  });
}

/**
 * The evidence-digest report for a run whose ANALYST never submitted (PLAN §4.2 guards): signal
 * insufficient_evidence, every dataset as an exhibit, no prose claims, INCOMPLETE_RUN limitation.
 */
export function buildIncompleteReport(input: IncompleteInput): Report {
  const { ledger } = input;
  const run = runFacts(input);
  // A digest's signal is always insufficient_evidence, however many bundles came back ok.
  const confidence = scoreConfidence({ ...run.counts, staleMomentumCited: false, checkerWarnings: 0, insufficientEvidence: true });
  const thesis =
    `The run stopped before the ANALYST submitted its note${input.reason ? ` (${input.reason})` : ""}. ` +
    "The exhibits show every dataset QUANT computed; no interpretation is offered.";

  return Report.parse({
    ...run.header,
    incomplete: true,
    verdict: {
      headline: INCOMPLETE_HEADLINE,
      signal: "insufficient_evidence",
      // A digest names no finding: the brief prints the signal.
      tag: null,
      thesis,
      confidence,
      coverage: run.coverage,
    },
    scorecard: buildScorecard(input.plan, null, ledger).rows,
    kpis: pickKpis(input.job, ledger.metrics, [], { subject: input.subject ?? null, peers: input.peers ?? [] }),
    exhibits: run.exhibits(
      ledger.datasets
        .filter((d) => !isLeadKind(d.kind))
        .map((dataset) => ({
          dataset,
          title: dataset.title,
          caption: dataset.evidenceIds.flatMap((id) => run.lookup.evidence(id)?.summary ?? []).join(" "),
        })),
    ),
    arguments: [],
    bearCase: [],
    recommendations: [],
    limitations: run.limitations(["INCOMPLETE_RUN"], []),
    disclaimers: run.disclaimers,
    ghost: input.ghost ?? null,
    nextMoves: [],
    warnings: [],
    receipt: run.receipt({ traced: 0, total: 0 }),
  });
}

/**
 * The verdict tag as the Report carries it: the checked draft's, spaces collapsed, or null when none
 * keeps its rule (V7 or the last attempt's CHECKER dropped it), so readers print the signal label.
 */
export function reportTag(tag: string): string | null {
  const text = verdictTagWords(tag).join(" ");
  return isVerdictTag(text) ? text : null;
}

/**
 * The CHECKER issues an accepted report carries as warnings. A report is assembled only once it is
 * accepted, so a rejection still standing (the loop had no repair turn left to offer) is a warning
 * too, and costs confidence like one (SPEC §6.2, §6.4).
 */
export function acceptedWarnings(issues: readonly ValidationIssue[]): ValidationIssue[] {
  return issues.flatMap((i) => (i.action === "reject" || i.action === "warn" ? [{ ...i, action: "warn" as const }] : []));
}

// Shared facts -------------------------------------------------------------------------------------------

/** Everything about the run that does not depend on the draft. */
function runFacts(ctx: ReportContext) {
  const { ledger } = ctx;
  const lookup = indexSnapshot(ledger);
  const pillar = JOB_PILLAR[ctx.job];
  const now = Date.parse(ctx.createdAt);
  const flags = ledger.evidence.flatMap((e) => e.flags);
  const bundlesWith = (flag: Flag) => ledger.evidence.filter((e) => e.flags.includes(flag));
  const window = trendWindow(ledger);
  const fetched = timeRange(ledger.evidence.map((e) => e.fetchedAt));
  // The Qloo data line dates Qloo bundles only; SEC and Census figures carry their own period lines.
  const qlooFetched = timeRange(ledger.evidence.filter(isQlooEvidence).map((e) => e.fetchedAt));
  const readAs = ctx.readAs ?? null;
  const skillLimitations =
    ctx.skillLimitations ?? [...new Set(ledger.evidence.map((e) => e.skill))].flatMap((s) => SKILL_LIMITATIONS[s]);
  const dataLine = qlooFetched
    ? dataDisclaimer(
        formatUtcDate(qlooFetched.from) === formatUtcDate(qlooFetched.to)
          ? formatUtcDate(qlooFetched.from)
          : `${formatUtcDate(qlooFetched.from)} to ${formatUtcDate(qlooFetched.to)}`,
        window,
      )
    : NO_DATA_DISCLAIMER;
  const scorecard = ledger.datasets.findLast((d) => d.kind === "Scorecard");
  // The investment desk's card follows the Scorecard (SPEC §7.2); recordPosition makes one only there.
  const position = POSITION_JOBS.has(ctx.job) ? ledger.datasets.findLast((d) => d.kind === "Position") : undefined;
  if (!scorecard && (ctx.plan?.hypotheses.length ?? 0) > 0) {
    throw new ReportAssemblyError(
      "the plan has hypotheses but the ledger holds no Scorecard dataset; call recordScorecard before assembling",
    );
  }

  return {
    lookup,
    window,
    header: {
      runId: ctx.runId,
      question: ctx.question,
      pillar,
      job: ctx.job,
      mode: ctx.mode,
      createdAt: ctx.createdAt,
      investmentBanner: pillar === "investment",
      dataFreshness: { fetchedFrom: fetched?.from ?? null, fetchedTo: fetched?.to ?? null, trendWindow: window },
    },
    coverage: {
      evidenceOk: ledger.evidence.filter((e) => e.status === "ok").length,
      evidenceTotal: ledger.evidence.length,
    },
    counts: {
      droppedEntities: ctx.droppedEntities,
      codeFallbacks: ctx.codeFallbacks,
      coarseGeohash: flags.includes("COARSE_GEOHASH"),
      thinCalls: thinCalls(bundlesWith("THIN_RESULT"), ctx.qlooCalls),
      qualityGateDrops: ledger.evidence.reduce((sum, e) => sum + e.qualityGateDrops, 0),
      // V7 counts Qloo bundles only: SEC and Census figures sit beside the taste read, never in its place.
      insufficientEvidence: ledger.evidence.filter((e) => e.status === "ok" && isQlooEvidence(e)).length < MIN_OK_EVIDENCE,
      readAsNearestJob: readAs !== null,
    },
    disclaimers: [...FIXED_DISCLAIMERS, dataLine, ...publicDisclaimers(ledger.metrics, lookup)],
    /** The flag limitations, the nearest-job one first among them (D41), then the desk, skill and open-question lines. */
    limitations: (extraFlags: readonly Flag[], openQuestions: readonly string[]) => {
      const built = limitationsFor({
        flags: [...flags, ...extraFlags].filter((f) => f !== "READ_AS_NEAREST_JOB"),
        pillar,
        openQuestions,
        skillLimitations,
        window,
        asOf: ctx.createdAt,
      });
      return readAs === null ? built : [readAsLimitation(ctx.job, readAs.notCovered), ...built];
    },
    /**
     * The Scorecard dataset first (absent only without hypotheses), then the Taste Position card on the
     * investment desk, then the given exhibits in order.
     */
    exhibits: (entries: readonly { dataset: DatasetEnvelope; title: string; caption: string }[]): ReportExhibit[] => {
      const lead = [
        ...(scorecard ? [{ dataset: scorecard, title: scorecard.title, caption: SCORECARD_CAPTION }] : []),
        ...(position ? [{ dataset: position, title: position.title, caption: POSITION_CAPTION }] : []),
      ];
      return [...lead, ...entries].map(({ dataset, title, caption }) => {
        const evidence = dataset.evidenceIds.flatMap((id) => lookup.evidence(id) ?? []);
        return {
          datasetId: dataset.id,
          kind: dataset.kind,
          viz: vizFor(dataset.kind),
          title,
          caption,
          badges: exhibitBadges(dataset, ledger.metrics, evidence),
          sourceLine: exhibitSourceLine(dataset, evidence, now),
          evidenceIds: dataset.evidenceIds,
        };
      });
    },
    receipt: (numbersTraced: Report["receipt"]["numbersTraced"]) =>
      buildReceipt({
        calls: ctx.qlooCalls,
        publicCalls: ctx.publicCalls ?? [],
        usage: ctx.usage,
        numbersTraced,
        models: ctx.models,
        economy: ctx.mode === "economy",
      }),
  };
}

/**
 * Thin results (§6.4 charges each): the calls of THIN_RESULT bundles that returned fewer than
 * THIN_RESULT_ROWS rows. A flagged bundle counts at least once, since its flag says one call was thin
 * even when the call log carries no row counts.
 */
function thinCalls(bundles: readonly Evidence[], calls: readonly ReceiptQlooCall[]): number {
  const rows = new Map(calls.map((c) => [c.qlooCallId, c.rows ?? null]));
  return bundles.reduce((n, e) => {
    const thin = e.qlooCallIds.filter((id) => {
      const r = rows.get(id);
      return r !== undefined && r !== null && r < THIN_RESULT_ROWS;
    }).length;
    return n + Math.max(1, thin);
  }, 0);
}

/** The trending window when the note used trending: from a STALE metric, else from a Momentum dataset. */
function trendWindow(ledger: LedgerSnapshot): TrendWindow | null {
  const fromMetric = ledger.metrics.find((m) => m.badge === "STALE" && m.window !== null)?.window;
  if (fromMetric) return fromMetric;
  const momentum = ledger.datasets.find((d) => d.kind === "Momentum");
  return momentum?.kind === "Momentum" ? momentum.payload.window : null;
}

/**
 * Badges on an exhibit: those of the metrics computed from the same evidence, plus the badges the
 * payload carries itself (Momentum is always STALE; Position axes carry one each).
 */
function exhibitBadges(dataset: DatasetEnvelope, metrics: readonly Metric[], evidence: readonly Evidence[]): Badge[] {
  const ids = new Set(evidence.map((e) => e.id));
  const badges = metrics.filter((m) => m.evidenceIds.some((e) => ids.has(e))).map((m) => m.badge);
  if (dataset.kind === "Momentum") badges.push(dataset.payload.badge);
  if (dataset.kind === "Position") badges.push(...dataset.payload.axes.map((a) => a.badge));
  return distinctBadges(badges);
}
