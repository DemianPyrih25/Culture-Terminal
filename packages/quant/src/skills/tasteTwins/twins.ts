import type { BlockFamily, Neighbourhood, NoValueReason } from "@ct/contracts";
import { jaccard, spearman } from "../../stats";
import type { Compared } from "../blockDna/fingerprint";

/**
 * Taste Twins arithmetic (SPEC S11, FORMULAS twin.rho and twin.shared_new). Each area is first read
 * against its own city (Block DNA's rank gain per tag); two areas are twins when the same tags rise
 * and fall in both. Pure and deterministic.
 */

/** Areas a run checks at most (PLAN §4.3: ≤ 8 target areas × 1 call). */
export const MAX_TARGET_AREAS = 8;
/** ρ over fewer tags than this is too unstable to report. */
export const TWIN_MIN_TAGS = 8;
/** Concept lift picks the areas only when at least this many target areas have a lift; else they go by size. */
export const MIN_LIFTED_AREAS = 3;

export interface TwinScore {
  /** Spearman ρ of the two areas' rank-gain vectors; null with `reason`. */
  rho: number | null;
  reason: NoValueReason | null;
  /** Tags in either comparison: the length of the vectors. */
  union: number;
  /** Tags ranked in both area lists: what the value rests on, the n of its confidence. */
  shared: number;
  /** Jaccard overlap of the two area lists' ranked tags. */
  overlap: number | null;
  /** Tags NEW in both areas, by id, most distinctive first (largest combined gain). */
  sharedNew: string[];
}

const byId = (compared: readonly Compared[]): Map<string, Compared> => new Map(compared.map((c) => [c.item.id, c]));

const ranked = (compared: readonly Compared[]): string[] => compared.filter((c) => c.areaRank !== null).map((c) => c.item.id);

/**
 * ρ between the source's and a target's rank gains over their own cities, aligned on the union of
 * tags. A tag absent from one comparison is in neither of that area's lists (its area or its city),
 * so its gain there is 0: missing counts the same on both sides.
 */
export function twinScore(source: readonly Compared[], target: readonly Compared[]): TwinScore {
  const src = byId(source);
  const tgt = byId(target);
  const union = [...new Set([...src.keys(), ...tgt.keys()])].sort();
  const srcRanked = ranked(source);
  const tgtRanked = new Set(ranked(target));
  const shared = srcRanked.filter((id) => tgtRanked.has(id)).length;
  const overlap = jaccard(srcRanked, tgtRanked);
  const sharedNew = union
    .filter((id) => src.get(id)?.isNew === true && tgt.get(id)?.isNew === true)
    .sort((a, b) => (tgt.get(b)?.delta ?? 0) + (src.get(b)?.delta ?? 0) - ((tgt.get(a)?.delta ?? 0) + (src.get(a)?.delta ?? 0)) || (a < b ? -1 : 1));
  const base = { union: union.length, shared, overlap, sharedNew };
  if (union.length < TWIN_MIN_TAGS) return { ...base, rho: null, reason: "insufficient_n" };
  const rho = spearman(
    union.map((id) => src.get(id)?.delta ?? 0),
    union.map((id) => tgt.get(id)?.delta ?? 0),
  );
  return rho === null ? { ...base, rho: null, reason: "not_measured" } : { ...base, rho, reason: null };
}

/** The largest areas of a city by land area, then by id: the pick when nothing better is known. */
export function largestAreas(areas: readonly Neighbourhood[], n = MAX_TARGET_AREAS): Neighbourhood[] {
  return [...areas].sort((a, b) => b.areaKm2 - a.areaKm2 || (a.id < b.id ? -1 : 1)).slice(0, n);
}

/** The areas with the highest concept lift, then by id. */
export function topLiftAreas<T extends { id: string; lift: number | null }>(areas: readonly T[], n = MAX_TARGET_AREAS): (T & { lift: number })[] {
  return areas
    .filter((a): a is T & { lift: number } => a.lift !== null && Number.isFinite(a.lift))
    .sort((a, b) => b.lift - a.lift || (a.id < b.id ? -1 : 1))
    .slice(0, n);
}

/** Butterfly bars per family: tags both areas over-index on, then those where they differ most. */
export const SHARED_BARS_PER_FAMILY = 6;
export const DIFFERING_BARS_PER_FAMILY = 4;

export interface TwinBar {
  id: string;
  name: string;
  family: BlockFamily;
  source: number;
  twin: number;
  sharedNew: boolean;
}

export function twinBars(source: readonly Compared[], twin: readonly Compared[], families: readonly BlockFamily[]): TwinBar[] {
  const src = byId(source);
  const tgt = byId(twin);
  const sharedNew = new Set(twinScore(source, twin).sharedNew);
  const ids = [...new Set([...src.keys(), ...tgt.keys()])].sort();
  return families.flatMap((family) => {
    const rows = ids.flatMap((id): TwinBar[] => {
      const c = src.get(id) ?? tgt.get(id);
      if (c === undefined || c.item.family !== family) return [];
      return [{ id, name: c.item.name, family, source: src.get(id)?.delta ?? 0, twin: tgt.get(id)?.delta ?? 0, sharedNew: sharedNew.has(id) }];
    });
    const both = rows
      .filter((r) => r.source > 0 && r.twin > 0)
      .sort((a, b) => Math.min(b.source, b.twin) - Math.min(a.source, a.twin) || (a.id < b.id ? -1 : 1))
      .slice(0, SHARED_BARS_PER_FAMILY);
    const taken = new Set(both.map((r) => r.id));
    const differ = rows
      .filter((r) => !taken.has(r.id) && r.source !== r.twin)
      .sort((a, b) => Math.abs(b.source - b.twin) - Math.abs(a.source - a.twin) || (a.id < b.id ? -1 : 1))
      .slice(0, DIFFERING_BARS_PER_FAMILY);
    return [...both, ...differ];
  });
}
