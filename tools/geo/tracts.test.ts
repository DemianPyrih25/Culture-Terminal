// The census crosswalk build (tools/geo/tracts.ts) on invented areas, tracts and ZCTAs, no Census data
// (D29): parsing both Census files (BOM, trailing blanks), assigning tracts by interior point, water-only
// and outside tracts dropped, the stand-in tract for an area holding none, ZIP clip shares with merged
// ZCTAs, and both data modules loading back as the tables they were written from.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import type { TractCrosswalk, ZctaClipTable } from "../../packages/geo/src/census";
import type { GazetteerCatalog } from "../../packages/geo/src/gazetteer";
import type { Shape } from "./build";
import {
  assignTracts,
  nearestTracts,
  readTable,
  readTractGazetteer,
  readZctaCountyRelation,
  tractModuleText,
  TRACT_SOURCE,
  zctaClipModuleText,
  zctaClipShares,
  type TractPoint,
} from "./tracts";

const rect = (w: number, s: number, e: number, n: number): Shape => ({
  type: "Polygon",
  coordinates: [
    [
      [w, s],
      [e, s],
      [e, n],
      [w, n],
      [w, s],
    ],
  ],
});

/** Two areas side by side and a small one, east of them, too small to hold a tract point. */
const AREAS = [
  { id: "west_fixture", geometry: rect(-100, 40, -99.95, 40.05) },
  { id: "east_fixture", geometry: rect(-99.95, 40, -99.9, 40.05) },
  { id: "pocket_fixture", geometry: rect(-99.89, 40.02, -99.885, 40.025) },
];

const tract = (geoid: string, lon: number, lat: number, aland = 1_000_000): TractPoint => ({ geoid, lat, lon, aland });

const TRACTS: readonly TractPoint[] = [
  tract("99001000100", -99.99, 40.01),
  tract("99001000200", -99.96, 40.04),
  // On the shared edge: the first area in order takes it.
  tract("99001000300", -99.95, 40.02),
  tract("99003000100", -99.92, 40.03),
  // Water-only, inside the east area.
  tract("99003990000", -99.93, 40.01, 0),
  // Between the areas and the pocket: in no area, the pocket's nearest.
  tract("99003000200", -99.893, 40.023),
  // Far outside every area's box.
  tract("99005000100", -98, 41),
];

describe("the tract build", () => {
  it("reads the Gazetteer tract file, BOM and trailing blanks included", () => {
    const text = "\uFEFFUSPS\tGEOID\tALAND\tAWATER\tALAND_SQMI\tAWATER_SQMI\tINTPTLAT\tINTPTLONG   \r\nZZ\t99001000100\t1000\t0\t0.1\t0\t40.01\t-99.99      \r\n";
    expect(readTractGazetteer(text)).toEqual([{ geoid: "99001000100", lat: 40.01, lon: -99.99, aland: 1000 }]);
    expect(() => readTractGazetteer("GEOID\tALAND\tINTPTLAT\tINTPTLONG\n9900100\t1\t40\t-99\n")).toThrow(/11-digit/);
    expect(readTable("a|b\n1|2\n\n", "|")).toEqual([{ a: "1", b: "2" }]);
  });

  it("assigns each tract with land to the area holding its interior point, and reports the rest", () => {
    const report: string[] = [];
    const assigned = assignTracts(AREAS, TRACTS, report);
    expect(assigned).toEqual({
      west_fixture: ["99001000100", "99001000200", "99001000300"],
      east_fixture: ["99003000100"],
    });
    expect(report).toContain("6 tracts near the areas: 4 assigned, 1 with their point in no area, 1 water-only");
    expect(report).toContain("no tract: pocket_fixture holds no tract interior point");
  });

  it("stands the nearest tract in for an area holding none, within the distance limit", () => {
    const assigned = assignTracts(AREAS, TRACTS, []);
    const report: string[] = [];
    expect(nearestTracts(AREAS, assigned, TRACTS, report)).toEqual({ pocket_fixture: "99003000200" });
    expect(report.some((l) => l.startsWith("nearest: pocket_fixture stands in tract 99003000200,"))).toBe(true);
    // With that tract gone, the next point is over 2 km away: reported, no stand-in.
    const far: string[] = [];
    expect(nearestTracts(AREAS, assigned, TRACTS.filter((t) => t.geoid !== "99003000200"), far)).toEqual({});
    expect(far).toEqual(["unreported: pocket_fixture has no tract point within 2 km"]);
  });

  it("writes a module that loads back as the table", async () => {
    const table: TractCrosswalk = { metro: "austin", source: TRACT_SOURCE, areas: { west_fixture: ["99001000100"] }, nearest: { pocket_fixture: "99003000200" } };
    const loaded = await loadModule<TractCrosswalk>(tractModuleText(table), "AUSTIN_TRACTS");
    expect(loaded).toEqual(table);
    expect(tractModuleText({ ...table, nearest: {} })).not.toMatch(/nearest/);
  });
});

/** An invented ZIP-area city: ZCTA 00012 has 00016 merged in, 00013 crosses into a county left out. */
const CATALOG: GazetteerCatalog = {
  nashville: {
    source: "fixture",
    areas: [
      { id: "zcta_00011", name: "ZIP 00011", aliases: ["ZIP 00011", "00011"], centroid: { lat: 40, lon: -100 }, areaKm2: 5 },
      { id: "zcta_00012", name: "ZIP 00012", aliases: ["ZIP 00012", "00012", "ZIP 00016", "00016"], centroid: { lat: 40, lon: -100 }, areaKm2: 5 },
      { id: "zcta_00013", name: "ZIP 00013 (Fixture part)", aliases: ["ZIP 00013", "00013"], centroid: { lat: 40, lon: -100 }, areaKm2: 5 },
    ],
  },
};

const RELATION = [
  "\uFEFFOID_ZCTA5_20|GEOID_ZCTA5_20|NAMELSAD_ZCTA5_20|AREALAND_ZCTA5_20|AREAWATER_ZCTA5_20|GEOID_COUNTY_20|AREALAND_PART|AREAWATER_PART",
  // A county part outside every ZCTA.
  "||||||99001|500|0",
  "1|00011|ZCTA5 00011|1000|0|99001|1000|0",
  "2|00012|ZCTA5 00012|900|0|99001|900|0",
  // The merged ZCTA lies mostly outside: together 900 + 20 of 1000 inside.
  "3|00016|ZCTA5 00016|100|0|99001|20|0",
  "3|00016|ZCTA5 00016|100|0|99009|80|0",
  "4|00013|ZCTA5 00013|1000|0|99001|300|0",
  "4|00013|ZCTA5 00013|1000|0|99009|700|0",
].join("\r\n");

describe("the ZIP clip build", () => {
  it("lists each ZIP area under 99% inside its city's counties, merged ZCTAs counted", () => {
    const relation = readZctaCountyRelation(RELATION);
    expect(relation.get("00016")?.byCounty).toEqual(
      new Map([
        ["99001", 20],
        ["99009", 80],
      ]),
    );
    const report: string[] = [];
    const shares = zctaClipShares(CATALOG, { nashville: ["99001"] }, relation, report);
    expect(shares).toEqual({ nashville: { zcta_00012: 92, zcta_00013: 30 } });
    expect(report).toEqual(["nashville: 2 of 3 ZIP areas under 99% inside"]);
  });

  it("refuses a ZIP-area city without clip counties, or a ZCTA the file lacks", () => {
    const relation = readZctaCountyRelation(RELATION);
    expect(() => zctaClipShares(CATALOG, {}, relation, [])).toThrow(/no clip counties/);
    relation.delete("00016");
    expect(() => zctaClipShares(CATALOG, { nashville: ["99001"] }, relation, [])).toThrow(/00016/);
  });

  it("writes a module that loads back as the table", async () => {
    const inside = { nashville: { zcta_00012: 92, zcta_00013: 30 } };
    const loaded = await loadModule<ZctaClipTable>(zctaClipModuleText(inside), "ZCTA_CLIP");
    expect(loaded.inside).toEqual(inside);
    expect(loaded.source).toMatch(/public domain/);
  });
});

async function loadModule<T>(text: string, name: string): Promise<T> {
  const dir = mkdtempSync(path.join(tmpdir(), "ct-tracts-"));
  try {
    const file = path.join(dir, "fixture.ts");
    writeFileSync(file, text, "utf8");
    return ((await import(pathToFileURL(file).href)) as Record<string, T>)[name] as T;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
