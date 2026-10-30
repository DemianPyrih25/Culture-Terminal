import type { Job } from "./enums";

/**
 * Cost per use, for /method (PLAN Part 10 "Done when", §8.1, §10.4). These are PLAN FIGURES read from
 * each feature's call plan, not measurements: /method labels them so, and the receipts of real runs,
 * screens and profiles show what each one actually spent. Cold: nothing cached; warm: the same request
 * again inside the cache window (Qloo cache, answer cache). SEC and Census calls are free and not counted.
 */

/** An inclusive range of Qloo network calls or LLM USD. */
export interface CostRange {
  min: number;
  max: number;
}

/** Qloo network calls per run of each job (PLAN §10.4); turn-2 follow-ups and the per-question cap are DEFAULT_RUN_LIMITS'. */
export interface JobQlooPlan {
  cold: CostRange;
  /** Null where the plan gives no warm figure (audience_discovery). */
  warm: CostRange | null;
}

const exact = (n: number): CostRange => ({ min: n, max: n });

export const JOB_QLOO_PLAN: Readonly<Record<Job, JobQlooPlan>> = {
  brand_health: { cold: exact(25), warm: exact(6) },
  head_to_head: { cold: exact(20), warm: exact(5) },
  site_selection: { cold: exact(7), warm: exact(2) },
  area_profile: { cold: exact(6), warm: exact(2) },
  tenant_mix: { cold: exact(6), warm: exact(2) },
  sponsorship: { cold: { min: 15, max: 25 }, warm: exact(4) },
  market_selection: { cold: exact(17), warm: exact(4) },
  audience_discovery: { cold: exact(6), warm: null },
  taste_twins: { cold: exact(12), warm: exact(4) },
  brand_collab: { cold: exact(10), warm: exact(3) },
  creator_fit: { cold: exact(10), warm: exact(3) },
  launch_test: { cold: exact(15), warm: exact(4) },
  city_compare: { cold: exact(12), warm: exact(3) },
};

/** LLM USD of one live (Sonnet) note, as PLAN §4.2 plans it; an economy (Haiku) note costs under a cent. */
export const NOTE_LLM_USD: CostRange = { min: 0.1, max: 0.3 };

export const Feature = [
  "following_rerun",
  "run_queue",
  "screener",
  "taste_map_note",
  "taste_map_screener",
  "des_profile",
  "verdict_tag",
  "share_card",
] as const;
export type Feature = (typeof Feature)[number];

export type FeatureCost =
  | {
      feature: Feature;
      label: string;
      /** What one use is, e.g. "per screen". */
      per: string;
      basis: "plan";
      qlooCold: CostRange;
      qlooWarm: CostRange;
      llmUsd: CostRange;
      /** The call plan in words, as /method prints it. */
      plan: string;
    }
  | {
      feature: Feature;
      label: string;
      per: string;
      /** Costs exactly one run of the followed note's job: read JOB_QLOO_PLAN and NOTE_LLM_USD. */
      basis: "job_run";
      plan: string;
    };

const zero: CostRange = exact(0);

export const FEATURE_COSTS: Readonly<Record<Feature, FeatureCost>> = {
  following_rerun: {
    feature: "following_rerun",
    label: "Following: re-run",
    per: "per re-run",
    basis: "job_run",
    plan: "One fresh run of the followed note's job, with that job's Qloo plan and one note's LLM cost. Listing follows and opening the latest note cost nothing.",
  },
  run_queue: {
    feature: "run_queue",
    label: "Run queue",
    per: "per queued run",
    basis: "plan",
    qlooCold: zero,
    qlooWarm: zero,
    llmUsd: zero,
    plan: "Waiting for a slot costs nothing; a run that times out in the queue spends nothing.",
  },
  screener: {
    feature: "screener",
    label: "Brand screener",
    per: "per screen",
    basis: "plan",
    qlooCold: { min: 5, max: 9 },
    qlooWarm: zero,
    llmUsd: zero,
    plan: "Lookup 1 (the category tag or seed brand), discovery 1 (its signal is the category tag or the seed, so it is also the one-scale scoring), age contexts 3, markets up to 4. Code only, no LLM. A repeat inside the cache window makes no network call.",
  },
  taste_map_note: {
    feature: "taste_map_note",
    label: "Category Taste Map on a note",
    per: "per map",
    basis: "plan",
    qlooCold: zero,
    qlooWarm: zero,
    llmUsd: zero,
    plan: "Drawn from the Substitution Map's similarity calls the note already made; no extra request.",
  },
  taste_map_screener: {
    feature: "taste_map_screener",
    label: "Category Taste Map on the screener",
    per: "per map",
    basis: "plan",
    qlooCold: { min: 2, max: 13 },
    qlooWarm: zero,
    llmUsd: zero,
    plan: "Triangular similarity calls over the top k ≤ 14 brands: k − 1 calls, at most 13. It also fills the distinctiveness column.",
  },
  des_profile: {
    feature: "des_profile",
    label: "Brand profile (/d/[entity])",
    per: "per profile",
    basis: "plan",
    qlooCold: { min: 8, max: 9 },
    qlooWarm: zero,
    llmUsd: zero,
    plan: "Search 1, a pick's describe 0–1, audience DNA 2, four cultural-neighbour domains 4, travel taste 1; capped at 12. Code only, no LLM. A profile read again within an hour is served from memory.",
  },
  verdict_tag: {
    feature: "verdict_tag",
    label: "Verdict tag",
    per: "per note",
    basis: "plan",
    qlooCold: zero,
    qlooWarm: zero,
    llmUsd: zero,
    plan: "Two to five words written in the same report call as the rest of the note; no extra request or model call.",
  },
  share_card: {
    feature: "share_card",
    label: "Share card",
    per: "per card",
    basis: "plan",
    qlooCold: zero,
    qlooWarm: zero,
    llmUsd: zero,
    plan: "Drawn from a curated note already stored (a reader's own answer gets no card); no request or model call.",
  },
};

/** The caption /method prints with these tables. */
export const FEATURE_COST_NOTE =
  "Plan figures from each feature's call plan, not measurements. Every note, screen and profile carries a receipt with what it actually spent.";

// Added to every answer (Part 11: R4, R5, R6) --------------------------------------------------------------

/**
 * What every answer adds on top of its job's Qloo plan and the ANALYST's LLM cost: the two side context
 * calls ("What AI knows (not verified)", "From the web") and OpenStreetMap supply. Plan figures; the
 * receipt's `context` line shows what a note actually spent. None of them costs a Qloo call.
 */
export const ANSWER_ADDONS = ["ai_context", "web_context", "local_supply"] as const;
export type AnswerAddon = (typeof ANSWER_ADDONS)[number];

export interface AnswerAddonCost {
  addon: AnswerAddon;
  label: string;
  per: string;
  basis: "plan";
  qloo: CostRange;
  llmUsd: CostRange;
  plan: string;
}

/** /method's heading for ANSWER_ADDON_COSTS. */
export const ANSWER_ADDONS_HEADING = "Added to every answer";

/** USD per billed web search (Anthropic web search: $10 per 1,000 searches), on top of the tokens. */
export const WEB_SEARCH_USD_PER_SEARCH_PLAN = 0.01;

export const ANSWER_ADDON_COSTS: Readonly<Record<AnswerAddon, AnswerAddonCost>> = {
  ai_context: {
    addon: "ai_context",
    label: "What AI knows (not verified)",
    per: "per answer",
    basis: "plan",
    qloo: zero,
    llmUsd: { min: 0.005, max: 0.02 },
    plan: "One small model call in parallel with the analysis, bounded by its token limit; cached 7 days per question. It never states a number and never changes the measured answer.",
  },
  web_context: {
    addon: "web_context",
    label: "From the web",
    per: "per answer",
    basis: "plan",
    qloo: zero,
    llmUsd: { min: 0.02, max: 0.08 },
    plan: "One small model call with up to 3 web searches ($0.01 a search), in parallel with the analysis; cached 24 hours per question. Off in economy mode.",
  },
  local_supply: {
    addon: "local_supply",
    label: "OpenStreetMap places nearby",
    per: "per place question",
    basis: "plan",
    qloo: zero,
    llmUsd: zero,
    plan: "One to three OpenStreetMap (Overpass API) reads per call, at most six per answer, cached 30 days. Free; no model call.",
  },
};
