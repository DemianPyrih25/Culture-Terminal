import type { CensusField, CensusGeo, CensusRow, CensusUnits, GeoApi, MetroId } from "@ct/contracts";

/**
 * Area economics arithmetic (SPEC S14, FORMULAS econ.count, econ.median, econ.share): Census units
 * (ZCTAs or tracts) rolled up to a gazetteer area. Counts are summed, medians are population-weighted
 * averages of the unit medians, commute shares are summed mode counts over summed workers. Pure.
 */

// The Census crosswalk @ct/geo serves (GeoApi.censusUnits, optional in contracts: a GeoApi without it
// has no crosswalk, and the skill answers unavailable).
export type AreaCensusUnits = CensusUnits;

export interface CensusCrosswalkApi {
  censusUnits(metro: MetroId, id: string): Promise<AreaCensusUnits | null>;
  censusUnitsOfMetro(metro: MetroId): Promise<AreaCensusUnits[]>;
}

/** The crosswalk methods of a GeoApi, or null when this GeoApi has none. */
export function censusCrosswalkOf(geo: GeoApi): CensusCrosswalkApi | null {
  if (geo.censusUnits === undefined || geo.censusUnitsOfMetro === undefined) return null;
  return { censusUnits: geo.censusUnits.bind(geo), censusUnitsOfMetro: geo.censusUnitsOfMetro.bind(geo) };
}

/** The unit ids of an area: ZCTAs or 11-digit tract GEOIDs. */
export const unitIdsOf = (u: AreaCensusUnits): readonly string[] => (u.kind === "zcta" ? u.zctas : u.tracts);

/** The ACS requests covering units: one ZCTA list (sorted, distinct) and one request per county for tracts. */
export function censusGeosOf(units: readonly AreaCensusUnits[]): CensusGeo[] {
  const zctas = new Set<string>();
  const counties = new Map<string, { state: string; county: string }>();
  for (const u of units) {
    if (u.kind === "zcta") for (const z of u.zctas) zctas.add(z);
    else for (const c of u.counties) counties.set(c.state + c.county, c);
  }
  const geos: CensusGeo[] = [];
  if (zctas.size > 0) geos.push({ kind: "zcta", zctas: [...zctas].sort() });
  for (const key of [...counties.keys()].sort()) {
    const c = counties.get(key) as { state: string; county: string };
    geos.push({ kind: "tract", state: c.state, county: c.county });
  }
  return geos;
}

export const COUNT_FIELDS = ["population", "households", "workers"] as const satisfies readonly CensusField[];
export const MEDIAN_FIELDS = ["median_age", "median_household_income"] as const satisfies readonly CensusField[];
export const COMMUTE_FIELDS = [
  "commute_drove_alone",
  "commute_public_transit",
  "commute_walked",
  "commute_bicycle",
  "commute_worked_from_home",
] as const satisfies readonly CensusField[];

export type CountField = (typeof COUNT_FIELDS)[number];
export type MedianField = (typeof MEDIAN_FIELDS)[number];
export type CommuteField = (typeof COMMUTE_FIELDS)[number];

export interface Rollup {
  /** Units asked for, and units Census returned a row for. */
  units: number;
  found: number;
  counts: Record<CountField, number | null>;
  medians: Record<MedianField, number | null>;
  /** Share of workers per mode, 0..1. */
  shares: Record<CommuteField, number | null>;
  /** Units whose value was withheld, per field: the sum or average leaves them out. */
  withheld: Partial<Record<CensusField, number>>;
}

/**
 * The rollup of one area's units. A unit Census returned no row for, or a withheld value, is left out
 * and counted in `withheld`; a field no unit holds is null. Units are deduplicated, so a ZIP area
 * named twice is counted once.
 */
export function rollUpUnits(unitIds: readonly string[], rows: ReadonlyMap<string, CensusRow>): Rollup {
  const ids = [...new Set(unitIds)];
  const found = ids.flatMap((id) => {
    const r = rows.get(id);
    return r === undefined ? [] : [r];
  });
  const withheld: Partial<Record<CensusField, number>> = {};
  const note = (field: CensusField) => {
    withheld[field] = (withheld[field] ?? 0) + 1;
  };
  const sum = (field: CensusField): number | null => {
    let total = 0;
    let any = false;
    for (const r of found) {
      const v = r.values[field];
      if (v === null || !Number.isFinite(v)) note(field);
      else {
        total += v;
        any = true;
      }
    }
    return any ? total : null;
  };
  const counts = { population: sum("population"), households: sum("households"), workers: sum("workers") };
  const weighted = (field: MedianField): number | null => {
    let num = 0;
    let den = 0;
    for (const r of found) {
      const m = r.values[field];
      const w = r.values.population;
      if (m === null || !Number.isFinite(m)) {
        note(field);
        continue;
      }
      if (w === null || !(w > 0)) continue;
      num += w * m;
      den += w;
    }
    return den > 0 ? num / den : null;
  };
  const medians = { median_age: weighted("median_age"), median_household_income: weighted("median_household_income") };
  const workers = counts.workers;
  const shares = Object.fromEntries(
    COMMUTE_FIELDS.map((f) => {
      const n = sum(f);
      return [f, n === null || workers === null || !(workers > 0) ? null : n / workers];
    }),
  ) as Record<CommuteField, number | null>;
  return { units: ids.length, found: found.length, counts, medians, shares, withheld };
}
