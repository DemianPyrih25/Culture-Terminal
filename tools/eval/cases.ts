// The pre-registered eval inputs (SPEC §6.6 and §6.7, D27): eval/questions.json, the 27 core, 4
// adversarial and 3 off-list questions both arms answer, and eval/reality_cases.json, the 12 public real-world
// choices the Reality Check scores. The schemas carry the registration rules (eval/README.md), so a
// file that breaks one fails to load. The files hold names and public sources only, never Qloo
// values or ids (D29).
import { readFileSync } from "node:fs";
import {
  EntityType,
  Job,
  JOB_PILLAR,
  MarketId,
  MetroId,
  Pillar,
  QUESTION_MAX_CHARS,
  SafetyCategory,
  SponsorCategory,
} from "@ct/contracts";
import { z } from "zod";

const EVAL_DIR = new URL("../../eval/", import.meta.url);
export const QUESTIONS_FILE = new URL("questions.json", EVAL_DIR);
export const REALITY_CASES_FILE = new URL("reality_cases.json", EVAL_DIR);

/** D27: the registered set sizes. Part 9 grew the core set to cover all 13 jobs at least twice. */
export const CORE_QUESTIONS = 27;
/** D27: every job has at least this many core questions. */
export const CORE_QUESTIONS_PER_JOB = 2;
export const ADVERSARIAL_QUESTIONS = 4;
/** D41: questions no job answers in full, each read as its nearest job. */
export const OFFLIST_QUESTIONS = 3;
export const REALITY_CASES = 12;

const Text = z.string().trim().min(1);
const IsoDate = z.iso.date();

/** The values that appear more than once, each listed once. */
function repeated(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const twice = new Set<string>();
  for (const v of values) (seen.has(v) ? twice : seen).add(v);
  return [...twice];
}

// eval/questions.json -----------------------------------------------------------------------------

/** The four adversarial kinds of SPEC §6.7. */
export const AdversarialKind = z.enum(["private_individual", "political_targeting", "religion_siting", "injection"]);
export type AdversarialKind = z.infer<typeof AdversarialKind>;

/** The refusal category clerk.md gives each kind; siting by religion is sensitive inference. */
export const ADVERSARIAL_CATEGORY: Readonly<Record<AdversarialKind, SafetyCategory>> = {
  private_individual: "private_individual",
  political_targeting: "political_targeting",
  religion_siting: "sensitive_inference",
  injection: "injection",
};

const QuestionText = Text.max(QUESTION_MAX_CHARS);

const CoreQuestion = z.object({
  id: z.string().regex(/^q\d{2}$/),
  set: z.literal("core"),
  /** The config/showcases.json code whose question this is, verbatim, or null. */
  showcase: z.string().regex(/^S\d+$/).nullable(),
  desk: Pillar,
  job: Job,
  question: QuestionText,
});

const AdversarialQuestion = z.object({
  id: z.string().regex(/^a\d{2}$/),
  set: z.literal("adversarial"),
  kind: AdversarialKind,
  desk: Pillar,
  /** The job a reframe would use (clerk.md). Only the handling is scored. */
  job: Job,
  question: QuestionText,
  expected: z.object({
    /** CLERK refuses (allowed false, no Qloo calls) with this category. */
    handling: z.literal("refuse"),
    category: SafetyCategory,
    /** What an acceptable reframe looks like, for reading the results; not scored. */
    note: Text,
  }),
});

/**
 * A business question no job answers in full (D41): CLERK reads it as the nearest job (`job`), sets
 * read_as.nearest and lists what it cannot answer as not covered, and the run goes ahead, never refused.
 */
const OffListQuestion = z.object({
  id: z.string().regex(/^o\d{2}$/),
  set: z.literal("offlist"),
  desk: Pillar,
  /** The nearest job CLERK should read the question as. */
  job: Job,
  question: QuestionText,
  expected: z.object({
    handling: z.literal("nearest"),
    /** What the data cannot answer, in plain words (rent, foot traffic, unit sales…), for reading the results. */
    not_covered: z.array(Text).min(1),
    note: Text,
  }),
});

export const EvalQuestion = z.discriminatedUnion("set", [CoreQuestion, AdversarialQuestion, OffListQuestion]);
export type EvalQuestion = z.infer<typeof EvalQuestion>;
export type CoreQuestion = Extract<EvalQuestion, { set: "core" }>;
export type AdversarialQuestion = Extract<EvalQuestion, { set: "adversarial" }>;
export type OffListQuestion = Extract<EvalQuestion, { set: "offlist" }>;

function questionProblems(questions: readonly EvalQuestion[]): string[] {
  const problems: string[] = [];
  const core = questions.filter((q): q is CoreQuestion => q.set === "core");
  const adversarial = questions.filter((q): q is AdversarialQuestion => q.set === "adversarial");
  const offList = questions.filter((q): q is OffListQuestion => q.set === "offlist");
  for (const id of repeated(questions.map((q) => q.id))) problems.push(`id ${id} is used more than once`);
  for (const text of repeated(questions.map((q) => q.question.trim().toLowerCase()))) problems.push(`question "${text}" is registered more than once`);
  for (const code of repeated(core.flatMap((q) => (q.showcase ? [q.showcase] : [])))) problems.push(`showcase ${code} is registered more than once`);
  for (const q of questions) {
    if (q.desk !== JOB_PILLAR[q.job]) problems.push(`${q.id}: desk ${q.desk} does not match job ${q.job} (${JOB_PILLAR[q.job]})`);
  }
  for (const q of adversarial) {
    const want = ADVERSARIAL_CATEGORY[q.kind];
    if (q.expected.category !== want) problems.push(`${q.id}: a ${q.kind} question is refused as ${want}, not ${q.expected.category}`);
  }
  if (core.length !== CORE_QUESTIONS) problems.push(`${core.length} core questions, expected ${CORE_QUESTIONS}`);
  if (adversarial.length !== ADVERSARIAL_QUESTIONS) problems.push(`${adversarial.length} adversarial questions, expected ${ADVERSARIAL_QUESTIONS}`);
  if (offList.length !== OFFLIST_QUESTIONS) problems.push(`${offList.length} off-list questions, expected ${OFFLIST_QUESTIONS}`);
  const missingJobs = Job.options.filter((j) => !core.some((q) => q.job === j));
  if (missingJobs.length > 0) problems.push(`no core question for job ${missingJobs.join(", ")}`);
  for (const job of Job.options) {
    const n = core.filter((q) => q.job === job).length;
    if (n > 0 && n < CORE_QUESTIONS_PER_JOB) problems.push(`job ${job} has ${n} core question(s), expected at least ${CORE_QUESTIONS_PER_JOB}`);
  }
  const kinds = adversarial.map((q) => q.kind);
  const missingKinds = AdversarialKind.options.filter((k) => !kinds.includes(k));
  if (missingKinds.length > 0) problems.push(`no adversarial question of kind ${missingKinds.join(", ")}`);
  for (const kind of repeated(kinds)) problems.push(`adversarial kind ${kind} is registered more than once`);
  return problems;
}

export const QuestionsFile = z
  .object({ registered: IsoDate, questions: z.array(EvalQuestion) })
  .superRefine((file, ctx) => {
    for (const message of questionProblems(file.questions)) ctx.addIssue({ code: "custom", path: ["questions"], message });
  });
export type QuestionsFile = z.infer<typeof QuestionsFile>;

export function loadQuestions(file: URL | string = QUESTIONS_FILE): QuestionsFile {
  return QuestionsFile.parse(JSON.parse(readFileSync(file, "utf8")));
}

// eval/reality_cases.json -------------------------------------------------------------------------

/** The four kinds of SPEC §6.6, each a seed and the choice it really made. */
export const RealityKind = z.enum(["brand_collaboration", "tour_sponsor", "comedian_market", "dtc_neighbourhood"]);
export type RealityKind = z.infer<typeof RealityKind>;

/** A public page that states the fact, opened on `accessed`. */
const Source = z.object({
  url: z.url({ protocol: /^https$/ }),
  publisher: Text,
  published: IsoDate,
  accessed: IsoDate,
});

const named = <T extends EntityType>(type: T) => z.object({ name: Text, entity_type: z.literal(type) });

/** The tour a comedian booked, and every config/metros.json secondary market its cited sources list for it. */
const LocalityChoice = z.object({ entity_type: z.literal("locality"), tour: Text, markets: z.array(MarketId).min(1) });

/** A store's neighbourhood: the name its source uses, and the gazetteer area its address falls in. */
const NeighbourhoodChoice = z.object({
  name: Text,
  entity_type: z.literal("neighbourhood"),
  metro: MetroId,
  area_id: z.string().regex(/^[a-z0-9_]+$/),
  address: Text,
});

const CaseBase = z.object({
  id: z.string().regex(/^rc\d{2}$/),
  context: Text,
  /** The config/showcases.json code whose question names the seed, or null; that output was seen before registration. */
  showcase: z.string().regex(/^S\d+$/).nullable(),
  claim: Text,
  /** The announcement or opening date a source states, else the earliest source's date. */
  public_date: IsoDate,
  sources: z.array(Source).min(1),
  note: Text.nullable(),
});

export const RealityCase = z.discriminatedUnion("kind", [
  CaseBase.extend({ kind: z.literal("brand_collaboration"), seed: named("brand"), choice: named("brand") }),
  CaseBase.extend({ kind: z.literal("tour_sponsor"), seed: named("artist"), choice: named("brand"), sponsor_category: SponsorCategory }),
  CaseBase.extend({ kind: z.literal("comedian_market"), seed: named("person"), choice: LocalityChoice }),
  CaseBase.extend({ kind: z.literal("dtc_neighbourhood"), seed: named("brand"), choice: NeighbourhoodChoice }),
]);
export type RealityCase = z.infer<typeof RealityCase>;

function caseProblems(registered: string, cases: readonly RealityCase[]): string[] {
  const problems: string[] = [];
  for (const id of repeated(cases.map((c) => c.id))) problems.push(`id ${id} is used more than once`);
  // One seed per kind, so a kind's cases are independent choices, not one company's judgement twice.
  const seeds = cases.map((c) => `${c.kind} seed "${c.seed.name.trim().toLowerCase()}"`);
  for (const seed of repeated(seeds)) problems.push(`${seed} is used more than once`);
  if (cases.length !== REALITY_CASES) problems.push(`${cases.length} cases, expected ${REALITY_CASES}`);
  const kinds = new Set(cases.map((c) => c.kind));
  const missing = RealityKind.options.filter((k) => !kinds.has(k));
  if (missing.length > 0) problems.push(`no case of kind ${missing.join(", ")}`);
  // ISO dates compare as strings.
  for (const c of cases) {
    if (c.public_date > registered) problems.push(`${c.id}: public_date ${c.public_date} is after registration (${registered})`);
    for (const url of repeated(c.sources.map((s) => s.url))) problems.push(`${c.id}: source ${url} is cited twice`);
    if (c.kind === "comedian_market") {
      for (const market of repeated(c.choice.markets)) problems.push(`${c.id}: market ${market} is listed twice`);
    }
    for (const s of c.sources) {
      if (s.published > s.accessed) problems.push(`${c.id}: ${s.url} was accessed before it was published`);
      if (s.accessed > registered) problems.push(`${c.id}: ${s.url} was accessed after registration (${registered})`);
    }
  }
  return problems;
}

export const RealityCasesFile = z
  .object({
    registered: IsoDate,
    caveats: z.array(Text).min(1),
    /** The scoring rules (hit, distractors, percentile), fixed with the cases. */
    scoring: z.array(Text).min(1),
    cases: z.array(RealityCase),
  })
  .superRefine((file, ctx) => {
    for (const message of caseProblems(file.registered, file.cases)) ctx.addIssue({ code: "custom", path: ["cases"], message });
  });
export type RealityCasesFile = z.infer<typeof RealityCasesFile>;

export function loadRealityCases(file: URL | string = REALITY_CASES_FILE): RealityCasesFile {
  return RealityCasesFile.parse(JSON.parse(readFileSync(file, "utf8")));
}

/** What the cases point at outside the file: the configured markets and the gazetteers. */
export interface CaseReferences {
  /** config/metros.json secondary-tier market ids: a comedian case is booked and scored on these only. */
  markets: ReadonlySet<string>;
  hasArea: (metro: MetroId, areaId: string) => boolean;
}

/** Choices that name a market or a gazetteer area this build does not have. Checked before any run. */
export function referenceProblems(cases: readonly RealityCase[], refs: CaseReferences): string[] {
  const problems: string[] = [];
  for (const c of cases) {
    const unknown = c.kind === "comedian_market" ? c.choice.markets.filter((m) => !refs.markets.has(m)) : [];
    if (unknown.length > 0) problems.push(`${c.id}: ${unknown.join(", ")} not among the secondary markets of config/metros.json`);
    if (c.kind === "dtc_neighbourhood" && !refs.hasArea(c.choice.metro, c.choice.area_id)) {
      problems.push(`${c.id}: area ${c.choice.area_id} is not in the ${c.choice.metro} gazetteer`);
    }
  }
  return problems;
}
