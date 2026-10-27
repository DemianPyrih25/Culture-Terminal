// The location equivalents of the Reality Check's one-call scoring (SPEC §6.6 item 3), for the two
// kinds whose real choice is a place rather than an entity.
//
// Comedian markets: SHARE's metro context (S2; the market_selection scan of S6). One person rank
// call per config/metros.json secondary market, its pinned locality as signal.location (G3) and the
// registered comedians as the candidate list, so each call says where among that panel a comedian
// stands in that market. A market's score for a comedian is that within-call percentile; markets
// are compared on percentiles, never raw affinities (V6). The panel is pre-registered (every comedian
// seed of eval/reality_cases.json, whichever cases run), so one call per market serves every
// comedian case and a case scores the same alone or with the others.
//
// Store neighbourhoods: geo_lift's Lift Map (S6, D18). The seed brand alone as an analog heatmap
// over the metro's pinned locality (P5), against the pinned restaurant baseline, rolled up to the
// gazetteer: every area of the metro is scored by one concept call on one scale. The cell lift is the
// D18 arithmetic of packages/quant/src/skills/geoLift/lift.ts, which @ct/quant does not export; the
// copy below keeps its constants and order of operations, but rolls up every cell both maps share,
// without the u ≥ 0.5 gate. The gate keeps the Lift Map's claims to where the concept is strong;
// here an area where the seed's taste is weak must score low rather than drop out of the median.
//
// What these equivalents cannot do: with three comedians a market score has three levels, so ties
// are common and pull a case towards 0.5 (a case where every comparison ties is not scorable, and
// the tied share is reported); an analog map covers about a fifth of a metro's cells, mostly its
// most popular (P5), so an area outside it has no lift (not measured, never low) and a registered
// area there leaves its case unscorable rather than scored low.
import { readFileSync } from "node:fs";
import {
  MarketId,
  type GeoApi,
  type LocalityApi,
  type MetroId,
  type QlooApi,
  type QlooEntity,
  type QlooHeatmapCell,
  type QlooParams,
} from "@ct/contracts";
import { PROBE_FACTS } from "@ct/qloo";
import { geometricMean, isBudgetError, median, normaliseName, withinCallPercentiles } from "@ct/quant";
import { z } from "zod";
import { percentileAmong } from "./reality-score";

const METROS_JSON = new URL("../../config/metros.json", import.meta.url);

export const PERSON = "urn:entity:person";
export const HEATMAP = "urn:heatmap";
/** A panel ranks nothing with fewer members: a lone one is first only by default (as MIN_RANKED). */
export const MIN_PANEL = 2;

/** Why a market or a map has no scores. */
export type LocationGap = "no_locality" | "budget" | "call_failed";

/** The error text a failed call or lookup leaves, and whether the Qloo budget refused it. */
export function gapOf(err: unknown): { gap: LocationGap; error: string } {
  return { gap: isBudgetError(err) ? "budget" : "call_failed", error: err instanceof Error ? err.message : String(err) };
}

// Markets ----------------------------------------------------------------------------------------------

/** A config/metros.json market of the secondary tier: the only markets a comedian case is booked and scored on. */
export interface SecondaryMarket {
  id: MarketId;
  label: string;
  /** Two-letter state code, e.g. TN. */
  state: string;
  stateName: string;
}

const MetrosConfig = z.object({
  markets: z.array(
    z.object({
      id: MarketId,
      label: z.string().min(1),
      state: z.string().min(1),
      state_name: z.string().min(1),
      tier: z.enum(["major", "secondary"]),
    }),
  ),
});

/**
 * The secondary markets of config/metros.json when the cases were registered: the comedian candidates
 * stay these 22, so the pool, the panel's calls and GHOST's question are the ones registered. Markets
 * added to the tier later (Part 8, D28) are left out of the Reality Check.
 */
export const REGISTERED_SECONDARY_MARKETS: readonly MarketId[] = [
  "louisville",
  "kansas_city",
  "indianapolis",
  "columbus",
  "cincinnati",
  "charlotte",
  "raleigh",
  "richmond",
  "birmingham",
  "knoxville",
  "chattanooga",
  "memphis",
  "oklahoma_city",
  "tulsa",
  "omaha",
  "des_moines",
  "grand_rapids",
  "greenville",
  "little_rock",
  "salt_lake_city",
  "boise",
  "spokane",
];

export function loadSecondaryMarkets(file: URL | string = METROS_JSON): SecondaryMarket[] {
  const { markets } = MetrosConfig.parse(JSON.parse(readFileSync(file, "utf8")));
  return markets
    .filter((m) => m.tier === "secondary" && REGISTERED_SECONDARY_MARKETS.includes(m.id))
    .map((m) => ({ id: m.id, label: m.label, state: m.state, stateName: m.state_name }));
}

/**
 * The secondary market a GHOST pick names, or null: "Riverton", "Riverton, WY" and "Riverton Wyoming"
 * match the Riverton market; a state after a comma must be that market's ("Riverton, ID" does not
 * match). A major market or any other city is outside the scored universe.
 */
export function matchMarket(text: string, markets: readonly SecondaryMarket[]): MarketId | null {
  const [head = "", ...rest] = text.split(",");
  const city = normaliseName(head);
  const state = rest.length > 0 ? normaliseName(rest.join(" ")) : null;
  if (city === "") return null;
  for (const m of markets) {
    const label = normaliseName(m.label);
    const states = [normaliseName(m.state), normaliseName(m.stateName)];
    if (state === null ? city === label || states.some((s) => city === `${label} ${s}`) : city === label && states.includes(state)) return m.id;
  }
  return null;
}

/** The SHARE metro rank call: the market's pinned locality over the comedian panel (G3). */
export function panelRankParams(localityId: string, panelIds: readonly string[]): QlooParams {
  return { "signal.location": localityId, "filter.results.entities": [...panelIds], take: panelIds.length };
}

/** Each returned entity's affinity, by entity id; a row without a finite affinity is left out (dropped, G2). */
export function affinityById(entities: readonly QlooEntity[]): Map<string, number> {
  return new Map(
    entities.flatMap((e) => {
      const a = e.query?.affinity;
      return typeof a === "number" && Number.isFinite(a) ? [[e.entity_id, a] as const] : [];
    }),
  );
}

/**
 * Each panel member's within-call percentile (1 = first, ties share the average rank). A member
 * missing from the response, or without an affinity, ranks below every member Qloo scored, tied with
 * any other such member; a row that scored no member, or a panel under MIN_PANEL, scores no one.
 * Unlike RANK and SHARE, "no relationship to the signal" is a score here (the lowest), whether as a
 * floor value or as a dropped row: it answers whether Qloo's taste points at a choice, and setting it
 * aside would drop exactly the choices Qloo misses.
 */
export function panelPercentiles(panelIds: readonly string[], affinity: ReadonlyMap<string, number>): Map<string, number> {
  const scored = panelIds.flatMap((id) => (affinity.has(id) ? [affinity.get(id) ?? 0] : []));
  if (panelIds.length < MIN_PANEL || scored.length === 0) return new Map();
  const below = Math.min(...scored) - 1;
  const { pct } = withinCallPercentiles(panelIds.map((id) => affinity.get(id) ?? below), null);
  return new Map(panelIds.flatMap((id, i) => (pct[i] === null || pct[i] === undefined ? [] : [[id, pct[i]] as const])));
}

export interface MarketCell {
  market: SecondaryMarket;
  /** Why the market has no scores; null when its call came back. */
  gap: LocationGap | null;
  error: string | null;
  /** Each panel member's within-call percentile, a member Qloo dropped at the bottom; empty when the call scored no one. */
  pct: ReadonlyMap<string, number>;
  /** The raw affinities behind `pct`, for .private/eval only. */
  affinity: ReadonlyMap<string, number>;
}

/** One SHARE metro call per market, the panel as candidates. A market without a pinned locality is not called. */
export async function scoreMarkets(
  qloo: QlooApi,
  localities: LocalityApi | null,
  markets: readonly SecondaryMarket[],
  panelIds: readonly string[],
): Promise<MarketCell[]> {
  const empty = { pct: new Map<string, number>(), affinity: new Map<string, number>() };
  return Promise.all(
    markets.map(async (market): Promise<MarketCell> => {
      let localityId: string;
      try {
        const pin = localities === null ? null : await localities.market(market.id);
        if (pin === null) return { market, gap: "no_locality", error: `no locality is pinned for ${market.label}`, ...empty };
        localityId = pin.entityId;
      } catch (err) {
        // A failed lookup is not a missing pin: the market is called on a rerun.
        const { gap, error } = gapOf(err);
        return { market, gap, error: `the locality lookup failed: ${error}`, ...empty };
      }
      try {
        const { data } = await qloo.insights(PERSON, panelRankParams(localityId, panelIds));
        const returned = affinityById(data.results.entities);
        const affinity = new Map(panelIds.flatMap((id) => (returned.has(id) ? [[id, returned.get(id) ?? 0] as const] : [])));
        return { market, gap: null, error: null, pct: panelPercentiles(panelIds, affinity), affinity };
      } catch (err) {
        return { market, ...gapOf(err), ...empty };
      }
    }),
  );
}

export interface BookedMarket {
  market: MarketId;
  /** Among the scored markets the tour did not book; null when the seed has no score in this market. */
  percentile: number | null;
}

export interface MarketCaseScore {
  booked: BookedMarket[];
  /** Markets the tour did not book with a score for the seed: the distractors (eval/reality_cases.json scoring). */
  distractors: number;
  /** Markets with a score for the seed, booked or not. */
  scored: number;
  /** Scored booked market against scored distractor, every pair: what the percentiles are made of. */
  comparisons: number;
  /** The comparisons where both markets hold the same place in the panel. */
  ties: number;
  /** The median of the booked markets' percentiles; null when no booked market or no distractor is scored. */
  percentile: number | null;
}

/**
 * A comedian case's score: each booked market's percentile among the markets the tour did not book,
 * then the median across the booked ones (the registered rule), with how many booked-versus-unbooked
 * comparisons tied. Every unbooked secondary market is a distractor: a market has no popularity on
 * the scored scale to match on, the universe is small, and taking all of them leaves nothing to a draw.
 */
export function comedianCaseScore(seedId: string, booked: readonly MarketId[], cells: readonly MarketCell[]): MarketCaseScore {
  const isBooked = new Set(booked);
  const scoreOf = (market: MarketId): number | null => cells.find((c) => c.market.id === market)?.pct.get(seedId) ?? null;
  const others = cells.filter((c) => !isBooked.has(c.market.id)).flatMap((c) => {
    const s = c.pct.get(seedId);
    return s === undefined ? [] : [s];
  });
  const rows = booked.map((market): BookedMarket => {
    const s = scoreOf(market);
    return { market, percentile: s === null ? null : percentileAmong(s, others) };
  });
  const scoredBooked = rows.flatMap((r) => (r.percentile === null ? [] : [r.percentile]));
  const bookedScores = booked.flatMap((market) => scoreOf(market) ?? []);
  return {
    booked: rows,
    distractors: others.length,
    scored: cells.filter((c) => c.pct.has(seedId)).length,
    comparisons: bookedScores.length * others.length,
    ties: bookedScores.reduce((n, s) => n + others.filter((o) => o === s).length, 0),
    percentile: median(scoredBooked),
  };
}

// Neighbourhoods ---------------------------------------------------------------------------------------

/** geo_lift's analog-only concept map: the seed brand alone, never with a tag (P5). */
export function seedHeatParams(localityId: string, seedId: string): QlooParams {
  return { "filter.location": localityId, "signal.interests.entities": [seedId] };
}

/** The pinned restaurant baseline, the same request geo_lift sends, so it is served from the pinned cache. */
export function baselineHeatParams(localityId: string): QlooParams {
  return { "filter.location": localityId, "signal.interests.tags": [PROBE_FACTS.heatmapBaselineTag] };
}

/**
 * The gazetteer area a GHOST neighbourhood pick names, or null: the registered choice's own name
 * resolves to its registered area, any other name through the gazetteer's names and aliases.
 */
export function matchArea(geo: GeoApi, choice: { name: string; metro: MetroId; area_id: string }, text: string): string | null {
  const name = normaliseName(text);
  if (name === "") return null;
  if (name === normaliseName(choice.name)) return choice.area_id;
  return geo.matchNeighbourhood(choice.metro, text)?.id ?? null;
}

const GEOHASH = /^[0-9b-hjkmnp-z]{1,12}$/;
/** D18, as packages/quant/src/skills/geoLift/lift.ts (its u ≥ 0.5 gate is left out, see the header). */
const LIFT_CUSHION = 0.05;
export const MIN_AREA_CELLS = 5;
const NO_CLAIM_PRECISION = 4;

interface HeatCell {
  geohash: string;
  affinity: number;
}

/** Cells with a positive affinity and a usable geohash; zero-affinity cells are excluded (D18). */
function heatCells(rows: readonly QlooHeatmapCell[]): HeatCell[] {
  return rows.flatMap((row) => {
    const geohash = row.location.geohash.trim().toLowerCase();
    const affinity = row.query.affinity;
    return GEOHASH.test(geohash) && Number.isFinite(affinity) && affinity > 0 ? [{ geohash, affinity }] : [];
  });
}

/** Cells re-keyed to their prefix of length `precision`, affinity averaged within each prefix (D18). */
function rekey(cells: readonly HeatCell[], precision: number): Map<string, number> {
  const sums = new Map<string, { total: number; n: number }>();
  for (const c of cells) {
    const key = c.geohash.slice(0, precision);
    const s = sums.get(key) ?? { total: 0, n: 0 };
    s.total += c.affinity;
    s.n += 1;
    sums.set(key, s);
  }
  return new Map([...sums].map(([key, s]) => [key, s.total / s.n]));
}

export interface AreaLift {
  id: string;
  name: string;
  /** Cells both maps cover in the area, each with a lift. */
  n: number;
  /** The geometric mean of those cells' lifts with n ≥ 5; null otherwise (off the seed's map) or when the maps are too coarse. */
  lift: number | null;
  /** The mean popularity of the baseline map's cells in the area: what distractor areas are matched on. */
  popularity: number | null;
}

/**
 * Every gazetteer area of the metro with its lift (D18's cell lift: the concept's within-map
 * percentile over the baseline's at the maps' shared geohash precision, cushioned by 0.05, rolled up
 * by the cell centroid's area as a geometric mean over every shared cell, ungated) and its popularity
 * from the baseline map. An area where the seed's taste is weak has a low lift, not none.
 */
export function areaLifts(geo: GeoApi, metro: MetroId, concept: readonly QlooHeatmapCell[], baseline: readonly QlooHeatmapCell[]): AreaLift[] {
  const located = new Map<string, string | null>();
  const areaOf = (geohash: string): string | null => {
    if (!located.has(geohash)) located.set(geohash, geo.locate(metro, geo.geohashCentroid(geohash)));
    return located.get(geohash) ?? null;
  };

  const popular = new Map<string, { total: number; n: number }>();
  for (const row of baseline) {
    const geohash = row.location.geohash.trim().toLowerCase();
    const p = row.query.popularity;
    if (!GEOHASH.test(geohash) || typeof p !== "number" || !Number.isFinite(p)) continue;
    const id = areaOf(geohash);
    if (id === null) continue;
    const s = popular.get(id) ?? { total: 0, n: 0 };
    s.total += p;
    s.n += 1;
    popular.set(id, s);
  }

  const raw = heatCells(concept);
  const base = heatCells(baseline);
  const lifts = new Map<string, number[]>();
  const precision = [...raw, ...base].reduce<number | null>((p, c) => (p === null ? c.geohash.length : Math.min(p, c.geohash.length)), null);
  if (raw.length > 0 && base.length > 0 && precision !== null && precision > NO_CLAIM_PRECISION) {
    const r = rekey(raw, precision);
    const b = rekey(base, precision);
    const shared = [...r.keys()].filter((g) => b.has(g)).sort();
    const u = withinCallPercentiles(shared.map((g) => r.get(g) ?? null), null).pct;
    const v = withinCallPercentiles(shared.map((g) => b.get(g) ?? null), null).pct;
    shared.forEach((g, i) => {
      const ui = u[i] ?? null;
      const vi = v[i] ?? null;
      if (ui === null || vi === null) return;
      const id = areaOf(g);
      if (id !== null) lifts.set(id, [...(lifts.get(id) ?? []), (ui + LIFT_CUSHION) / (vi + LIFT_CUSHION)]);
    });
  }

  return geo.neighbourhoods(metro).map((a): AreaLift => {
    const cellLifts = lifts.get(a.id) ?? [];
    const p = popular.get(a.id);
    return {
      id: a.id,
      name: a.name,
      n: cellLifts.length,
      lift: cellLifts.length >= MIN_AREA_CELLS ? geometricMean(cellLifts) : null,
      popularity: p === undefined ? null : p.total / p.n,
    };
  });
}
