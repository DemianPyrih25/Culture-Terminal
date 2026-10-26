import { z } from "zod";
import { DatasetKind, ScorecardRow, TrendWindow } from "./datasets";
import {
  ArgumentSection,
  Badge,
  Comparator,
  ConfidenceBand,
  Flag,
  HypothesisVerdict,
  IsoDateTime,
  Job,
  Mode,
  Pillar,
  Priority,
  Signal,
  SkillId,
  Strength,
} from "./enums";
import {
  ArgumentIdSchema,
  DatasetIdSchema,
  EntityRefSchema,
  EvidenceIdSchema,
  HypothesisIdSchema,
  MetricIdSchema,
  StepIdSchema,
} from "./ids";
import { QUESTION_MAX_CHARS } from "./limits";
import { QlooPath } from "./qloo-types";
import { VizComponent } from "./viz-compat";

/**
 * Model-facing schemas (snake_case) for the two strict submit tools, and the code-assembled Report.
 *
 * Strict tool use strips length and count limits and id patterns from the schema the API sees, so
 * each model-facing schema exists twice: the `…Shape` variant is structural only (exactly what the
 * API guarantees, ids as plain strings; what the plan and report.draft events carry), and the limited
 * variant adds what the CHECKER enforces server-side: id formats (V1) and lengths and counts (V9).
 * Descriptions state the limits so the model can follow them.
 */

type Limits = boolean;

const text = (limits: Limits, max: number, describe: string) =>
  (limits ? z.string().min(1).max(max) : z.string()).describe(describe);

const list = <T extends z.ZodType>(limits: Limits, item: T, min: number, max: number, describe: string) =>
  (limits ? z.array(item).min(min).max(max) : z.array(item)).describe(describe);

/** An id field: the format-checked id schema when limited, a plain string with the same description otherwise. */
const idOf = <Lim extends Limits, T extends z.ZodType<string>>(limits: Lim, id: T): Lim extends true ? T : z.ZodString =>
  (limits ? id : z.string().describe(id.description ?? "")) as Lim extends true ? T : z.ZodString;

// submit_plan ----------------------------------------------------------------------------------------

function buildSubmitPlan<Lim extends Limits>(limits: Lim) {
  const Hypothesis = z.strictObject({
    id: idOf(limits, HypothesisIdSchema.describe("H1, H2, … in order.")),
    statement: text(limits, 300, "A falsifiable prior from your own knowledge, written before any data (≤300 chars)."),
    expectation: text(limits, 300, "What the data should show if the prior is right (≤300 chars)."),
    test_tool: SkillId.describe("The tool whose result will confirm or refute it."),
    metric_hint: text(limits, 160, "The measurement that decides it, e.g. 'rank of Juniper Cola in its own row' (≤160 chars)."),
  });
  const Step = z.strictObject({
    id: idOf(limits, StepIdSchema.describe("S1, S2, … in order.")),
    tool: SkillId,
    purpose: text(limits, 200, "Why this step, in one sentence (≤200 chars)."),
  });
  return z.strictObject({
    restated_question: text(limits, 300, "The business question in one sentence (≤300 chars)."),
    hypotheses: list(limits, Hypothesis, 2, 4, "Two to four priors, written before data."),
    steps: list(limits, Step, 1, 12, "The investigation steps, in order (at most 12)."),
    assumptions: list(limits, z.string().describe("One assumption."), 0, 6, "Assumptions you are making (at most 6)."),
  });
}

/** submit_plan input in its structural form (no limits, ids as plain strings); the loop checks it in code, since the tool is not strict. */
export const SubmitPlanInputShape = buildSubmitPlan(false);
/** The structural plan, as the `plan` event and RunState carry it. */
export type SubmitPlanInputShape = z.infer<typeof SubmitPlanInputShape>;
/** submit_plan input with the V1 id formats and V9 limits enforced server-side. */
export const SubmitPlanInput = buildSubmitPlan(true);
/** A checked plan with narrow ids, what parseToolInput returns. */
export type SubmitPlanInput = z.infer<typeof SubmitPlanInput>;
export type PlanHypothesis = SubmitPlanInput["hypotheses"][number];
export type PlanStep = SubmitPlanInput["steps"][number];

// submit_report (PLAN §7, SPEC §7.1) ------------------------------------------------------------------

export const REPORT_LIMITS = {
  headline: 120,
  thesis: 600,
  part: 400,
  note: 300,
  argumentsMin: 3,
  argumentsMax: 5,
  hypothesisVerdictsMax: 4,
  bearCaseMax: 3,
  nextMovesMin: 2,
  nextMovesMax: 4,
  recommendationsMax: 5,
  exhibitsMax: 10,
  openQuestionsMax: 5,
} as const;

/** The verdict tag (Report.verdict.tag): two to five words, at most 32 characters, no digits or tokens (CHECKER V9). */
export const VERDICT_TAG_LIMITS = { wordsMin: 2, wordsMax: 5, chars: 32 } as const;

/** The words of a verdict tag: runs of non-space characters. */
export function verdictTagWords(tag: string): string[] {
  return tag.split(/\s+/).filter((w) => w !== "");
}

/**
 * How a verdict tag breaks its rule, one predicate per problem ("has 7 words, not 2 to 5"); empty when
 * it keeps it. Surrounding spaces do not count.
 */
export function verdictTagProblems(tag: string): string[] {
  const L = VERDICT_TAG_LIMITS;
  const trimmed = tag.trim();
  if (trimmed === "") return ["is empty"];
  const out: string[] = [];
  const words = verdictTagWords(trimmed).length;
  if (words < L.wordsMin || words > L.wordsMax) {
    out.push(`has ${words} ${words === 1 ? "word" : "words"}, not ${L.wordsMin} to ${L.wordsMax}`);
  }
  if (trimmed.length > L.chars) out.push(`has ${trimmed.length} characters, more than ${L.chars}`);
  if (/\d/.test(trimmed)) out.push("contains digits");
  // {{WINDOW}} has no digits; a list row or the running head would print any token raw.
  if (/[{}[\]]/.test(trimmed)) out.push("contains tokens");
  return out;
}

/** True when the tag keeps its rule, so a list row or the running head may print it. */
export function isVerdictTag(tag: unknown): tag is string {
  return typeof tag === "string" && verdictTagProblems(tag).length === 0;
}

const VERDICT_TAG_DESCRIPTION =
  "The verdict in two to five words, at most 32 characters, no digits or tokens: the finding a reader " +
  "scans in a list of briefs, e.g. 'Taste island', 'Clear lead', 'Strong fit'. Sentence case. Not a Qloo tag.";

/**
 * verdict_tag: limited, the rule as custom issues (V9). Structural, it defaults to empty so a draft
 * stored before the tag existed still parses; the strict tool schema lists it as required all the same.
 */
const verdictTag = <Lim extends Limits>(limits: Lim): Lim extends true ? z.ZodString : z.ZodDefault<z.ZodString> =>
  (limits
    ? z
        .string()
        .superRefine((tag, ctx) => {
          for (const message of verdictTagProblems(tag)) ctx.addIssue({ code: "custom", message });
        })
        .describe(VERDICT_TAG_DESCRIPTION)
    : z.string().default("").describe(VERDICT_TAG_DESCRIPTION)) as Lim extends true ? z.ZodString : z.ZodDefault<z.ZodString>;

function buildReportDraft<Lim extends Limits>(limits: Lim) {
  const L = REPORT_LIMITS;
  const ids = <T extends z.ZodType<string>>(id: T, what: string) => z.array(idOf(limits, id)).describe(what);
  return z.strictObject({
    headline: text(limits, L.headline, "One line; tokens allowed (≤120 chars)."),
    signal: Signal.describe("The signal for this question. insufficient_evidence when fewer than three bundles are ok."),
    verdict_tag: verdictTag(limits),
    thesis: text(limits, L.thesis, "Two or three sentences with {{M#}} and [E#] tokens (≤600 chars)."),
    hypothesis_verdicts: list(
      limits,
      z.strictObject({
        hypothesis_id: idOf(limits, HypothesisIdSchema),
        verdict: HypothesisVerdict,
        metric_ids: ids(MetricIdSchema, "Metrics that decide it (at least one)."),
        note: text(limits, L.note, "What was measured, with tokens (≤300 chars)."),
      }),
      0,
      L.hypothesisVerdictsMax,
      "One verdict per planned hypothesis (at most 4).",
    ),
    arguments: list(
      limits,
      z.strictObject({
        id: idOf(limits, ArgumentIdSchema.describe("A1, A2, … in order.")),
        section: ArgumentSection,
        qloo_fact: text(limits, L.part, "QLOO DATA: what the data shows, tokens only for numbers (≤400 chars)."),
        our_read: text(limits, L.part, "OUR READ: the interpretation, kept separate from the data (≤400 chars)."),
        metric_ids: ids(MetricIdSchema, "Metrics cited (at least one)."),
        evidence_ids: ids(EvidenceIdSchema, "Evidence bundles cited."),
      }),
      L.argumentsMin,
      L.argumentsMax,
      "Three to five arguments.",
    ),
    exhibits: list(
      limits,
      z.strictObject({
        dataset_id: idOf(limits, DatasetIdSchema),
        title: text(limits, 80, "Exhibit title (≤80 chars)."),
        caption: text(limits, 200, "One-sentence caption, tokens allowed (≤200 chars)."),
      }),
      0,
      L.exhibitsMax,
      "Exhibits in layout order (at most 10). Code picks each chart from the dataset kind.",
    ),
    bear_case: list(
      limits,
      z.strictObject({
        text: text(limits, L.note, "What would change our mind (≤300 chars)."),
        metric_ids: ids(MetricIdSchema, "Metrics it rests on."),
      }),
      1,
      L.bearCaseMax,
      "One to three bear-case items.",
    ),
    recommendations: list(
      limits,
      z.strictObject({
        action: text(limits, 200, "A concrete next action, never buy/sell advice (≤200 chars)."),
        priority: Priority,
        argument_ids: ids(ArgumentIdSchema, "Arguments that support it (at least one)."),
      }),
      0,
      L.recommendationsMax,
      "Recommendations (at most 5).",
    ),
    next_moves: list(
      limits,
      z.strictObject({
        label: text(limits, 40, "Chip label (≤40 chars)."),
        question: text(limits, QUESTION_MAX_CHARS, "The full question for a new run (≤400 chars)."),
      }),
      L.nextMovesMin,
      L.nextMovesMax,
      "Two to four follow-up questions; each launches a child run.",
    ),
    open_questions: list(
      limits,
      text(limits, 200, "One open question (≤200 chars)."),
      0,
      L.openQuestionsMax,
      "What the data could not answer (at most 5).",
    ),
  });
}

/**
 * submit_report input as the API guarantees it (strict, every field required, no unions or optionals,
 * ids as plain strings). Only verdict_tag defaults, to "", for drafts stored before it existed.
 */
export const ReportDraftShape = buildReportDraft(false);
/** The structural draft, as the `report.draft` event and RunState carry it. */
export type ReportDraftShape = z.infer<typeof ReportDraftShape>;
/** submit_report input with the V1 id formats and V9 limits enforced server-side. */
export const ReportDraft = buildReportDraft(true);
/** A checked draft with narrow ids, what parseToolInput returns and the Report is assembled from. */
export type ReportDraft = z.infer<typeof ReportDraft>;

// GHOST (§6.6) --------------------------------------------------------------------------------------

/** GHOST's answer: the same model, no tools (`messages.parse`), so structured-output subset only. */
export const GhostAnswer = z.strictObject({
  headline: z.string(),
  picks: z.strictObject({
    competitors: z.array(z.string()),
    markets: z.array(z.string()),
    neighbourhoods: z.array(z.string()),
    tenants: z.array(z.string()),
    partners: z.array(z.string()),
  }),
  numeric_claims: z.array(z.string()).describe("Every number GHOST states, verbatim."),
});
export type GhostAnswer = z.infer<typeof GhostAnswer>;

export const GhostPickCategory = z.enum(["competitors", "markets", "neighbourhoods", "tenants", "partners"]);
export type GhostPickCategory = z.infer<typeof GhostPickCategory>;

export const GHOST_HONESTY_LINE = "Agreement is measured against Qloo's taste graph, not outcomes.";

export const GhostDiff = z.object({
  items: z.array(
    z.object({
      name: z.string(),
      category: GhostPickCategory,
      /** both ✓, qloo_only ★, llm_only ✗. */
      status: z.enum(["both", "qloo_only", "llm_only"]),
      /** For llm_only picks: whether the name resolves exactly in Qloo; null otherwise. */
      resolvesInQloo: z.boolean().nullable(),
      ref: EntityRefSchema.nullable(),
    }),
  ),
  overlapAt5: z.number().min(0).max(1).nullable(),
  resolvability: z.number().min(0).max(1).nullable(),
  unsourcedNumericClaims: z.int().nonnegative(),
  meanPopularity: z.object({ ghost: z.number().nullable(), qloo: z.number().nullable() }),
  honestyLine: z.literal(GHOST_HONESTY_LINE),
});
export type GhostDiff = z.infer<typeof GhostDiff>;

// CHECKER (§6.2) ----------------------------------------------------------------------------------------

export const ValidationRule = z.enum(["V1", "V2", "V3", "V4", "V5", "V6", "V7", "V8", "V9", "V10"]);
export type ValidationRule = z.infer<typeof ValidationRule>;

export const ValidationIssue = z.object({
  rule: ValidationRule,
  /**
   * reject: triggers the repair turn; warn: accepted, costs confidence; forced/injected: code fixed it
   * (V7, V8, and V9 trimming the verdict tag on the last attempt).
   */
  action: z.enum(["reject", "warn", "forced", "injected"]),
  message: z.string(),
  /** Where in the draft, e.g. "arguments[2].our_read"; null for whole-report issues. */
  path: z.string().nullable(),
  /** Ids or phrases involved, e.g. an unknown M# or a banned phrase. */
  subjects: z.array(z.string()),
});
export type ValidationIssue = z.infer<typeof ValidationIssue>;

export const NumbersTraced = z
  .object({ traced: z.int().nonnegative(), total: z.int().nonnegative() })
  .refine((n) => n.traced <= n.total, { message: "traced cannot exceed total" });
export type NumbersTraced = z.infer<typeof NumbersTraced>;

// Confidence (§6.4) -------------------------------------------------------------------------------------

export const ConfidenceRule = z.enum([
  "dropped_entity",
  "code_fallback",
  "coarse_geohash",
  "stale_momentum",
  "thin_result",
  "quality_gate_drop",
  "checker_warning",
  "insufficient_evidence",
]);
export type ConfidenceRule = z.infer<typeof ConfidenceRule>;

/**
 * Points subtracted from 100 per occurrence (coarse_geohash, stale_momentum and insufficient_evidence
 * count once). insufficient_evidence alone puts a note in the LOW band: V7 left no reading to trust.
 */
export const CONFIDENCE_PENALTY: Readonly<Record<ConfidenceRule, number>> = {
  dropped_entity: 15,
  code_fallback: 10,
  coarse_geohash: 10,
  stale_momentum: 20,
  thin_result: 10,
  quality_gate_drop: 5,
  checker_warning: 5,
  insufficient_evidence: 60,
};

export function confidenceBand(score: number): ConfidenceBand {
  if (score >= 75) return "HIGH";
  if (score >= 50) return "MED";
  return "LOW";
}

export const Confidence = z.object({
  /** 100 minus penalties, floored at 0. Computed by code; the model never chooses it (D9). */
  score: z.int().min(0).max(100),
  band: ConfidenceBand,
  breakdown: z.array(
    z.object({ rule: ConfidenceRule, label: z.string(), count: z.int().positive(), points: z.int().nonpositive() }),
  ),
});
export type Confidence = z.infer<typeof Confidence>;

// Fixed text (§6.3) ---------------------------------------------------------------------------------------

export const FIXED_DISCLAIMERS = [
  "Analytics, not financial advice.",
  "Aggregated group-level taste signals; no individual-level inference.",
  "Affinity ≠ sales, share or causation.",
] as const;

/** The data line closing every disclaimer list; `window` is shown only when the note used trending. */
export function dataDisclaimer(fetchedAt: string, window: TrendWindow | null): string {
  const w = window ? `; trending window ${window.start}..${window.end}` : "";
  return `Data: Qloo hackathon dataset, fetched ${fetchedAt}${w}.`;
}

// Assembled Report (code-built, PLAN §7) ------------------------------------------------------------------

const draft = ReportDraftShape.shape;

export const ReportArgument = z.object({
  id: ArgumentIdSchema,
  section: ArgumentSection,
  qlooFact: z.string(),
  ourRead: z.string(),
  metricIds: z.array(MetricIdSchema),
  evidenceIds: z.array(EvidenceIdSchema),
  strength: Strength,
});
export type ReportArgument = z.infer<typeof ReportArgument>;

export const ReportExhibit = z.object({
  datasetId: DatasetIdSchema,
  kind: DatasetKind,
  viz: VizComponent,
  title: z.string(),
  caption: z.string(),
  badges: z.array(Badge),
  /** "Source: Qloo /v2/insights (urn:entity:brand) · req 9f2a… · fetched <ts> · cache 3h · Culture Terminal analysis". */
  sourceLine: z.string(),
  evidenceIds: z.array(EvidenceIdSchema),
});
export type ReportExhibit = z.infer<typeof ReportExhibit>;

export const Limitation = z
  .object({
    /** flag: from a data-quality flag; desk: a fixed per-desk bullet; open_question: from the model. */
    source: z.enum(["flag", "desk", "open_question"]),
    flag: Flag.nullable(),
    text: z.string(),
  })
  .refine((l) => (l.source === "flag") === (l.flag !== null), { message: "only flag limitations carry a flag" });
export type Limitation = z.infer<typeof Limitation>;

export const TokenUsage = z.object({
  input: z.int().nonnegative(),
  output: z.int().nonnegative(),
  cacheRead: z.int().nonnegative(),
  cacheCreation: z.int().nonnegative(),
});
export type TokenUsage = z.infer<typeof TokenUsage>;

export const Receipt = z.object({
  qlooNetwork: z.int().nonnegative(),
  qlooCached: z.int().nonnegative(),
  qlooReused: z.int().nonnegative(),
  endpoints: z.array(z.object({ path: QlooPath, filterType: z.string().nullable(), calls: z.int().positive() })),
  ms: z.int().nonnegative(),
  usd: z.number().nonnegative(),
  tokens: TokenUsage,
  numbersTraced: NumbersTraced,
  /** Model ids per LLM role; economy runs show the economy ANALYST. */
  models: z.object({ clerk: z.string().nullable(), analyst: z.string().nullable(), ghost: z.string().nullable() }),
  economy: z.boolean(),
});
export type Receipt = z.infer<typeof Receipt>;

export const Report = z.object({
  runId: z.string().min(1),
  question: z.string(),
  pillar: Pillar,
  job: Job,
  mode: Mode,
  createdAt: IsoDateTime,
  /** Code built an evidence-digest report because the ANALYST did not submit (INCOMPLETE badge). */
  incomplete: z.boolean(),
  /** Investment notes carry an amber not-advice banner above THE CALL. */
  investmentBanner: z.boolean(),
  dataFreshness: z.object({
    fetchedFrom: IsoDateTime.nullable(),
    fetchedTo: IsoDateTime.nullable(),
    trendWindow: TrendWindow.nullable(),
  }),
  verdict: z.object({
    headline: z.string(),
    signal: Signal,
    /**
     * The verdict in two to five words ("Taste island") for list rows and the running head. Null when
     * the note has none that keeps the rule, absent in notes stored before it existed: readers then
     * print the signal label.
     */
    tag: z.string().nullable().optional(),
    thesis: z.string(),
    confidence: Confidence,
    /** Evidence bundles with status ok, out of all bundles (V7). */
    coverage: z.object({ evidenceOk: z.int().nonnegative(), evidenceTotal: z.int().nonnegative() }),
  }),
  scorecard: z.array(ScorecardRow),
  kpis: z.array(z.object({ metricId: MetricIdSchema, label: z.string(), comparator: Comparator.nullable() })),
  exhibits: z.array(ReportExhibit),
  arguments: z.array(ReportArgument),
  bearCase: z.array(z.object({ text: z.string(), metricIds: z.array(MetricIdSchema) })),
  recommendations: z.array(
    z.object({ action: z.string(), priority: Priority, argumentIds: z.array(ArgumentIdSchema) }),
  ),
  limitations: z.array(Limitation),
  disclaimers: z.array(z.string()),
  ghost: z.object({ answer: GhostAnswer, diff: GhostDiff }).nullable(),
  nextMoves: draft.next_moves,
  /** CHECKER warnings the report was accepted with. */
  warnings: z.array(ValidationIssue),
  receipt: Receipt,
});
export type Report = z.infer<typeof Report>;
