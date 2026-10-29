import { UNDER_THE_RADAR_MAX_POPULARITY, type Domain, type NoValueReason, type QlooEntity } from "@ct/contracts";
import { detectFloor, median, qualityGate, withinCallPercentiles } from "../../stats";
import { insightTags, type EntityTagRef } from "../common";
import { displayRanks } from "../format";
import { GENRE_PREFIX } from "./requests";

/**
 * S9 QUANT math (SPEC §5.3 S9), pure: per domain the within-call percentile A_n (FIT), UNDER-THE-RADAR
 * U_n = A_n − p_n with its pick, the explainability edges kept by the frozen G15 rule, a halo of the
 * results' top genre tags, and the quality-gate drops. Unscored rows and missing popularities stay
 * explicit.
 */

/** G15: an edge needs two or more seeds and a share clearly above an even split (FORMULAS xdom.edge). */
export const EDGE_MIN_SEEDS = 2;
export const EDGE_MIN_SHARE_TIMES_K = 1.1;
/** Tags in a domain's halo, each carried by at least HALO_MIN_COUNT results. */
export const HALO_SIZE = 3;
export const HALO_MIN_COUNT = 2;

/** Absorbs floating-point error when share·K lands exactly on the threshold, or a value on a median. */
const EPS = 1e-9;

/** The edge rule: K ≥ 2 and share·K ≥ 1.1. */
export function isExplainabilityEdge(share: number, seedCount: number): boolean {
  return seedCount >= EDGE_MIN_SEEDS && Number.isFinite(share) && share * seedCount >= EDGE_MIN_SHARE_TIMES_K - EPS;
}

/**
 * Whether a row may be its domain's UNDER-THE-RADAR pick: FIT at or above the domain's median FIT
 * and popularity below its median popularity, as slate.under_the_radar reads it (SPEC §5.3 S10), popularity
 * below UNDER_THE_RADAR_MAX_POPULARITY (a mass-market name is never under the radar), and
 * U > 0. The top row always has FIT 1, so U alone would flag a pick in almost every list, however
 * mainstream.
 */
export function isUnderTheRadar(
  row: { fit: number | null; popularity: number | null; utr: number | null },
  medianFit: number,
  medianPopularity: number,
): boolean {
  return (
    row.fit !== null &&
    row.popularity !== null &&
    row.utr !== null &&
    row.fit >= medianFit - EPS &&
    row.popularity < medianPopularity - EPS &&
    row.popularity < UNDER_THE_RADAR_MAX_POPULARITY - EPS &&
    row.utr > EPS
  );
}

/**
 * A result's genre: its deepest urn:tag:genre:* tag, the first of equally deep ones. Brands list
 * every level of their category path, so this is the leaf, as categoryTagOf reads it for S1.
 */
export function genreLeafOf(tags: readonly EntityTagRef[]): EntityTagRef | null {
  let leaf: EntityTagRef | null = null;
  for (const tag of tags) {
    if (!tag.tagId.startsWith(GENRE_PREFIX)) continue;
    if (leaf === null || tag.tagId.split(":").length > leaf.tagId.split(":").length) leaf = tag;
  }
  return leaf;
}

export interface Edge {
  seedEntityId: string;
  share: number;
}

export interface NeighbourRow {
  /** 1-based position in Qloo's answer: the stable part of the dataset row key. */
  position: number;
  entity: QlooEntity;
  tags: EntityTagRef[];
  genre: EntityTagRef | null;
  /** Null when Qloo sent none (some tv_show rows, P5). */
  popularity: number | null;
  /** FIT A_n: within-call percentile among the domain's scored rows; null when unscored. */
  fit: number | null;
  /** Whole display rank among the scored rows, 1 = best, ties share the better rank; null when unscored. */
  rank: number | null;
  /** U_n = A_n − p_n; null when either side is missing. */
  utr: number | null;
  /** Why FIT is missing: not_scored (floor tie or no affinity) or quality_gate; null when scored. */
  reason: Extract<NoValueReason, "not_scored" | "quality_gate"> | null;
  /** Seeds whose explainability share passes the edge rule, largest share first. */
  edges: Edge[];
  /** Every seed's share in seed order, edge or not, with two or more seeds: a row's tooltip. */
  shares: Edge[];
  /** Qloo returned per-seed shares for this row. */
  explained: boolean;
}

export interface DomainNeighbourhood {
  domain: Domain;
  /** Rows Qloo returned, seeds and repeats left out. */
  returned: number;
  /** Dataset order: scored rows by rank, then unscored rows, then quality-gate drops, each in Qloo order. */
  rows: NeighbourRow[];
  scored: number;
  notScored: number;
  gateDropped: number;
  /** Scored rows without a popularity, so without U. */
  missingPopularity: number;
  /** Rows with per-seed shares, and rows with at least one edge. */
  explained: number;
  withEdges: number;
  /** The first row by FIT, or null when nothing is scored. */
  top: NeighbourRow | null;
  /** Medians of FIT and popularity over the scored rows with a popularity; null when there are none. */
  medianFit: number | null;
  medianPopularity: number | null;
  /**
   * The UNDER-THE-RADAR pick: the highest U among the rows isUnderTheRadar accepts (ties: better
   * rank, then Qloo order), or null when none qualifies or no U is measured.
   */
  pick: NeighbourRow | null;
  /** The genre tags most results carry, most frequent first. */
  halo: { name: string; count: number }[];
}

export interface DomainAnswer {
  domain: Domain;
  entities: readonly QlooEntity[];
}

interface Kept {
  position: number;
  entity: QlooEntity;
  affinity: number | null;
}

const finite = (x: number | null | undefined): x is number => typeof x === "number" && Number.isFinite(x);

/** Rows Qloo returned in order, the seeds and repeated ids left out (the signal entity is absent anyway, G1/S1). */
function distinctRows(entities: readonly QlooEntity[], seedIds: ReadonlySet<string>): { position: number; entity: QlooEntity }[] {
  const seen = new Set<string>();
  const out: { position: number; entity: QlooEntity }[] = [];
  for (const entity of entities) {
    if (seedIds.has(entity.entity_id) || seen.has(entity.entity_id)) continue;
    seen.add(entity.entity_id);
    out.push({ position: out.length + 1, entity });
  }
  return out;
}

/**
 * A row's per-seed shares and the edges among them. With one seed there is nothing to split: every
 * result is explained by it alone, so neither shares nor edges are kept.
 */
function explainOf(entity: QlooEntity, seedIds: readonly string[]): { explained: boolean; edges: Edge[]; shares: Edge[] } {
  const raw = entity.query?.explainability?.["signal.interests.entities"];
  if (raw === undefined || raw.length === 0) return { explained: false, edges: [], shares: [] };
  const k = seedIds.length;
  const shares =
    k < EDGE_MIN_SEEDS
      ? []
      : seedIds.flatMap((seedEntityId) => {
          const s = raw.find((x) => x.entity_id === seedEntityId);
          return s === undefined || !Number.isFinite(s.score) ? [] : [{ seedEntityId, share: s.score }];
        });
  const edges = shares
    .filter((s) => isExplainabilityEdge(s.share, k))
    .sort((a, b) => b.share - a.share || seedIds.indexOf(a.seedEntityId) - seedIds.indexOf(b.seedEntityId));
  return { explained: true, edges, shares };
}

function haloOf(rows: readonly NeighbourRow[]): { name: string; count: number }[] {
  const counts = new Map<string, { name: string; count: number; first: number }>();
  rows.forEach((row, i) => {
    const names = new Set(row.tags.filter((t) => t.tagId.startsWith(GENRE_PREFIX) && t.name.trim() !== "").map((t) => t.name.trim()));
    for (const name of names) {
      const entry = counts.get(name.toLowerCase());
      if (entry === undefined) counts.set(name.toLowerCase(), { name, count: 1, first: i });
      else entry.count += 1;
    }
  });
  return [...counts.values()]
    .filter((c) => c.count >= HALO_MIN_COUNT)
    .sort((a, b) => b.count - a.count || a.first - b.first)
    .slice(0, HALO_SIZE)
    .map(({ name, count }) => ({ name, count }));
}

interface Prepared {
  domain: Domain;
  /** Rows Qloo returned, seeds and repeats left out. */
  returned: number;
  kept: Kept[];
  dropped: Kept[];
}

function neighbourhood(p: Prepared, floor: number | null, seedIds: readonly string[]): DomainNeighbourhood {
  const { kept, dropped } = p;
  const pct = withinCallPercentiles(kept.map((k) => k.affinity), floor);
  const ranks = displayRanks(pct.pct);
  const build = (k: Kept, i: number | null): NeighbourRow => {
    const tags = insightTags(k.entity.tags);
    const popularity = finite(k.entity.popularity) ? k.entity.popularity : null;
    const fit = i === null ? null : (pct.pct[i] ?? null);
    const { explained, edges, shares } = explainOf(k.entity, seedIds);
    return {
      position: k.position,
      entity: k.entity,
      tags,
      genre: genreLeafOf(tags),
      popularity,
      fit,
      rank: i === null ? null : (ranks[i] ?? null),
      utr: fit !== null && popularity !== null ? fit - popularity : null,
      reason: i === null ? "quality_gate" : fit === null ? "not_scored" : null,
      edges,
      shares,
      explained,
    };
  };
  const built = kept.map((k, i) => build(k, i));
  const scoredRows = built.filter((r) => r.fit !== null);
  scoredRows.sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0) || a.position - b.position);
  const unscored = built.filter((r) => r.fit === null);
  const gated = dropped.map((k) => build(k, null));
  const ordered = [...scoredRows, ...unscored, ...gated];

  // U needs both sides, and so do the medians that bar a pick; scoredRows are in rank order, so a
  // tied U goes to the better rank.
  const measured = scoredRows.filter((r) => r.utr !== null);
  const medianFit = median(measured.flatMap((r) => (r.fit === null ? [] : [r.fit])));
  const medianPopularity = median(measured.flatMap((r) => (r.popularity === null ? [] : [r.popularity])));
  const pick =
    medianFit === null || medianPopularity === null
      ? null
      : measured
          .filter((r) => isUnderTheRadar(r, medianFit, medianPopularity))
          .reduce<NeighbourRow | null>((best, r) => (best === null || (r.utr ?? 0) > (best.utr ?? 0) ? r : best), null);
  // `built` is in Qloo order, so a halo tie goes to the tag the higher-placed results carry.
  return {
    domain: p.domain,
    returned: p.returned,
    rows: ordered,
    scored: scoredRows.length,
    notScored: unscored.length,
    gateDropped: gated.length,
    missingPopularity: scoredRows.length - measured.length,
    explained: built.filter((r) => r.explained).length,
    withEdges: built.filter((r) => r.edges.length > 0).length,
    top: scoredRows[0] ?? null,
    medianFit,
    medianPopularity,
    pick,
    halo: haloOf(built),
  };
}

/**
 * Every answered domain's neighbourhood. A call's floor is a tie at its own minimum (PROBE
 * consequence 2), else the floor of every answered call pooled, since one call may hold a single
 * floor value (stats.detectFloor); both are read after the quality gate.
 */
export function computeNeighbourhoods(answers: readonly DomainAnswer[], seedIds: readonly string[]): DomainNeighbourhood[] {
  const seedSet = new Set(seedIds);
  const prepared = answers.map((a): Prepared => {
    const rows = distinctRows(a.entities, seedSet);
    const gate = qualityGate(rows, (r) => r.entity.popularity);
    const toKept = (r: { position: number; entity: QlooEntity }): Kept => ({
      position: r.position,
      entity: r.entity,
      affinity: finite(r.entity.query?.affinity) ? (r.entity.query?.affinity ?? null) : null,
    });
    return { domain: a.domain, returned: rows.length, kept: gate.kept.map(toKept), dropped: gate.dropped.map(toKept) };
  });
  const scoresOf = (p: Prepared) => p.kept.flatMap((k) => (k.affinity === null ? [] : [k.affinity]));
  const pooled = detectFloor(prepared.flatMap(scoresOf));
  return prepared.map((p) => neighbourhood(p, detectFloor(scoresOf(p)) ?? pooled, seedIds));
}
