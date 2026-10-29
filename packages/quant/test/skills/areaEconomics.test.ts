// area_economics over a fake Census API and an invented crosswalk (D29): a weighted rollup golden,
// the whole-city comparator, clipped ZIP areas, withheld values and failures.
import {
  DatasetEnvelope,
  digestFits,
  Metric,
  ModelDigest,
  PUBLIC_DATA_NOTICE,
  type CensusField,
  type CensusGeo,
  type CensusRow,
  type GeoApi,
  type MetroId,
  type Neighbourhood,
  type PublicDataApi,
} from "@ct/contracts";
import { describe, expect, it } from "vitest";
import { areaEconomicsSkill, fieldsPerSubject, MAX_ECON_METRICS, vintageText } from "../../src/skills/areaEconomics";
import { censusGeosOf, rollUpUnits, type AreaCensusUnits } from "../../src/skills/areaEconomics/rollup";
import { fakeQloo, fakeRun, FETCHED_AT } from "./support/fakes";

function censusRow(geoId: string, v: Partial<Record<CensusField, number | null>>): CensusRow {
  const base: Record<CensusField, number | null> = {
    population: null,
    median_age: null,
    households: null,
    median_household_income: null,
    workers: null,
    commute_drove_alone: null,
    commute_public_transit: null,
    commute_walked: null,
    commute_bicycle: null,
    commute_worked_from_home: null,
  };
  return { geoId, values: { ...base, ...v } };
}

// Invented ZCTAs 00001..00004 (no real ZIP is an all-zero code).
const ROWS = [
  censusRow("00001", { population: 1000, median_age: 30, households: 400, median_household_income: 50000, workers: 500, commute_drove_alone: 300, commute_public_transit: 100, commute_walked: 50, commute_bicycle: 10, commute_worked_from_home: 40 }),
  censusRow("00002", { population: 3000, median_age: 40, households: 1200, median_household_income: 90000, workers: 1500, commute_drove_alone: 1200, commute_public_transit: 100, commute_walked: 50, commute_bicycle: 0, commute_worked_from_home: 150 }),
  censusRow("00003", { population: 2000, median_age: 35, households: 900, median_household_income: null, workers: 1000, commute_drove_alone: 600, commute_public_transit: 200, commute_walked: 100, commute_bicycle: 20, commute_worked_from_home: 80 }),
  censusRow("00004", { population: 0, median_age: null, households: 0, median_household_income: null, workers: 0, commute_drove_alone: 0, commute_public_transit: 0, commute_walked: 0, commute_bicycle: 0, commute_worked_from_home: 0 }),
];
const byId = new Map(ROWS.map((r) => [r.geoId, r]));

const area = (id: string, name: string): Neighbourhood => ({ id, name, metro: "nashville", centroid: { lat: 36, lon: -86 }, areaKm2: 3 });
const AREAS = [area("zcta_00001", "ZIP 00001"), area("zcta_00002", "Hilltop"), area("zcta_00003", "Mill Town (00003 part)"), area("zcta_00004", "Airport")];
const UNITS: Record<string, AreaCensusUnits> = {
  zcta_00001: { kind: "zcta", metro: "nashville", areaId: "zcta_00001", zctas: ["00001"], clipped: false, insidePct: null },
  // Hilltop merges two ZIPs (an alias), so its medians are a weighted average.
  zcta_00002: { kind: "zcta", metro: "nashville", areaId: "zcta_00002", zctas: ["00002", "00001"], clipped: false, insidePct: null },
  zcta_00003: { kind: "zcta", metro: "nashville", areaId: "zcta_00003", zctas: ["00003"], clipped: true, insidePct: 60 },
  zcta_00004: { kind: "zcta", metro: "nashville", areaId: "zcta_00004", zctas: ["00004"], clipped: false, insidePct: null },
};

const GEO: GeoApi & { censusUnits(m: MetroId, id: string): Promise<AreaCensusUnits | null>; censusUnitsOfMetro(m: MetroId): Promise<AreaCensusUnits[]> } = {
  metros: () => ["nashville"],
  neighbourhoods: (m) => (m === "nashville" ? AREAS : []),
  neighbourhood: (m, id) => (m === "nashville" ? (AREAS.find((a) => a.id === id) ?? null) : null),
  matchNeighbourhood: () => null,
  polygonWkt: () => null,
  locate: () => null,
  geohashCentroid: () => ({ lat: 0, lon: 0 }),
  boundarySource: () => "Invented test gazetteer",
  censusUnits: async (_m, id) => UNITS[id] ?? null,
  censusUnitsOfMetro: async () => Object.values(UNITS),
};

class PublicDataError extends Error {
  override name = "PublicDataError";
  constructor(readonly code: string) {
    super(code);
  }
}

function census(options: { fail?: string } = {}): PublicDataApi & { asked: CensusGeo[] } {
  const asked: CensusGeo[] = [];
  return {
    asked,
    secTicker: async () => {
      throw new Error("unused");
    },
    secCompanyFacts: async () => {
      throw new Error("unused");
    },
    censusAcs: async (geo) => {
      asked.push(geo);
      if (options.fail) throw new PublicDataError(options.fail);
      const ids = geo.kind === "zcta" ? geo.zctas : [];
      return {
        data: { vintage: 2023, dataset: "acs/acs5", rows: ids.flatMap((id) => (byId.has(id) ? [byId.get(id) as CensusRow] : [])) },
        meta: {
          publicCallId: `pc-${asked.length}`,
          source: "census",
          endpoint: "/data/acs/acs5",
          reference: `acs5 2023 zcta ${ids.join(",")}`,
          cache: "miss",
          fetchedAt: FETCHED_AT,
          ms: 4,
          stale: false,
          originRunId: null,
        },
      };
    },
  };
}

function setup(api: PublicDataApi | null = census(), geo: GeoApi = GEO) {
  const run = fakeRun(fakeQloo().api);
  return { ...run, api, ctx: { ...run.ctx, geo, publicdata: api, pillar: "location" as const } };
}

const input = (areas: string[]) => areaEconomicsSkill.input.parse({ metro: "nashville", areas, trigger_finding_id: null, step_id: "S6" });

describe("census rollup", () => {
  it("sums counts and weights unit medians by population", () => {
    const r = rollUpUnits(["00002", "00001", "00001"], byId);
    expect(r.units).toBe(2);
    expect(r.counts).toEqual({ population: 4000, households: 1600, workers: 2000 });
    // (3000·40 + 1000·30) / 4000 and (3000·90000 + 1000·50000) / 4000.
    expect(r.medians.median_age).toBeCloseTo(37.5, 10);
    expect(r.medians.median_household_income).toBeCloseTo(80000, 10);
    expect(r.shares.commute_drove_alone).toBeCloseTo(1500 / 2000, 10);
    expect(r.withheld).toEqual({});
  });

  it("leaves withheld values and missing units out, and says so", () => {
    const r = rollUpUnits(["00001", "00003", "09999"], byId);
    expect(r.found).toBe(2);
    expect(r.medians.median_household_income).toBe(50000);
    expect(r.withheld.median_household_income).toBe(1);
    const empty = rollUpUnits(["00004"], byId);
    expect(empty.medians.median_age).toBeNull();
    expect(empty.shares.commute_walked).toBeNull();
  });

  it("asks one ZCTA list for the city and one request per county for tracts", () => {
    const tract: AreaCensusUnits = { kind: "tract", metro: "nyc", areaId: "x", tracts: ["36047000100"], nearestOnly: false, counties: [{ state: "36", county: "047" }] };
    expect(censusGeosOf([UNITS.zcta_00002 as AreaCensusUnits, UNITS.zcta_00001 as AreaCensusUnits, tract])).toEqual([
      { kind: "zcta", zctas: ["00001", "00002"] },
      { kind: "tract", state: "36", county: "047" },
    ]);
  });

  it("shrinks the fields per row so the metric count stays bounded", () => {
    expect(fieldsPerSubject(2)).toBe(9);
    expect(fieldsPerSubject(13)).toBe(2);
    for (let s = 1; s <= 13; s++) expect(fieldsPerSubject(s) * s).toBeLessThanOrEqual(Math.max(MAX_ECON_METRICS, 2 * s));
    expect(vintageText(2023)).toBe("ACS 2019-2023 5-year");
  });
});

describe("area_economics", () => {
  it("rolls areas up with the city row, period tokens and the residents-only flag", async () => {
    const run = setup();
    const result = await areaEconomicsSkill.run(input(["zcta_00002", "zcta_00003"]), run.ctx);
    // One ACS request covers every ZCTA of the city.
    expect((run.api as ReturnType<typeof census>).asked).toEqual([{ kind: "zcta", zctas: ["00001", "00002", "00003", "00004"] }]);
    expect(result.flags).toContain("CENSUS_RESIDENTS_ONLY");
    expect(run.ledger.evidences[0]?.source).toBe("census");

    for (const m of run.ledger.metrics) Metric.parse(m);
    expect(run.ledger.metrics.every((m) => m.period === "ACS 2019-2023 5-year")).toBe(true);
    const income = run.ledger.metrics.filter((m) => m.key === "econ.median_hh_income");
    expect(income.map((m) => [m.subjectRefs[0], m.value, m.badge, m.display])).toEqual([
      ["zcta_00002", 80000, "ESTIMATED", "$80,000 (approx.)"],
      // The clipped ZIP's own median is withheld: not measured, never 0.
      ["zcta_00003", null, "UNAVAILABLE", "not measured"],
      // The city's units include the clipped ZIP, so the city row is its whole ZIPs and says so.
      ["nashville", 80000, "ESTIMATED", "$80,000 (approx., whole ZIPs)"],
    ]);
    const pop = run.ledger.metrics.filter((m) => m.key === "econ.population");
    expect(pop.map((m) => [m.value, m.badge, m.comparator])).toEqual([
      [4000, "DERIVED", "CITY"],
      [2000, "ESTIMATED", "CITY"],
      [6000, "ESTIMATED", null],
    ]);
    expect(pop.map((m) => m.display)).toEqual(["4,000 residents", "2,000 residents (whole ZIP)", "6,000 residents (whole ZIPs)"]);
    expect(pop[2]?.label).toContain("ZIP areas (whole ZIPs)");

    const table = run.ledger.datasets[0];
    if (table?.kind !== "Ranked") throw new Error("expected the economics table");
    DatasetEnvelope.parse(table);
    expect(table.payload.groups.map((g) => g.rows.map((r) => r.key))).toEqual([["zcta_00002", "zcta_00003"], ["nashville"]]);
    expect(table.payload.groups[0]?.rows[1]?.sublabel).toContain("whole-ZIP figures");

    const digest = ModelDigest.parse(result.forModel);
    expect(digest._data_notice).toBe(PUBLIC_DATA_NOTICE);
    expect(digestFits(digest, { tool: "area_economics", step: "S6" })).toBe(true);
    expect(digest.notices.join(" ")).toContain("Mill Town (00003 part): the area is part of its ZIP area");
  });

  it("fits the digest with twelve areas", async () => {
    const many: Neighbourhood[] = Array.from({ length: 12 }, (_, i) => area(`zcta_1${String(i).padStart(4, "0")}`, `Invented Area Number ${i + 1}`));
    const units = Object.fromEntries(many.map((a, i) => [a.id, { kind: "zcta", metro: "nashville", areaId: a.id, zctas: [`0000${(i % 3) + 1}`], clipped: false, insidePct: null } as AreaCensusUnits]));
    const geo = { ...GEO, neighbourhoods: () => many, neighbourhood: (_m: MetroId, id: string) => many.find((a) => a.id === id) ?? null, censusUnits: async (_m: MetroId, id: string) => units[id] ?? null, censusUnitsOfMetro: async () => Object.values(units) };
    const run = setup(census(), geo);
    const result = await areaEconomicsSkill.run(input(many.map((a) => a.id)), run.ctx);
    expect(run.ledger.metrics).toHaveLength(13 * 2);
    expect(digestFits(ModelDigest.parse(result.forModel), { tool: "area_economics", step: "S6" })).toBe(true);
  });

  it("says plainly when the Census API fails or public data is off, and estimates nothing", async () => {
    const run = setup(census({ fail: "unavailable" }));
    const result = await areaEconomicsSkill.run(input(["zcta_00001"]), run.ctx);
    expect(result.status).toBe("error");
    expect(result.forModel.notices.join(" ")).toContain("the Census API could not be reached");
    expect(run.ledger.metrics).toHaveLength(0);
    const off = setup(null);
    expect((await areaEconomicsSkill.run(input(["zcta_00001"]), off.ctx)).status).toBe("error");
    const noCrosswalk = setup(census(), { ...GEO, censusUnits: undefined, censusUnitsOfMetro: undefined } as unknown as GeoApi);
    expect((await areaEconomicsSkill.run(input(["zcta_00001"]), noCrosswalk.ctx)).forModel.notices[0]).toContain("no Census crosswalk");
  });
});
