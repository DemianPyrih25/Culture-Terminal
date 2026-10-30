// local_supply over a fake OpenStreetMap API and an invented gazetteer (D29, Part 11 R6): counts, densities,
// the city index and its about-level band, mix, named places, findings, the floor flag and failures.
import {
  DatasetEnvelope,
  digestFits,
  Metric,
  ModelDigest,
  type GeoApi,
  type Neighbourhood,
  type OsmCountQuery,
  type OsmCounts,
  type OsmPlace,
  type OsmPlacesQuery,
  type PublicCallMeta,
  type PublicDataApi,
  type SupplyPayload,
} from "@ct/contracts";
import { osmCitySets, osmMetro, osmTenantTypes } from "@ct/publicdata/osm-config";
import { describe, expect, it } from "vitest";
import { localSupplySkill, osmPeriod, ringFromWkt } from "../../src/skills/localSupply";
import { fakeQloo, fakeRun, FETCHED_AT } from "./support/fakes";

const area = (id: string, name: string, areaKm2: number): Neighbourhood => ({ id, name, metro: "nashville", centroid: { lat: 36.15, lon: -86.78 }, areaKm2 });
const AREAS = [area("area_north", "Area North", 2), area("area_south", "Area South", 4)];

const GEO: GeoApi = {
  metros: () => ["nashville"],
  neighbourhoods: () => AREAS,
  neighbourhood: (m, id) => (m === "nashville" ? (AREAS.find((a) => a.id === id) ?? null) : null),
  matchNeighbourhood: () => null,
  polygonWkt: (_m, id) => (id === "area_north" ? "POLYGON((-86.80 36.10,-86.70 36.10,-86.70 36.20,-86.80 36.10))" : null),
  locate: () => null,
  geohashCentroid: () => ({ lat: 0, lon: 0 }),
  boundarySource: () => "Invented test gazetteer",
};

class PublicDataError extends Error {
  override name = "PublicDataError";
  constructor(readonly code: string) {
    super(code);
  }
}

const meta = (n: number, stale = false): PublicCallMeta => ({
  publicCallId: `pc-${n}`,
  source: "osm",
  endpoint: "/api/interpreter",
  reference: "osm-2026-01-01T00:00:00Z",
  cache: "miss",
  fetchedAt: FETCHED_AT,
  ms: 3,
  stale,
  originRunId: null,
});

interface FakeOsm extends PublicDataApi {
  counted: OsmCountQuery[];
  named: OsmPlacesQuery[];
}

/**
 * Invented counts: every area shape has `perArea[type]` places (default 4), the city reference
 * `cityPerKm2[type] × landKm2` (default 2 per km²), activity 40 in an area and 10 per km² in the city.
 */
function osm(options: { perArea?: Record<string, number>; cityPerKm2?: Record<string, number>; failCounts?: string; failCity?: boolean; stale?: boolean } = {}): FakeOsm {
  const counted: OsmCountQuery[] = [];
  const named: OsmPlacesQuery[] = [];
  const land = osmMetro("nashville")?.landKm2 ?? 1000;
  return {
    counted,
    named,
    secTicker: async () => {
      throw new Error("unused");
    },
    secCompanyFacts: async () => {
      throw new Error("unused");
    },
    censusAcs: async () => {
      throw new Error("unused");
    },
    osmCounts: async (q) => {
      counted.push(q);
      const isCity = q.shapes.some((s) => s.kind === "admin");
      if (isCity && options.failCity) throw new PublicDataError("unavailable");
      if (!isCity && options.failCounts) throw new PublicDataError(options.failCounts);
      const counts: OsmCounts["counts"] = Object.fromEntries(
        q.shapes.map((s) => [
          s.id,
          Object.fromEntries(
            q.types.map((t) => [
              t.key,
              isCity
                ? Math.round((t.key === "activity" ? 10 : (options.cityPerKm2?.[t.key] ?? 2)) * land)
                : t.key === "activity"
                  ? 40
                  : (options.perArea?.[t.key] ?? 4),
            ]),
          ),
        ]),
      );
      return { data: { counts, osmBase: "2026-01-01T00:00:00Z" }, meta: meta(counted.length, options.stale) };
    },
    osmPlaces: async (q) => {
      named.push(q);
      const places: OsmPlace[] = [
        { name: "Example Cafe 1", brand: null, lat: 36.15, lon: -86.75, typeKey: q.types[0]?.key ?? "cafe", osmType: "node", osmId: 9000000001 },
        { name: "Example Cafe 2", brand: "Example Brand", lat: 36.16, lon: -86.76, typeKey: q.types[0]?.key ?? "cafe", osmType: "way", osmId: 9000000002 },
      ];
      return { data: places, meta: meta(100 + named.length) };
    },
  };
}

function setup(api: FakeOsm | null = osm()) {
  const run = fakeRun(fakeQloo().api);
  return { ...run, api, ctx: { ...run.ctx, geo: GEO, publicdata: api, pillar: "location" as const } };
}

const input = (over: Partial<{ metro: string | null; areas: string[]; market: string | null; place_types: string[]; mix: boolean; list_places: boolean }> = {}) =>
  localSupplySkill.input.parse({ metro: "nashville", areas: ["area_north", "area_south"], market: null, place_types: ["cafe"], mix: false, list_places: false, trigger_finding_id: null, step_id: "S7", ...over });

const supplyOf = (ds: readonly DatasetEnvelope[]): SupplyPayload => {
  const d = ds.find((x) => x.kind === "Supply");
  expect(d).toBeDefined();
  return (d as Extract<DatasetEnvelope, { kind: "Supply" }>).payload;
};

describe("local_supply helpers", () => {
  it("reads a WKT outer ring as [lat, lon] and names the period", () => {
    expect(ringFromWkt("POLYGON((-86.8 36.1,-86.7 36.1,-86.7 36.2,-86.8 36.1))")).toEqual([
      [36.1, -86.8],
      [36.1, -86.7],
      [36.2, -86.7],
      [36.1, -86.8],
    ]);
    expect(ringFromWkt("POINT(1 2)")).toBeNull();
    expect(osmPeriod("2026-01-01T00:00:00Z")).toBe("OpenStreetMap data as of 2026-01-01");
  });
});

describe("local_supply", () => {
  it("counts areas against the city with period tokens, the floor flag and a valid Supply dataset", async () => {
    const run = setup(osm({ perArea: { cafe: 8 } }));
    const result = await localSupplySkill.run(input(), run.ctx);
    expect(result.status).toBe("ok");
    expect(result.flags).toContain("OSM_SUPPLY_FLOOR");
    expect(run.ledger.evidences[0]?.source).toBe("osm");
    for (const m of run.ledger.metrics) Metric.parse(m);
    expect(run.ledger.metrics.every((m) => m.period === "OpenStreetMap data as of 2026-01-01")).toBe(true);
    const p = supplyOf(run.ledger.datasets);
    expect(p.attribution).toBe("© OpenStreetMap contributors");
    expect(p.rows.map((r) => r.id)).toEqual(["area_north", "area_south"]);
    // 8 cafés in 2 km² = 4 per km², city 2 per km²: index 2; in 4 km², 2 per km² = about the city's level.
    expect(p.rows[0]?.perKm2.cafe).toBe(4);
    expect(p.rows[0]?.index.cafe).toBe(2);
    expect(p.rows[1]?.index.cafe).toBe(1);
    const southIndex = run.ledger.metrics.find((m) => m.key === "osm.density_index.cafe" && m.subjectRefs[0] === "area_south");
    expect(southIndex?.level).toBe("about_level");
    expect(southIndex?.display).toMatch(/about the city's level/);
    const northIndex = run.ledger.metrics.find((m) => m.key === "osm.density_index.cafe" && m.subjectRefs[0] === "area_north");
    expect(northIndex?.level).toBeUndefined();
    // Area North has 2× the city's cafés with 8 places, but its street activity is 2× the city's too: the same
    // share of its places, so not OVERSUPPLIED (a denser street, not too many cafés).
    expect(run.ledger.findings.map((f) => f.kind)).not.toContain("OVERSUPPLIED");
    // Area polygon used where the gazetteer has one; a circle of the same size otherwise.
    expect(run.api?.counted[0]?.shapes.map((s) => s.kind)).toEqual(["poly", "around"]);
    expect(result.forModel.notices.join(" ")).toMatch(/circle of the same size/);
    expect(digestFits(ModelDigest.parse(result.forModel), { tool: "local_supply", step: "S7" })).toBe(true);
  });

  it("calls a type oversupplied only beyond the area's own street activity, and cites both", async () => {
    // 12 cafés in 2 km² = 6 per km²: 3× the city, against street activity at 2× (40 in 2 km², city 10 per km²).
    const run = setup(osm({ perArea: { cafe: 12 } }));
    await localSupplySkill.run(input(), run.ctx);
    const over = run.ledger.findings.find((f) => f.kind === "OVERSUPPLIED");
    expect(over?.text).toMatch(/3\.0 times the city's density against 2\.0 times for all its shops and food and drink places/);
    const cited = over?.metricIds.map((id) => run.ledger.metrics.find((m) => m.id === id)?.key);
    expect(cited).toContain("osm.density_index.cafe");
    expect(cited).toContain("osm.activity_density");
  });

  it("reads the city reference in the fixed sets the warm-up caches", async () => {
    const run = setup();
    await localSupplySkill.run(input(), run.ctx);
    const cityQueries = run.api?.counted.filter((q) => q.shapes.some((s) => s.kind === "admin")) ?? [];
    expect(cityQueries.length).toBeGreaterThanOrEqual(1);
    const setKeys = osmCitySets().map((s) => s.types.map((t) => t.key).join(","));
    for (const q of cityQueries) expect(setKeys).toContain(q.types.map((t) => t.key).join(","));
  });

  it("answers mix with what the area has more and less of, and lists names of asked types only", async () => {
    const tenant = osmTenantTypes().map((t) => t.key);
    const [over, under] = tenant;
    const run = setup(osm({ perArea: { [over as string]: 20, [under as string]: 0 } }));
    const result = await localSupplySkill.run(input({ areas: ["area_north"], place_types: [], mix: true, list_places: true }), run.ctx);
    const p = supplyOf(run.ledger.datasets);
    expect(p.mix?.over.map((m) => m.typeKey)).toContain(over);
    expect(p.mix?.under.map((m) => m.typeKey)).toContain(under);
    expect(p.places).toEqual([]);
    expect(run.api?.named).toEqual([]);
    expect(result.forModel.notices.join(" ")).toMatch(/has more than the city of/);
  });

  it("lists named places with OpenStreetMap links, never their names in the digest", async () => {
    const run = setup();
    const result = await localSupplySkill.run(input({ list_places: true }), run.ctx);
    const p = supplyOf(run.ledger.datasets);
    expect(p.places.map((x) => x.osmUrl)).toEqual(["https://www.openstreetmap.org/node/9000000001", "https://www.openstreetmap.org/way/9000000002"]);
    expect(JSON.stringify(result.forModel)).not.toContain("Example Cafe");
    expect(result.forModel.notices.join(" ")).toMatch(/2 named places are listed/);
  });

  it("reads a market as a circle with no city index", async () => {
    const run = setup();
    const result = await localSupplySkill.run(input({ metro: null, areas: [], market: "nashville" }), run.ctx);
    expect(result.status).toBe("ok");
    const p = supplyOf(run.ledger.datasets);
    expect(p.scope).toBe("market");
    expect(p.radiusKm).toBe(5);
    expect(p.city).toBeNull();
    expect(p.rows[0]?.index.cafe).toBeNull();
    expect(run.api?.counted[0]?.shapes[0]).toMatchObject({ kind: "around", radiusM: 5000 });
  });

  it("refuses an unknown place type with the valid keys", async () => {
    const run = setup();
    const result = await localSupplySkill.run(input({ place_types: ["not_a_type"] }), run.ctx);
    expect(result.status).toBe("error");
    expect(result.forModel.notices.join(" ")).toMatch(/INVALID_INPUT.*cafe/);
    expect(run.api?.counted).toEqual([]);
  });

  it("is honest when OpenStreetMap is missing, failing or partly failing", async () => {
    expect((await localSupplySkill.run(input(), setup(null).ctx)).status).toBe("error");
    const failed = setup(osm({ failCounts: "not_configured" }));
    const r1 = await localSupplySkill.run(input(), failed.ctx);
    expect(r1.status).toBe("error");
    expect(r1.forModel.notices.join(" ")).toMatch(/OpenStreetMap is not configured/);
    expect(failed.ledger.metrics).toEqual([]);
    const noCity = setup(osm({ failCity: true }));
    const r2 = await localSupplySkill.run(input(), noCity.ctx);
    expect(r2.status).toBe("partial");
    expect(supplyOf(noCity.ledger.datasets).city).toBeNull();
    expect(noCity.ledger.findings).toEqual([]);
    const stale = setup(osm({ stale: true }));
    expect((await localSupplySkill.run(input(), stale.ctx)).flags).toContain("STALE_CACHE");
  });

  it("marks rows the question named (R3)", async () => {
    const run = setup();
    const ctx = { ...run.ctx, candidates: { entities: [], markets: [], areas: [{ metro: "nashville" as const, id: "area_south", source: "user_named" as const }] } };
    await localSupplySkill.run(input(), ctx);
    const p = supplyOf(run.ledger.datasets);
    expect(p.rows.find((r) => r.id === "area_south")?.source).toBe("user_named");
    expect(p.rows.find((r) => r.id === "area_north")?.source).toBeUndefined();
  });
});
