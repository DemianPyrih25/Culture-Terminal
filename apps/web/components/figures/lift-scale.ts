import type { GeoLiftCell, GeoLiftNeighbourhood, GeoLiftPayload, WhiteSpaceQuadrant } from "@ct/contracts";
import { METRO_LABEL } from "@ct/contracts/values";
import { formatNumber } from "./format";
import { geohashCentre, unionBounds, type Bounds } from "./geohash";
import { clamp, textWidth } from "./scale";

/**
 * LiftMap scales shared by the static schematic and the WebGL map, so both draw the same colours:
 * the log2 diverging lift ramp (red → paper at 1.00× → green, clamped to 0.6–1.6×, PLAN §8.3),
 * the sequential RAW and BASE ramp by percentile, confidence as alpha, the neighbourhood markers
 * sized by lift and the labels' positions. Pure; colours mirror the redesign tokens in globals.css.
 */

/** RAW: the concept's own heat. BASE: the pinned baseline's heat. LIFT: concept over baseline. */
export type LiftMode = "RAW" | "BASE" | "LIFT";
export const LIFT_MODES: readonly LiftMode[] = ["RAW", "BASE", "LIFT"];
/** Keys 1/2/3 switch RAW/BASE/LIFT (SPEC §8.4). */
export const LIFT_MODE_KEY: Readonly<Record<LiftMode, string>> = { RAW: "1", BASE: "2", LIFT: "3" };

export type Rgb = readonly [number, number, number];

/** Ledger tokens (app/globals.css, design/redesign-v3.pen) as RGB, for ramps and map layers that need computed colours. */
export const TOKEN_RGB = {
  surface: [255, 255, 255],
  ink: [22, 24, 29],
  ink2: [79, 83, 92],
  ink3: [140, 144, 154],
  line: [226, 221, 211],
  lineStrong: [203, 195, 180],
  accent: [29, 62, 158],
  second: [194, 122, 44],
  muted: [203, 195, 180],
  good: [30, 122, 79],
  danger: [180, 50, 44],
} as const satisfies Record<string, Rgb>;

/** The sequential map ramp, map-1 … map-5: more interest is deeper ledger blue. */
export const MAP_RAMP: readonly Rgb[] = [
  [232, 236, 247],
  [184, 196, 229],
  [125, 147, 205],
  [67, 100, 179],
  [29, 62, 158],
];

/** The diverging lift ramp's arms (design a-div-*): the neutral 1.00× step, then green above and red below. */
const NEUTRAL: Rgb = [238, 234, 226];
export const LIFT_ABOVE: readonly Rgb[] = [NEUTRAL, [179, 214, 192], [98, 168, 130], [30, 122, 79]];
export const LIFT_BELOW: readonly Rgb[] = [NEUTRAL, [236, 187, 177], [213, 119, 107], [180, 50, 44]];
/** The lift ramp's clamp (PLAN §8.3): 0.6× is full "less", 1.6× the deepest ramp step. */
export const LIFT_CLAMP = { min: 0.6, max: 1.6 } as const;

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  const k = clamp(t, 0, 1);
  return [Math.round(a[0] + (b[0] - a[0]) * k), Math.round(a[1] + (b[1] - a[1]) * k), Math.round(a[2] + (b[2] - a[2]) * k)];
}

function along(ramp: readonly Rgb[], t: number): Rgb {
  const k = clamp(t, 0, 1) * (ramp.length - 1);
  const i = Math.min(ramp.length - 2, Math.floor(k));
  return mix(ramp[i]!, ramp[i + 1]!, k - i);
}

/** A colour along the map ramp, 0 (map-1) to 1 (map-5). */
export function rampRgb(t: number): Rgb {
  return along(MAP_RAMP, t);
}

export function rgbHex(rgb: Rgb): string {
  return `#${rgb.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

/** A lift's position on the log2 ramp: −1 at 0.6× or below, 0 at 1.00×, +1 at 1.6× or above. */
export function liftT(lift: number): number {
  if (!(lift > 0)) return -1;
  const l = Math.log2(lift);
  return l >= 0 ? clamp(l / Math.log2(LIFT_CLAMP.max), 0, 1) : -clamp(l / Math.log2(LIFT_CLAMP.min), 0, 1);
}

/**
 * The diverging lift ramp colour: paper at 1.00×, deeper green the more interest above a typical area,
 * deeper red the less; confidence (the alpha) keeps uncertain cells pale either way.
 */
export function liftRgb(lift: number): Rgb {
  const t = liftT(lift);
  return t >= 0 ? along(LIFT_ABOVE, t) : along(LIFT_BELOW, -t);
}

/** The RAW/BASE ramp colour for a heat percentile (0 = coolest cell, 1 = hottest). */
export function heatRgb(pct: number): Rgb {
  return rampRgb(pct);
}

/**
 * Fill alpha of a cell. LIFT: confidence is the alpha, scaled by how far the lift is from 1.00× so
 * cells at the baseline leave the basemap readable; cells below the u ≥ 0.5 gate (D18) stay faint.
 * RAW and BASE: the heat percentile.
 */
export function cellAlpha(cell: Pick<GeoLiftCell, "conf" | "gated" | "lift">, mode: LiftMode, pct = 1): number {
  if (mode === "LIFT") {
    const reach = cell.lift === null ? 0 : Math.abs(liftT(cell.lift));
    return clamp(cell.conf, 0, 1) * (cell.gated ? 0.2 + 0.65 * reach : 0.08 + 0.2 * reach);
  }
  return 0.12 + 0.6 * clamp(pct, 0, 1);
}

/** The value a cell shows in a mode, or null when the cell is absent there. */
export function modeValue(cell: GeoLiftCell, mode: LiftMode): number | null {
  return mode === "RAW" ? cell.raw : mode === "BASE" ? cell.base : cell.lift;
}

/**
 * Percentile rank (0–1, average ranks for ties) of each cell's value in a mode, for the RAW and BASE
 * ramps: raw affinities are per-call scores, so only their order within the map is read (G6).
 */
export function heatPercentiles(cells: readonly GeoLiftCell[], mode: "RAW" | "BASE"): Map<string, number> {
  const scored = cells
    .map((c) => ({ g: c.geohash, v: modeValue(c, mode) }))
    .filter((c): c is { g: string; v: number } => c.v !== null)
    .sort((a, b) => a.v - b.v);
  const out = new Map<string, number>();
  const n = scored.length;
  for (let i = 0; i < n; ) {
    let j = i;
    while (j + 1 < n && scored[j + 1]!.v === scored[i]!.v) j += 1;
    const rank = n === 1 ? 1 : (i + j) / 2 / (n - 1);
    for (let k = i; k <= j; k += 1) out.set(scored[k]!.g, rank);
    i = j + 1;
  }
  return out;
}

/**
 * The confidence a coarse map's cells are drawn with on the LIFT layer. S6 gives each cell the map's
 * precision factor as confidence, which is 0 at geohash 4 and coarser, so the layer would come out
 * blank and read as no data; the floor keeps where lift sits visible while the COARSE badge carries
 * the caveat.
 */
export const COARSE_CONF_FLOOR = 0.35;

/** Fill colour and alpha of every cell drawn in a mode; cells absent in the mode are left out. */
export function cellFills(data: GeoLiftPayload, mode: LiftMode): Map<string, { rgb: Rgb; alpha: number }> {
  const out = new Map<string, { rgb: Rgb; alpha: number }>();
  if (mode === "LIFT") {
    for (const c of data.cells) {
      if (c.lift === null) continue;
      const conf = data.coarse ? Math.max(COARSE_CONF_FLOOR, c.conf) : c.conf;
      out.set(c.geohash, { rgb: liftRgb(c.lift), alpha: cellAlpha({ ...c, conf }, mode) });
    }
    return out;
  }
  const pct = heatPercentiles(data.cells, mode);
  for (const c of data.cells) {
    const p = pct.get(c.geohash);
    if (p !== undefined) out.set(c.geohash, { rgb: heatRgb(p), alpha: cellAlpha(c, mode, p) });
  }
  return out;
}

/**
 * The box a map opens on: the cells inside the gazetteer's neighbourhoods when there are a few
 * (the claims), otherwise every cell. Null without a cell.
 */
export function focusBounds(data: Pick<GeoLiftPayload, "cells">): Bounds | null {
  const inside = data.cells.filter((c) => c.neighbourhood !== null);
  return unionBounds((inside.length >= 4 ? inside : data.cells).map((c) => c.geohash));
}

/** "1.48×". */
export function formatLift(lift: number): string {
  return `${formatNumber(lift, "lift", { digits: 2 })}×`;
}

/** A named place from an OpenStreetMap supply read (R6), drawn on the map's "Similar places" layer. */
export interface MapPlace {
  name: string;
  lat: number;
  lon: number;
  /** The place type's label, e.g. "Cafés and coffee shops". */
  type: string;
}

/** A labelled neighbourhood: where to put it and what it says. */
export interface LiftLabel {
  id: string;
  name: string;
  lift: number;
  /** The centre of the neighbourhood's cells, or null when no cell falls inside it. */
  at: { lat: number; lon: number } | null;
  /** The highest lift on the map. */
  top: boolean;
  /** The pin's numeral: the area's rank by extra interest (pins only). */
  rank?: number;
  /** Few similar venues nearby (white space "latent & open"): the second-colour ring and tag. */
  fewRivals?: boolean;
  /** An area the question names: an accent pin, listed first. */
  named?: boolean;
  /** R7: a numbered pin whose area is a hidden pocket (high lift, little interest overall); its flag says so. */
  hidden?: boolean;
  /** R7: an area among the most popular overall (raw interest), pinned with an outlined mark and "Already popular". */
  popular?: boolean;
}

/**
 * The supply-label rule of @ct/quant (skills/geoLift/lift), mirrored for the client bundle, which does not
 * import quant; test/figures/lift-scale.test.ts keeps the numbers equal and runs both on the same areas.
 * geo_lift applies it when it writes a map; the page applies it again so a run stored before the rule
 * never shows a label its data cannot carry.
 * - MIN_SUPPLY_VENUES: similar venues a map's sample must place in its areas with a lift before any count is read.
 * - A capped sample's 0 is no count.
 * - MIN_BUSY_AREA_VENUES: venues an area needs before it reads crowded or saturated ("busy with rivals").
 * Below the rule an area with a lift reads THIN_SUPPLY_LABEL.
 */
export const MIN_SUPPLY_VENUES = 10;
export const MIN_BUSY_AREA_VENUES = 3;
export const THIN_SUPPLY_LABEL = "Not enough venue data";
const BUSY: ReadonlySet<WhiteSpaceQuadrant> = new Set(["PROVEN_CROWDED", "SATURATED"]);

type SupplyData = Pick<GeoLiftPayload, "metro" | "supply" | "supplyGap" | "neighbourhoods">;

/**
 * Why a lift map's competitor counts cannot be read area by area, in a reader's words, or null when
 * they can (or no venue sample was asked for). The payload's own supplyGap first; a run stored before
 * geo_lift set one for a thin sample is read by the same rule, so an unknown is never shown as 0 or few.
 */
export function supplyUnknown(data: SupplyData): string | null {
  if (data.supplyGap) return data.supplyGap;
  if (data.supply === null) return null;
  const placed = data.neighbourhoods.reduce((n, a) => n + (a.demandPct !== null ? (a.supplyCount ?? 0) : 0), 0);
  if (placed >= MIN_SUPPLY_VENUES) return null;
  return (
    `Qloo's venue sample places only ${placed} similar ${placed === 1 ? "venue" : "venues"} in the ${METRO_LABEL[data.metro]} areas this map compares, ` +
    `too few to count competitors area by area (${MIN_SUPPLY_VENUES} needed), so the number of competitors here is unknown, not zero.`
  );
}

/**
 * What a map can say about one area's competition, by the supply-label rule:
 * - unknown: similar venues were not counted area by area (no count, a supply gap, a sample too thin to read);
 * - thin: counted, but the count cannot carry a label (a capped sample's 0, a crowded reading from fewer
 *   than MIN_BUSY_AREA_VENUES venues, or a quadrant geo_lift withheld): THIN_SUPPLY_LABEL;
 * - label: the white-space quadrant, which ranks the area against the others;
 * - count: a count with nothing to rank it against (an area without a lift);
 * - none: no venue sample was asked for.
 */
export type AreaSupplyRead =
  | { kind: "unknown"; why: string }
  | { kind: "thin"; count: number; cappedZero: boolean }
  | { kind: "label"; count: number; quadrant: WhiteSpaceQuadrant }
  | { kind: "count"; count: number }
  | { kind: "none" };

type SupplyArea = Pick<GeoLiftNeighbourhood, "quadrant"> & Partial<Pick<GeoLiftNeighbourhood, "supplyCount" | "demandPct">>;

export function areaSupply(n: SupplyArea, data: SupplyData): AreaSupplyRead {
  const gap = supplyUnknown(data);
  if (gap !== null) return { kind: "unknown", why: gap };
  if (data.supply === null) return { kind: "none" };
  const count = n.supplyCount ?? null;
  if (count === null) return { kind: "unknown", why: "" };
  if (data.supply.capped && count === 0) return { kind: "thin", count, cappedZero: true };
  if (n.quadrant !== null) {
    return BUSY.has(n.quadrant) && count < MIN_BUSY_AREA_VENUES ? { kind: "thin", count, cappedZero: false } : { kind: "label", count, quadrant: n.quadrant };
  }
  // A ranked area (it has a demand percentile) with no quadrant is one geo_lift withheld.
  return n.demandPct !== null && n.demandPct !== undefined ? { kind: "thin", count, cappedZero: false } : { kind: "count", count };
}

/**
 * Few rivals nearby: demand is high and similar venues are fewer than in most areas (the white-space
 * "latent & open" quadrant). With the map's data, only where the supply-label rule lets the area carry
 * its quadrant: never from a sample too thin to read, nor from a capped sample's 0.
 */
export function fewRivals(n: SupplyArea, data?: SupplyData): boolean {
  if (n.quadrant !== "LATENT_OPEN") return false;
  if (data === undefined) return true;
  const read = areaSupply(n, data);
  return read.kind === "label" && read.quadrant === "LATENT_OPEN";
}

/** An area the question names, as the map card lists it: its rank among the areas with a lift, or why it has none. */
export interface NamedArea {
  id: string;
  name: string;
  lift: number | null;
  /** [rank, of] among the areas with a lift; null without a lift. */
  rank: [number, number] | null;
}

/** The areas the question names (focusAreas), in the question's order. */
export function namedAreas(data: Pick<GeoLiftPayload, "focusAreas" | "neighbourhoods">): NamedArea[] {
  const ranked = data.neighbourhoods.filter((n) => n.lift !== null).sort((a, b) => (b.lift ?? 0) - (a.lift ?? 0) || (a.id < b.id ? -1 : 1));
  return (data.focusAreas ?? []).flatMap((id) => {
    const n = data.neighbourhoods.find((x) => x.id === id);
    if (!n) return [];
    const at = ranked.indexOf(n);
    return [{ id, name: n.name, lift: n.lift, rank: at >= 0 ? ([at + 1, ranked.length] as [number, number]) : null }];
  });
}

/** The areas the question names that have a lift, as accent pins; the top pins already mark any that rank there. */
export function namedPins(data: GeoLiftPayload, pinned: readonly LiftLabel[] = []): LiftLabel[] {
  if (data.coarse) return [];
  const centres = cellCentres(data.cells);
  const taken = new Set(pinned.map((p) => p.id));
  return (data.focusAreas ?? []).flatMap((id) => {
    const n = data.neighbourhoods.find((x) => x.id === id);
    if (!n || n.lift === null || taken.has(id)) return [];
    return [{ id, name: n.name, lift: n.lift, at: centres.get(id) ?? null, top: false, named: true, fewRivals: fewRivals(n, data) }];
  });
}

/**
 * The numbered pins of the map card: the areas with the most extra interest (lift above 1.00×), best
 * first, at most `max`. A coarse map makes no neighbourhood claims, so it pins none.
 */
export function mapPins(data: GeoLiftPayload, max = 3): LiftLabel[] {
  if (data.coarse) return [];
  const centres = cellCentres(data.cells);
  return data.neighbourhoods
    .filter((n): n is GeoLiftNeighbourhood & { lift: number } => n.lift !== null && n.lift > 1)
    .sort((a, b) => b.lift - a.lift || (a.id < b.id ? -1 : 1))
    .slice(0, Math.max(0, max))
    .map((n, i) => ({
      id: n.id,
      name: n.name,
      lift: n.lift,
      at: centres.get(n.id) ?? null,
      top: i === 0,
      rank: i + 1,
      fewRivals: fewRivals(n, data),
      ...((data.focusAreas ?? []).includes(n.id) ? { named: true } : {}),
      ...(n.standing === "hidden" ? { hidden: true } : {}),
    }));
}

/**
 * R7: the areas where the concept is already popular (the payload's `popular` list, the top 3 by raw
 * interest), as outlined pins beside the numbered extra-interest pins, and the top hidden pockets the
 * numbered pins miss, in RAW and LIFT alike. An area already pinned keeps its pin. A coarse map, or one
 * stored before Part 11, pins none.
 */
export function popularPins(data: GeoLiftPayload, pinned: readonly LiftLabel[] = []): LiftLabel[] {
  if (data.coarse) return [];
  const centres = cellCentres(data.cells);
  const taken = new Set(pinned.map((p) => p.id));
  const popular = (data.popular ?? []).slice(0, 3).flatMap((id) => {
    const n = data.neighbourhoods.find((x) => x.id === id);
    if (!n || taken.has(id)) return [];
    taken.add(id);
    return [{ id, name: n.name, lift: n.lift ?? 1, at: centres.get(id) ?? null, top: false, popular: true }];
  });
  // The top hidden pockets the numbered pins do not already mark get a pin of their own, flagged as hidden.
  const hidden = (data.hidden ?? []).slice(0, 3).flatMap((id) => {
    const n = data.neighbourhoods.find((x) => x.id === id);
    if (!n || n.lift === null || taken.has(id)) return [];
    taken.add(id);
    return [{ id, name: n.name, lift: n.lift, at: centres.get(id) ?? null, top: false, hidden: true }];
  });
  return [...popular, ...hidden];
}

/** The mean centre of each neighbourhood's cells. */
export function cellCentres(cells: readonly GeoLiftCell[]): Map<string, { lat: number; lon: number }> {
  const sums = new Map<string, { lat: number; lon: number; n: number }>();
  for (const c of cells) {
    if (c.neighbourhood === null) continue;
    const at = geohashCentre(c.geohash);
    if (at === null) continue;
    const s = sums.get(c.neighbourhood) ?? { lat: 0, lon: 0, n: 0 };
    sums.set(c.neighbourhood, { lat: s.lat + at.lat, lon: s.lon + at.lon, n: s.n + 1 });
  }
  return new Map([...sums].map(([id, s]) => [id, { lat: s.lat / s.n, lon: s.lon / s.n }]));
}

/** A label chip to place beside its marker: the marker at (x, y) with radius r, the chip w × h. */
export interface ChipRequest {
  id: string;
  x: number;
  y: number;
  r: number;
  w: number;
  h: number;
}

/**
 * Greedy chip placement in priority order: right of the marker, then left, above and below; a chip
 * that fits nowhere inside the box without covering another chip or marker is dropped (the table
 * still lists it). Returns each placed chip's top-left corner.
 */
export function placeChips(
  chips: readonly ChipRequest[],
  box: { w: number; h: number },
  gap = 5,
  /** Areas the map's own controls cover (legend, zoom, credits): no flag goes there. */
  reserved: readonly { x: number; y: number; w: number; h: number }[] = [],
): Map<string, { x: number; y: number }> {
  const markerBoxes = chips.map((c) => ({ x: c.x - c.r, y: c.y - c.r, w: c.r * 2, h: c.r * 2 }));
  const taken: { x: number; y: number; w: number; h: number }[] = [...markerBoxes, ...reserved];
  const overlaps = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  const out = new Map<string, { x: number; y: number }>();
  chips.forEach((c, i) => {
    const candidates = [
      { x: c.x + c.r + gap, y: c.y - c.h / 2 },
      { x: c.x - c.r - gap - c.w, y: c.y - c.h / 2 },
      { x: c.x - c.w / 2, y: c.y - c.r - gap - c.h },
      { x: c.x - c.w / 2, y: c.y + c.r + gap },
    ];
    for (const at of candidates) {
      const rect = { ...at, w: c.w, h: c.h };
      if (rect.x < 2 || rect.y < 2 || rect.x + rect.w > box.w - 2 || rect.y + rect.h > box.h - 2) continue;
      // Its own marker (entry i) sits beside it by construction; every other marker and chip is kept clear.
      if (taken.some((t, k) => k !== i && overlaps(rect, t))) continue;
      out.set(c.id, at);
      taken.push(rect);
      return;
    }
  });
  return out;
}

/** Below this map width the legend sits top-left and the credits fold into a button (the max-sm layout). */
const NARROW_MAP = 640;

/**
 * Padding that keeps the areas clear of what sits over the map: the legend (top-left on a narrow map,
 * bottom-left otherwise), the zoom buttons on the right and the credits along the bottom.
 */
export function fitPadding(width: number): { top: number; bottom: number; left: number; right: number } {
  return width < NARROW_MAP ? { top: 56, bottom: 48, left: 16, right: 56 } : { top: 48, bottom: 64, left: 48, right: 56 };
}

/** The boxes the map's overlays cover, so no flag is placed under them. */
export function overlayBoxes(w: number, h: number): { x: number; y: number; w: number; h: number }[] {
  const narrow = w < NARROW_MAP;
  return [
    // Zoom buttons (36 x 73 at right 12, bottom 32) and the credits under them.
    { x: w - 52, y: h - 109, w: 52, h: 109 },
    { x: 0, y: h - 26, w, h: 26 },
    // The legend.
    narrow ? { x: 0, y: 0, w: Math.min(w, 300), h: 52 } : { x: 0, y: h - 64, w: 320, h: 64 },
  ];
}

/** What a pin's flag says under the name: "1.42× interest". */
export function flagValue(lift: number): string {
  return `${formatLift(lift)} interest`;
}

/** A flag's second line by pin: "Already popular", "1.42× interest · hidden pocket", or "1.42× interest". */
export function flagText(label: Pick<LiftLabel, "lift" | "popular" | "hidden">): string {
  if (label.popular) return "Already popular";
  return label.hidden ? `${flagValue(label.lift)} · hidden pocket` : flagValue(label.lift);
}

/** A pin flag's size: the name 13/600 over the value 12, padding 6 10. */
export function flagSize(label: Pick<LiftLabel, "name" | "lift" | "popular" | "hidden">): { w: number; h: number } {
  const w = Math.max(textWidth(flagName(label.name), 13, { weight: 600 }), textWidth(flagText(label), 12, { weight: 400 }));
  return { w: Math.ceil(w + 20), h: 46 };
}

/** Flag names longer than this are shortened (Austin's longest planning area is 30 characters). */
const FLAG_NAME_MAX = 30;

/**
 * An area's name on its map flag, which does not wrap: a long ZIP area reads as its bracketed name
 * ("ZIP 77005 (West University Place)" → "West University Place"), a long hyphenated one as its first
 * place ("Morningside Heights-Hamilton Heights" → "Morningside Heights…"), else its first words. The
 * pin list and the table keep the full name.
 */
export function flagName(name: string): string {
  if (name.length <= FLAG_NAME_MAX) return name;
  const bracketed = /^ZIP \d{5} \((.+)\)$/.exec(name)?.[1];
  if (bracketed !== undefined && bracketed.length <= FLAG_NAME_MAX) return bracketed;
  const first = name.split("-")[0]?.trim() ?? "";
  const short = first !== "" && first.length < FLAG_NAME_MAX ? first : name.slice(0, FLAG_NAME_MAX).replace(/\s+\S*$/, "");
  return `${short}…`;
}

/** A pin's radius in px: 14, or 20 with the few-rivals ring. */
export function pinRadius(label: Pick<LiftLabel, "fewRivals">): number {
  return label.fewRivals ? 20 : 14;
}

/** The precision badge: "GEOHASH 6 · PRECISION 0.80", or the coarse warning. */
export function precisionBadge(data: Pick<GeoLiftPayload, "precision" | "precisionFactor" | "coarse">): {
  text: string;
  coarse: boolean;
} {
  return data.coarse
    ? { text: `Geohash ${data.precision} · coarse · no neighbourhood claims`, coarse: true }
    : { text: `Geohash ${data.precision} · precision ${data.precisionFactor.toFixed(2)}`, coarse: false };
}
