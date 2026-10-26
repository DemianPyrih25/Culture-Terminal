import type { GeoLiftCell, GeoLiftNeighbourhood, GeoLiftPayload } from "@ct/contracts";
import { formatNumber } from "./format";
import { geohashCentre, unionBounds, type Bounds } from "./geohash";
import { clamp, textWidth } from "./scale";

/**
 * LiftMap scales shared by the static schematic and the WebGL map, so both draw the same colours:
 * the log2 diverging lift ramp (negative → neutral at 1.00× → data, clamped to 0.6–1.6×, PLAN §8.3),
 * the sequential RAW and BASE ramp by percentile, confidence as alpha, the neighbourhood markers
 * sized by lift and the labels' positions. Pure; colours mirror the Concept A tokens in globals.css.
 */

/** RAW: the concept's own heat. BASE: the pinned baseline's heat. LIFT: concept over baseline. */
export type LiftMode = "RAW" | "BASE" | "LIFT";
export const LIFT_MODES: readonly LiftMode[] = ["RAW", "BASE", "LIFT"];
/** Keys 1/2/3 switch RAW/BASE/LIFT (SPEC §8.4). */
export const LIFT_MODE_KEY: Readonly<Record<LiftMode, string>> = { RAW: "1", BASE: "2", LIFT: "3" };

export type Rgb = readonly [number, number, number];

/** Concept A tokens (app/globals.css) as RGB, for ramps that need computed colours. */
export const TOKEN_RGB = {
  paper: [255, 255, 255],
  ink: [18, 20, 22],
  dim: [107, 113, 120],
  line: [230, 231, 233],
  lineStrong: [201, 204, 208],
  data: [28, 61, 110],
  negative: [142, 47, 47],
  data2: [169, 176, 184],
} as const satisfies Record<string, Rgb>;

/** The neutral the ramps start from: 1.00× on the lift ramp, the lowest heat on the RAW/BASE ramp. */
const NEUTRAL: Rgb = [238, 240, 242];
/** The lift ramp's clamp (PLAN §8.3): 0.6× is full negative, 1.6× full data colour. */
export const LIFT_CLAMP = { min: 0.6, max: 1.6 } as const;

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  const k = clamp(t, 0, 1);
  return [Math.round(a[0] + (b[0] - a[0]) * k), Math.round(a[1] + (b[1] - a[1]) * k), Math.round(a[2] + (b[2] - a[2]) * k)];
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

/** The lift ramp colour: negative below 1.00×, data above, neutral at 1.00×. */
export function liftRgb(lift: number): Rgb {
  const t = liftT(lift);
  return t >= 0 ? mix(NEUTRAL, TOKEN_RGB.data, t) : mix(NEUTRAL, TOKEN_RGB.negative, -t);
}

/** The RAW/BASE ramp colour for a heat percentile (0 = coolest cell, 1 = hottest). */
export function heatRgb(pct: number): Rgb {
  return mix(NEUTRAL, TOKEN_RGB.data, pct);
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

/** Marker radius in px for a neighbourhood lift: circle size = lift (A06). */
export function liftRadius(lift: number): number {
  return clamp(1.5 + 15 * (lift - LIFT_CLAMP.min), 3, 16);
}

/** A labelled neighbourhood: where to put it and what it says. */
export interface LiftLabel {
  id: string;
  name: string;
  lift: number;
  /** The centre of the neighbourhood's cells, or null when no cell falls inside it. */
  at: { lat: number; lon: number } | null;
  /** The highest lift on the map gets the halo (A06). */
  top: boolean;
}

/**
 * The neighbourhoods the map labels: the highest lifts and, for contrast, the lowest ones below the
 * baseline, at most `max` in all. Each sits at the centre of its cells unless the caller has the
 * gazetteer centroid. A coarse map makes no neighbourhood claims, so it labels none.
 */
export function liftLabels(data: GeoLiftPayload, max = 7): LiftLabel[] {
  if (data.coarse) return [];
  const withLift = data.neighbourhoods
    .filter((n): n is GeoLiftNeighbourhood & { lift: number } => n.lift !== null)
    .sort((a, b) => b.lift - a.lift || (a.id < b.id ? -1 : 1));
  const lowCount = Math.min(2, withLift.filter((n) => n.lift < 1).length, Math.max(0, max - 1));
  const high = withLift.slice(0, Math.max(0, max - lowCount));
  // slice(-0) would keep every remaining area: with no lift below 1.00× there is no contrast to add.
  const low = lowCount > 0 ? withLift.slice(high.length).slice(-lowCount) : [];
  const centres = cellCentres(data.cells);
  return [...high, ...low].map((n, i) => ({ id: n.id, name: n.name, lift: n.lift, at: centres.get(n.id) ?? null, top: i === 0 }));
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
export function placeChips(chips: readonly ChipRequest[], box: { w: number; h: number }, gap = 5): Map<string, { x: number; y: number }> {
  const taken: { x: number; y: number; w: number; h: number }[] = chips.map((c) => ({ x: c.x - c.r, y: c.y - c.r, w: c.r * 2, h: c.r * 2 }));
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

/** A chip's size for a label: name and lift in 11 px Inter with 6 px padding. */
export function chipSize(label: Pick<LiftLabel, "name" | "lift" | "top">, withLift: boolean): { w: number; h: number } {
  const name = textWidth(label.name, 11, { weight: label.top ? 600 : 500 });
  const lift = withLift ? 5 + textWidth(formatLift(label.lift), 11, { weight: 500 }) : 0;
  return { w: Math.ceil(name + lift + 12), h: 18 };
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
