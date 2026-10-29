import { UNDER_THE_RADAR_MAX_POPULARITY, type NoValueReason, type QlooEntity, type QuadrantName, type SponsorCategory } from "@ct/contracts";
import { median, withinCallPercentiles } from "../../stats";
import type { EntityDraft } from "../common";
import { displayRanks } from "../format";
import { draftFromInsight, passesQualityGate } from "../peerSelection";

/**
 * The S10 slate rules (SPEC §5.3 S10), pure so the same responses always give the same slate:
 * candidates from per-category discovery and the shortlist, FIT from the one-scale scoring call,
 * the best fit per category (one brand per category), the UNDER-THE-RADAR rule and the market
 * alignment Δ_jm = pct_jm − A_j^(m), both percentiles over the same set: the slate members market m
 * scored. A candidate a call did not score keeps the reason, never a rank.
 */

/** Discovered candidates per category that go to the scoring call (the top two). */
export const PICKS_PER_CATEGORY = 2;
/** filter.results.entities of the one-scale call (SPEC: ≤30). */
export const MAX_CANDIDATES = 30;
/** filter.results.entities of a market call (SPEC: slate ≤12). */
export const MAX_SLATE = 12;
/** A market that scored fewer slate members than this gives no Δ: with two, every Δ swings by ±1. */
export const MIN_MARKET_SCORED = 3;

/** One category's discovery as the skill got it. */
export interface CategoryDiscovery {
  category: SponsorCategory;
  /** The filter tag sent, or null when the category had none. */
  tagId: string | null;
  /** Results in Qloo order, or null when no call answered. */
  results: readonly QlooEntity[] | null;
  /** Why results is null: unavailable (no tag found), budget_truncated or error. */
  gap: NoValueReason | null;
}

export type CandidateSource = "discovered" | "shortlist";

export interface Candidate {
  entity: EntityDraft;
  /** The category this candidate fills; null for a shortlist brand found in no requested category. */
  category: SponsorCategory | null;
  source: CandidateSource;
  /** A shortlist brand that discovery also picked. */
  shortlisted: boolean;
}

export interface CandidateSelection {
  candidates: Candidate[];
  /** Per category, in input order: usable discovery rows (after the gates, without the seed). */
  usable: Map<SponsorCategory, number>;
  /** Discovery results the quality gate skipped, by name (each a QUALITY_GATE_DROPPED). */
  gateDropped: string[];
  /** Discovery results whose main line lies in another category (offCategoryBranch), by category, in order. */
  offCategory: { category: SponsorCategory; name: string; branch: string }[];
  /** Per category: discovery rows the quality gate or the category check skipped. */
  gated: Map<SponsorCategory, number>;
  /** Shortlist brands left out because the candidate cap was reached. */
  overCap: string[];
  /**
   * Per category: its usable discovery results that are no candidate, in affinity order. The pool a
   * category's dropped picks can be substituted from (SPEC §4.4 DROPPED_CANDIDATES).
   */
  pool: Map<SponsorCategory, EntityDraft[]>;
}

const BRAND_GENRE = "urn:tag:genre:brand:";
/** Tags under one other genre:brand branch that make it a brand's main line (offCategoryBranch). */
export const MAIN_LINE_MIN_TAGS = 3;

/**
 * The genre:brand branch a discovery row's main line lies in, when that is not its category's
 * (ANSWER_QUALITY §9): the row carries the category tag but no tag under it, and at least
 * MAIN_LINE_MIN_TAGS tags under one other top-level branch, as a fashion house with a fragrance line
 * does under a beauty tag. The filter guarantees only that the row carries the tag, not that the
 * brand belongs to the category. Null when the row belongs, or when the category tag is not a
 * genre:brand tag (a descriptive product tag has no branches to compare).
 */
export function offCategoryBranch(row: Pick<QlooEntity, "tags">, tagId: string): string | null {
  if (!tagId.startsWith(BRAND_GENRE)) return null;
  const category = tagId.slice(BRAND_GENRE.length);
  const top = category.split(":")[0];
  const paths = (row.tags ?? []).flatMap((t) => (t.id?.startsWith(BRAND_GENRE) === true ? [t.id.slice(BRAND_GENRE.length)] : []));
  if (paths.some((p) => p.startsWith(`${category}:`))) return null;
  const others = new Map<string, number>();
  for (const p of new Set(paths)) {
    const branch = p.split(":")[0] ?? p;
    if (branch !== top) others.set(branch, (others.get(branch) ?? 0) + 1);
  }
  const [main] = [...others].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return main !== undefined && main[1] >= MAIN_LINE_MIN_TAGS ? main[0] : null;
}

function affinityOf(r: QlooEntity): number | null {
  const a = r.query?.affinity;
  return typeof a === "number" && Number.isFinite(a) ? a : null;
}

/** Rows by affinity, highest first, rows without one last; row order breaks ties (never read row order alone, P5). */
function byAffinity(results: readonly QlooEntity[]): QlooEntity[] {
  return results
    .map((r, i) => ({ r, i, a: affinityOf(r) }))
    .sort((x, y) => (x.a === null ? (y.a === null ? x.i - y.i : 1) : y.a === null ? -1 : y.a - x.a || x.i - y.i))
    .map((x) => x.r);
}

/**
 * The candidate set: for each category in input order its top two discovery results not already
 * taken by an earlier category (a brand fills one category only) and past the quality gate and the
 * category check (offCategoryBranch), then the shortlist. A shortlist
 * brand fills the first requested category that discovery found it in or whose tag it carries, and
 * none otherwise. The seed is never a candidate.
 */
export function selectCandidates(args: {
  seedEntityId: string;
  discoveries: readonly CategoryDiscovery[];
  shortlist: readonly EntityDraft[];
}): CandidateSelection {
  const { seedEntityId, discoveries, shortlist } = args;
  const taken = new Map<string, Candidate>();
  const gateDropped = new Map<string, string>();
  const offCategory: CandidateSelection["offCategory"] = [];
  const usable = new Map<SponsorCategory, number>();
  const gated = new Map<SponsorCategory, number>();
  const members = new Map<SponsorCategory, Set<string>>();
  const pools = new Map<SponsorCategory, QlooEntity[]>();

  for (const d of discoveries) {
    const rows: QlooEntity[] = [];
    let skipped = 0;
    for (const r of byAffinity(d.results ?? [])) {
      if (r.entity_id === seedEntityId || rows.some((x) => x.entity_id === r.entity_id)) continue;
      const branch = d.tagId === null ? null : offCategoryBranch(r, d.tagId);
      if (!passesQualityGate(r)) {
        gateDropped.set(r.entity_id, r.name);
        skipped += 1;
      } else if (branch !== null) {
        offCategory.push({ category: d.category, name: r.name, branch });
        skipped += 1;
      } else rows.push(r);
    }
    usable.set(d.category, rows.length);
    gated.set(d.category, skipped);
    members.set(d.category, new Set(rows.map((r) => r.entity_id)));
    pools.set(d.category, rows);
    let picked = 0;
    for (const r of rows) {
      if (picked >= PICKS_PER_CATEGORY) break;
      if (taken.has(r.entity_id)) continue;
      taken.set(r.entity_id, { entity: draftFromInsight(r), category: d.category, source: "discovered", shortlisted: false });
      picked += 1;
    }
  }

  const overCap: string[] = [];
  for (const s of shortlist) {
    if (s.entityId === seedEntityId) continue;
    const known = taken.get(s.entityId);
    if (known !== undefined) {
      known.shortlisted = true;
      continue;
    }
    if (taken.size >= MAX_CANDIDATES) {
      overCap.push(s.name);
      continue;
    }
    const home = discoveries.find(
      (d) => members.get(d.category)?.has(s.entityId) === true || (d.tagId !== null && s.tags.some((t) => t.tagId === d.tagId)),
    );
    taken.set(s.entityId, { entity: s, category: home?.category ?? null, source: "shortlist", shortlisted: true });
  }
  const pool = new Map(
    discoveries.map((d) => [d.category, (pools.get(d.category) ?? []).filter((r) => !taken.has(r.entity_id)).map(draftFromInsight)] as const),
  );
  return { candidates: [...taken.values()].slice(0, MAX_CANDIDATES), usable, gateDropped: [...gateDropped.values()], offCategory, gated, overCap, pool };
}

/** A within-call score for one candidate: a value, or why there is none. */
export interface CallCell {
  value: number | null;
  reason: NoValueReason | null;
  /** Competition rank among the call's scored candidates (1 = top). */
  rank: number | null;
}

/** Why a call has no response for its candidates: the budget refused it, or the Qloo client failed it. */
export type CallGap = Extract<NoValueReason, "budget_truncated" | "error">;

/** Within-call cells over raw affinities: a missing one is dropped (G2), one at the floor is not scored (G1). */
export function cellsOf(raw: readonly (number | null)[], floor: number | null): CallCell[] {
  const pct = withinCallPercentiles(raw, floor);
  const ranks = displayRanks(pct.pct);
  return raw.map((a, i) => {
    const value = pct.pct[i] ?? null;
    if (value !== null) return { value, reason: null, rank: ranks[i] ?? null };
    return { value: null, reason: a === null ? "dropped" : "not_scored", rank: null };
  });
}

/**
 * Within-call percentiles for the requested ids from one response. A requested id missing from the
 * response, or present without an affinity, is dropped (G2); one at the floor is not scored (G1).
 */
export function scoreCall(ids: readonly string[], response: readonly QlooEntity[] | CallGap, floor: number | null): CallCell[] {
  if (typeof response === "string") return ids.map(() => ({ value: null, reason: response, rank: null }));
  const scores = new Map(response.map((r) => [r.entity_id, affinityOf(r)]));
  return cellsOf(
    ids.map((id) => scores.get(id) ?? null),
    floor,
  );
}

/**
 * Affinities for floor detection across the skill's calls, one per (signal, entity): discovery and
 * the scoring call share the seed signal, so they score the same pair alike (G1), and counting that
 * pair twice would make every minimum a tie. `signal` names the call's signal ("seed", a locality).
 */
export function pooledAffinities(responses: readonly { signal: string; rows: readonly QlooEntity[] | null }[]): number[] {
  const pooled = new Map<string, number>();
  for (const { signal, rows } of responses) {
    for (const r of rows ?? []) {
      const a = affinityOf(r);
      const key = `${signal}|${r.entity_id}`;
      if (a !== null && !pooled.has(key)) pooled.set(key, a);
    }
  }
  return [...pooled.values()];
}

/**
 * The slate quadrant. A candidate at or above UNDER_THE_RADAR_MAX_POPULARITY is well known whatever the
 * slate's median: high fit makes it HEARTLAND, never the UNDER-THE-RADAR quadrant.
 */
export function quadrantOf(fit: number, popularity: number, medianFit: number, medianPopularity: number): QuadrantName {
  const known = popularity >= medianPopularity || popularity >= UNDER_THE_RADAR_MAX_POPULARITY;
  if (fit >= medianFit) return known ? "HEARTLAND" : "HIDDEN_POCKET";
  return popularity >= medianPopularity ? "MASS" : "COLD";
}

export interface ScoredSlate {
  /** FIT A_j by candidate, from the one-scale call. */
  fit: CallCell[];
  /** The raw national affinity by candidate, null when the call did not return one: re-ranked per market. */
  affinity: (number | null)[];
  /** Popularity by candidate: the scoring row's, else the registry's. */
  popularity: (number | null)[];
  scored: number;
  /** Candidates with FIT and popularity: the points of the quadrant and the UTR medians. */
  placed: number[];
  medianFit: number | null;
  medianPopularity: number | null;
  /** UNDER-THE-RADAR: A ≥ median A and p < median p, over the placed candidates, and p below UNDER_THE_RADAR_MAX_POPULARITY. */
  utr: boolean[];
  quadrant: (QuadrantName | null)[];
}

export function scoreSlate(candidates: readonly Candidate[], response: readonly QlooEntity[] | CallGap, floor: number | null): ScoredSlate {
  const ids = candidates.map((c) => c.entity.entityId);
  const fit = scoreCall(ids, response, floor);
  const rows = typeof response === "string" ? new Map<string, QlooEntity>() : new Map(response.map((r) => [r.entity_id, r]));
  const affinity = ids.map((id) => {
    const row = rows.get(id);
    return row === undefined ? null : affinityOf(row);
  });
  const popularity = candidates.map((c) => {
    const p = rows.get(c.entity.entityId)?.popularity ?? c.entity.popularity;
    return typeof p === "number" && Number.isFinite(p) ? p : null;
  });
  const placed = candidates.flatMap((_, j) => (fit[j]?.value !== null && popularity[j] !== null ? [j] : []));
  const medianFit = median(placed.map((j) => fit[j]!.value!));
  const medianPopularity = median(placed.map((j) => popularity[j]!));
  const utr = candidates.map(() => false);
  const quadrant: (QuadrantName | null)[] = candidates.map(() => null);
  if (medianFit !== null && medianPopularity !== null) {
    for (const j of placed) {
      quadrant[j] = quadrantOf(fit[j]!.value!, popularity[j]!, medianFit, medianPopularity);
      utr[j] = quadrant[j] === "HIDDEN_POCKET";
    }
  }
  return { fit, affinity, popularity, scored: fit.filter((c) => c.value !== null).length, placed, medianFit, medianPopularity, utr, quadrant };
}

/** The category's best fit and runner-up (candidate indices), or why it has none. */
export interface CategoryRow {
  category: SponsorCategory;
  best: number | null;
  runnerUp: number | null;
  reason: NoValueReason | null;
}

/** Most telling first: a call not made, then a failed one, then a market too thin to compare, then Qloo's own omissions. */
const GAP_ORDER: readonly NoValueReason[] = ["budget_truncated", "error", "insufficient_n", "dropped", "not_scored"];

function dominantReason(reasons: readonly (NoValueReason | null)[]): NoValueReason {
  return GAP_ORDER.find((r) => reasons.includes(r)) ?? "not_scored";
}

/** Why a category has no member at all: its discovery gap, else an empty or fully gated result. */
function emptyCategoryReason(d: CategoryDiscovery, selection: CandidateSelection): NoValueReason {
  if (d.gap !== null) return d.gap;
  const usable = selection.usable.get(d.category) ?? 0;
  return usable === 0 && (selection.gated.get(d.category) ?? 0) > 0 ? "quality_gate" : "not_measured";
}

/** Best fit = argmax A among the category's candidates (SPEC: one brand per category); ties keep candidate order. */
export function categoryRows(args: {
  discoveries: readonly CategoryDiscovery[];
  selection: CandidateSelection;
  slate: ScoredSlate;
}): CategoryRow[] {
  const { discoveries, selection, slate } = args;
  return discoveries.map((d) => {
    const members = selection.candidates.flatMap((c, j) => (c.category === d.category ? [j] : []));
    const scored = members
      .filter((j) => slate.fit[j]?.value !== null)
      .sort((a, b) => slate.fit[b]!.value! - slate.fit[a]!.value! || a - b);
    const best = scored[0] ?? null;
    if (best !== null) return { category: d.category, best, runnerUp: scored[1] ?? null, reason: null };
    const reason =
      members.length === 0
        ? emptyCategoryReason(d, selection)
        : dominantReason(members.map((j) => slate.fit[j]?.reason ?? null));
    return { category: d.category, best: null, runnerUp: null, reason };
  });
}

/**
 * The market slate (≤12): each category's best fit and runner-up, then scored shortlist brands
 * outside every category by FIT. Candidate indices, in that order.
 */
export function marketSlate(selection: CandidateSelection, rows: readonly CategoryRow[], slate: ScoredSlate): number[] {
  const out: number[] = [];
  for (const row of rows) for (const j of [row.best, row.runnerUp]) if (j !== null && !out.includes(j)) out.push(j);
  const uncategorised = selection.candidates
    .flatMap((c, j) => (c.category === null && slate.fit[j]?.value !== null ? [j] : []))
    .sort((a, b) => slate.fit[b]!.value! - slate.fit[a]!.value! || a - b);
  for (const j of uncategorised) if (!out.includes(j)) out.push(j);
  return out.slice(0, MAX_SLATE);
}

/** One market call's column, aligned with the market slate. */
export interface MarketColumn {
  market: string;
  label: string;
  /** pct_jm: the member's percentile in the market call, or why the call or the member has none. */
  cells: CallCell[];
  /**
   * A_j^(m): the national affinity re-ranked over S_m, the members this market scored, so both sides
   * of Δ rank the same set; by G1 candidate-set invariance it equals a national call over S_m.
   * A member outside S_m keeps the market cell's reason.
   */
  national: CallCell[];
  /** |S_m|. */
  scored: number;
  /** Null when the call answered. */
  gap: CallGap | null;
}

/**
 * The column of one market call. `nationalAffinity` is the one-scale call's raw affinity per slate
 * member; only the members the market scored are ranked on the national side.
 */
export function marketColumn(args: {
  market: string;
  label: string;
  slateIds: readonly string[];
  nationalAffinity: readonly (number | null)[];
  response: readonly QlooEntity[] | CallGap;
  floor: number | null;
}): MarketColumn {
  const { slateIds, nationalAffinity, response, floor } = args;
  const cells = scoreCall(slateIds, response, floor);
  const ranked = cellsOf(
    cells.map((c, k) => (c.value === null ? null : (nationalAffinity[k] ?? null))),
    floor,
  );
  return {
    market: args.market,
    label: args.label,
    cells,
    national: ranked.map((c, k) => (cells[k]!.value === null ? cells[k]! : c)),
    scored: cells.filter((c) => c.value !== null).length,
    gap: typeof response === "string" ? response : null,
  };
}

/** Δ_jm = pct_jm − A_j^(m) for slate member k, or why market m gives none (a market under MIN_MARKET_SCORED: insufficient_n). */
export function marketDelta(column: MarketColumn, k: number): { delta: number } | { reason: NoValueReason } {
  if (column.gap !== null) return { reason: column.gap };
  const here = column.cells[k];
  if (here === undefined || here.value === null) return { reason: here?.reason ?? "not_scored" };
  if (column.scored < MIN_MARKET_SCORED) return { reason: "insufficient_n" };
  const national = column.national[k];
  if (national === undefined || national.value === null) return { reason: national?.reason ?? "not_scored" };
  return { delta: here.value - national.value };
}

/** The markets where a slate member gains most against the same set nationally: Δ > 0, largest first, at most two. */
export function topMarkets(columns: readonly MarketColumn[], k: number): { column: MarketColumn; delta: number }[] {
  return columns
    .flatMap((column, m) => {
      const d = marketDelta(column, k);
      return "delta" in d && d.delta > 0 ? [{ column, delta: d.delta, m }] : [];
    })
    .sort((a, b) => b.delta - a.delta || a.m - b.m)
    .slice(0, 2)
    .map(({ column, delta }) => ({ column, delta }));
}

/** The best Δ over the markets that give one (it can be negative), or the most telling reason none does. */
export function bestMarket(columns: readonly MarketColumn[], k: number): { column: MarketColumn; delta: number } | { reason: NoValueReason } {
  let best: { column: MarketColumn; delta: number } | null = null;
  const reasons: NoValueReason[] = [];
  for (const column of columns) {
    const d = marketDelta(column, k);
    if ("reason" in d) reasons.push(d.reason);
    else if (best === null || d.delta > best.delta) best = { column, delta: d.delta };
  }
  return best ?? { reason: dominantReason(reasons) };
}
