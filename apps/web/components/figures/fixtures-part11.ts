import type { AreaStanding, DatasetOf, GeoLiftNeighbourhood } from "@ct/contracts";
import { austinLiftMap } from "./fixtures-geo";

/**
 * Part 11 figure fixtures, invented for tests and the dev gallery: an OpenStreetMap supply read (R6) with
 * invented place names and example ids, and the Austin lift map with R7 popularity (raw, rawPct, standing,
 * the popular and hidden lists). No real Qloo or OpenStreetMap values.
 */

/** Ranks the Austin areas by an invented raw interest, so the standing rule of STANDING (0.75 / 0.5) applies. */
function withStanding(areas: readonly GeoLiftNeighbourhood[]): GeoLiftNeighbourhood[] {
  const n = areas.length;
  // Raw interest runs opposite to the list order for the first half: the top-lift areas are small.
  const raw = areas.map((a, i) => ({ id: a.id, raw: Number((0.2 + ((n - i) % n) / n / 2 + (i % 3) * 0.05).toFixed(3)) }));
  const sorted = [...raw].sort((a, b) => a.raw - b.raw);
  const pct = new Map(sorted.map((r, i) => [r.id, n > 1 ? i / (n - 1) : 1]));
  return areas.map((a, i) => {
    const rawPct = Number((pct.get(a.id) ?? 0).toFixed(3));
    const demand = a.demandPct;
    const standing: AreaStanding | null =
      rawPct >= 0.75 && demand !== null && demand >= 0.75
        ? "popular_distinct"
        : rawPct >= 0.75
          ? "popular"
          : demand !== null && demand >= 0.75 && rawPct < 0.5
            ? "hidden"
            : null;
    return { ...a, raw: raw[i]?.raw ?? null, rawPct, standing, ...(i === 0 ? { source: "user_named" as const } : i === 2 ? { source: "obvious" as const } : {}) };
  });
}

const standingAreas = withStanding(austinLiftMap.payload.neighbourhoods);

export const standingLiftMap: DatasetOf<"GeoLift"> = {
  ...austinLiftMap,
  id: "D40",
  formulaIds: [...austinLiftMap.formulaIds, "lift.area_popularity"],
  payload: {
    ...austinLiftMap.payload,
    neighbourhoods: standingAreas,
    popular: [...standingAreas]
      .filter((a) => a.standing === "popular" || a.standing === "popular_distinct")
      .sort((a, b) => (b.rawPct ?? 0) - (a.rawPct ?? 0))
      .slice(0, 3)
      .map((a) => a.id),
    hidden: standingAreas
      .filter((a) => a.standing === "hidden")
      .sort((a, b) => (b.demandPct ?? 0) - (a.demandPct ?? 0))
      .slice(0, 3)
      .map((a) => a.id),
  },
};

const ids = austinLiftMap.payload.neighbourhoods.slice(0, 3).map((a) => ({ id: a.id, name: a.name }));
const first = ids[0] ?? { id: "area-1", name: "Example Area" };

/** An OpenStreetMap supply read of three invented Austin areas: two place types, a mix read and named places. */
export const supplyAreas: DatasetOf<"Supply"> = {
  id: "D41",
  kind: "Supply",
  title: "Cafés and record shops already in the areas",
  evidenceIds: ["E40"],
  formulaIds: ["osm.count", "osm.density", "osm.density_index", "osm.activity_density"],
  payload: {
    source: "osm",
    attribution: "© OpenStreetMap contributors",
    licence: "ODbL-1.0",
    licenceUrl: "https://www.openstreetmap.org/copyright",
    osmBase: "2026-10-28T06:00:00Z",
    scope: "areas",
    metro: "austin",
    market: null,
    radiusKm: null,
    types: [
      { key: "cafe", label: "Cafés and coffee shops", tags: ["amenity=cafe"] },
      { key: "record_store", label: "Record shops", tags: ["shop=music"] },
    ],
    rows: ids.map((a, i) => ({
      id: a.id,
      name: a.name,
      areaKm2: 4 + i,
      ...(i === 0 ? { source: "user_named" as const } : {}),
      counts: { cafe: [18, 6, 9][i] ?? 0, record_store: [3, 0, 1][i] ?? 0 },
      perKm2: { cafe: [4.5, 1.2, 1.5][i] ?? 0, record_store: [0.75, 0, 0.17][i] ?? 0 },
      index: { cafe: [2.1, 0.55, 1.05][i] ?? null, record_store: [3.4, 0, 0.8][i] ?? null },
      activity: [140, 40, 66][i] ?? null,
      activityPerKm2: [35, 8, 11][i] ?? null,
    })),
    city: {
      label: "Austin (Travis County)",
      areaKm2: 820,
      approximate: true,
      counts: { cafe: 1750, record_store: 180 },
      perKm2: { cafe: 2.13, record_store: 0.22 },
      activityPerKm2: 12,
    },
    mix: {
      over: [
        { typeKey: "record_store", index: 3.4, count: 3 },
        { typeKey: "cafe", index: 2.1, count: 18 },
      ],
      under: [],
    },
    places: [
      { name: "Example Café 1", brand: null, lat: 30.262, lon: -97.725, typeKey: "cafe", area: first.id, osmUrl: "https://www.openstreetmap.org/node/1000000001" },
      { name: "Example Café 2", brand: "Example Roasters", lat: 30.264, lon: -97.722, typeKey: "cafe", area: first.id, osmUrl: "https://www.openstreetmap.org/node/1000000002" },
      { name: "Example Records", brand: null, lat: 30.261, lon: -97.728, typeKey: "record_store", area: first.id, osmUrl: "https://www.openstreetmap.org/way/1000000003" },
    ],
    completeness: "OpenStreetMap is mapped by volunteers: counts are a floor, not a census.",
    caption: "Places counted in each area's outline; each type against the city's level.",
  },
};
