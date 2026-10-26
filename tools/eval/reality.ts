// The Reality Check (SPEC §6.6 item 3, PLAN Part 7): for each pre-registered case of
// eval/reality_cases.json, does Qloo's taste for the seed put the real-world choice above other
// candidates? Per case the candidate set is the real choice, GHOST's top five (the same model with no
// tools, D23) and five distractors matched on popularity from the choice's own discovery pool, all
// scored in one call on one scale; the case reports the real choice's percentile among them (ties
// half, 0.5 the random expectation) and whether GHOST named it. The location kinds use the
// equivalents in reality-location.ts.
//
// Every Qloo call goes through the client the CLIs open (openCliQloo: QLOO_TAG, QLOO_TAG_CAP,
// QLOO_RPS and the shared Postgres cache), so a rerun is served from the cache and draws the same
// distractors. A case whose seed or choice does not resolve exactly is reported as not scorable,
// never dropped or replaced (eval/README.md). The run itself holds raw scores and goes only to
// .private/eval/ (writeRealityRaw); realityExport is the aggregate the eval writers publish (D29).
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  METRO_LABEL,
  type EntityType,
  type GeoApi,
  type GhostAnswer,
  type GhostPickCategory,
  type Job,
  type LocalityApi,
  type QlooApi,
  type QlooParams,
  type QlooSearchEntity,
} from "@ct/contracts";
import { isNetworkCacheStatus, type QlooCallRecord, type QlooClient } from "@ct/qloo";
import { classifyMatches, median, searchParams, type ResolveMatchClass } from "@ct/quant";
import type { EvalSummary } from "../../apps/web/components/method/eval-summary";
import { RealityKind, type RealityCase, type RealityCasesFile } from "./cases";
import {
  affinityById,
  areaLifts,
  baselineHeatParams,
  comedianCaseScore,
  gapOf,
  HEATMAP,
  matchArea,
  matchMarket,
  MIN_AREA_CELLS,
  MIN_PANEL,
  scoreMarkets,
  seedHeatParams,
  type BookedMarket,
  type MarketCell,
  type SecondaryMarket,
} from "./reality-location";
import { DISTRACTORS, GHOST_TOP, hitChance, percentileAmong, popularityMatched, rankAmong } from "./reality-score";

export const PRIVATE_EVAL_DIR = new URL("../../.private/eval/", import.meta.url);

const BRAND = "urn:entity:brand";
/** The discovery pool: Qloo's top fifty brands for the registered choice (the insights maximum). */
export const POOL_TAKE = 50;
/** Calls several cases share (the comedian panel's markets, the pinned baselines) go under this tool id. */
const SHARED_TOOL = "reality-shared";

/** GHOST's picks for a case, best first; the harness uses the first five. */
export type GhostTop5 = (c: RealityCase) => Promise<readonly string[]>;

export interface RealityDeps {
  /** The client openCliQloo opens, so the tag, its cap, the pace and the shared cache apply. */
  client: QlooClient;
  geo: GeoApi;
  /** The pinned market localities (kv metro_localities); null leaves comedian and neighbourhood cases unscorable. */
  localities: LocalityApi | null;
  /** config/metros.json secondary markets (loadSecondaryMarkets). */
  markets: readonly SecondaryMarket[];
  ghostTop5: GhostTop5;
  /**
   * Every registered case (default: the cases run). The comedian panel is all of its comedians, so a
   * comedian case scores the same alone, in a rerun or beside the others.
   */
  registered?: readonly RealityCase[];
  log?: (line: string) => void;
  now?: () => Date;
  signal?: AbortSignal;
}

export type UnscorableReason =
  | "seed_unresolved"
  | "choice_unresolved"
  | "choice_unscored"
  | "no_distractors"
  | "no_contrast"
  | "no_locality"
  | "panel_too_small"
  | "budget"
  | "call_failed";

export interface RealityCandidate {
  /** Entity id, market id or gazetteer area id. */
  key: string;
  name: string;
  /** "choice" is the real choice; in a comedian case, every booked market. */
  role: "choice" | "ghost" | "distractor";
  /** Named by GHOST, the real choice included when it was a hit. */
  ghost: boolean;
  popularity: number | null;
  /**
   * On the case's one scale (affinity in the scoring call, panel percentile or area lift); null when
   * unscored: an entity Qloo left out of the scoring call ranks below every scored one, an area off
   * the seed's map is left out.
   */
  score: number | null;
}

export interface GhostOutcome {
  /** GHOST's picks as it named them, at most five. */
  picks: string[];
  /** Picks that resolved: exactly in Qloo, to a secondary market or to a gazetteer area. */
  resolved: number;
  /** A pick is the real choice (comedian: any booked market); null when GHOST failed or the choice did not resolve. */
  hit: boolean | null;
  /** Comedian cases: the chance that five random secondary markets include a booked one. */
  chance: number | null;
  error: string | null;
}

export interface CallTally {
  network: number;
  cached: number;
}

export interface RealityCaseResult {
  id: string;
  kind: RealityKind;
  showcase: string | null;
  seed: string;
  /** The real choice as the table prints it. */
  choice: string;
  status: "scored" | "not_scorable";
  reason: UnscorableReason | null;
  /** Why the case is not scorable, in a sentence; null when scored. */
  detail: string | null;
  /** The real choice's percentile among the other ranked candidates (comedian: the median over booked markets). */
  percentile: number | null;
  /** 1 = scored above every other candidate; null for a comedian case or one not scored. */
  rank: number | null;
  /** Ranked candidates, the choice included: an entity Qloo left out counts, an area off the map does not (comedian: markets with a score for the seed). */
  of: number | null;
  /** Every candidate put up for scoring, scored or not. */
  candidates: RealityCandidate[];
  /** Comedian cases: each booked market's percentile among the unbooked ones. */
  booked: BookedMarket[] | null;
  /** Comedian cases: the booked-versus-unbooked market comparisons, and how many tied; null otherwise or with none. */
  ties: { tied: number; of: number } | null;
  ghost: GhostOutcome;
  calls: CallTally;
  /**
   * A Qloo call or lookup the case needed was refused or failed (for a comedian case, any of the
   * panel's), so a rerun may score it differently: the eval runs it again on --resume.
   */
  retry: boolean;
}

export interface CallPlan {
  /** Network calls each case can spend on a cold cache. */
  perCase: { id: string; calls: number }[];
  /** Calls the cases share: one per secondary market and the searches of registered comedians not run, for the panel; one baseline per metro. */
  shared: number;
  total: number;
}

/** A full run: raw scores included, so it goes only to .private/eval/ (writeRealityRaw). */
export interface RealityRun {
  ranAt: string;
  /** eval/reality_cases.json's registration date. */
  registered: string;
  plan: CallPlan;
  cases: RealityCaseResult[];
  shared: CallTally;
  calls: CallTally;
  /** The registered caveats, verbatim. */
  caveats: string[];
}

// Call plan --------------------------------------------------------------------------------------------

/**
 * Network calls the check can spend on a cold cache: an entity case searches its seed, its choice
 * and GHOST's five picks, then makes the pool call and the scoring call; a comedian case searches
 * its seed and shares one call per secondary market, and the search of every registered comedian
 * not run (the panel); a neighbourhood case searches its seed and makes its concept map, sharing one
 * pinned baseline per metro. Cached requests cost nothing, so a rerun spends less.
 */
export function planRealityCalls(cases: readonly RealityCase[], markets: readonly SecondaryMarket[], registered: readonly RealityCase[] = cases): CallPlan {
  const perCase = cases.map((c) => ({
    id: c.id,
    calls: c.kind === "comedian_market" ? 1 : c.kind === "dtc_neighbourhood" ? 2 : 2 + GHOST_TOP + 2,
  }));
  const running = new Set(cases.map((c) => c.id));
  const panel = cases.some((c) => c.kind === "comedian_market")
    ? markets.length + registered.filter((c) => c.kind === "comedian_market" && !running.has(c.id)).length
    : 0;
  const metros = new Set(cases.flatMap((c) => (c.kind === "dtc_neighbourhood" ? [c.choice.metro] : []))).size;
  const shared = panel + metros;
  return { perCase, shared, total: perCase.reduce((n, c) => n + c.calls, 0) + shared };
}

function tally(records: readonly QlooCallRecord[], toolCallId: string): CallTally {
  const mine = records.filter((r) => r.toolCallId === toolCallId);
  const network = mine.filter((r) => isNetworkCacheStatus(r.cache)).length;
  return { network, cached: mine.length - network };
}

// Requests ---------------------------------------------------------------------------------------------

/**
 * The discovery pool the distractors are drawn from: the registered choice's own top brands (SUBS's
 * discovery of the choice), never the seed's. For a fixed signal Qloo's scores do not depend on the
 * candidate list (S12), so a pool of the seed's top brands would outscore any choice outside it by
 * construction and put the null near 0. The choice's look-alikes carry no pick by the seed's taste:
 * where that taste says nothing about the choice, the choice and the five are interchangeable and
 * 0.5 is the random expectation.
 */
export function discoveryParams(choiceId: string): QlooParams {
  return { "signal.interests.entities": [choiceId], take: POOL_TAKE };
}

/** The one scoring call: the seed's taste over the exact candidate list, as RANK's none context sends it. */
export function scoringParams(seedId: string, candidateIds: readonly string[]): QlooParams {
  return { "signal.interests.entities": [seedId], "filter.results.entities": [...candidateIds], take: candidateIds.length };
}

interface Resolved {
  text: string;
  match: ResolveMatchClass;
  /** The one exact match of the right type (D20); null otherwise. */
  entity: QlooSearchEntity | null;
}

/** One /search, applied only on a single exact normalised name of the type (S0's rule). */
async function resolveName(qloo: QlooApi, text: string, type: EntityType): Promise<Resolved> {
  const params = searchParams({ text, type, metro: null });
  if (params === null) throw new Error(`a ${type} cannot be searched without a metro`);
  const { data } = await qloo.search(params);
  const c = classifyMatches({ text, type }, data.results);
  return { text, match: c.matchClass, entity: c.matchClass === "exact" ? (c.exact[0] ?? null) : null };
}

const MATCH_WORDS: Readonly<Record<ResolveMatchClass, string>> = {
  exact: "an exact match",
  ambiguous: "ambiguous (several exact matches)",
  not_found: "not found",
};

const unresolved = (r: Resolved, type: EntityType): string => `'${r.text}' is ${MATCH_WORDS[r.match]} as a ${type} in Qloo, so it was not applied.`;

// Cases ------------------------------------------------------------------------------------------------

type EntityCase = Extract<RealityCase, { kind: "brand_collaboration" | "tour_sponsor" }>;
type ComedianCase = Extract<RealityCase, { kind: "comedian_market" }>;
type NeighbourhoodCase = Extract<RealityCase, { kind: "dtc_neighbourhood" }>;

/** What a case's scorer decides; the run adds the case's identity, its calls and whether to retry it. */
type Outcome = Pick<RealityCaseResult, "status" | "reason" | "detail" | "percentile" | "rank" | "of" | "candidates" | "booked" | "ties" | "ghost">;

function notScorable(reason: UnscorableReason, detail: string, ghost: GhostOutcome, candidates: RealityCandidate[] = []): Outcome {
  return { status: "not_scorable", reason, detail, percentile: null, rank: null, of: null, candidates, booked: null, ties: null, ghost };
}

/**
 * The choice's percentile and rank among the other candidates, or why there is none (`unscored`).
 * `missing` is what a candidate without a score is. "lowest" in an entity case's scoring call: an
 * entity Qloo left out shows no relationship to the seed's taste, so it ranks below every scored one,
 * tied with any other left out (setting the choice aside there would drop exactly the choices Qloo
 * misses, as panelPercentiles). "unmeasured" for an area off the seed's map: it is left out, and a
 * choice there has no score. A call that scored no candidate at all scores no one.
 */
function placeChoice(candidates: RealityCandidate[], ghost: GhostOutcome, missing: "lowest" | "unmeasured", unscored: string): Outcome {
  const scores = candidates.flatMap((c) => (c.score === null ? [] : [c.score]));
  const below = missing === "lowest" && scores.length > 0 ? Math.min(...scores) - 1 : null;
  const valueOf = (c: RealityCandidate): number | null => c.score ?? below;
  const choice = candidates.find((c) => c.role === "choice");
  const mine = choice === undefined ? null : valueOf(choice);
  if (choice === undefined || mine === null) return notScorable("choice_unscored", unscored, ghost, candidates);
  const others = candidates.flatMap((c) => (c === choice ? [] : (valueOf(c) ?? [])));
  const percentile = percentileAmong(mine, others);
  if (percentile === null) return notScorable("no_distractors", "No other candidate was put up and scored beside the real choice.", ghost, candidates);
  return {
    status: "scored",
    reason: null,
    detail: null,
    percentile,
    rank: rankAmong(mine, others),
    of: others.length + 1,
    candidates,
    booked: null,
    ties: null,
    ghost,
  };
}

async function ghostPicks(deps: RealityDeps, c: RealityCase): Promise<{ picks: string[]; error: string | null }> {
  try {
    const named = await deps.ghostTop5(c);
    return { picks: named.map((n) => n.trim()).filter((n) => n.length > 0).slice(0, GHOST_TOP), error: null };
  } catch (err) {
    return { picks: [], error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Brand collaboration and tour sponsor: the seed, the choice and GHOST's picks resolved exactly; a
 * pool of the choice's own top brands (discoveryParams); five of them matched on popularity to the
 * choice; then one rank call over the choice, GHOST's resolved picks and the five, under the seed's
 * taste. A hit is a pick that resolves to the choice's entity (a pick of another real partner of the
 * seed is a distractor like any other). The case asks whether the seed's taste picks the real choice
 * out from brands like it; a candidate Qloo leaves out of the scoring call ranks lowest.
 */
async function scoreEntityCase(c: EntityCase, qloo: QlooApi, named: { picks: string[]; error: string | null }): Promise<Outcome> {
  const type = c.choice.entity_type;
  const [seed, choice, ...picks] = await Promise.all([
    resolveName(qloo, c.seed.name, c.seed.entity_type),
    resolveName(qloo, c.choice.name, type),
    ...named.picks.map((name) => resolveName(qloo, name, type)),
  ]);
  if (seed === undefined || choice === undefined) throw new Error("missing resolution");
  const ghostEntities = [...new Map(picks.flatMap((p) => (p.entity === null ? [] : [[p.entity.entity_id, p.entity] as const]))).values()];
  const choiceId = choice.entity?.entity_id ?? null;
  const ghost: GhostOutcome = {
    picks: named.picks,
    resolved: picks.filter((p) => p.entity !== null).length,
    hit: named.error !== null || choiceId === null ? null : ghostEntities.some((e) => e.entity_id === choiceId),
    chance: null,
    error: named.error,
  };
  if (seed.entity === null) return notScorable("seed_unresolved", unresolved(seed, c.seed.entity_type), ghost);
  if (choice.entity === null || choiceId === null) return notScorable("choice_unresolved", unresolved(choice, type), ghost);
  const seedId = seed.entity.entity_id;

  const pool = (await qloo.insights(BRAND, discoveryParams(choiceId))).data.results.entities;
  const exclude = new Set([seedId, choiceId, ...ghostEntities.map((e) => e.entity_id)]);
  const choicePopularity = choice.entity.popularity ?? null;
  const distractors = popularityMatched(
    c.id,
    choicePopularity,
    pool.map((e) => ({ key: e.entity_id, name: e.name, popularity: e.popularity ?? null })),
    exclude,
    DISTRACTORS,
  );
  const candidates: RealityCandidate[] = [
    { key: choiceId, name: choice.entity.name, role: "choice", ghost: ghost.hit === true, popularity: choicePopularity, score: null },
    ...ghostEntities
      .filter((e) => e.entity_id !== choiceId && e.entity_id !== seedId)
      .map((e): RealityCandidate => ({ key: e.entity_id, name: e.name, role: "ghost", ghost: true, popularity: e.popularity ?? null, score: null })),
    ...distractors.map((d): RealityCandidate => ({ key: d.key, name: d.name, role: "distractor", ghost: false, popularity: d.popularity, score: null })),
  ];

  const scored = (await qloo.insights(BRAND, scoringParams(seedId, candidates.map((k) => k.key)))).data.results.entities;
  const affinity = affinityById(scored);
  for (const k of candidates) k.score = affinity.get(k.key) ?? null;
  return placeChoice(candidates, ghost, "lowest", `Qloo returned no affinity for any of the ${candidates.length} candidates in the scoring call.`);
}

/** The comedian panel: every registered comedian seed resolved once, by case id (a case that runs under its own tool id, the rest as shared calls). */
interface Panel {
  seeds: Map<string, Resolved | { error: unknown }>;
  /** Null when fewer than MIN_PANEL seeds resolved: no market call was made. */
  cells: MarketCell[] | null;
  /** A seed search or a market call failed or was refused, so every comedian case may score differently on a rerun. */
  failed: boolean;
}

/**
 * A comedian case: the booked markets' percentiles among the unbooked ones on the panel's market
 * calls. When every booked-versus-unbooked comparison ties (the seed holds one place in the panel
 * across the scored markets, as when it leads everywhere) the case measures nothing and is not
 * scorable, rather than scored at 0.5 by construction. A GHOST hit is any booked market among its
 * five, reported beside the chance of one.
 */
function scoreComedianCase(c: ComedianCase, panel: Panel, markets: readonly SecondaryMarket[], named: { picks: string[]; error: string | null }): Outcome {
  const booked = c.choice.markets;
  const ghostMarkets = [...new Set(named.picks.flatMap((p) => matchMarket(p, markets) ?? []))];
  const inUniverse = booked.filter((m) => markets.some((s) => s.id === m)).length;
  const ghost: GhostOutcome = {
    picks: named.picks,
    resolved: named.picks.filter((p) => matchMarket(p, markets) !== null).length,
    hit: named.error !== null ? null : ghostMarkets.some((m) => booked.includes(m)),
    chance: hitChance(markets.length, inUniverse, GHOST_TOP),
    error: named.error,
  };
  const seed = panel.seeds.get(c.id);
  if (seed === undefined || "error" in seed) throw seed?.error ?? new Error(`${c.id}: the seed was not searched`);
  if (seed.entity === null) return notScorable("seed_unresolved", unresolved(seed, c.seed.entity_type), ghost);
  if (panel.cells === null) {
    return notScorable("panel_too_small", `Fewer than ${MIN_PANEL} registered comedians resolved, so no market could rank one against another.`, ghost);
  }
  const seedId = seed.entity.entity_id;
  const score = comedianCaseScore(seedId, booked, panel.cells);
  const candidates = panel.cells.map(
    (cell): RealityCandidate => ({
      key: cell.market.id,
      name: cell.market.label,
      role: booked.includes(cell.market.id) ? "choice" : ghostMarkets.includes(cell.market.id) ? "ghost" : "distractor",
      ghost: ghostMarkets.includes(cell.market.id),
      popularity: null,
      score: cell.pct.get(seedId) ?? null,
    }),
  );
  const ties = score.comparisons === 0 ? null : { tied: score.ties, of: score.comparisons };
  const outcome = (reason: UnscorableReason, detail: string): Outcome => ({ ...notScorable(reason, detail, ghost, candidates), booked: score.booked, ties });
  if (score.percentile !== null && score.ties === score.comparisons) {
    return outcome("no_contrast", `'${seed.entity.name}' holds the same place in the panel in every scored market, so no booked market stands apart from an unbooked one.`);
  }
  if (score.percentile !== null) {
    return { status: "scored", reason: null, detail: null, percentile: score.percentile, rank: null, of: score.scored, candidates, booked: score.booked, ties, ghost };
  }
  const called = panel.cells.filter((cell) => cell.gap === null);
  const failed = panel.cells.filter((cell) => cell.gap === "budget" || cell.gap === "call_failed");
  if (called.length === 0 && failed.length === 0) return outcome("no_locality", "No secondary market has a pinned locality.");
  if (called.length === 0) {
    const budget = failed.find((cell) => cell.gap === "budget");
    return outcome(budget ? "budget" : "call_failed", (budget ?? failed[0])?.error ?? "every market call failed");
  }
  if (score.distractors === 0) return outcome("no_distractors", `No market the tour did not book has a score for '${seed.entity.name}'.`);
  return outcome("choice_unscored", `No booked market has a score for '${seed.entity.name}'.`);
}

/**
 * A store neighbourhood: the seed's analog Lift Map over the metro, every gazetteer area on it scored
 * (areaLifts, ungated); the candidates are the registered area, GHOST's resolved areas and five areas
 * with a lift matched on baseline popularity. An area off the seed's map was not measured: a GHOST
 * area there is left out, and a registered area there leaves the case unscorable. A GHOST hit is a
 * pick that resolves to the registered area.
 */
async function scoreNeighbourhoodCase(
  c: NeighbourhoodCase,
  qloo: QlooApi,
  shared: QlooApi,
  deps: RealityDeps,
  named: { picks: string[]; error: string | null },
): Promise<Outcome> {
  const { metro, area_id: areaId } = c.choice;
  const ghostAreas = [...new Set(named.picks.flatMap((p) => matchArea(deps.geo, c.choice, p) ?? []))];
  const ghost: GhostOutcome = {
    picks: named.picks,
    resolved: named.picks.filter((p) => matchArea(deps.geo, c.choice, p) !== null).length,
    hit: named.error !== null ? null : ghostAreas.includes(areaId),
    chance: null,
    error: named.error,
  };
  const seed = await resolveName(qloo, c.seed.name, c.seed.entity_type);
  if (seed.entity === null) return notScorable("seed_unresolved", unresolved(seed, c.seed.entity_type), ghost);
  const pin = deps.localities === null ? null : await deps.localities.market(metro);
  if (pin === null) return notScorable("no_locality", `No locality is pinned for ${METRO_LABEL[metro]}, so its maps cannot be requested.`, ghost);

  const [concept, baseline] = await Promise.all([
    qloo.insights(HEATMAP, seedHeatParams(pin.entityId, seed.entity.entity_id)),
    shared.insights(HEATMAP, baselineHeatParams(pin.entityId)),
  ]);
  const areas = areaLifts(deps.geo, metro, concept.data.results.heatmap, baseline.data.results.heatmap);
  const choice = areas.find((a) => a.id === areaId);
  if (choice === undefined) return notScorable("choice_unresolved", `Area ${areaId} is not in the ${METRO_LABEL[metro]} gazetteer.`, ghost);
  const exclude = new Set([areaId, ...ghostAreas]);
  const measured = areas.flatMap((a) => (a.lift === null ? [] : [{ ...a, key: a.id }]));
  const distractors = popularityMatched(c.id, choice.popularity, measured, exclude, DISTRACTORS);
  const candidate = (a: (typeof areas)[number], role: RealityCandidate["role"]): RealityCandidate => ({
    key: a.id,
    name: a.name,
    role,
    ghost: ghostAreas.includes(a.id),
    popularity: a.popularity,
    score: a.lift,
  });
  const candidates = [
    candidate(choice, "choice"),
    ...ghostAreas.flatMap((id) => {
      const a = areas.find((x) => x.id === id);
      return a === undefined || id === areaId ? [] : [candidate(a, "ghost")];
    }),
    ...distractors.map((a) => candidate(a, "distractor")),
  ];
  return placeChoice(
    candidates,
    ghost,
    "unmeasured",
    `${choice.name} is off the seed's map: too few cells both maps cover for a lift (${choice.n} of ${MIN_AREA_CELLS}).`,
  );
}

function choiceLabel(c: RealityCase): string {
  if (c.kind === "comedian_market") {
    const n = c.choice.markets.length;
    return `${c.choice.tour} (${n} secondary market${n === 1 ? "" : "s"})`;
  }
  return c.choice.name;
}

function caseLine(r: RealityCaseResult): string {
  const score =
    r.status === "scored"
      ? `percentile ${(r.percentile ?? 0).toFixed(2)}${r.rank !== null ? ` (rank ${r.rank} of ${r.of})` : ` (median over booked markets, ${r.of} scored)`}`
      : `not scorable: ${r.reason} (${r.detail})`;
  const hit = r.ghost.hit === null ? "n/a" : r.ghost.hit ? "yes" : "no";
  const chance = r.ghost.chance === null ? "" : `, chance ${r.ghost.chance.toFixed(2)}`;
  return `${r.id} ${r.kind}: ${score}; GHOST hit ${hit}${chance}; Qloo ${r.calls.network} network, ${r.calls.cached} cached`;
}

/**
 * Runs every case of `file` in file order, one at a time, so each case's calls are its own; nothing
 * throws for a single case: a refused or failed call makes that case not scorable, with the reason,
 * and marks it to retry. The comedian panel is every comedian of deps.registered; the seeds of those
 * not run are searched as shared calls.
 */
export async function runRealityCheck(file: RealityCasesFile, deps: RealityDeps): Promise<RealityRun> {
  const log = deps.log ?? (() => undefined);
  const ranAt = (deps.now?.() ?? new Date()).toISOString();
  const records: QlooCallRecord[] = [];
  const scope = deps.client.standalone({ onCall: (r) => records.push(r), signal: deps.signal });
  const toolId = (c: RealityCase) => `reality-${c.id}`;
  const shared = scope.forTool(SHARED_TOOL);
  const registered = deps.registered ?? file.cases;
  const plan = planRealityCalls(file.cases, deps.markets, registered);
  log(`Reality Check: ${file.cases.length} cases, at most ${plan.total} Qloo network calls on a cold cache (${plan.shared} shared)`);

  // The comedian panel first: its market calls serve every comedian case.
  const isComedian = (c: RealityCase): c is ComedianCase => c.kind === "comedian_market";
  const comedians = file.cases.filter(isComedian);
  const running = new Set(file.cases.map((c) => c.id));
  const members = comedians.length === 0 ? [] : [...registered.filter((c) => isComedian(c) && !running.has(c.id)), ...comedians];
  const seeds = new Map<string, Resolved | { error: unknown }>();
  for (const c of members) {
    try {
      seeds.set(c.id, await resolveName(running.has(c.id) ? scope.forTool(toolId(c)) : shared, c.seed.name, c.seed.entity_type));
    } catch (error) {
      seeds.set(c.id, { error });
    }
  }
  const panelIds = [...new Set([...seeds.values()].flatMap((s) => ("entity" in s && s.entity !== null ? [s.entity.entity_id] : [])))];
  const cells = panelIds.length >= MIN_PANEL ? await scoreMarkets(shared, deps.localities, deps.markets, panelIds) : null;
  const panel: Panel = {
    seeds,
    cells,
    failed: [...seeds.values()].some((s) => "error" in s) || (cells ?? []).some((cell) => cell.gap === "budget" || cell.gap === "call_failed"),
  };
  if (comedians.length > 0) {
    const sharedCalls = tally(records, SHARED_TOOL);
    const called = panel.cells?.filter((cell) => cell.gap !== "no_locality").length ?? 0;
    log(`comedian panel: ${panelIds.length} comedians ranked in ${called} markets (${sharedCalls.network} network calls)`);
  }

  const cases: RealityCaseResult[] = [];
  for (const c of file.cases) {
    const qloo = scope.forTool(toolId(c));
    const named = await ghostPicks(deps, c);
    let outcome: Outcome;
    try {
      outcome =
        c.kind === "comedian_market"
          ? scoreComedianCase(c, panel, deps.markets, named)
          : c.kind === "dtc_neighbourhood"
            ? await scoreNeighbourhoodCase(c, qloo, shared, deps, named)
            : await scoreEntityCase(c, qloo, named);
    } catch (err) {
      const { gap, error } = gapOf(err);
      outcome = notScorable(gap === "budget" ? "budget" : "call_failed", error, {
        picks: named.picks,
        resolved: 0,
        hit: null,
        chance: null,
        error: named.error,
      });
    }
    const result: RealityCaseResult = {
      id: c.id,
      kind: c.kind,
      showcase: c.showcase,
      seed: c.seed.name,
      choice: choiceLabel(c),
      ...outcome,
      calls: tally(records, toolId(c)),
      retry: outcome.reason === "budget" || outcome.reason === "call_failed" || (isComedian(c) && panel.failed),
    };
    log(caseLine(result));
    cases.push(result);
  }

  const network = records.filter((r) => isNetworkCacheStatus(r.cache)).length;
  const calls = { network, cached: records.length - network };
  log(`Reality Check done: ${calls.network} network and ${calls.cached} cached Qloo calls (planned at most ${plan.total})`);
  return { ranAt, registered: file.registered, plan, cases, shared: tally(records, SHARED_TOOL), calls, caveats: [...file.caveats] };
}

// Aggregates -------------------------------------------------------------------------------------------

export interface RealityGroup {
  /** Cases in the group. */
  cases: number;
  scorable: number;
  /** The median of the scorable cases' percentiles; random expectation 0.5. */
  medianPercentile: number | null;
  /** Cases where GHOST's hit is known (GHOST answered and the choice resolved), comedian cases apart outside byKind. */
  ghostCases: number;
  ghostHits: number;
  ghostHitRate: number | null;
}

export interface RealityKindGroup extends RealityGroup {
  /** Comedian cases: the mean chance of a GHOST hit at random; null for the other kinds. */
  chance: number | null;
}

export interface RealityAggregate {
  all: RealityGroup;
  /** The registered rule: every median is reported again without the cases whose seed a showcase names. */
  withoutShowcase: RealityGroup;
  byKind: Record<RealityKind, RealityKindGroup>;
  notScorable: { id: string; reason: UnscorableReason; detail: string }[];
  caveats: string[];
}

/**
 * A group's median and GHOST hit rate. The hit rate leaves comedian cases out unless `withComedians`
 * (byKind): five random secondary markets include a booked one almost surely (hitChance), so a
 * comedian hit says little and is reported beside that chance instead.
 */
function group(cases: readonly RealityCaseResult[], withComedians = false): RealityGroup {
  const percentiles = cases.flatMap((c) => (c.status === "scored" && c.percentile !== null ? [c.percentile] : []));
  const known = cases.filter((c) => c.ghost.hit !== null && (withComedians || c.kind !== "comedian_market"));
  const hits = known.filter((c) => c.ghost.hit === true).length;
  return {
    cases: cases.length,
    scorable: percentiles.length,
    medianPercentile: median(percentiles),
    ghostCases: known.length,
    ghostHits: hits,
    ghostHitRate: known.length === 0 ? null : hits / known.length,
  };
}

const round2 = (x: number | null): number | null => (x === null ? null : Math.round(x * 100) / 100);
const fixed2 = (x: number | null): string => (x === null ? "none" : x.toFixed(2));

export function aggregateReality(run: RealityRun): RealityAggregate {
  const all = group(run.cases);
  const byKind = Object.fromEntries(
    RealityKind.options.map((kind) => {
      const cases = run.cases.filter((c) => c.kind === kind);
      const chances = cases.flatMap((c) => (c.ghost.chance === null ? [] : [c.ghost.chance]));
      return [kind, { ...group(cases, true), chance: chances.length === 0 ? null : chances.reduce((a, b) => a + b, 0) / chances.length }];
    }),
  ) as RealityAggregate["byKind"];
  const notScorable = run.cases.flatMap((c) => (c.status === "scored" || c.reason === null ? [] : [{ id: c.id, reason: c.reason, detail: c.detail ?? "" }]));
  const comedians = byKind.comedian_market;
  const ties = run.cases.reduce((t, c) => (c.ties === null ? t : { tied: t.tied + c.ties.tied, of: t.of + c.ties.of }), { tied: 0, of: 0 });
  const caveats = [
    ...run.caveats,
    `${all.scorable} of ${all.cases} cases were scored${notScorable.length > 0 ? `; not scorable: ${notScorable.map((n) => `${n.id} (${n.reason})`).join(", ")}` : ""}.`,
    ...(comedians.chance === null
      ? []
      : [
          `A comedian GHOST hit is near certain by chance: five random secondary markets include a booked one with probability ${fixed2(comedians.chance)} on average, ` +
            `so the GHOST hit rate leaves the comedian cases out (they hit ${comedians.ghostHits} of ${comedians.ghostCases}).`,
        ]),
    ...(ties.of === 0
      ? []
      : [
          `${ties.tied} of ${ties.of} booked-versus-unbooked market comparisons in the comedian cases tied: a small comedian panel gives a market few levels, ` +
            "which pulls a case towards 0.5.",
        ]),
    "GHOST may know choices made public before its training data ends, so its hit rate partly measures recall rather than judgement of taste.",
  ];
  return { all, withoutShowcase: group(run.cases.filter((c) => c.showcase === null)), byKind, notScorable, caveats };
}

// Export -----------------------------------------------------------------------------------------------

/** EvalSummary.realityCheck, the block /method#eval and the launchpad read. */
export type RealityCheckSummary = NonNullable<EvalSummary["realityCheck"]>;

/** One row of the Reality Check table (SPEC §6.7): names, the rank of N and the GHOST hit, no raw score. */
export interface RealityTableRow {
  id: string;
  kind: RealityKind;
  showcase: string | null;
  seed: string;
  choice: string;
  /** 1 = Qloo scored the real choice above every other candidate; null for a comedian case or one not scored. */
  rank: number | null;
  /** Ranked candidates, the choice included (comedian: markets scored for the seed). */
  of: number | null;
  percentile: number | null;
  ghostHit: boolean | null;
  /** Comedian cases: the chance of a GHOST hit at random. */
  ghostChance: number | null;
  status: "scored" | "not_scorable";
  reason: UnscorableReason | null;
}

/** What the eval writers consume: aggregates and the table, every number at most two decimals. */
export interface RealityCheckExport {
  summary: RealityCheckSummary;
  table: RealityTableRow[];
  aggregate: RealityAggregate;
}

function roundGroup<G extends RealityGroup>(g: G): G {
  return { ...g, medianPercentile: round2(g.medianPercentile), ghostHitRate: round2(g.ghostHitRate) };
}

export function realityExport(run: RealityRun): RealityCheckExport {
  const raw = aggregateReality(run);
  const aggregate: RealityAggregate = {
    ...raw,
    all: roundGroup(raw.all),
    withoutShowcase: roundGroup(raw.withoutShowcase),
    byKind: Object.fromEntries(
      Object.entries(raw.byKind).map(([kind, g]) => [kind, { ...roundGroup(g), chance: round2(g.chance) }]),
    ) as RealityAggregate["byKind"],
  };
  const { all, withoutShowcase } = aggregate;
  const showcaseNote =
    withoutShowcase.scorable < all.scorable
      ? ` Without showcase seeds: median ${fixed2(withoutShowcase.medianPercentile)} (n = ${withoutShowcase.scorable}).`
      : "";
  const summary: RealityCheckSummary = {
    cases: all.scorable > 0 ? all.scorable : all.cases,
    medianPercentile: all.medianPercentile,
    ghostHitRate: all.ghostHitRate,
    note:
      `${all.scorable} of ${all.cases} registered cases scored; the GHOST hit rate is over ${all.ghostCases} cases, comedian cases apart.${showcaseNote} ` +
      "Post-event co-engagement may leak into Qloo's data, GHOST may recall choices made public before its training data ends, and n is small: no claim of significance.",
  };
  const table = run.cases.map(
    (c): RealityTableRow => ({
      id: c.id,
      kind: c.kind,
      showcase: c.showcase,
      seed: c.seed,
      choice: c.choice,
      rank: c.rank,
      of: c.of,
      percentile: round2(c.percentile),
      ghostHit: c.ghost.hit,
      ghostChance: round2(c.ghost.chance),
      status: c.status,
      reason: c.reason,
    }),
  );
  return { summary, table, aggregate };
}

/** Writes the run, raw scores included, under .private/eval/ (gitignored, blocked by the guard); returns the file. */
export function writeRealityRaw(run: RealityRun, dir: URL | string = PRIVATE_EVAL_DIR): string {
  const folder = typeof dir === "string" ? dir : fileURLToPath(dir);
  mkdirSync(folder, { recursive: true });
  const file = path.join(folder, `reality-check-${run.ranAt.replace(/[-:.]/g, "")}.json`);
  writeFileSync(file, `${JSON.stringify(run, null, 2)}\n`, "utf8");
  return file;
}

// GHOST ------------------------------------------------------------------------------------------------

/** The job GHOST is asked under per kind, and the pick category its top five are read from. */
export const REALITY_GHOST: Readonly<Record<RealityKind, { job: Job; category: GhostPickCategory }>> = {
  brand_collaboration: { job: "audience_discovery", category: "partners" },
  tour_sponsor: { job: "sponsorship", category: "partners" },
  comedian_market: { job: "market_selection", category: "markets" },
  dtc_neighbourhood: { job: "site_selection", category: "neighbourhoods" },
};

/**
 * The question GHOST answers for a case (runGhost under REALITY_GHOST's job, so the LISTS line asks for
 * the kind's pick category), fixed here so it is committed before any run. It is built from the seed
 * and the case's context only: the seed's kind of entity (so a band named after a state reads as a
 * band) and the metro for a store. It never carries the choice, the tour's name, the claim, the
 * sources or any date, so nothing in it points at the answer. Nor the sponsor category: it describes
 * the registered sponsor, so it would narrow GHOST to a few brands while Qloo's candidates get no
 * such hint.
 *
 * | kind | template |
 * |---|---|
 * | brand_collaboration | Which brands would make the best partners for a brand collaboration with the brand {seed}? Name your top five, best first. |
 * | tour_sponsor | The artist {seed} is touring. Which brands would be the best tour sponsors? Name your top five, best first. |
 * | comedian_market | The comedian {seed} is booking a tour. Which five of these secondary markets fit their audience best, best first: {every secondary market}? |
 * | dtc_neighbourhood | The brand {seed} is opening its own store in {metro}. Which neighbourhoods fit it best? Name your top five, best first. |
 *
 * A comedian question lists every secondary market of config/metros.json in config order, booked or
 * not, so GHOST picks from the universe the markets are scored on.
 */
export function ghostQuestion(c: RealityCase, markets: readonly SecondaryMarket[]): string {
  switch (c.kind) {
    case "brand_collaboration":
      return `Which brands would make the best partners for a brand collaboration with the brand ${c.seed.name}? Name your top five, best first.`;
    case "tour_sponsor":
      return `The artist ${c.seed.name} is touring. Which brands would be the best tour sponsors? Name your top five, best first.`;
    case "comedian_market":
      return (
        `The comedian ${c.seed.name} is booking a tour. Which five of these secondary markets fit their audience best, ` +
        `best first: ${markets.map((m) => m.label).join(", ")}?`
      );
    case "dtc_neighbourhood":
      return `The brand ${c.seed.name} is opening its own store in ${METRO_LABEL[c.choice.metro]}. Which neighbourhoods fit it best? Name your top five, best first.`;
  }
}

/** GHOST's top five for a case from its structured answer: the kind's pick category, in GHOST's order. */
export function ghostTop5FromAnswer(answer: GhostAnswer, kind: RealityKind): string[] {
  return answer.picks[REALITY_GHOST[kind].category].slice(0, GHOST_TOP);
}
