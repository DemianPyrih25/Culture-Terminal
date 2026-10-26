import type { BlockFamily, QlooEntity, QlooTagInsightRow } from "@ct/contracts";
import { competitionRanks, detectFloor } from "../../stats";
import { passesQualityGate } from "../peerSelection";

/**
 * Block DNA arithmetic (SPEC §5.3 S7, FORMULAS block.rank_delta and block.new_tag): ranks within each
 * list, the rank gain of the area over the city with a missing rank counted one below the list, NEW
 * tags, families, and the same delta on brands. Pure and deterministic: ties break on rank, then id.
 */

/** Tags per fingerprint call (G8); a tag missing from a list counts as TAG_TAKE + 1 = 51. */
export const TAG_TAKE = 50;
/** Local brands per call (G9); a brand missing from a list counts as BRAND_TAKE + 1 = 31. */
export const BRAND_TAKE = 30;
/** The popularity cap of the brand calls (G9): the most popular brands rank high everywhere. */
export const BRAND_POPULARITY_MAX = 0.9;
/** NEW: absent from the city list and inside the area's top 20. */
export const NEW_AREA_TOP = 20;
/** The SOUND pair's filter (PROBE consequence 3): the unfiltered city list holds almost no music. */
export const MUSIC_TAG_TYPE = "urn:tag:genre:music";
/** Bars per family in the dataset: the most distinctive and the least (SPEC §5.3 S7). */
export const TOP_PER_FAMILY = 10;
export const BOTTOM_PER_FAMILY = 5;

/** Family tag types (SPEC §5.3 S7). genre:qloo, activities:place and the rest fall outside the four. */
const FAMILY_TYPES: readonly { family: BlockFamily; types: readonly string[] }[] = [
  { family: "WHO", types: ["urn:tag:customer_identity"] },
  { family: "VIBE", types: ["urn:tag:ambience"] },
  { family: "WHAT", types: ["urn:tag:genre:place", "urn:tag:category:place", "urn:tag:specialty_dish"] },
  { family: "SOUND", types: [MUSIC_TAG_TYPE] },
];

function familyOfType(type: string): BlockFamily | null {
  for (const { family, types } of FAMILY_TYPES) {
    if (types.some((t) => type === t || type.startsWith(`${t}:`))) return family;
  }
  return null;
}

/** A tag's family from its subtype, else from its id (a tag id starts with its type). */
export function familyOf(row: Pick<QlooTagInsightRow, "tag_id" | "subtype">): BlockFamily | null {
  return familyOfType(row.subtype ?? "") ?? familyOfType(row.tag_id);
}

/** The tag type the registry keeps: the subtype, else the id without its leaf. */
export function tagTypeOf(row: Pick<QlooTagInsightRow, "tag_id" | "subtype">): string {
  if (row.subtype) return row.subtype;
  const cut = row.tag_id.lastIndexOf(":");
  return cut > 0 ? row.tag_id.slice(0, cut) : row.tag_id;
}

export interface ListItem {
  id: string;
  name: string;
  /** Tag type for tags, "urn:entity:brand" for brands. */
  type: string;
  popularity: number | null;
  family: BlockFamily | null;
}

/** One call's answer as ranks: competition ranks by affinity (1 = top), unscored rows kept apart. */
export interface RankedList {
  items: Map<string, ListItem>;
  ranks: Map<string, number>;
  /** Rows tied at the list's floor value or without an affinity: present but never ranked (G1). */
  unscored: Set<string>;
  /** Rows the quality gate dropped (brands only). */
  gateDropped: number;
  /** Rows the call answered, before the gate. */
  rows: number;
}

interface RawRow {
  item: ListItem;
  affinity: number | null;
}

/**
 * Ranks rows by affinity, never by row order (PROBE consequence 8), except a list with no affinity
 * at all, which keeps Qloo's order. Ties at the minimum are the floor (G1) and stay unranked.
 */
function rankRaw(raw: readonly RawRow[], rows: number, gateDropped: number): RankedList {
  const items = new Map<string, ListItem>();
  const scores = new Map<string, number | null>();
  for (const r of raw) {
    if (items.has(r.item.id)) continue;
    items.set(r.item.id, r.item);
    scores.set(r.item.id, r.affinity !== null && Number.isFinite(r.affinity) ? r.affinity : null);
  }
  const ids = [...items.keys()];
  const ranks = new Map<string, number>();
  const unscored = new Set<string>();
  const scored = ids.filter((id) => scores.get(id) !== null);
  if (scored.length === 0) {
    ids.forEach((id, i) => ranks.set(id, i + 1));
    return { items, ranks, unscored, gateDropped, rows };
  }
  const values = scored.map((id) => scores.get(id) as number);
  const floor = detectFloor(values);
  const ranked = scored.filter((id) => scores.get(id) !== floor);
  const rankedIds = new Set(ranked);
  for (const id of ids) if (!rankedIds.has(id)) unscored.add(id);
  const order = competitionRanks(
    ranked.map((id) => scores.get(id) as number),
    "desc",
  );
  ranked.forEach((id, i) => ranks.set(id, order[i] as number));
  return { items, ranks, unscored, gateDropped, rows };
}

/** A tag list; `families` keeps only the tags this list speaks for (WHO/VIBE/WHAT or SOUND). */
export function rankTagRows(rows: readonly QlooTagInsightRow[], families: readonly BlockFamily[]): RankedList {
  const raw: RawRow[] = rows.flatMap((r) => {
    const family = familyOf(r);
    if (family === null || !families.includes(family)) return [];
    return [
      {
        item: { id: r.tag_id, name: r.name, type: tagTypeOf(r), popularity: r.popularity ?? null, family },
        affinity: r.query?.affinity ?? null,
      },
    ];
  });
  // Ranks are positions among the family tags of the list, so a tag outside the four families never
  // pushes a family tag down.
  return rankRaw(raw, rows.length, 0);
}

/** A brand list after the §5.2 quality gate. */
export function rankBrandRows(rows: readonly QlooEntity[]): RankedList {
  const kept = rows.filter(passesQualityGate);
  const raw: RawRow[] = kept.map((r) => ({
    item: { id: r.entity_id, name: r.name, type: "urn:entity:brand", popularity: r.popularity ?? null, family: null },
    affinity: r.query?.affinity ?? null,
  }));
  return rankRaw(raw, rows.length, rows.length - kept.length);
}

/** One tag or brand compared between the area and the city. */
export interface Compared {
  item: ListItem;
  /** Rank in the area list, null when absent or unscored there. */
  areaRank: number | null;
  /** Rank in the city list, null when absent, unscored, or the city list is missing. */
  cityRank: number | null;
  /** rank_city − rank_area with a missing rank counted as `missing`; null without a city list. */
  delta: number | null;
  /** Absent from the city list and in the area's top 20 (tags only). */
  isNew: boolean;
}

/**
 * Every item of either list, compared. Without a city list there is no delta and nothing is NEW;
 * the items are the area's alone. A row tied at a list's floor counts as missing for the delta, but
 * a tag the city list holds, even at its floor, is never NEW: NEW means absent city-wide.
 */
export function compareLists(area: RankedList, city: RankedList | null, missing: number, newTop: number | null): Compared[] {
  const ids = [...area.items.keys()];
  if (city !== null) for (const id of city.items.keys()) if (!area.items.has(id)) ids.push(id);
  return ids.map((id) => {
    const item = (area.items.get(id) ?? city?.items.get(id)) as ListItem;
    const areaRank = area.ranks.get(id) ?? null;
    const cityRank = city?.ranks.get(id) ?? null;
    return {
      item,
      areaRank,
      cityRank,
      delta: city === null ? null : (cityRank ?? missing) - (areaRank ?? missing),
      isNew: city !== null && newTop !== null && !city.items.has(id) && areaRank !== null && areaRank <= newTop,
    };
  });
}

const rankOrInf = (r: number | null): number => r ?? Number.POSITIVE_INFINITY;
const byId = (a: Compared, b: Compared): number => (a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0);

/** Over-indexed first: largest gain, then the better area rank, then the better city rank. */
export function byGain(a: Compared, b: Compared): number {
  return (b.delta ?? 0) - (a.delta ?? 0) || rankOrInf(a.areaRank) - rankOrInf(b.areaRank) || rankOrInf(a.cityRank) - rankOrInf(b.cityRank) || byId(a, b);
}

/** Under-indexed first: largest loss, then the better city rank. */
export function byLoss(a: Compared, b: Compared): number {
  return (a.delta ?? 0) - (b.delta ?? 0) || rankOrInf(a.cityRank) - rankOrInf(b.cityRank) || byId(a, b);
}

/** Area order, for a family with no city side to compare against. */
export function byAreaRank(a: Compared, b: Compared): number {
  return rankOrInf(a.areaRank) - rankOrInf(b.areaRank) || byId(a, b);
}

export interface FamilyBars {
  /** Positive gains, largest first (at most TOP_PER_FAMILY). */
  top: Compared[];
  /** Negative gains, largest loss first (at most BOTTOM_PER_FAMILY). */
  bottom: Compared[];
}

/** The bars a family shows: top gains and bottom losses, or the area's top tags when nothing compares. */
export function familyBars(items: readonly Compared[], compared: boolean): FamilyBars {
  if (!compared) return { top: items.filter((c) => c.areaRank !== null).sort(byAreaRank).slice(0, TOP_PER_FAMILY), bottom: [] };
  return {
    top: items.filter((c) => (c.delta ?? 0) > 0).sort(byGain).slice(0, TOP_PER_FAMILY),
    bottom: items.filter((c) => (c.delta ?? 0) < 0).sort(byLoss).slice(0, BOTTOM_PER_FAMILY),
  };
}

/** NEW tags of a family in the area's top 20, and how many of the family's tags sit there. */
export function newTagCount(items: readonly Compared[]): { count: number; inTop: number } {
  const inTop = items.filter((c) => c.areaRank !== null && c.areaRank <= NEW_AREA_TOP);
  return { count: inTop.filter((c) => c.isNew).length, inTop: inTop.length };
}
