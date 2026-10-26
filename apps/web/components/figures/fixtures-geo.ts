import type { DatasetOf, GeoLiftCell, GeoLiftNeighbourhood, WhiteSpaceQuadrant } from "@ct/contracts";
import { encodeGeohash, geohashCentre } from "./geohash";

/**
 * An invented GeoLift fixture for the LiftMap (D29): central Austin at geohash 6, where the
 * neighbourhood ids, names and centroids are public geography (the City of Austin planning areas the
 * gazetteer ships), and every heat, lift and venue is made up. The cells are generated from two
 * smooth invented fields and then run through the S6 arithmetic (percentiles, the u ≥ 0.5 gate,
 * (u+0.05)/(v+0.05), the geometric mean over at least 5 gated cells, white space), so the fixture is
 * internally consistent. Cells join the nearest listed neighbourhood within 2.4 km; the real skill
 * uses the gazetteer polygons instead.
 */

const AREAS: readonly { id: string; name: string; lat: number; lon: number }[] = [
  { id: "east_cesar_chavez", name: "East Cesar Chavez", lat: 30.25783, lon: -97.73068 },
  { id: "holly", name: "Holly", lat: 30.25492, lon: -97.71948 },
  { id: "central_east_austin", name: "Central East Austin", lat: 30.26975, lon: -97.72416 },
  { id: "govalle", name: "Govalle", lat: 30.2592, lon: -97.7019 },
  { id: "chestnut", name: "Chestnut", lat: 30.27786, lon: -97.71506 },
  { id: "downtown", name: "Downtown", lat: 30.27101, lon: -97.74277 },
  { id: "bouldin_creek", name: "Bouldin Creek", lat: 30.25171, lon: -97.75563 },
  { id: "zilker", name: "Zilker", lat: 30.25538, lon: -97.76835 },
  { id: "south_river_city", name: "South River City", lat: 30.24538, lon: -97.74404 },
  { id: "riverside", name: "Riverside", lat: 30.23859, lon: -97.72943 },
  { id: "university_of_texas", name: "University of Texas", lat: 30.28501, lon: -97.73329 },
  { id: "old_west_austin", name: "Old West Austin", lat: 30.27606, lon: -97.76072 },
];

const PRECISION = 6;
const PRECISION_FACTOR = 0.8;
const MIN_GATED = 5;
const JOIN_KM = 2.4;

/** Deterministic noise in [0, 1). */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const bump = (lat: number, lon: number, cLat: number, cLon: number, km: number) => {
  const dy = (lat - cLat) * 111;
  const dx = (lon - cLon) * 96;
  return Math.exp(-(dx * dx + dy * dy) / (2 * km * km));
};

function distanceKm(lat: number, lon: number, a: { lat: number; lon: number }): number {
  return Math.hypot((lat - a.lat) * 111, (lon - a.lon) * 96);
}

/** Average-rank percentiles (0–1) of the values, aligned with the input. */
function percentiles(values: readonly number[]): number[] {
  const order = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const out = values.map(() => 0);
  const n = order.length;
  for (let i = 0; i < n; ) {
    let j = i;
    while (j + 1 < n && order[j + 1]!.v === order[i]!.v) j += 1;
    for (let k = i; k <= j; k += 1) out[order[k]!.i] = n === 1 ? 1 : (i + j) / 2 / (n - 1);
    i = j + 1;
  }
  return out;
}

const round = (v: number, d = 3) => Number(v.toFixed(d));

function buildCells(): GeoLiftCell[] {
  const noise = lcg(4242);
  const seen = new Set<string>();
  const raw: { geohash: string; lat: number; lon: number; raw: number; base: number }[] = [];
  for (let lat = 30.222; lat <= 30.3; lat += 0.0045) {
    for (let lon = -97.836; lon <= -97.64; lon += 0.009) {
      const geohash = encodeGeohash(lat, lon, PRECISION);
      if (seen.has(geohash)) continue;
      seen.add(geohash);
      const c = geohashCentre(geohash)!;
      // Invented fields: a shared city-centre heat, plus an east-side pull for the concept and a
      // south-central pull for the baseline, so the two maps agree downtown and part ways elsewhere.
      const centre = bump(c.lat, c.lon, 30.266, -97.741, 2.4);
      const concept = 0.4 * centre + 0.6 * bump(c.lat, c.lon, 30.258, -97.722, 1.6) + 0.05 * noise();
      const base = 0.7 * centre + 0.3 * bump(c.lat, c.lon, 30.249, -97.756, 1.8) + 0.05 * noise();
      raw.push({ geohash, lat: c.lat, lon: c.lon, raw: round(concept), base: round(base) });
    }
  }
  const u = percentiles(raw.map((c) => c.raw));
  const v = percentiles(raw.map((c) => c.base));
  return raw.map((c, i) => {
    const nearest = AREAS.map((a) => ({ a, d: distanceKm(c.lat, c.lon, a) })).sort((x, y) => x.d - y.d)[0]!;
    return {
      geohash: c.geohash,
      raw: c.raw,
      base: c.base,
      lift: round((u[i]! + 0.05) / (v[i]! + 0.05)),
      gated: u[i]! >= 0.5,
      conf: PRECISION_FACTOR,
      neighbourhood: nearest.d <= JOIN_KM ? nearest.a.id : null,
    };
  });
}

/** Invented venue sample: a few points per area, denser downtown. */
const VENUE_NAMES = ["Copper Kettle", "Low Tide Records", "Night Heron", "Fern & Vine", "Tin Lantern", "Quiet Hours"] as const;

function buildSupply(): { lat: number; lon: number; label: string; ref: null }[] {
  const noise = lcg(77);
  const plan: readonly [string, number][] = [
    ["downtown", 6],
    ["bouldin_creek", 3],
    ["south_river_city", 2],
    ["central_east_austin", 2],
    ["east_cesar_chavez", 1],
    ["zilker", 2],
    ["university_of_texas", 3],
    ["old_west_austin", 1],
    ["chestnut", 1],
  ];
  const points: { lat: number; lon: number; label: string; ref: null }[] = [];
  for (const [id, count] of plan) {
    const a = AREAS.find((x) => x.id === id)!;
    for (let k = 0; k < count; k += 1) {
      points.push({
        lat: round(a.lat + (noise() - 0.5) * 0.008, 5),
        lon: round(a.lon + (noise() - 0.5) * 0.009, 5),
        label: `${VENUE_NAMES[points.length % VENUE_NAMES.length]} ${Math.floor(points.length / VENUE_NAMES.length) + 1}`,
        ref: null,
      });
    }
  }
  return points;
}

function median(values: readonly number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function buildNeighbourhoods(cells: readonly GeoLiftCell[], supply: ReturnType<typeof buildSupply>): GeoLiftNeighbourhood[] {
  const rows = AREAS.map((a) => {
    const inside = cells.filter((c) => c.neighbourhood === a.id);
    const gated = inside.filter((c) => c.gated && c.lift !== null);
    const lift = gated.length >= MIN_GATED ? Math.exp(gated.reduce((s, c) => s + Math.log(c.lift!), 0) / gated.length) : null;
    const venues = supply.filter((p) => {
      const nearest = AREAS.map((x) => ({ x, d: distanceKm(p.lat, p.lon, x) })).sort((m, n) => m.d - n.d)[0]!;
      return nearest.x.id === a.id;
    }).length;
    // About 0.73 km² per geohash-6 cell at this latitude.
    const density = inside.length > 0 ? venues / (inside.length * 0.73) : 0;
    return { a, n: gated.length, lift, venues, density };
  });
  const lifted = rows.filter((r) => r.lift !== null);
  const demand = percentiles(lifted.map((r) => r.lift!));
  const supplyPct = percentiles(lifted.map((r) => r.density));
  const dMid = median(demand);
  const sMid = median(supplyPct);
  const quadrantOf = (d: number, s: number): WhiteSpaceQuadrant =>
    d >= dMid ? (s < sMid ? "LATENT_OPEN" : "PROVEN_CROWDED") : s >= sMid ? "SATURATED" : "COLD";
  const out = rows.map((r): GeoLiftNeighbourhood => {
    const k = lifted.indexOf(r);
    if (r.lift === null) {
      return {
        id: r.a.id,
        name: r.a.name,
        n: r.n,
        lift: null,
        conf: null,
        demandPct: null,
        supplyPct: null,
        supplyCount: r.venues,
        whiteSpace: null,
        quadrant: null,
        reason: "insufficient_n",
      };
    }
    // Percentiles are stored to two places; white space is computed from what is stored.
    const d = round(demand[k]!, 2);
    const s = round(supplyPct[k]!, 2);
    return {
      id: r.a.id,
      name: r.a.name,
      n: r.n,
      lift: round(r.lift, 3),
      conf: round(Math.min(1, r.n / 12) * PRECISION_FACTOR, 2),
      demandPct: d,
      supplyPct: s,
      supplyCount: r.venues,
      whiteSpace: round(d * (1 - s), 2),
      quadrant: quadrantOf(d, s),
      reason: null,
    };
  });
  // Lifts highest first, then the rest, as the skill orders them.
  return [
    ...out.filter((n) => n.lift !== null).sort((a, b) => b.lift! - a.lift! || (a.id < b.id ? -1 : 1)),
    ...out.filter((n) => n.lift === null),
  ];
}

const CELLS = buildCells();
const SUPPLY = buildSupply();

export const austinLiftMap: DatasetOf<"GeoLift"> = {
  id: "D15",
  kind: "GeoLift",
  title: "Lift Map · natural wine and vinyl in Austin",
  evidenceIds: ["E9", "E10"],
  formulaIds: ["lift.cell", "lift.area", "lift.confidence", "lift.white_space"],
  payload: {
    metro: "austin",
    precision: PRECISION,
    precisionFactor: PRECISION_FACTOR,
    coarse: false,
    concept: { label: "natural wine and vinyl", tagRefs: ["T1", "T2"], entityRefs: [] },
    baseline: { label: "restaurants", tag: "urn:tag:genre:place:restaurant" },
    cells: CELLS,
    neighbourhoods: buildNeighbourhoods(CELLS, SUPPLY),
    supply: { source: "places_sample", capped: true, points: SUPPLY },
    boundarySource: "City of Austin Neighborhood Planning Areas (data.austintexas.gov), public domain",
    caption:
      "Lift = the concept's taste heat against the pinned restaurant baseline, relative within Austin · geohash 6 · supply: a capped sample of Qloo-indexed venues",
  },
};

/** A coarse map (geohash 4): drawn, badged COARSE, and no neighbourhood gets a lift or a label. */
export const coarseLiftMap: DatasetOf<"GeoLift"> = {
  id: "D16",
  kind: "GeoLift",
  title: "Lift Map · listening rooms in Austin",
  evidenceIds: ["E11"],
  formulaIds: ["lift.cell", "lift.area"],
  payload: {
    metro: "austin",
    precision: 4,
    precisionFactor: 0,
    coarse: true,
    concept: { label: "listening rooms", tagRefs: ["T3"], entityRefs: [] },
    baseline: { label: "restaurants", tag: "urn:tag:genre:place:restaurant" },
    cells: ["9v6k", "9v6m", "9v6s", "9v67", "9v6e", "9v6h"].map((geohash, i) => ({
      geohash,
      raw: round(0.3 + 0.1 * i),
      base: round(0.8 - 0.08 * i),
      lift: round(0.82 + 0.09 * i),
      gated: i >= 2,
      conf: 0,
      neighbourhood: null,
    })),
    neighbourhoods: AREAS.slice(0, 4).map((a) => ({
      id: a.id,
      name: a.name,
      n: 0,
      lift: null,
      conf: null,
      demandPct: null,
      supplyPct: null,
      supplyCount: null,
      whiteSpace: null,
      quadrant: null,
      reason: "coarse",
    })),
    supply: null,
    boundarySource: "City of Austin Neighborhood Planning Areas (data.austintexas.gov), public domain",
    caption: "Lift = the concept's taste heat against the pinned restaurant baseline, relative within Austin · geohash 4 (coarse: no neighbourhood claims)",
  },
};
