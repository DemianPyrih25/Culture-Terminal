import type {
  ArgumentId,
  ArgumentSection,
  Badge,
  CacheStatus,
  Comparator,
  ConfidenceBand,
  ConfidenceRule,
  DatasetEnvelope,
  DatasetId,
  DatasetKind,
  EntityType,
  EvidenceId,
  EvidenceSource,
  Flag,
  FindingId,
  HypothesisId,
  Job,
  Limitation,
  LocationMethod,
  MatchClass,
  MetricId,
  MetricUnit,
  NoValueReason,
  Phase,
  PickerCandidate,
  Pillar,
  Priority,
  PublicEndpoint,
  QlooPath,
  RunStatus,
  SafetyCategory,
  Signal,
  SkillStatus,
  StepId,
  Strength,
  ToolName,
  VizComponent,
} from "@ct/contracts";

/**
 * The brief view-model (Concept A · Brief, D36): everything the brief page renders, live and
 * finished, built purely from a RunState by `buildBriefModel`. Answer first, evidence second,
 * mechanics last. Every cited number carries a footnote that resolves to its metric, its evidence
 * and the Qloo requests behind it. Plain data: no functions, no class instances.
 */

/** The page's sections, in reading order. Their numbers are "01" … "06". */
export type BriefSectionId = "answer" | "conviction" | "evidence" | "risks" | "method" | "sources";

/** Where a footnote was first cited; finished briefs number footnotes in this order. */
export type CiteSection = "answer" | "conviction" | "priors" | "key_figures" | "figures" | "arguments" | "risks";

/** live: the run is still writing (footnotes numbered in arrival order); final: report.final arrived (reading order). */
export type BriefMode = "live" | "final";

// Prose ---------------------------------------------------------------------------------------------

/** A metric as the brief prints it. UNAVAILABLE prints "not measured" with its reason, never 0. */
export interface MetricView {
  id: MetricId;
  /** The run's own label, in full: what the request inspector prints. */
  label: string;
  /** "Distinctiveness", "Hub score": what a key figure and a margin note print (METRIC_SHORT_LABEL). */
  shortLabel: string;
  /** The text to print: the metric's display, or "not measured". */
  text: string;
  badge: Badge;
  unavailable: boolean;
  reason: NoValueReason | null;
  /** "no usable trend in the window"; null when the metric has a value. */
  reasonLabel: string | null;
  comparator: Comparator | null;
  /** "vs peers"; null when the metric has no comparator. */
  comparatorLabel: string | null;
  /** ▲ over / ▼ under for signed units (delta, lift); null otherwise. */
  direction: "over" | "under" | null;
  unit: MetricUnit;
  formulaId: string;
  /** DERIVED: computed in code by QUANT from other values. */
  derived: boolean;
  /** STALE: from the historical trending window; `window` names it. */
  stale: boolean;
  /** "Apr–Sep 2025" for a STALE metric; null otherwise. */
  window: string | null;
  /** The reporting period or vintage of an SEC or Census number ("FY2024", "ACS 2019–2023"); null or absent otherwise. */
  period?: string | null;
  /** Inside the about-level band (R1, V13): printed "about level" / "about average", never as a lead. */
  aboutLevel?: boolean;
  /** Rests on a thin sample (R1): the focus card says so. */
  thin?: boolean;
}

/**
 * Report prose split into printable pieces. {{M#}} becomes a `metric` with a footnote, [E#] a
 * `cite` (a bare superscript), {{WINDOW}} the trending window. An [E#] right after a metric whose
 * evidence it is folds into that metric's footnote. Text is never parsed as markup.
 */
export type Inline =
  | { kind: "text"; text: string }
  | { kind: "metric"; metric: MetricView; footnote: number }
  | { kind: "cite"; evidenceId: EvidenceId; footnote: number }
  | { kind: "window"; text: string }
  /** A token whose metric the run never streamed; it prints `text` and has no footnote. */
  | { kind: "missing"; id: MetricId; text: string };

// Footnotes -------------------------------------------------------------------------------------------

/** The endpoint a lookup went to: a Qloo path, or an SEC or Census endpoint template (Part 9). */
export type SourceEndpoint = QlooPath | PublicEndpoint;

/**
 * One request as the brief cites it: what opens when a number is clicked. Most are Qloo requests; an
 * SEC or Census request (Part 9) has `source` "sec" or "census", its call id in `qlooCallId` (the
 * field name predates public data, like Evidence.qlooCallIds) and its reference (a CIK, or the Census
 * dataset, vintage and geography) in `requestId`.
 */
export interface RequestRef {
  qlooCallId: string;
  /** Where the data came from; absent reads as "qloo". */
  source?: EvidenceSource;
  /** Index into `BriefModel.sources.items`, or null when the run did not stream this call. */
  sourceIndex: number | null;
  requestId: string | null;
  /** "ab12…cd34"; a public reference whole when it is short. */
  shortRequestId: string;
  endpoint: SourceEndpoint | null;
  filterType: string | null;
  /** "brand", "demographics". */
  filterLabel: string | null;
  params: [string, string][];
  rows: number | null;
  ms: number | null;
  cache: CacheStatus | null;
  /** "cached 2h", "live 13 Oct, 09:13", "reused from #A1F3". */
  cacheLabel: string;
}

/**
 * A footnote as the margin prints it (A/Sidenote): two short lines that fit the 300 px column at 1440.
 * The note: "Qloo /v2/insights · brand ← R1 · 15 rows. Audience overlap." (bare refs, a short label),
 * "Hub score vs peers, from 5 Qloo requests." for a derived number, or a figure's short codes. The
 * trace: "req ab12…cd34 · cached 2h" for one request, "5 requests · req ab12…cd34" for several, and
 * "computed in code · QUANT" for a derived number. A trace is never longer than SHORT_TRACE_MAX.
 */
export interface ShortNote {
  text: string;
  trace: string;
}

export interface Footnote {
  /** The superscript number. */
  n: number;
  /**
   * What it points at: a metric (M#), an evidence bundle (E#), a figure's dataset (D#) or a CODE
   * FALLBACK step (its index in the run's fallbacks, "0", "1", …).
   */
  key: string;
  kind: "metric" | "evidence" | "figure" | "fallback";
  firstCitedIn: CiteSection;
  /**
   * The long note, for the request inspector, the note's hover title and the printed endnotes:
   * "Qloo /v2/insights · brand ← R1 Juniper Cola · 20 rows. Distinctiveness rank of …, computed in QUANT
   * from 5 requests." Evidence notes carry the bundle's purpose and summary.
   */
  text: string;
  /** The long trace: "req ab12…cd34 · cached 2h", "7 requests · req ab12…cd34 · partly cached", "computed in code · QUANT · subs.distinctiveness". */
  trace: string;
  /** What the margin prints. */
  short: ShortNote;
  metric: MetricView | null;
  evidenceIds: EvidenceId[];
  /** The requests behind it, in ledger order. Empty for a number no request produced. */
  requests: RequestRef[];
  /** Set for DERIVED metrics: computed in code by QUANT with this formula. */
  computed: { formulaId: string; label: string } | null;
  /** Set when the metric is UNAVAILABLE: why it was not measured. */
  unavailable: { reason: NoValueReason | null; label: string } | null;
  /** Set for a CODE FALLBACK note: the ladder step code took, never the model. */
  fallback: { from: string; to: string; reason: string } | null;
}

// Head ------------------------------------------------------------------------------------------------

export interface SignalTag {
  signal: Signal;
  /** "Mixed signal"; the running head uppercases it. */
  label: string;
}

export interface ConvictionSummary {
  score: number;
  band: ConfidenceBand;
  /** "High". */
  bandLabel: string;
  /** "High · 80". */
  text: string;
  /** Marker position on the meter, 0–1. */
  position: number;
}

export interface BriefHeader {
  pillar: Pillar | null;
  /** "Investment". */
  deskLabel: string | null;
  job: Job | null;
  /** The running head's job label: "Competitors", "Compare two brands" (JOB_HEAD_LABEL). */
  jobLabel: string | null;
  /** The compiled mnemonic, "JUNIPER COLA <BRAND> HLTH". */
  mnemonic: string | null;
  question: string | null;
  signal: SignalTag | null;
  /**
   * The finding in a few words for the running head: the verdict tag ("Taste island"), else the
   * signal label for a note without one. Null until the report is final.
   */
  finding: string | null;
  /** Null until the report is final. */
  conviction: ConvictionSummary | null;
  /** "A1F3", from the run id. */
  briefId: string;
  /** "Brief A1F3". */
  briefLabel: string;
  /** "14 Oct 2026" (UTC), from the run's first event. */
  date: string | null;
  /** Estimated reading time of the finished brief; null while live. */
  readMinutes: number | null;
  figureCount: number;
  /** Qloo requests made or served for this brief. */
  sourceCount: number;
  /** Outline footer: "5 min read · 2 figures · 24 sources", or "Being written · since 09:12:04". */
  footer: string;
  /** Child runs launched from a next move. */
  parentRunId: string | null;
  investmentBanner: boolean;
  incomplete: boolean;
}

export interface OutlineEntry {
  id: BriefSectionId;
  /** "01" … "06". */
  number: string;
  label: string;
  /** False while the section has nothing to show yet (dimmed in the outline). */
  available: boolean;
}

// Answer and conviction ------------------------------------------------------------------------------------

export interface BriefAnswer {
  /** pending: written last, after the check; stopped: the run ended before it was written. */
  state: "pending" | "final" | "stopped";
  /**
   * "Mixed signal"; "Written last, after the check" while pending; "Waiting for your pick" (needs
   * input), "Question refused", else "Not written · run stopped".
   */
  tag: string;
  signal: SignalTag | null;
  headline: Inline[] | null;
  thesis: Inline[] | null;
}

export interface ConvictionLine {
  rule: ConfidenceRule;
  /** In a reader's words (convictionRuleLabel): "Code fell back to a simpler query", "Signal is insufficient evidence". */
  label: string;
  count: number;
  points: number;
  /** The ceiling a cap rule sets (R1, CONFIDENCE_CAP); absent for a penalty. */
  cap?: number;
  /** "−10", or for a cap "at most 70". */
  pointsText: string;
}

export interface BriefConviction {
  /** stopped: the run ended before the check, so there is no score. */
  state: "pending" | "final" | "stopped";
  /** "Computed, not chosen", "Pending · computed after the check" or "Not computed · run stopped". */
  aside: string;
  summary: ConvictionSummary | null;
  /** LOW 0–0.5, MEDIUM 0.5–0.75, HIGH 0.75–1, as fractions of the meter. */
  scale: { band: ConfidenceBand; label: string; from: number; to: number }[];
  ticks: number[];
  ruleNote: string;
  /** "Why 80" with the penalty lines and the total; null while pending. */
  why: { label: string; lines: ConvictionLine[]; total: { text: string; label: string } } | null;
  /** Evidence bundles with status ok: "8 of 9 evidence bundles ok". */
  coverage: { ok: number; total: number; text: string } | null;
}

/** Scored from the report; awaiting while live; not_scored when the run stopped without a report. */
export type PriorState = "refuted" | "confirmed" | "inconclusive" | "awaiting_data" | "awaiting_check" | "not_scored";

export interface BriefPrior {
  id: HypothesisId;
  /** "We expected: Juniper Cola and Kestrel Tonic are near-substitutes." */
  expected: string;
  expectation: string;
  testTool: ToolName;
  state: PriorState;
  /** × ✓ – · */
  mark: string;
  /** "REFUTED", "AWAITING DATA", "NOT SCORED". */
  word: string;
  /** "Measured: …" with footnotes once scored; null while awaiting. */
  measured: Inline[] | null;
  /** While awaiting: "Written before data · 09:12:04 · age data in"; "Run stopped before the check" once not scored. */
  progress: string | null;
}

export interface BriefPriors {
  /** "Three priors, written before any data · 09:12:04". */
  kicker: string;
  /** UTC time the plan arrived; null without a plan. */
  lockedAt: string | null;
  /** "1 refuted · 1 confirmed · 1 inconclusive"; null while live. */
  tally: string | null;
  items: BriefPrior[];
}

// Evidence ---------------------------------------------------------------------------------------------

export interface BriefKeyFigure {
  key: string;
  state: "ready" | "pending";
  metric: MetricView | null;
  /**
   * The number the strip prints: the head of the metric's own display ("+0.34" of "+0.34 · site 1 of 8 ·
   * city 5 of 8"), whose rest moves to `comparator`; "not measured" when UNAVAILABLE, null while pending.
   * Never a number the run did not print.
   */
  value: string | null;
  footnote: number | null;
  /**
   * A short label (A/Key figure): "Audience overlap", "Distinctiveness". The report's KPI label when it
   * is short, else the job's slot label, else the metric's short label; the full label is `metric.label`.
   */
  label: string;
  /**
   * The line under it: "with Granite Outfitters", "vs peers", "Apr–Sep 2025 only", "site 1 of 8 · city 5 of 8",
   * "vs restaurant baseline"; null when there is none.
   */
  comparator: string | null;
  /** While pending: "computing · QUANT" or "waiting on age data"; "not measured · run stopped" once the run ended without it. */
  pendingNote: string | null;
}

export interface LegendSeries {
  key: string;
  label: string;
  /** subject: $data; comparison: $data-2; other: grouped points. */
  role: "subject" | "comparison" | "other";
}

export interface FigureLegend {
  series: LegendSeries[];
  /** A colour ramp's ends for heatmaps. */
  ramp: { min: number; max: number; label: string } | null;
  /** Short column codes for matrices: "JC Juniper Cola". */
  codes: { key: string; code: string; label: string }[];
}

export interface FigureSource {
  /**
   * "Source: Qloo /v2/insights · 8 requests · computed in code", or for a location figure "Source: Qloo
   * /v2/insights · location ← East Nashville · 3 requests · read by POINT · computed in code".
   */
  text: string;
  /** The place a location figure reads ("East Nashville", "Austin"); null for every other figure. */
  place: string | null;
  endpoints: { path: SourceEndpoint; filterLabels: string[] }[];
  requestCount: number;
  computedInCode: boolean;
  requestId: string | null;
  /** "ab12…cd34"; null without a request. */
  shortRequestId: string | null;
  /** The assembler's full source line, when the report carries one. */
  line: string | null;
}

export interface BriefFigure {
  /** FIGURE n. */
  number: number;
  datasetId: DatasetId;
  kind: DatasetKind;
  viz: VizComponent;
  title: string;
  /** The caption with tokens resolved; the figure's own footnote is `footnote`. */
  caption: Inline[];
  footnote: number;
  badges: Badge[];
  /** The full dataset when the stream carried it inline (up to 64 KB); null otherwise. */
  dataset: DatasetEnvelope | null;
  /**
   * The dataset was not streamed inline (a large LiftMap or matrix): fetch it from `datasetUrl`,
   * then recompute `legend` with figureLegend, the footnote text with figureNoteText and the ⓘ
   * link with methodHrefFor, since all three read the dataset.
   */
  needsFetch: boolean;
  datasetUrl: string;
  legend: FigureLegend;
  source: FigureSource;
  evidenceIds: EvidenceId[];
  formulaIds: string[];
  /** "/method#<formula id>" for the ⓘ link; "/method" until the dataset names its formulas. */
  methodHref: string;
  /** Shown before the report assembles its exhibits; title from the dataset, no caption. */
  provisional: boolean;
  /** How a location figure read its area, and the CODE FALLBACK notes that got it there; null elsewhere. */
  location: FigureLocation | null;
}

/** How a figure's area was read (S7 ladder): the method and the fallback steps down to it. */
export interface FigureLocation {
  place: string | null;
  method: LocationMethod | null;
  /** "read by POINT"; null when the method is unknown. */
  text: string | null;
  /** Footnotes of the CODE FALLBACK steps behind this figure, in order. */
  fallbackNotes: number[];
}

export interface BriefArgument {
  id: ArgumentId;
  section: ArgumentSection;
  sectionLabel: string;
  strength: Strength;
  strengthLabel: string;
  /** QLOO DATA. */
  qlooFact: Inline[];
  /** OUR READ. */
  ourRead: Inline[];
}

export interface BriefRecommendation {
  action: string;
  priority: Priority;
  priorityLabel: string;
  argumentIds: ArgumentId[];
}

export interface BriefEvidence {
  /** "2 figures · 14 of 20 requests", or live "2 of 4 key figures in · exhibits drafted last". */
  aside: string;
  keyFigures: BriefKeyFigure[];
  figures: BriefFigure[];
  arguments: BriefArgument[];
  recommendations: BriefRecommendation[];
}

// Risks -------------------------------------------------------------------------------------------------

export interface ChangeRow {
  n: number;
  /** WE WOULD CHANGE OUR VIEW IF. */
  condition: Inline[];
  /** NOW: the first metric the condition rests on. */
  now: { metric: MetricView; footnote: number } | null;
  /** TRIGGER: the contracts carry none yet, so always null. */
  trigger: string | null;
}

export interface BriefLimitation {
  text: string;
  source: Limitation["source"];
  flag: Flag | null;
  flagLabel: string | null;
}

export interface BriefRisks {
  changes: ChangeRow[];
  limitations: BriefLimitation[];
}

// Method and sources ------------------------------------------------------------------------------------

/**
 * planned: no call yet; not_run: the run ended without calling it (a step the opening scan covered,
 * or a run that stopped first); stopped: a call was still running when the run ended.
 */
export type StepStatus = "planned" | "running" | "not_run" | "stopped" | SkillStatus;

export interface MethodCall {
  toolCallId: string;
  /** stopped: still running when the run ended. */
  status: "running" | "stopped" | SkillStatus;
  ms: number | null;
  /** Qloo calls made or served for it. */
  requests: number;
  estimate: number | null;
  error: string | null;
}

export interface MethodStep {
  /** 1-based position in the list. */
  n: number;
  stepId: StepId | null;
  /** scan: code's opening scan; plan: an ANALYST plan step; followup: a pivot or an unplanned call. */
  origin: "scan" | "plan" | "followup";
  tool: ToolName;
  toolLabel: string;
  purpose: string | null;
  phase: Phase | null;
  /** Estimated Qloo calls (plan estimate, else the tool's own). */
  estimate: number | null;
  /** Qloo calls actually made or served. */
  actual: number;
  /** SEC and Census calls made or served (Part 9); they cost no Qloo calls. Absent reads as 0. */
  publicActual?: number;
  status: StepStatus;
  calls: MethodCall[];
  pivot: boolean;
  triggerFindingId: FindingId | null;
}

export interface MethodPivot {
  toolCallId: string;
  tool: ToolName;
  toolLabel: string;
  triggerFindingId: FindingId;
  /** The finding that triggered it, or null when the run never streamed it. */
  finding: string | null;
  /** "ANALYST PIVOT · F1 Taste island → Cultural neighbourhood". */
  line: string;
}

export interface MethodFallback {
  from: string;
  to: string;
  reason: string;
  toolCallId: string | null;
  /** "CODE FALLBACK · 26-week window → 13-week window: <reason>". */
  line: string;
}

export interface Interpretation {
  deskLabel: string;
  jobLabel: string;
  mnemonic: string;
  /** Named subjects, primary first: "Juniper Cola, Kestrel Tonic". */
  subjects: string[];
  /** "Brand Alpha metro · Riverside", ages and domains; null when the question names none. */
  scope: string | null;
  /** The neighbourhood the question names (CLERK's geo.area), as asked; null or absent when it names none. */
  area?: string | null;
  /** "Investment lens · 2 of 3 names matched exactly". */
  detail: string;
  assumptions: string[];
  /** A group-level reframe CLERK applied (financial advice), or null. */
  reframe: string | null;
  /**
   * D41: the question asked for more than any job covers and was read as the nearest job. `line` is the
   * plain sentence for the top of the answer: "Read as Brand health. Not covered: sales and prices."
   * Null (or absent) when the job fits the question as asked.
   */
  readAs?: ReadAs | null;
  resolves: { mention: string; entityType: EntityType; match: MatchClass; matchLabel: string; name: string | null; applied: boolean }[];
  ms: number | null;
}

/** The "Read as" chip and its sentence (D41, ANSWER_QUALITY §8). */
export interface ReadAs {
  /** The job the question was read as, in reader words. */
  jobLabel: string;
  /** What the question asks that the data does not cover ("sales", "rents"); may be empty. */
  notCovered: string[];
  /** "Read as: Brand health". */
  chip: string;
  /** "Read as Brand health. Not covered: sales and prices; Culture Terminal has no data on them." */
  line: string;
}

export interface CheckerLine {
  /**
   * skipped: an evidence digest (the analysis did not finish), whose prose no CHECKER read;
   * stopped: the run ended before the check.
   */
  state: "queued" | "checking" | "passed" | "rejected" | "skipped" | "stopped";
  traced: number | null;
  total: number | null;
  adviceTerms: number | null;
  attempt: number | null;
  warnings: number;
  /** "27/27 numbers traced · 0 advice terms"; null before the check. */
  line: string | null;
}

export interface BriefMethod {
  /** "7 steps · 20 requests, 9 cached · computed in code, then traced". */
  line: string;
  steps: MethodStep[];
  pivots: MethodPivot[];
  fallbacks: MethodFallback[];
  interpretation: Interpretation | null;
  checker: CheckerLine;
  models: { clerk: string | null; analyst: string | null };
  requests: { total: number; network: number; cached: number; reused: number };
  /** "Context: AI $0.012 · web $0.041 (3 searches)" (R4, R5); null without side calls. */
  context?: string | null;
}

/**
 * One lookup, in arrival order: a Qloo request, or an SEC or Census request (Part 9). For a public one
 * `qlooCallId` holds its public call id, `requestId` its reference (a CIK, or the Census dataset, vintage
 * and geography), and there is no filter type or row count.
 */
export interface BriefSource {
  /** 1-based, in arrival order. */
  n: number;
  qlooCallId: string;
  /** Where the data came from; absent reads as "qloo". */
  source?: EvidenceSource;
  /** The host of an SEC or Census request ("data.sec.gov"); null or absent for Qloo. */
  host?: string | null;
  toolCallId: string | null;
  tool: ToolName | null;
  endpoint: SourceEndpoint;
  filterType: string | null;
  filterLabel: string | null;
  /** Subject refs with names where known: "R1 Juniper Cola". */
  refs: string[];
  /** Redacted parameters as the server sent them; never the API key. */
  params: [string, string][];
  rows: number | null;
  ms: number;
  status: number | null;
  error: string | null;
  cache: CacheStatus;
  cacheAgeMs: number | null;
  cacheLabel: string;
  originRunId: string | null;
  requestId: string | null;
  shortRequestId: string;
  /** When the event arrived (UTC ISO). */
  at: string;
  evidenceIds: EvidenceId[];
  /** Footnotes that resolve to this request. */
  footnotes: number[];
}

export interface BriefSources {
  /** "24 requests · 11 cached · 3 endpoints". */
  line: string;
  items: BriefSource[];
  endpoints: { path: SourceEndpoint; filterType: string | null; filterLabel: string | null; calls: number }[];
}

// Location -----------------------------------------------------------------------------------------------

/**
 * One area a location brief read, with how it was read (SPEC §5.3 S7 ladder: POLYGON → POINT → QUERY).
 * An area read by several calls is one area: the method its last read ended on, every read's fallbacks.
 */
export interface BriefArea {
  /** "East Nashville"; unique within a brief. */
  name: string;
  method: LocationMethod | null;
  /** "its gazetteer boundary", "a centre point", "a place-name search". */
  methodLabel: string | null;
  /** The CODE FALLBACK steps code took to read it, each with its footnote (null until cited). */
  fallbacks: { from: string; to: string; reason: string; line: string; footnote: number | null }[];
}

/**
 * Where a location brief stands (SPEC §8: the area name and the location method): the city, the areas
 * read, and how. Null for a brief that reads no place.
 */
export interface BriefLocation {
  /** "Nashville", from the intent or a lift map; null when the run names no city. */
  city: string | null;
  /** Areas in the order they were read; empty for a metro-wide lift map. */
  areas: BriefArea[];
  /** "East Nashville, Nashville", or the city alone; null when neither is known. */
  place: string | null;
}

// Follow-up -----------------------------------------------------------------------------------------------

/** A next move as the follow-up bar's chip prints it (SPEC §7.3): a child run's question and its desk. */
export interface BriefNextMove {
  label: string;
  question: string;
  /** The desk the question reads as (by its words; CLERK decides when it runs). */
  pillar: Pillar;
  /** "Location": the chip's desk label, uppercased on the page. */
  deskLabel: string;
  /** "/ask?q=…&parent=<runId>". */
  href: string;
}

// Live --------------------------------------------------------------------------------------------------

export type StageRole = "clerk" | "analyst" | "quant" | "checker";
export type StageState = "queued" | "active" | "idle" | "done" | "failed";

export interface StageView {
  role: StageRole;
  label: string;
  state: StageState;
  /** "✓", "writing", "computing", "queued". */
  word: string;
  /** "Clerk ✓", "Analyst writing". */
  text: string;
}

export interface Meter {
  label: string;
  used: number;
  limit: number | null;
  /** "7 / 40", "$0.06 / $0.60", "00:21 / 180 s". */
  text: string;
  /** used / limit, 0–1. */
  fraction: number;
  warn: boolean;
}

export interface IncomingRequest {
  key: string;
  /** fetching: the call in flight; queued: the rest of a running tool's estimate; received: a call that arrived. */
  state: "fetching" | "received" | "queued";
  toolCallId: string | null;
  tool: ToolName | null;
  /** "Qloo /v2/insights · tags ← R2 Kestrel Tonic · fetching", or "Qloo /v2/insights · tags ← R2 Kestrel Tonic" once received. */
  text: string;
  /** "fetching · 00:04", "req ab12…cd34 · 20 rows · 154 ms", "3 more queued". */
  trace: string;
  /** Pending requests this row stands for (queued rows group them). */
  count: number;
  sourceIndex: number | null;
}

export interface BriefLive {
  stages: StageView[];
  progress: {
    /** "Gathering evidence". */
    label: string;
    sourcesIn: number;
    /** The plan's estimate, at least what has arrived; null before the plan and once no more calls can come. */
    sourcesExpected: number | null;
    /** "· 7 of ~12 sources", or "· 7 sources" without an estimate. */
    count: string;
    elapsedMs: number;
    /** "00:21". */
    clock: string;
    /** For the progress bar, 0–1, by stage; it only moves forward. */
    fraction: number;
  };
  meters: { requests: Meter; cost: Meter; time: Meter };
  incoming: IncomingRequest[];
  /** "Being written · since 09:12:04". */
  since: string | null;
  /** The run still accepts a cancel. */
  cancellable: boolean;
}

/** The numbers-traced note at the top of the margin, live and final. */
export interface TraceNote {
  /**
   * passed and rejected follow the CHECKER; skipped: an evidence digest, which has no prose to
   * trace; stopped: the run ended before the check.
   */
  state: "pending" | "checking" | "passed" | "rejected" | "skipped" | "stopped";
  /** "27/27 numbers traced", "0 of ~27 numbers traced" (from the draft), "Numbers traced after the check" or "Not checked". */
  headline: string;
  /** "Checker · 0 advice terms · 14 Oct 2026, 09:14" or "Checker queued · 7 sources in, 2 cited". */
  detail: string;
}

export type BriefTerminal =
  | {
      kind: "needs_input";
      mention: string;
      entityType: EntityType;
      reason: MatchClass;
      reasonLabel: string;
      candidates: PickerCandidate[];
      message: string;
    }
  | { kind: "refused"; category: SafetyCategory | null; categoryLabel: string | null; reframe: string | null; message: string }
  | { kind: "failed"; reason: string | null; errors: { code: string; message: string }[]; message: string }
  | { kind: "cancelled"; reason: string | null; message: string }
  | { kind: "incomplete"; badge: "INCOMPLETE"; reason: string | null; message: string };

export interface BriefStatusLine {
  /** "Analytics, not financial advice · Group-level taste data · No individuals · Snapshot 14 Oct 2026". */
  honesty: string;
  snapshot: string | null;
  /** "Trend window Apr–Sep 2025"; null when no trending data is involved. */
  window: string | null;
  /** "Qloo 24 req · 11 cached". */
  requests: string;
}

export interface BriefModel {
  runId: string;
  mode: BriefMode;
  status: RunStatus;
  header: BriefHeader;
  outline: OutlineEntry[];
  answer: BriefAnswer;
  conviction: BriefConviction;
  priors: BriefPriors;
  evidence: BriefEvidence;
  risks: BriefRisks;
  method: BriefMethod;
  sources: BriefSources;
  /** Every footnote, by number. */
  footnotes: Footnote[];
  trace: TraceNote;
  /** Live progress; null once the run has ended. */
  live: BriefLive | null;
  /** How the run stopped short of a brief, or null. */
  terminal: BriefTerminal | null;
  /** Where a location brief stands; null for every other brief. */
  location: BriefLocation | null;
  nextMoves: BriefNextMove[];
  disclaimers: string[];
  statusLine: BriefStatusLine;
}
