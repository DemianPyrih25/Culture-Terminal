import type { Badge, ConfidenceRule, RunLimits, ScorecardVerdict, SkillId, ValidationRule } from "@ct/contracts";
import { REPORT_LIMITS } from "@ct/contracts/values";
import { isFormulaId, MIN_BUSY_AREA_VENUES, MIN_SUPPLY_VENUES, THIN_SUPPLY_LABEL, type FormulaId } from "@ct/quant";

/**
 * The copy of /method (A11 · Method & sources). The numbers in it come from the code: the page passes
 * the facts below, read from the packages, so the prose never drifts from what runs. The formulas
 * themselves (name, TeX, plain English, caveats) render from @ct/quant FORMULAS; this file adds what
 * each one reads, the badge it produces and the group it belongs to.
 */

/** Facts the copy quotes, read from the code by the page. */
export interface MethodFacts {
  /** "Haiku 5.5". */
  clerkModel: string;
  analystModel: string;
  limits: RunLimits;
  /** CHECKER V7: below this many ok evidence bundles the signal is insufficient evidence. */
  minOkEvidence: number;
  /** The month the trending window ends, e.g. "Sep 2025". */
  windowEnd: string;
}

export const METHOD_PAGE = {
  metaTitle: "Method · Culture Terminal",
  metaDescription:
    "Every formula and rule behind a Culture Terminal answer: the steps, the checks, confidence, what we refuse and the guards, generated from the code.",
  title: "Every formula and rule",
  lede: "How an answer is made, how each number is checked, and what we refuse. Generated from the code every answer runs on.",
} as const;

export type MethodSectionId = "steps" | "marks" | "checker" | "conviction" | "context" | "supply" | "formulas" | "eval";

/** Outline label, section title and the note on the right of its head. `eval` is the anchor SPEC §6.7 names. */
export const METHOD_SECTIONS: Readonly<Record<MethodSectionId, { title: string; aside: string }>> = {
  steps: { title: "The seven steps", aside: "Same for every answer" },
  marks: { title: "Evidence marks", aside: "How to read an answer" },
  checker: { title: "Checker rules", aside: "Code, not a model" },
  conviction: { title: "Confidence", aside: "Computed, not chosen" },
  context: { title: "AI and web context", aside: "Shown apart, never measured" },
  supply: { title: "OpenStreetMap places", aside: "Counts are a floor" },
  formulas: { title: "Formulas", aside: "Every number has one" },
  eval: { title: "Evaluation", aside: "With and without Qloo" },
};

export const METHOD_SECTION_ORDER: readonly MethodSectionId[] = ["steps", "marks", "checker", "conviction", "context", "supply", "formulas", "eval"];

// 01 The seven steps ------------------------------------------------------------------------------------

export interface StepCopy {
  name: string;
  text: string;
  /** "Clerk · Haiku 5.5". */
  who: string;
  /** A sidenote for this step. */
  note?: { text: string; trace: string };
}

/** "Haiku 5.5" → "Haiku": a step's agent line names the family only. */
const family = (model: string) => model.split(" ")[0] ?? model;

export function methodSteps(f: MethodFacts): StepCopy[] {
  const priors = `H1–H${REPORT_LIMITS.hypothesisVerdictsMax}`;
  const clerk = family(f.clerkModel);
  const analyst = family(f.analystModel);
  return [
    { name: "Interpret", text: "The question becomes an intent: topic, job, names and safety.", who: `Clerk · ${clerk}` },
    { name: "Resolve", text: "Names must match Qloo exactly; a near miss stops at a picker.", who: "Gate · code" },
    {
      name: "Plan",
      text: `Priors ${priors} are written before any data reaches the model.`,
      who: `Analyst · ${analyst}`,
      note: {
        text: "Priors are written in the first turn, before any Qloo data reaches the model. The report can only give them verdicts.",
        trace: "submit_plan · checked in code",
      },
    },
    {
      name: "Fetch",
      text: `Up to ${f.limits.qlooCalls} Qloo requests per answer; repeats come from cache.`,
      who: "Quant · code",
      note: {
        text: "A cached request keeps its original request id and fetch time, and its age is shown on every note.",
        trace: "ledger · request id · cache age",
      },
    },
    { name: "Compute", text: "Every figure is computed in code; the model types none.", who: "Quant · code" },
    {
      name: "Check",
      text: "Each number in the prose is traced to its metric and request.",
      who: "Checker · code",
      note: {
        text: "A number passes only as a token bound to a metric that code computed. A failed check buys one repair turn.",
        trace: "checker · V1–V10",
      },
    },
    { name: "Write", text: "Prose is written around traced numbers; priors get verdicts.", who: `Analyst · ${analyst}` },
  ];
}

export const SCAN_COPY = {
  heading: "Opening scan",
  caption: "The opening scan of each job",
  text: "While the analyst plans, code runs the job's default skills, so the first figures arrive early. Their evidence is cited like any other.",
  analystOnly: "Called by the analyst when a question needs it",
} as const;

export const TURNS_HEADING = "The analyst's turns";

export function analystTurns(f: MethodFacts): { label: string; text: string }[] {
  const l = f.limits;
  return [
    {
      label: "Turn 1",
      text: `The plan: up to ${REPORT_LIMITS.hypothesisVerdictsMax} priors and the steps, with the first data calls. Code runs them alongside the scan and answers once, with every digest and the findings it detected.`,
    },
    {
      label: "Turn 2",
      text: `Plan steps that needed turn-1 results, and follow-ups that must each cite a finding: ${l.followupCalls} requests and about ${Math.round(l.followupMs / 1000)} s in all. Or the report.`,
    },
    { label: "Turn 3", text: "The report. Any further data call is refused." },
    {
      label: "Guards",
      text: `At most ${l.modelResponses} model responses. A nudge at ${Math.round(l.softMs / 1000)} s and a stop at ${Math.round(l.hardMs / 1000)} s; a wrap-up nudge at $${l.usdNudge.toFixed(2)} of model spend and a stop at $${l.usdHard.toFixed(2)}. An answer with no report by then becomes an evidence digest marked incomplete.`,
    },
  ];
}

// 02 Evidence marks ---------------------------------------------------------------------------------------

export const MARKS_COPY = {
  claimsHeading: "On a number",
  dataHeading: "On the data",
  guessesHeading: "On a guess",
  source: "Opens the Qloo requests behind a number",
  draft: "Still being checked; opens once every number passes",
  cached: "From the shared cache; its age is shown",
  noSignal: "No data; never drawn as 0",
  /** The sample glyphs the legend draws. */
  samples: { cached: "Saved copy, 2h old" },
  badgesHeading: "Badges",
  badgesCaption: "The five badges and their weight in evidence strength",
  badgeColumns: { badge: "Badge", meaning: "Meaning" },
  badgesIntro:
    "Every number carries one badge. Its weight m scales the evidence strength conf = m·(1 − 1/√n), which sets the Strong, Moderate and Thin tags.",
  weightLabel: "Weight",
  staleWeight: "freshness F",
} as const;

/** The guess states an answer shows, by the verdict behind them. */
export const VERDICT_WORD: Readonly<Record<ScorecardVerdict, string>> = {
  CONFIRMED: "As expected",
  REFUTED: "Surprise",
  INCONCLUSIVE: "Can't tell yet",
};

export const VERDICT_MEANING: Readonly<Record<ScorecardVerdict, string>> = {
  CONFIRMED: "Prior held against the data",
  REFUTED: "Data contradicted the prior",
  INCONCLUSIVE: "Too thin or mixed to call",
};

export const BADGE_MEANING: Readonly<Record<Badge, string>> = {
  MEASURED: "Returned by Qloo as is: a popularity, a pair similarity, a demographic index.",
  DERIVED: "Exact arithmetic in code over measured values: a within-call percentile, a tilt, a lift.",
  ESTIMATED: "A fit or a model: a Theil–Sen residual, a robust z-score, a neighbourhood rollup.",
  STALE: "From Qloo's historical trending window, and always shown with that window.",
  UNAVAILABLE: "No value. The reason is shown, never a zero.",
};

// 03 Checker rules -----------------------------------------------------------------------------------------

export interface RuleCopy {
  title: string;
  text: string;
  /** What happens when the rule fails. */
  action: string;
}

export const CHECKER_INTRO =
  "The checker reads every draft report before anyone sees it. It is code, not a model. A rejection sends the draft back once; after that the report is accepted with warnings, and each warning lowers confidence.";

export function checkerRules(f: MethodFacts): Readonly<Record<ValidationRule, RuleCopy>> {
  const r = REPORT_LIMITS;
  return {
    V1: { title: "Ids exist", text: "Every metric, evidence, dataset and prior the draft cites exists in this run.", action: "Rejects" },
    V2: { title: "Tokens resolve", text: "Every number token and evidence token resolves to the run's ledger.", action: "Rejects" },
    V3: {
      title: "No bare numbers",
      text: "No decimals or percentages outside tokens. Whole numbers above ten count too, in digits or spelled out (\"forty\"), except years, age labels, ZIPs written as ZIPs and digits inside names.",
      action: "Rejects; warns on the repair",
    },
    V4: {
      title: "No advice, no causation",
      text: "A phrase list blocks buy, sell and short calls, price targets, under- or overvalued, guarantees, shares of customers, causal verbs, collapse, individual framing, poaching and underpriced.",
      action: "Rejects",
    },
    V5: {
      title: "Citations chain",
      text: "Each argument cites a metric, each recommendation an argument, and each verdict on a prior a metric.",
      action: "Rejects",
    },
    V6: { title: "One scale per claim", text: "No claim compares two raw affinity scores from different Qloo calls.", action: "Rejects" },
    V7: {
      title: "Enough evidence",
      text: `With fewer than ${f.minOkEvidence} evidence bundles that came back ok, or with Qloo off, the signal becomes insufficient evidence.`,
      action: "Forced by code",
    },
    V8: { title: "History names its window", text: "A historical metric appears with its trending window in the same argument.", action: "Added by code" },
    V9: {
      title: "Lengths and counts",
      text:
        `A headline of at most ${r.headline} characters, ${r.argumentsMin} to ${r.argumentsMax} arguments, parts of at most ${r.part} characters, at most ${r.hypothesisVerdictsMax} priors and ${r.bearCaseMax} bear-case points. ` +
        "The thesis does not repeat the note at the top of the answer (a concept read at category level, a question read as its nearest job).",
      action: "Rejects; a repeated note that survives is dropped by code",
    },
    V10: {
      title: "Claims are measured",
      text:
        "Age, gender or generation is claimed only where the same part cites a metric that measures it. " +
        "A competitor claim (a count, few or no rivals, crowded, white space) needs the same part to cite a counted venue sample: " +
        `at least ${MIN_SUPPLY_VENUES} similar venues across the compared areas, and ${MIN_BUSY_AREA_VENUES} in an area before it is called crowded. ` +
        `An area with none in a capped sample is not "few": its competition is unknown, and the map reads ${THIN_SUPPLY_LABEL}. ` +
        "Where similar venues could not be counted, the note says the count is unknown.",
      action: "Rejects; warns on the repair",
    },
    V11: {
      title: "Public figures name their period",
      text:
        "A figure from SEC EDGAR filings or the US Census appears with its period or vintage in the same sentence (a fiscal year with its filing, or the ACS 5-year vintage). " +
        "No sentence ties a financial or Census figure to a taste metric as cause and effect: they are read side by side, never one explaining the other.",
      action: "Period added by code; a causal link rejects, then warns on the repair",
    },
    V12: {
      title: "Concepts and areas read honestly",
      text:
        "A number that rests on a look-alike tag standing in for a concept the data lacks is never cited. " +
        "A read of the concept's broader category is called a category read, with no winner, keep or veto. " +
        "A hidden pocket (an area that stands out for its size, not where the crowd is) is never called the best. " +
        "A prior judged only on category reads, on thin samples, or by a tool that never returned data stays inconclusive.",
      action: "Rejects; on the repair warns and caps confidence, or forces the prior to inconclusive",
    },
    V13: {
      title: "Small differences never lead",
      text: "A difference inside the about-level band (a near-even index, a percentile gap under five points, a rank gain of a place or two) cannot lead the headline, the finding or the thesis. It reads about level, never a lead or a win.",
      action: "Rejects; warns on the repair",
    },
  };
}

export const CHECKER_NOTE = {
  text: (points: number) => `Each warning a report is accepted with costs ${points} confidence points.`,
  trace: "checker_warning",
};

// 04 Conviction --------------------------------------------------------------------------------------------

export const CONVICTION_COPY = {
  intro:
    "Confidence starts at 100 and loses points only by written rules. Some rules also cap it: a mixed or weak signal, a headline on a small sample, or a concept read only at category level can never score high, however clean the rest is. Code computes it from the run's flags; the model never sets it.",
  capsHeading: "Caps",
  capsCaption: "Confidence caps: the highest score a rule allows",
  capsIntro: "The score is the lower of 100 minus the penalties and the lowest cap that applies. The answer names the cap that sets its band, e.g. \"Medium: the signal is mixed\".",
  atMost: (cap: number) => `at most ${cap}`,
  start: "Start",
  caption: "Confidence penalties",
  bandsHeading: "Bands",
  once: "once",
  each: "each",
  note: "Confidence rates how complete and clean the run's evidence is, not the chance that the conclusion is right.",
  noteTrace: "confidence.run",
} as const;

/** Rules that count at most once, whatever happens: the rest cost points per occurrence. */
export const CONFIDENCE_ONCE: ReadonlySet<ConfidenceRule> = new Set(["coarse_geohash", "stale_momentum", "insufficient_evidence"]);

// 05 Formulas ----------------------------------------------------------------------------------------------

export const FORMULAS_COPY = {
  intro:
    "Every number in an answer names one of these formulas, and “How it's calculated” in How we know opens its entry here. They render from the same registry the code computes with.",
  inputs: "Reads",
  caveats: "Caveats",
  badge: "Badge",
  noBadge: "None",
  anchor: "Link to this formula",
  opens: "Opening scan",
  note: "A value that is missing is badged Not measured with its reason, whatever the formula. It is never shown as 0.",
  noteTrace: "UNAVAILABLE · never 0",
} as const;

export interface FormulaGroup {
  id: string;
  title: string;
  /** The skill that computes the group, or null for shared primitives and report-level formulas. */
  skill: SkillId | null;
  /** When there is no skill: who computes it. */
  owner?: string;
  /** When the skill runs, where the opening scan does not say it: overrides the scan-table line. */
  where?: string;
  formulas: readonly FormulaId[];
}

/** The Part 11 formula ids (R6 OpenStreetMap supply, R7 area popularity). */
type Part11FormulaId = "osm.count" | "osm.density" | "osm.density_index" | "osm.activity_density" | "lift.area_popularity";

/** The Part 11 ids the formula registry holds, in the order given: a group never lists an id the code lacks. */
function part11(...ids: Part11FormulaId[]): FormulaId[] {
  return ids.filter((id): id is Part11FormulaId & FormulaId => isFormulaId(id));
}

/** The groups in FORMULA_IDS order: shared primitives, the skills S0–S10, then the report. */
export const FORMULA_GROUPS: readonly FormulaGroup[] = [
  { id: "shared", title: "Shared primitives", skill: null, owner: "Every skill", formulas: ["pct.within_call", "quality_gate", "popularity"] },
  {
    id: "resolve",
    title: "Name matching",
    skill: "resolve_entities",
    where: "Run by the resolution gate on every answer; the analyst calls it for new names",
    formulas: ["resolve.exact_match"],
  },
  {
    id: "subs",
    title: "Substitution map",
    skill: "peer_landscape",
    formulas: ["subs.similarity", "subs.rank_in_row", "subs.hub", "subs.distinctiveness", "subs.near_substitutes", "subs.taste_island"],
  },
  { id: "share", title: "Share of taste", skill: "share_of_taste", formulas: ["share.pct", "share.youth_tilt", "share.metros_won", "share.pair_split"] },
  { id: "dna", title: "Audience DNA", skill: "audience_dna", formulas: ["dna.age_index", "dna.gender_index", "dna.youth_index", "dna.distinctive_tags"] },
  { id: "mom", title: "Momentum", skill: "momentum", formulas: ["mom.delta_26w", "mom.mann_kendall", "mom.label", "mom.freshness"] },
  { id: "trvl", title: "Travel taste", skill: "destination_affinity", formulas: ["trvl.quadrant", "trvl.hidden_pocket"] },
  { id: "lift", title: "Lift map and white space", skill: "geo_lift", formulas: ["lift.cell", "lift.area", "lift.confidence", "lift.white_space", ...part11("lift.area_popularity")] },
  { id: "block", title: "Block DNA", skill: "block_dna", formulas: ["block.rank_delta", "block.new_tag", "block.panel_rank", "block.concept_rank"] },
  { id: "tenant", title: "Tenant fit", skill: "rank_candidates", formulas: ["tenant.rank_shift", "tenant.fit", "rank.shift"] },
  { id: "xdom", title: "Cultural neighbourhood", skill: "cross_domain", formulas: ["xdom.under_the_radar", "xdom.edge", "xdom.partners_one_category"] },
  { id: "slate", title: "Sponsor slate", skill: "sponsor_slate", formulas: ["slate.best_fit", "slate.under_the_radar", "slate.market_alignment"] },
  { id: "twin", title: "Taste twins", skill: "taste_twins", formulas: ["twin.rho", "twin.shared_new"] },
  { id: "cnpt", title: "Concept check", skill: "concept_vector", formulas: ["cnpt.s50", "cnpt.verdict", "cnpt.precision"] },
  {
    id: "fin",
    title: "Company financials (SEC EDGAR)",
    skill: "company_financials",
    formulas: ["fin.revenue", "fin.margin", "fin.yoy"],
  },
  {
    id: "econ",
    title: "Area economics (US Census)",
    skill: "area_economics",
    formulas: ["econ.count", "econ.median", "econ.share"],
  },
  {
    id: "osm",
    title: "Places nearby (OpenStreetMap)",
    skill: "local_supply",
    where: "Chained after the lift map, the twin search or a city comparison, and run for tenant and area questions, when OpenStreetMap is configured",
    formulas: part11("osm.count", "osm.density", "osm.density_index", "osm.activity_density"),
  },
  {
    id: "screen",
    title: "Brand screener",
    skill: null,
    owner: "The screener (/screener), in code with no model",
    formulas: ["screen.universe", "screen.under_the_radar"],
  },
  {
    id: "tastemap",
    title: "Category Taste Map",
    skill: null,
    owner: "From a note's substitution map, or the screener's taste map calls",
    formulas: ["taste_map_mds"],
  },
  { id: "report", title: "Report level", skill: null, owner: "The report assembler", formulas: ["confidence.run", "confidence.metric"] },
];

export interface FormulaMeta {
  /** What the formula reads. */
  inputs: readonly string[];
  /** The badge its value carries when it has one; null for a rule or a report-level score. */
  badge: Badge | null;
  /** Why there is no badge. */
  noBadge?: string;
}

const RULE = "A rule: it decides, it produces no number";

const CORE_FORMULA_META: Readonly<Record<Exclude<FormulaId, Part11FormulaId>, FormulaMeta>> = {
  "pct.within_call": { inputs: ["Qloo affinity of each candidate scored in one call"], badge: "DERIVED" },
  quality_gate: { inputs: ["Qloo popularity of each result"], badge: null, noBadge: RULE },
  popularity: { inputs: ["Qloo popularity from search or entity lookup"], badge: "MEASURED" },
  "resolve.exact_match": {
    inputs: ["The name as written and the entity type the clerk read", "Qloo search results of that type"],
    badge: null,
    noBadge: RULE,
  },
  "subs.similarity": { inputs: ["Qloo affinity of entity j with entity i as the signal, one call per row"], badge: "MEASURED" },
  "subs.rank_in_row": { inputs: ["The scored similarities in row i"], badge: "DERIVED" },
  "subs.hub": { inputs: ["Within-row percentiles of j across the other rows", "How many cells each row scored"], badge: "DERIVED" },
  "subs.distinctiveness": { inputs: ["Similarities of entity i to every other entity in the set"], badge: "DERIVED" },
  "subs.near_substitutes": { inputs: ["Average rank in row, both ways", "Every scored pair similarity in the set"], badge: "MEASURED" },
  "subs.taste_island": { inputs: ["The target's place in each peer row that scored it"], badge: "DERIVED" },
  "share.pct": { inputs: ["Qloo affinity of each entity in one context call: an age group, an audience or a metro"], badge: "DERIVED" },
  "share.youth_tilt": {
    inputs: ["Share-of-taste percentiles in the young and old age contexts queried, re-ranked over the entities all of them scored"],
    badge: "DERIVED",
  },
  "share.metros_won": { inputs: ["Ranks and percentiles in each metro context that ranked the set"], badge: "DERIVED" },
  "share.pair_split": { inputs: ["The two entities' Qloo affinities in each context call"], badge: "DERIVED" },
  "dna.age_index": { inputs: ["Qloo demographics for the entity: six age groups"], badge: "MEASURED" },
  "dna.gender_index": { inputs: ["Qloo demographics for the entity: two gender groups"], badge: "MEASURED" },
  "dna.youth_index": { inputs: ["Age indices of the two youngest and the two oldest groups"], badge: "DERIVED" },
  "dna.distinctive_tags": { inputs: ["Search tags of the target", "Search tags of each peer"], badge: "DERIVED" },
  "mom.delta_26w": { inputs: ["Weekly Qloo trending percentiles over the fixed historical window"], badge: "STALE" },
  "mom.mann_kendall": { inputs: ["The same weekly series"], badge: "STALE" },
  "mom.label": { inputs: ["26-week momentum", "Mann–Kendall p"], badge: "STALE" },
  "mom.freshness": { inputs: ["The end of the trending window", "Today's date"], badge: "STALE" },
  "trvl.quadrant": { inputs: ["Affinity percentile of each of Qloo's top US destinations for the audience", "Destination popularity"], badge: "DERIVED" },
  "trvl.hidden_pocket": { inputs: ["Destination affinity percentiles", "Destination popularity"], badge: "ESTIMATED" },
  "lift.cell": { inputs: ["The concept's Qloo heatmap of the metro", "The baseline heatmap: restaurants"], badge: "DERIVED" },
  "lift.area": { inputs: ["Gated cell lifts", "Neighbourhood boundaries from the gazetteer"], badge: "ESTIMATED" },
  "lift.confidence": { inputs: ["Gated cells in the neighbourhood", "Map precision (geohash length)"], badge: "DERIVED" },
  "lift.white_space": {
    inputs: ["Neighbourhood lift percentile (demand)", "Venues per square kilometre in a capped sample of Qloo-indexed places (supply)"],
    badge: "ESTIMATED",
  },
  "block.rank_delta": { inputs: ["The area's top tags (or brands) from Qloo", "The same list for the whole city"], badge: "DERIVED" },
  "block.new_tag": { inputs: ["The city's top 50 tags", "The area's top 20 tags"], badge: "DERIVED" },
  "block.panel_rank": { inputs: ["The top-50 tag list of each other map city"], badge: "DERIVED" },
  "block.concept_rank": { inputs: ["The concept tags from the question", "The top-50 tag lists Block DNA already read (the area, the city or the other map cities)"], badge: "DERIVED" },
  "tenant.rank_shift": {
    inputs: ["Each candidate's percentile with the site as the location signal", "The same with the city as the signal"],
    badge: "DERIVED",
  },
  "tenant.fit": { inputs: ["Percentile at the site", "Rank shift"], badge: "DERIVED" },
  "rank.shift": {
    inputs: ["Each candidate's percentile in the first and last context of a slope, re-ranked over the candidates every compared context scored"],
    badge: "DERIVED",
  },
  "xdom.under_the_radar": { inputs: ["Within-call percentile of each result", "Its popularity"], badge: "DERIVED" },
  "xdom.partners_one_category": {
    inputs: ["The scored partners' top-level brand categories", "The subject's own category, left out"],
    badge: null,
    noBadge: RULE,
  },
  "xdom.edge": { inputs: ["Qloo's explainability share of each seed", "The number of seeds"], badge: null, noBadge: "A drawing rule: it decides which lines a figure draws" },
  "slate.best_fit": { inputs: ["Percentiles from one scoring call over the shortlist", "Each candidate's sponsor category"], badge: "DERIVED" },
  "slate.under_the_radar": { inputs: ["Slate fit percentiles", "Candidate popularity"], badge: "DERIVED" },
  "slate.market_alignment": {
    inputs: ["Percentile in each metro call", "National affinity re-ranked over the brands that metro scored"],
    badge: "DERIVED",
  },
  "twin.rho": {
    inputs: ["The source area's and each checked area's top tags from Qloo", "The same lists for their two cities"],
    badge: "DERIVED",
  },
  "twin.shared_new": { inputs: ["The NEW tags of the source area and of each checked area"], badge: "DERIVED" },
  "cnpt.s50": { inputs: ["Qloo's open call for the concept's tags", "The 50th result, scored again in the scoring call"], badge: "MEASURED" },
  "cnpt.verdict": { inputs: ["Affinity of each analog and of the anchor in one scoring call"], badge: null, noBadge: RULE },
  "cnpt.precision": { inputs: ["The KEEP and VETO verdicts"], badge: "DERIVED" },
  "fin.revenue": { inputs: ["US GAAP revenue lines in the company's SEC filings (10-K, 10-Q), latest filing per period"], badge: "MEASURED" },
  "fin.margin": { inputs: ["Gross profit and operating income as filed", "Revenue for the same period"], badge: "DERIVED" },
  "fin.yoy": { inputs: ["Revenue for a period and for the same period a year earlier, as filed"], badge: "DERIVED" },
  "econ.count": { inputs: ["US Census ACS 5-year estimates for each ZIP area or census tract in the area"], badge: "DERIVED" },
  "econ.median": { inputs: ["Each unit's published median", "Each unit's population"], badge: "ESTIMATED" },
  "econ.share": { inputs: ["Resident workers by usual commute mode, ACS 5-year"], badge: "DERIVED" },
  "screen.universe": {
    inputs: ["The category tag or the seed brand", "Qloo's brand results for it, in their order"],
    badge: null,
    noBadge: "A rule: it sets which brands are screened, it produces no number",
  },
  "screen.under_the_radar": {
    inputs: ["FIT: each brand's within-call percentile from the screen's scoring call", "Each brand's Qloo popularity", "The screened set's median of each"],
    badge: "DERIVED",
  },
  taste_map_mds: {
    inputs: ["Pairwise Qloo similarities of up to 14 entities, one call per row", "The largest scored distance, for any pair left unscored"],
    badge: "ESTIMATED",
  },
  "confidence.run": {
    inputs: ["Counts the run collected: dropped names, code fallbacks, thin results, quality-gate drops and checker warnings", "The coarse-map, stale-momentum and insufficient-evidence flags"],
    badge: null,
    noBadge: "A score about the run, not a measurement",
  },
  "confidence.metric": {
    inputs: ["The metric's badge", "The number of observations n behind it", "Freshness F for a historical metric"],
    badge: null,
    noBadge: "A score about a number, not a measurement",
  },
};

const PART11_FORMULA_META: Readonly<Record<Part11FormulaId, FormulaMeta>> = {
  "osm.count": { inputs: ["OpenStreetMap elements with the place type's tags inside the area outline or the market circle (Overpass API)"], badge: "MEASURED" },
  "osm.density": { inputs: ["The count", "The area's size in km² from the gazetteer, or the circle's"], badge: "DERIVED" },
  "osm.density_index": { inputs: ["The area's density", "The same density over the metro's counties (an approximate area)"], badge: "DERIVED" },
  "osm.activity_density": { inputs: ["Shops plus food and drink places in the area (OpenStreetMap)", "The area's size in km²"], badge: "DERIVED" },
  "lift.area_popularity": { inputs: ["The concept's raw Qloo heatmap affinity in the area's cells", "The same for every other area on the map"], badge: "DERIVED" },
};

/** Each formula's inputs and badge; a Part 11 entry is listed once the formula registry holds it. */
export const FORMULA_META: Readonly<Record<FormulaId, FormulaMeta>> = Object.fromEntries([
  ...Object.entries(CORE_FORMULA_META),
  ...Object.entries(PART11_FORMULA_META).filter(([id]) => isFormulaId(id)),
]) as Readonly<Record<FormulaId, FormulaMeta>>;

// 06 Evaluation --------------------------------------------------------------------------------------------

export const EVAL_COPY = {
  notRun:
    "The evaluation has not been run yet, so there are no results to show. When it runs, this section prints its aggregates, never single answers.",
  unreadable: "An evaluation summary exists but could not be read, so no results are shown.",
  design:
    "Pre-registered questions across the four topics, adversarial ones included, are answered twice: by the full system, and by the same model with no tools (Ghost). A Reality Check scores public, real-world choices against Qloo.",
  measures: [
    "How often priors are refuted",
    "Overlap of the top five picks, with and without Qloo",
    "Picks the model alone names that Qloo cannot resolve",
    "Numbers bound to a source",
    "Adversarial questions handled correctly",
    "Checker first-pass rate",
    "Latency, Qloo calls and model cost per answer",
  ],
  measuresHeading: "What it measures",
  ranAt: "Run",
  questions: (total: number, adversarial: number) => `${total} questions, ${adversarial} adversarial`,
  caption: "Evaluation aggregates, with and without Qloo",
  measure: "Measure",
  grounded: "Culture Terminal",
  ghost: "Model alone",
  realityHeading: "Reality Check",
  realityCases: (n: number) => `${n} public cases`,
  realityMedian: "Median percentile of the real choice (random: 50%)",
  realityHit: "Ghost hit rate",
  note: "Only aggregates are published. Raw transcripts stay private.",
  noteTrace: "eval · aggregates only",
} as const;

// Sources ----------------------------------------------------------------------------------------------------

export const METHOD_SOURCES = {
  aside: (formulas: number, rules: number) => `${formulas} formulas · ${rules} checker rules`,
  heading: "Sources",
  rows: (f: { endpoints: readonly string[]; trendWindow: string; clerkModel: string; analystModel: string }): { key: string; value: string }[] => [
    { key: "Data", value: "Qloo taste graph, group-level only" },
    { key: "Calls", value: f.endpoints.join(" · ") },
    {
      key: "Public data",
      value:
        "SEC EDGAR company facts (us-gaap revenue, gross profit and operating income as filed, company-wide) and US Census ACS 5-year estimates for residents (population, age, households, income, commute); they cost no Qloo calls",
    },
    { key: "Window", value: `${f.trendWindow}; nothing after it` },
    { key: "Cache", value: "Shared; the age of every saved copy is shown" },
    { key: "Models", value: `Clerk ${f.clerkModel} · Analyst ${f.analystModel}` },
  ],
} as const;

// AI and web context (R4, R5, D45) ----------------------------------------------------------------------------

export const CONTEXT_COPY = {
  intro:
    "Beside the measured answer, two blocks add context. They sit under the answer, apart from it, with dashed borders, and they never change the verdict, a number or the confidence.",
  aiHeading: "What AI knows (not verified)",
  ai: [
    "One small model call recalls widely reported facts about the subject and place: deals and ownership, where it already operates, local operators, brand-safety risks.",
    "It may state no number: code drops any item with a digit, a percent or currency sign, or a number word, and says how many it dropped. The model's knowledge can be out of date or wrong, so the block is labelled not verified.",
    "Only one thing from it reaches the analysis: the market ids where the subject is said to operate already, checked against our market list, so market tables can mark them \"Already there\". The ranking stays the data's.",
  ],
  webHeading: "From the web",
  web: [
    "One small model call runs up to three web searches and writes short sentences, each tied to a search result. Code keeps only sentences with a citation, shows each with its link, publisher, published date (or \"date unknown\") and the date it was retrieved, and drops any sentence whose numbers are not in the cited passage.",
    "Page text is untrusted data. It is shown escaped, with its link, and never reaches the analysis, a candidate list or a number. Sentences that read like instructions are dropped.",
  ],
  offHeading: "When they are off",
  off: "Either block can be turned off on a server; web search is off in economy mode. A block that is off, empty, timed out or failed says so in one line. With Qloo off, the measured answer stays \"not enough data\" whatever the blocks say.",
  note: "Neither block is a source for a number in the answer.",
  noteTrace: "aiContext · webContext",
} as const;

// OpenStreetMap places (R6, D46) --------------------------------------------------------------------------------

export const SUPPLY_COPY = {
  intro:
    "For place questions, code counts the real places already there from OpenStreetMap through the public Overpass API: competitors of the place type in each area (or around a city's centre), counts per km², each area against its city, and street activity (shops plus food and drink places).",
  points: [
    "Each count is a floor, not a census: OpenStreetMap is mapped by volunteers, dense US cities well, suburbs less so.",
    "\"More than the city\" and \"less than the city\" compare an area's density with the metro's counties. Inside 0.8 to 1.25 times the city's level an area reads \"about the city's level\", never more or less. The city's area is approximate.",
    "What an area has too much or too little of comes from counting every storefront type against the city: at 1.5 times the city's level with at least five places it has more; at half or less it has less.",
    "Only place types whose tags are documented and widely used in OpenStreetMap are counted. A concept with no reliable tag is not counted, and the answer says so.",
    "Reads are cached 30 days and cost no Qloo call. Every figure carries the data's date and the credit \"© OpenStreetMap contributors\" under the Open Database License (ODbL).",
  ],
  note: "Map data from OpenStreetMap, © OpenStreetMap contributors, available under the Open Database License (ODbL) 1.0, via the Overpass API.",
  noteTrace: "local_supply · osm.count",
} as const;
