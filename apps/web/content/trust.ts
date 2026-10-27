import type { Lane, Pillar, SafetyCategory } from "@ct/contracts";

/**
 * The rules /method states, moved from the old /trust page: the safe-use rules, the kit's guidance and
 * ours, and what enforces each one (SPEC §6.5), the clerk's refusal categories and the reframe offered,
 * the audience allowlist's rationale, data handling, and the model and cost guards. The allowlist
 * itself, the limits, the budgets and the models are read from the code by the page.
 */

export type TrustSectionId = "safe-use" | "refusals" | "allowlist" | "data" | "guards";

export const TRUST_SECTIONS: Readonly<Record<TrustSectionId, { title: string; aside: string }>> = {
  "safe-use": { title: "Safe use", aside: "Each rule and what enforces it" },
  refusals: { title: "What we refuse", aside: "Decided before any request" },
  allowlist: { title: "Audience allowlist", aside: "Checked inside the Qloo client" },
  data: { title: "Data handling", aside: "Group-level, dated, never in git" },
  guards: { title: "Models and cost", aside: "Hard caps in code" },
};

export const TRUST_SECTION_ORDER: readonly TrustSectionId[] = ["safe-use", "refusals", "allowlist", "data", "guards"];

// 01 Safe use ----------------------------------------------------------------------------------------------

/**
 * Where a rule comes from: the Qloo hackathon kit's guidance (its agent prompts' grounding rules, and
 * the resolution policy and provenance envelope D30 adopts), or a rule Culture Terminal adds.
 */
export type SafeUseSource = "kit" | "ours";

export interface SafeUseRule {
  id: string;
  source: SafeUseSource;
  /** For a kit rule: the part of the kit it follows. */
  basis?: string;
  /** The rule, in our words. */
  rule: string;
  /** What enforces it. */
  enforced: string;
  /** Where in the code, as a trace line. */
  where: string;
}

export const SAFE_USE_INTRO =
  "The Qloo hackathon kit's safe-use guidance and the rules we add to it, each mapped to the code that enforces it. Rules marked Kit follow the kit's agent prompts or its resolution and provenance policy; the rest are ours.";

export const SAFE_USE_SOURCE_LABEL: Readonly<Record<SafeUseSource, string>> = { kit: "Kit", ours: "Ours" };

export const SAFE_USE: readonly SafeUseRule[] = [
  {
    id: "group-level",
    source: "ours",
    rule: "Use taste data at group level. Never profile or infer an individual.",
    enforced:
      "The clerk refuses questions about private people before any request. Only public figures are looked up. The checker rejects individual framing such as “this person” or “residents who”, and every answer says it is group-level.",
    where: "clerk · private_individual · checker V4",
  },
  {
    id: "sensitive",
    source: "ours",
    rule: "No inference about sensitive traits: health, religion, ethnicity, sexuality, immigration status.",
    enforced:
      "The clerk refuses sensitive inference and offers a commercial reframe. Identity, belief and issue audiences are denied on every topic by the Qloo client itself.",
    where: "clerk · sensitive_inference · audience allowlist",
  },
  {
    id: "politics",
    source: "ours",
    rule: "No political targeting or persuasion.",
    enforced: "The clerk refuses political targeting. Political audiences are denied on every topic, by family and by name.",
    where: "clerk · political_targeting · audience allowlist",
  },
  {
    id: "eligibility",
    source: "ours",
    rule: "No decisions about who gets housing, credit, employment or insurance.",
    enforced:
      "The clerk refuses eligibility questions. Tenant fit carries a fixed limitation: commercial concept fit only, never a decision about a business owner or resident.",
    where: "clerk · eligibility · tenant.fit caveat",
  },
  {
    id: "screening",
    source: "ours",
    rule: "No residential leasing or tenant screening.",
    enforced:
      "The clerk refuses residential screening; commercial tenant mix for a storefront is answered. Customer-identity tags are shown as venue-goer taste tags, never as residents.",
    where: "clerk · residential_screening · block_dna",
  },
  {
    id: "not-causal",
    source: "kit",
    basis: "agent prompts",
    rule: "Affinity is not sales, share, causation or an individual's probability.",
    enforced:
      "Every answer carries the line “Affinity ≠ sales, share or causation.” The checker rejects causal verbs and shares of customers, and forbids comparing raw affinity across calls. Each formula states its own limits.",
    where: "checker V4, V6 · FORMULAS caveats",
  },
  {
    id: "advice",
    source: "ours",
    rule: "No financial advice.",
    enforced:
      "Buy, sell and price questions are answered as taste-signal health and labelled “Analytics, not financial advice.” The checker rejects buy, sell and short calls, price targets and valuation words.",
    where: "clerk · financial_advice · checker V4",
  },
  {
    id: "resolution",
    source: "kit",
    basis: "resolution policy",
    rule: "Match names exactly, and ask when a name is ambiguous.",
    enforced:
      "The resolution gate applies exact matches of name and type only. A near miss on the subject stops the run at a picker; on any other name it is dropped with a limitation. Popularity never decides a match.",
    where: "resolve_entities · D20",
  },
  {
    id: "provenance",
    source: "kit",
    basis: "provenance envelope",
    rule: "Keep provenance: say which request each result came from.",
    enforced:
      "Every number is a metric in the run's ledger, bound to its Qloo requests with request id, cache state and fetch time. The model cannot type a number; it cites tokens the checker resolves.",
    where: "ledger · tokens · checker V1–V3",
  },
  {
    id: "no-model-as-data",
    source: "kit",
    basis: "agent prompts",
    rule: "Never present model knowledge as Qloo data.",
    enforced:
      "With too little evidence, or with Qloo off, the signal is forced to insufficient evidence. The model-alone column is always labelled as such.",
    where: "checker V7",
  },
  {
    id: "key",
    source: "ours",
    rule: "Keep the API key secret.",
    enforced:
      "The key lives in the server's environment only, never reaches the browser and is redacted from logs. A guard scans the built client bundle for server-only names before release.",
    where: "@ct/qloo · pnpm guard --bundle",
  },
  {
    id: "data",
    source: "ours",
    rule: "Do not redistribute Qloo data.",
    enforced:
      "No Qloo values or ids are committed to the repository: ids are resolved at run time and kept in the database, and a guard scans every commit. No Qloo images are shown.",
    where: "D29 · pnpm guard",
  },
  {
    id: "quota",
    source: "ours",
    rule: "Respect rate limits and quota.",
    enforced:
      "One Qloo client per process with a rate limiter, a shared cache, a cap per answer and a daily cap on fresh requests. No bulk downloads, and Home fetches nothing on its own.",
    where: "@ct/qloo · limiter · quota",
  },
];

// 02 Refusals ----------------------------------------------------------------------------------------------

export interface RefusalCopy {
  /** Refused (no Qloo request) or answered with a reframe. */
  outcome: "refused" | "reframed";
  /** What the category covers. */
  covers: string;
  /** The reframe offered, or null when there is none. */
  reframe: string | null;
}

export const REFUSALS_INTRO =
  "The clerk reads every question before anything runs. A refused question makes no Qloo request; the reason and a group-level reframe take the answer's place. When several categories apply, the first in this list wins.";

export const OUTCOME_LABEL: Readonly<Record<RefusalCopy["outcome"], string>> = {
  refused: "Refused",
  reframed: "Answered, reframed",
};

export const REFUSAL_LABELS = { reframe: "Offered instead", noReframe: "No reframe: nothing at group level fits" } as const;

/** In the clerk's order of precedence (clerk.md: injection first, financial advice last). */
export const REFUSAL_ORDER: readonly SafetyCategory[] = [
  "injection",
  "political_targeting",
  "sensitive_inference",
  "residential_screening",
  "eligibility",
  "private_individual",
  "out_of_scope",
  "financial_advice",
];

export const REFUSALS: Readonly<Record<SafetyCategory, RefusalCopy>> = {
  injection: {
    outcome: "refused",
    covers: "Text that tries to change the instructions, reveal prompts, call tools or open links, even beside a real question.",
    reframe: "The business question in it, without the instructions",
  },
  political_targeting: {
    outcome: "refused",
    covers: "Voters, campaigns, persuasion, or anyone's politics.",
    reframe: "Who an artist's audience is and what else it loves, for a commercial event",
  },
  sensitive_inference: {
    outcome: "refused",
    covers: "Inferring or targeting health, religion, ethnicity, sexuality, immigration status or similar traits, including siting a business by them.",
    reframe: "Where a concept fits by taste, without reading who lives there",
  },
  residential_screening: {
    outcome: "refused",
    covers: "Choosing renters or residents. Commercial tenants for a storefront are a normal answer.",
    reframe: "The group-level taste profile of a neighbourhood, for a commercial concept",
  },
  eligibility: {
    outcome: "refused",
    covers: "Deciding who gets housing, credit, employment or insurance.",
    reframe: "Who a brand's audience is, for a commercial offer",
  },
  private_individual: {
    outcome: "refused",
    covers: "A named or identifiable private person, or picking individuals out of a group.",
    reframe: "Who an artist's audience is, at group level",
  },
  out_of_scope: {
    outcome: "refused",
    covers: "Questions that are not about taste, or that need data Culture Terminal does not have: sales, prices, rents, foot traffic, weather.",
    reframe: "The brand's taste-signal health",
  },
  financial_advice: {
    outcome: "reframed",
    covers: "Buying, selling, shorting, price targets or valuation. Answered, never as advice.",
    reframe: "The brand's taste-signal health, labelled not financial advice",
  },
};

export const REFUSALS_NOTE = {
  text: "A declined question makes no Qloo request and costs nothing. The reason and a question we can answer take its place.",
  trace: "clerk · safety{allowed, category, reframe}",
};

// 03 Audience allowlist ------------------------------------------------------------------------------------

export const ALLOWLIST_COPY = {
  intro:
    "Qloo can read taste through audiences. Each topic may send only the audience families below; anything else is refused by the Qloo client before the request leaves the server, so even a faulty skill cannot send a denied segment.",
  desksHeading: "Allowed per topic",
  desksCaption: "Audience families each topic may use",
  deniedHeading: "Denied on every topic",
  deniedAudiences: "Also denied by name",
  noReason: "Outside what a topic needs",
  note: "The allowlist lives inside the Qloo client and is mirrored in a config file for readers; a test keeps the two equal.",
  noteTrace: "packages/qloo · audiences.ts",
} as const;

/** Family names that read better than their keys; any other key is printed in words ("leisure" → "Leisure"). */
export const FAMILY_LABEL: Readonly<Record<string, string>> = {
  lifestyle_preferences_beliefs: "Lifestyle preferences and beliefs",
};

/** Why a family is denied everywhere. A family without a line here still shows, with ALLOWLIST_COPY.noReason. */
export const DENIED_FAMILY_REASON: Readonly<Record<string, string>> = {
  communities: "Identity groups: targeting them would be sensitive inference.",
  political_preferences: "Political leanings: no political targeting.",
  lifestyle_preferences_beliefs: "Beliefs and convictions, religion included.",
  global_issues: "Stances on public issues: persuasion territory.",
};

/** Why a topic's list is as wide or as narrow as it is. */
export const DESK_ALLOWLIST_REASON: Readonly<Record<Pillar, string>> = {
  investment: "The six allowed families, for audience research on a brand's taste position.",
  location: "The same six families, only as taste contexts: what a group favours in an area, never who lives there.",
  marketing: "The same six families, for sponsor and market fit.",
  audience: "The same six families, to describe an audience at group level.",
};

// 04 Data handling -----------------------------------------------------------------------------------------

export const DATA_HANDLING: readonly { term: string; text: string }[] = [
  {
    term: "No individuals",
    text: "Qloo's signals are aggregates of groups. Your question is never sent to Qloo, and neither is a private person or any personal detail: only the names of brands, artists, public figures and places, concept words for tag search, and areas.",
  },
  {
    term: "Group level",
    text: "Demographics are relative indices of age and gender groups, not shares of customers, and a claim about an audience's age needs a metric that measured it.",
  },
  {
    term: "Snapshots",
    text: "Every number carries the time it was fetched. Cached answers keep their original request id and show their age. Trend data comes from one fixed historical window and always says so.",
  },
  {
    term: "Never in git",
    text: "No Qloo values or ids live in the repository. They are resolved at run time and kept in the app's database; a guard scans the tree and its whole history for them.",
  },
  {
    term: "Your answers",
    text: "There are no accounts. An answer you ask for is unlisted and kept out of search engines. Your answers are remembered in this browser only.",
  },
];

export const DATA_NOTE = {
  /** The row the note hangs from. */
  term: "Snapshots",
  text: "Snapshot framing is enforced in components: every chart says what it compares against, and has a table view and a Source.",
  trace: "ChartCard · figures",
};

// 05 Models and cost ---------------------------------------------------------------------------------------

export const GUARDS_COPY = {
  modelsHeading: "Models",
  modelsCaption: "Who does what, and on which model",
  perBriefHeading: "Per answer",
  dailyHeading: "Per day",
  roles: {
    clerk: "Clerk: reads the question",
    analyst: "Analyst: plans and writes",
    economy: "Economy analyst: once today's budget runs low",
    quant: "Quant: computes every number",
    checker: "Checker: reviews the draft",
  },
  code: "Code, not a model",
  note: "Replays, saved answers and repeated questions are served from the database: no Qloo request and no model cost.",
  noteTrace: "replay · answer cache",
} as const;

/** Per-brief guards from the run limits; dollars and seconds as printed. */
export function perBriefGuards(l: {
  qlooCalls: number;
  qlooWarnAt: number;
  followupCalls: number;
  softMs: number;
  hardMs: number;
  usdNudge: number;
  usdHard: number;
  modelResponses: number;
}): { term: string; text: string }[] {
  return [
    { term: "Qloo requests", text: `At most ${l.qlooCalls} new requests, with a warning at ${l.qlooWarnAt}; follow-ups share ${l.followupCalls}.` },
    { term: "Model responses", text: `At most ${l.modelResponses}, a nudge included.` },
    { term: "Time", text: `A nudge to finish at ${Math.round(l.softMs / 1000)} s, a hard stop at ${Math.round(l.hardMs / 1000)} s.` },
    { term: "Model spend", text: `A wrap-up nudge at $${l.usdNudge.toFixed(2)}, a hard stop at $${l.usdHard.toFixed(2)}.` },
  ];
}

/** A lane's thresholds on today's model spend across all briefs, in USD (laneBudget in server/breakers). */
export interface LaneBudgetView {
  /** From here the lane's briefs run on the economy analyst. */
  economyAt: number;
  /** From here the lane is replay only. */
  replayAt: number;
  /** The most today's spend may reach with the lane's briefs: the pre-run check's cap. */
  cap: number;
}

/** The daily budgets as the server runs them: its spend policy, each lane's thresholds and the Qloo cap. */
export interface DailyBudgetView {
  /** LLM_DAILY_USD_CAP. */
  dailyCapUsd: number;
  /** LLM_JUDGE_SHARE: the share of the budget public briefs may not reach. */
  judgeShare: number;
  lanes: Readonly<Record<Lane, LaneBudgetView>>;
  /** What a brief holds of today's budget before it starts, on the analyst and on the economy analyst. */
  preRunUsd: { live: number; economy: number };
  /** QLOO_DAILY_FRESH_CAP, and each lane's part of it. */
  qloo: { dailyFresh: number; lanes: Readonly<Record<Lane, number>> };
}

const usd = (n: number) => `$${n.toFixed(2)}`;

/** A lane's steps down, e.g. "Sonnet 5.5 until today's spend reaches $0.49, then Haiku 5.5 until $0.79; …". */
function laneSteps(b: LaneBudgetView, models: { analyst: string; economy: string }): string {
  return `${models.analyst} until today's spend reaches ${usd(b.economyAt)}, then ${models.economy} until ${usd(b.replayAt)}; past that, saved answers and replays only, until 00:00 UTC.`;
}

/** Daily guards from the server's configuration; `models` as words ("Sonnet 5.5"). */
export function dailyGuards(d: DailyBudgetView, models: { analyst: string; economy: string }): { term: string; text: string }[] {
  const count = (n: number) => n.toLocaleString("en-US");
  return [
    {
      term: "Model budget",
      text: `${usd(d.dailyCapUsd)} a day across all answers, counted by UTC day. ${Math.round(d.judgeShare * 100)}% of it is held for the judge lane, which hackathon judges open with a code; public answers never reach it.`,
    },
    { term: "Public answers", text: laneSteps(d.lanes.public, models) },
    { term: "Judge lane", text: laneSteps(d.lanes.judge, models) },
    {
      term: "Before an answer",
      text: `An answer holds ${usd(d.preRunUsd.live)} of today's budget before it starts (${usd(d.preRunUsd.economy)} on ${models.economy}), and starts only while today's spend plus that stays within its lane's cap: ${usd(d.lanes.public.cap)} public, ${usd(d.lanes.judge.cap)} judge.`,
    },
    {
      term: "Qloo budget",
      text: `At most ${count(d.qloo.dailyFresh)} fresh Qloo requests a day: ${count(d.qloo.lanes.public)} for public answers, ${count(d.qloo.lanes.judge)} for the judge lane. Cached answers are free.`,
    },
  ];
}
