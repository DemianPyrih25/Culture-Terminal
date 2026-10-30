import {
  ScreenerColumn,
  SCREENER_COLUMN_FORMULA,
  SCREENER_COLUMN_LABEL,
  TASTE_MAP_MAX_K,
  type AgeBucket,
  type MarketId,
  type MarketLocality,
  type NoValueReason,
  type QlooCallMeta,
  type QlooEntity,
  type QlooParams,
  type QlooSearchEntity,
  type QlooTagSearchItem,
  type ScreenerCell,
  type ScreenerColumnMeta,
  type ScreenerRequestId,
  type ScreenerRow,
  type ScreenerRowFlag,
} from "@ct/contracts";
import { median } from "./stats";
import { computeSubstitution } from "./subs";
import { searchTags } from "./skills/common";
import { tagSearchParams } from "./skills/findTags";
import { safeName } from "./skills/format";
import { normaliseName } from "./skills/normalise";
import { discoveryParams } from "./skills/peerLandscape";
import { categoryTagOf } from "./skills/peerSelection";
import { BRAND_GENRE_TAG_TYPE } from "./skills/sponsorSlate/categories";
import { ageContext, metroContext, signalContext, type ContextSpec } from "./skills/rankCandidates/contexts";
import { fillGrid, type Candidate, type GridRow, type RowResponse } from "./skills/rankCandidates/scoring";
import { signed2 } from "./skills/rankCandidates/shared";
import { metroWins, youthTilts } from "./skills/shareOfTaste/measures";
import { fillMatrix, isComplete, mapGap, similarityOf, triangularCalls, type CallGap } from "./skills/substitutionMap";

/**
 * The brand screener's math (PLAN §5.5 "Brand screener"): pure, so the same responses always give the
 * same table. The web service makes the calls through @ct/qloo and hands them here; every column reads
 * an existing FORMULAS entry (SCREENER_COLUMN_FORMULA) through the skills' own helpers, so a screen and
 * a note never compute the same quantity two ways:
 * - FIT: pct.within_call of the one-scale scoring call (fillGrid, floor ties unscored);
 * - distinctiveness: S1's 1 − max similarity over the top ≤ 14 rows (computeSubstitution), only when
 *   the triangular calls ran and all returned;
 * - next-gen tilt: share.youth_tilt over the age calls (youthTilts, re-ranked over a common set);
 * - metro breadth: share.metros_won over the market calls (metroWins);
 * - popularity: Qloo's own value from the discovery or resolving request;
 * - UNDER-THE-RADAR: screen.under_the_radar, FIT − popularity, flagged against the set's medians.
 * An absent value is a reason, never 0, and every cell names the requests it came from (or that failed
 * to give it).
 */

/** The age contexts of a screen (§5.5 "ages share 3"): the two youngest buckets against the oldest. */
export const SCREENER_AGES: readonly AgeBucket[] = ["24_and_younger", "25_to_29", "55_and_older"];

/** UNDER-THE-RADAR never flags a brand at or above this popularity (FORMULAS screen.under_the_radar). */
export const UTR_POPULARITY_CAP = 0.85;

/** The badge and unit of each column, in ScreenerColumn order (§5.5 Taste Position: no composite). */
export const SCREENER_COLUMNS: readonly ScreenerColumnMeta[] = ScreenerColumn.options.map((key): ScreenerColumnMeta => {
  const meta: Record<ScreenerColumn, Pick<ScreenerColumnMeta, "unit" | "badge">> = {
    fit: { unit: "pct", badge: "DERIVED" },
    distinctiveness: { unit: "similarity", badge: "MEASURED" },
    next_gen_tilt: { unit: "delta", badge: "DERIVED" },
    metro_breadth: { unit: "count", badge: "DERIVED" },
    popularity: { unit: "popularity", badge: "MEASURED" },
    under_the_radar: { unit: "delta", badge: "DERIVED" },
  };
  return { key, label: SCREENER_COLUMN_LABEL[key], formulaId: SCREENER_COLUMN_FORMULA[key], ...meta[key] };
});

/** One brand of the screened set (FORMULAS screen.universe), in discovery order. */
export interface ScreenerCandidate {
  /** Opaque and unique within the screen; never a Qloo id. */
  key: string;
  label: string;
  disambiguation: string | null;
  /** Server-side only: the scoring calls name it; it never reaches a row. */
  entityId: string;
  popularity: number | null;
  /** The request its popularity was read from (discovery, or the seed's /search). */
  popularityFrom: ScreenerRequestId;
  /** The seed brand of a brand screen: it is the scoring signal, so it has no FIT of its own. */
  seed: boolean;
}

/** One call's answer, or the gap that stands in for it; `id` is its Q# when the call was made. */
export type ScreenerResponse =
  | { kind: "ok"; id: ScreenerRequestId; entities: readonly QlooEntity[]; meta: QlooCallMeta }
  | { kind: "gap"; id: ScreenerRequestId | null; reason: NoValueReason };

/** An age or market context with its call. */
export interface ScreenerContextCall {
  spec: ContextSpec;
  response: ScreenerResponse;
}

/** The taste map calls: the members (candidate indices, in plan order) and one response per triangular call. */
export interface ScreenerMapCalls {
  members: readonly number[];
  responses: readonly ScreenerResponse[];
}

export interface ScreenerInput {
  candidates: readonly ScreenerCandidate[];
  /** The one-scale scoring call: every candidate shares its scale. */
  fit: ScreenerResponse;
  ages: readonly ScreenerContextCall[];
  /** Empty when the screen names no market: metro breadth is then not measured. */
  markets: readonly ScreenerContextCall[];
  /** Null when the screen did not ask for the taste map: distinctiveness is then not measured. */
  map: ScreenerMapCalls | null;
}

/** What the Category Taste Map needs from a screen (the map's own builder turns it into a TasteMapPayload). */
export interface ScreenerMapInput {
  source: "screener";
  /** Map members in plan order; `target` marks the seed brand. Keys are the rows' keys. */
  members: { key: string; label: string; target: boolean; hub: number | null }[];
  /** sim[i][j] over the members; null where Qloo gave no score (and on the diagonal). */
  sim: (number | null)[][];
  /** Every triangular call returned, so the map is whole. */
  complete: boolean;
  /** Requests behind the similarities, in plan order. */
  requestIds: ScreenerRequestId[];
}

export interface ScreenerComputed {
  /** Ranked by FIT, best first; rows with no FIT follow in discovery order. */
  rows: ScreenerRow[];
  map: ScreenerMapInput | null;
  /** Plain notes on what the responses left out, for the limitations line. */
  notes: string[];
}

const fixed2 = (x: number): string => x.toFixed(2);
const ok = (value: number, display: string, requestIds: readonly ScreenerRequestId[]): ScreenerCell => ({
  status: "ok",
  value,
  reason: null,
  display,
  requestIds: [...new Set(requestIds)],
});
const none = (reason: NoValueReason, requestIds: readonly (ScreenerRequestId | null)[]): ScreenerCell => ({
  status: "unavailable",
  value: null,
  reason,
  display: null,
  requestIds: [...new Set(requestIds.filter((id): id is ScreenerRequestId => id !== null))],
});

function rowResponse(response: ScreenerResponse): RowResponse {
  return response.kind === "ok" ? { kind: "ok", entities: response.entities, meta: response.meta } : { kind: "gap", reason: response.reason };
}

const idOf = (response: ScreenerResponse): ScreenerRequestId | null => response.id;

/** The category lookup: find_tags' own semantic tag search, brand scope (genre:brand tags only). */
export function screenerTagSearchParams(query: string): QlooParams {
  return tagSearchParams(query, "brand");
}

/**
 * A tag search read for a category name (D20: names compared normalised, nothing substituted):
 * the genre:brand tags whose name is the query, and the other genre:brand tags in Qloo's order, which
 * a reader may pick from but are never applied unasked.
 */
export function classifyCategoryTags(query: string, items: readonly QlooTagSearchItem[]): { exact: QlooTagSearchItem[]; others: QlooTagSearchItem[] } {
  const wanted = normaliseName(query);
  const seen = new Set<string>();
  const brandTags = items.filter((t) => {
    if (!t.id.startsWith(`${BRAND_GENRE_TAG_TYPE}:`) || seen.has(t.id)) return false;
    seen.add(t.id);
    return true;
  });
  const exact = wanted === "" ? [] : brandTags.filter((t) => normaliseName(t.name) === wanted);
  return { exact, others: brandTags.filter((t) => !exact.includes(t)) };
}

/** "Brand · beverage · soda": where a category tag sits in Qloo's public taxonomy (D29), for a picker. */
export function categoryPath(tagId: string): string | null {
  const parts = tagId.slice(BRAND_GENRE_TAG_TYPE.length + 1).split(":").slice(0, -1);
  return parts.length === 0 ? null : parts.map((p) => p.replace(/_/g, " ")).join(" · ");
}

/**
 * Brands of a category: brands carrying the tag (filter), ranked by the category's own taste (the tag
 * as the signal; a brand rank needs a signal, G1). Its affinities are the FIT scale: by candidate-set
 * invariance (G1) a separate scoring call over the same brands would return the same scores.
 */
export function screenerTagDiscoveryParams(tagId: string, take: number): QlooParams {
  return { "signal.interests.tags": [tagId], "filter.tags": [tagId], take };
}

/**
 * Brands near a seed: S1's discovery (the seed as the signal, excluded from the results), inside the
 * seed's own genre:brand leaf when it has one, else across categories. Its affinities are the FIT scale.
 */
export function screenerBrandDiscovery(seed: Pick<QlooSearchEntity, "entity_id" | "tags">, take: number): { params: QlooParams; categoryTagId: string | null; categoryName: string | null } {
  const category = categoryTagOf({ tags: searchTags(seed.tags) });
  return {
    params: { ...discoveryParams(seed.entity_id, category?.tagId ?? null), take },
    categoryTagId: category?.tagId ?? null,
    categoryName: category?.name ?? null,
  };
}

/** The scoring call parameters: the signal over the exact candidate list (one scale for all). */
export function screenerScoringParams(signal: QlooParams, candidateIds: readonly string[]): QlooParams {
  return { ...signal, "filter.results.entities": [...candidateIds], take: candidateIds.length };
}

/** The age contexts, youngest first. */
export function screenerAgeSpecs(): ContextSpec[] {
  return SCREENER_AGES.map(ageContext);
}

/**
 * A market context: the market's pinned locality id (G2), or why it is not read. `pin` is the lookup's
 * answer ("failed" when it threw); without a locality seam at all no market is read.
 */
export function screenerMarketSpec(market: MarketId, pin: MarketLocality | null | "failed", hasLocalities: boolean): ContextSpec {
  return metroContext(market, pin, { localities: hasLocalities ? { market: async () => null } : null, geo: null });
}

/**
 * The taste map's members: the seed first, then the rows with a FIT, best first, then the rest in
 * discovery order, up to TASTE_MAP_MAX_K. Indices into the candidates.
 */
export function screenerMapMembers(candidates: readonly ScreenerCandidate[], fit: readonly (number | null)[], k = TASTE_MAP_MAX_K): number[] {
  const order = candidates.map((_, j) => j);
  const seeds = order.filter((j) => candidates[j]?.seed);
  const scored = order.filter((j) => !candidates[j]?.seed && fit[j] != null).sort((a, b) => (fit[b] ?? 0) - (fit[a] ?? 0) || a - b);
  const rest = order.filter((j) => !candidates[j]?.seed && fit[j] == null);
  return [...seeds, ...scored, ...rest].slice(0, Math.max(0, k));
}

/** The k − 1 triangular calls over the members (S1: symmetric scores fill the whole matrix). */
export function screenerMapPlan(memberIds: readonly string[]): { params: QlooParams }[] {
  return memberIds.length < 2 ? [] : triangularCalls(memberIds).map((c) => ({ params: c.params }));
}

/** FIT per candidate from the scoring call: the within-call percentile, the seed marked `self`. */
export function screenerFit(input: Pick<ScreenerInput, "candidates" | "fit">): { pct: (number | null)[]; reasons: (NoValueReason | null)[]; rows: GridRow[] } {
  const cands = asCandidates(input.candidates);
  const grid = fillGrid(cands, [signalContext("FIT")], [rowResponse(input.fit)]);
  const row = grid.rows[0];
  const pct = input.candidates.map((c, j) => (c.seed ? null : (row?.cells[j]?.pct ?? null)));
  const reasons = input.candidates.map((c, j) => (c.seed ? "self" : pct[j] !== null ? null : (row?.cells[j]?.reason ?? "not_scored")));
  return { pct, reasons, rows: grid.rows };
}

function asCandidates(candidates: readonly ScreenerCandidate[]): Candidate[] {
  // fillGrid keys rows by entity id; the ref is never read on this path.
  return candidates.map((c) => ({ ref: "R1", entityId: c.entityId, name: c.label, popularity: c.popularity }));
}

/** Computes every cell of the screen. */
export function computeScreener(input: ScreenerInput): ScreenerComputed {
  const { candidates } = input;
  const n = candidates.length;
  const notes: string[] = [];
  const fitId = idOf(input.fit);
  const fit = screenerFit(input);

  // Ages and markets share one grid, so a floor is read the way share_of_taste reads it.
  const contexts = [...input.ages, ...input.markets];
  const grid = fillGrid(
    asCandidates(candidates),
    contexts.map((c) => c.spec),
    contexts.map((c) => rowResponse(c.response)),
  );
  const ageIds = input.ages.map((c) => idOf(c.response));
  const marketIds = input.markets.map((c) => idOf(c.response));
  const tilts = youthTilts(grid);
  const wins = input.markets.length > 0 ? metroWins(grid) : null;

  const fitCells = candidates.map((c, j): ScreenerCell => {
    const value = fit.pct[j];
    return value != null ? ok(value, fixed2(value), [fitId!]) : none(fit.reasons[j] ?? "not_scored", [fitId]);
  });

  const popularityCells = candidates.map((c): ScreenerCell =>
    c.popularity === null ? none("not_measured", [c.popularityFrom]) : ok(c.popularity, fixed2(c.popularity), [c.popularityFrom]),
  );

  const tiltCells = candidates.map((_, j): ScreenerCell => {
    if (tilts === null) return none("unavailable", ageIds);
    const v = tilts.values[j];
    return v != null ? ok(v, signed2(v), ageIds.filter((id): id is ScreenerRequestId => id !== null)) : none(tilts.reasons[j] ?? "not_scored", ageIds);
  });

  const marketCells = candidates.map((_, j): ScreenerCell => {
    if (wins === null) return none("not_measured", marketIds);
    const reason = wins.reasons[j];
    if (reason != null) return none(reason, marketIds);
    const won = wins.won[j] ?? 0;
    const half = wins.topHalf[j] ?? 0;
    const of = wins.rankedIn[j] ?? 0;
    const cited = wins.ranked.map((r) => contexts[grid.rows.indexOf(r)]?.response.id ?? null).filter((id): id is ScreenerRequestId => id !== null);
    return ok(half, `top half in ${half} of ${of}${won > 0 ? ` · first in ${won}` : ""}`, cited);
  });

  const utrCells = underTheRadar(candidates, fit.pct, fit.reasons, fitId);
  const { cells: distinctCells, map } = distinctiveness(input, notes);

  const scoredFit = fit.pct.filter((v) => v !== null).length;
  const nonSeed = candidates.filter((c) => !c.seed).length;
  if (nonSeed > 0 && scoredFit < nonSeed) {
    notes.push(`${nonSeed - scoredFit} of ${nonSeed} brands were not scored by the fit call; they show why instead of a FIT.`);
  }
  if (tilts === null && input.ages.length > 0) notes.push("Next-gen tilt is unavailable: an age call gave no ranking.");

  const order = candidates
    .map((_, j) => j)
    .sort((a, b) => {
      const fa = fit.pct[a] ?? null;
      const fb = fit.pct[b] ?? null;
      if (fa === null || fb === null) return fa === null ? (fb === null ? a - b : 1) : -1;
      return fb - fa || a - b;
    });
  const rows = order.map((j, i): ScreenerRow => {
    const c = candidates[j]!;
    const flags: ScreenerRowFlag[] = [];
    if (c.seed) flags.push("SEED");
    if (utrCells.flagged[j]) flags.push("UTR");
    return {
      key: c.key,
      rank: i + 1,
      label: safeName(c.label),
      disambiguation: c.disambiguation === null ? null : safeName(c.disambiguation),
      flags,
      cells: {
        fit: fitCells[j]!,
        distinctiveness: distinctCells[j]!,
        next_gen_tilt: tiltCells[j]!,
        metro_breadth: marketCells[j]!,
        popularity: popularityCells[j]!,
        under_the_radar: utrCells.cells[j]!,
      },
    };
  });
  if (rows.length !== n) throw new Error("computeScreener: a row was lost");
  return { rows, map, notes };
}

/**
 * screen.under_the_radar: U = FIT − popularity where both exist; flagged when FIT is at or above the
 * set's median FIT and popularity is below both the set's median popularity and UTR_POPULARITY_CAP.
 * The medians read the rows that have both values.
 */
function underTheRadar(
  candidates: readonly ScreenerCandidate[],
  fit: readonly (number | null)[],
  fitReasons: readonly (NoValueReason | null)[],
  fitId: ScreenerRequestId | null,
): { cells: ScreenerCell[]; flagged: boolean[] } {
  const both = candidates.map((c, j) => (fit[j] != null && c.popularity !== null ? j : -1)).filter((j) => j >= 0);
  const medFit = median(both.map((j) => fit[j]!));
  const medPop = median(both.map((j) => candidates[j]!.popularity!));
  const flagged = candidates.map(() => false);
  const cells = candidates.map((c, j): ScreenerCell => {
    const f = fit[j];
    const ids = [fitId, c.popularityFrom];
    if (f == null) return none(fitReasons[j] ?? "not_scored", ids);
    if (c.popularity === null) return none("not_measured", ids);
    const u = f - c.popularity;
    flagged[j] = medFit !== null && medPop !== null && f >= medFit && c.popularity < Math.min(medPop, UTR_POPULARITY_CAP);
    return ok(u, signed2(u), ids.filter((id): id is ScreenerRequestId => id !== null));
  });
  return { cells, flagged };
}

/**
 * S1 distinctiveness over the map members, only when every triangular call returned (a row with one
 * scored cell would rank it first and last at once). Rows outside the map are not measured.
 */
function distinctiveness(input: ScreenerInput, notes: string[]): { cells: ScreenerCell[]; map: ScreenerMapInput | null } {
  const { candidates } = input;
  if (input.map === null) return { cells: candidates.map(() => none("not_measured", [])), map: null };
  const { members, responses } = input.map;
  const ids = responses.map(idOf);
  const cited = ids.filter((id): id is ScreenerRequestId => id !== null);
  const memberIds = members.map((j) => candidates[j]!.entityId);
  const plan = memberIds.length < 2 ? [] : triangularCalls(memberIds);
  const matrix = fillMatrix(
    memberIds,
    plan,
    plan.map((_, c): readonly QlooEntity[] | CallGap => {
      const r = responses[c];
      if (r?.kind === "ok") return r.entities;
      return r?.reason === "error" ? "error" : "budget_truncated";
    }),
  );
  const sim = similarityOf(matrix);
  const complete = memberIds.length >= 2 && isComplete(matrix);
  const stats = complete ? computeSubstitution({ refs: members.map((j) => candidates[j]!.key), targetIndex: 0, sim }) : null;
  const position = new Map(members.map((j, m) => [j, m]));
  const gap = mapGap(matrix);
  if (!complete && memberIds.length >= 2) notes.push("Distinctiveness is not measured: a taste map call did not return, so the similarity grid is incomplete.");
  const scoredDistinct = stats?.distinctiveness.filter((d) => d !== null).length ?? 0;
  const cells = candidates.map((_, j): ScreenerCell => {
    const m = position.get(j);
    if (m === undefined) return none("not_measured", []);
    if (stats === null) return none(gap ?? "insufficient_n", ids);
    const d = stats.distinctiveness[m];
    const rank = stats.distinctivenessRank[m];
    if (d == null || rank == null) return none(matrix.cells[m]?.some((c) => c.reason === "dropped") ? "dropped" : "not_scored", ids);
    return ok(d, `${fixed2(d)} · ${rank} of ${scoredDistinct}`, cited);
  });
  const map: ScreenerMapInput = {
    source: "screener",
    members: members.map((j, m) => ({
      key: candidates[j]!.key,
      label: safeName(candidates[j]!.label),
      target: candidates[j]!.seed,
      hub: stats?.hub[m] ?? null,
    })),
    sim,
    complete,
    requestIds: cited,
  };
  return { cells, map };
}
