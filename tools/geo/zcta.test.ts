// The ZCTA build (tools/geo/zcta.ts) on an invented metro: made-up counties, ZIP codes and shapes, no
// Census data (D29). Clipping to the counties, part labels, a skipped sliver, a tiny area merged into its
// longest-border neighbour, approximate names, query rings within the WKT budget, the data module, and
// lookups through createGeo, cells outside every ZIP area included.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { createGeo, GAZETTEER_CATALOG, MAX_WKT_VERTICES, type Gazetteer } from "../../packages/geo/src/index";
import { edgesOf, overlapProblem, polygonsOf, ringProblem, signedArea } from "../../packages/geo/test/validity";
import { moduleText, type BuiltArea, type Shape } from "./build";
import { buildZcta, countyGeoid, partLabelOf, tigerwebZctaQuery, zctaSpec, type Feature, type ZctaInput } from "./zcta";

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

/** A many-sided ring, to exercise the 40-point query budget. */
const circle = (lon: number, lat: number, r: number, sides: number): Shape => {
  const ring = Array.from({ length: sides }, (_, i) => [lon + r * Math.cos((2 * Math.PI * i) / sides), lat + r * Math.sin((2 * Math.PI * i) / sides)]);
  return { type: "Polygon", coordinates: [[...ring, ring[0] as number[]]] };
};

const county = (geoid: string, geometry: Shape): Feature => ({ properties: { GEOID: geoid }, geometry });
const zcta = (code: string, geometry: Shape, field = "ZCTA5"): Feature => ({ properties: { [field]: code }, geometry });

/** Two selected counties side by side and a third, east of them, that the metro leaves out. */
const COUNTIES: readonly Feature[] = [county("99001", rect(-100, 40, -99.9, 40.08)), county("99003", rect(-99.9, 40, -99.85, 40.08)), county("99005", rect(-99.85, 40, -99.8, 40.08))];

const ZCTAS: readonly Feature[] = [
  zcta("00011", rect(-100, 40, -99.96, 40.04)),
  // Across the line between the two selected counties, in the TIGER/Line field.
  zcta("00012", rect(-99.96, 40, -99.88, 40.04), "ZCTA5CE20"),
  // Half outside the metro's west edge.
  zcta("00013", rect(-100.03, 40.04, -99.97, 40.08)),
  // Mostly in the left-out county: under 1 km² inside.
  zcta("00014", rect(-99.855, 40.06, -99.81, 40.08)),
  // Wholly in the left-out county.
  zcta("00015", rect(-99.84, 40, -99.81, 40.04)),
  // Tiny, overlapping 00011's corner and abutting 00012: its overlap goes to it, then it merges back.
  zcta("00016", rect(-99.962, 40.01, -99.96, 40.013)),
  zcta("00017", circle(-99.93, 40.06, 0.012, 120)),
];

const INPUT: ZctaInput = { label: "Fixture County", counties: COUNTIES, countyGeoids: ["99001", "99003"], zctas: ZCTAS, aliases: { "00017": ["Maple Hollow"] } };

describe("the ZCTA build", () => {
  const report: string[] = [];
  let built: BuiltArea[] = [];
  let gazetteer: Gazetteer;

  beforeAll(async () => {
    built = await buildZcta(INPUT, report);
    // createGeo serves MetroId metros only, so the invented metro is read under a stand-in id.
    gazetteer = { metro: "nashville", source: zctaSpec("fixture", INPUT.label, true).source, areas: built };
  });

  it("keeps the ZIP areas inside the counties, labels a part, and reports what it left out and merged", () => {
    expect(built.map((b) => [b.id, b.name])).toEqual([
      ["zcta_00011", "ZIP 00011"],
      ["zcta_00012", "ZIP 00012"],
      ["zcta_00013", "ZIP 00013 (Fixture part)"],
      ["zcta_00017", "ZIP 00017 (Maple Hollow)"],
    ]);
    expect(report).toContain("00015: nothing left inside the clip outline, left out");
    expect(report.some((line) => line.startsWith("zcta: skipped 00014,"))).toBe(true);
    expect(report).toContain("zcta: 00013 clipped to Fixture County, 50% kept");
    expect(report.some((line) => /^tiny: merged 00016 \(0\.0\d+ km2\) into 00011/.test(line))).toBe(true);
  });

  it("gives every area its ZIP as exact aliases, a merged ZIP's too, and the approximate name as approximate", () => {
    const byId = new Map(built.map((b) => [b.id, b]));
    // "ZIP 00011" is the display name already, so it is no alias; "ZIP 00013" is one beside its bracketed name.
    expect(byId.get("zcta_00011")?.aliases).toEqual(["00011", "ZIP 00016", "00016"]);
    expect(byId.get("zcta_00012")?.aliases).toEqual(["00012"]);
    expect(byId.get("zcta_00013")?.aliases).toEqual(["ZIP 00013", "00013"]);
    expect(byId.get("zcta_00017")?.approximateAliases).toEqual(["Maple Hollow"]);
    expect(built.flatMap((b) => b.approximateAliases)).toEqual(["Maple Hollow"]);
  });

  it("clips at the county line and restores the merged corner", () => {
    const byId = new Map(built.map((b) => [b.id, b]));
    // 0.04° by 0.04° at 40°N is about 3.41 km by 4.44 km; the part of 00013 inside is three quarters of that.
    expect(byId.get("zcta_00011")?.areaKm2).toBeCloseTo(15.15, 1);
    expect(byId.get("zcta_00013")?.areaKm2).toBeCloseTo(11.36, 1);
    expect(byId.get("zcta_00011")?.geometry.type).toBe("Polygon");
  });

  it("writes valid rings, no overlaps, and query rings within the WKT budget", () => {
    for (const b of built) {
      for (const poly of polygonsOf(b.geometry)) {
        poly.forEach((ring, k) => {
          expect(ringProblem(ring), `${b.id} ring ${k}`).toBeNull();
          expect(Math.sign(signedArea(ring)), `${b.id} ring ${k}`).toBe(k === 0 ? 1 : -1);
        });
      }
      const query = b.query.coordinates[0] ?? [];
      expect(ringProblem(query), b.id).toBeNull();
      expect(query.length, b.id).toBeLessThanOrEqual(MAX_WKT_VERTICES);
    }
    expect(built.find((b) => b.id === "zcta_00017")?.query.coordinates[0]).toHaveLength(MAX_WKT_VERTICES);
    for (let i = 0; i < built.length; i++) {
      for (let j = i + 1; j < built.length; j++) {
        const [x, y] = [built[i], built[j]] as [BuiltArea, BuiltArea];
        expect(overlapProblem(edgesOf(x.geometry), edgesOf(y.geometry)), `${x.id} and ${y.id}`).toBeNull();
      }
    }
  });

  it("indexes in createGeo: points land in their ZIP area, and cells outside every ZIP area in none", () => {
    const geo = createGeo({ gazetteers: { nashville: gazetteer } });
    expect(geo.locate("nashville", { lat: 40.0115, lon: -99.961 })).toBe("zcta_00011"); // the merged corner
    expect(geo.locate("nashville", { lat: 40.02, lon: -99.89 })).toBe("zcta_00012"); // the second county
    expect(geo.locate("nashville", { lat: 40.06, lon: -99.985 })).toBe("zcta_00013");
    expect(geo.locate("nashville", { lat: 40.06, lon: -99.93 })).toBe("zcta_00017");
    expect(geo.locate("nashville", { lat: 40.06, lon: -100.02 })).toBeNull(); // 00013 outside the metro
    expect(geo.locate("nashville", { lat: 40.07, lon: -99.852 })).toBeNull(); // the skipped sliver
    expect(geo.locate("nashville", { lat: 40.02, lon: -99.82 })).toBeNull(); // the left-out county
    expect(geo.locate("nashville", { lat: 40.075, lon: -99.955 })).toBeNull(); // no ZCTA there
    expect(geo.matchNeighbourhood("nashville", "ZIP 00016")?.id).toBe("zcta_00011");
    expect(geo.matchNeighbourhood("nashville", "the 00013 ZIP code")?.id).toBe("zcta_00013");
    expect(geo.matchNeighbourhood("nashville", "Maple Hollow")?.id).toBe("zcta_00017");
  });

  it("writes a data module that loads back as the gazetteer it built", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ct-zcta-"));
    try {
      const file = path.join(dir, "fixture.ts");
      writeFileSync(file, moduleText(zctaSpec("fixture", INPUT.label, true), built), "utf8");
      const loaded = ((await import(pathToFileURL(file).href)) as { FIXTURE: Gazetteer }).FIXTURE;
      expect(loaded.metro).toBe("fixture");
      expect(loaded.source).toBe(gazetteer.source);
      expect(loaded.areas.map((a) => ({ aliases: [], approximateAliases: [], ...a }))).toEqual(built);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses an alias for a ZIP it does not keep and a county it cannot find", async () => {
    await expect(buildZcta({ ...INPUT, aliases: { "00015": ["Cedar Bend"] } }, [])).rejects.toThrow(/does not keep: 00015/);
    await expect(buildZcta({ ...INPUT, countyGeoids: ["99007"] }, [])).rejects.toThrow(/no county outline with GEOID 99007/);
  });
});

describe("ZCTA build helpers", () => {
  it("names the source as Nashville's gazetteer does", () => {
    expect(zctaSpec("nashville", "Davidson County", true).source).toBe(GAZETTEER_CATALOG.nashville?.source);
    expect(zctaSpec("fixture", "Fixture County", false).source).toBe("U.S. Census Bureau 2020 ZIP Code Tabulation Areas clipped to Fixture County, public domain");
    expect(zctaSpec("st_fixture", "Fixture County", false).constName).toBe("ST_FIXTURE");
  });

  it("reads a county GEOID from a GEOID field or its FIPS parts, and the part label from the county name", () => {
    expect(countyGeoid({ GEOID: "99001" })).toBe("99001");
    expect(countyGeoid({ STATEFP: "99", COUNTYFP: "003" })).toBe("99003");
    expect(countyGeoid({ NAME: "Fixture" })).toBeNull();
    expect(partLabelOf("Davidson County")).toBe("Davidson");
    expect(partLabelOf("Fixture Parish")).toBe("Fixture");
  });

  it("asks TIGERweb's ZCTA layer for the box as GeoJSON", () => {
    const url = tigerwebZctaQuery({ minLon: -100, minLat: 40, maxLon: -99.85, maxLat: 40.08 });
    expect(url).toMatch(/^https:\/\/tigerweb\.geo\.census\.gov\/arcgis\/rest\/services\/TIGERweb\/tigerWMS_Census2020\/MapServer\/84\/query\?/);
    expect(url).toContain("geometry=-100.0000,40.0000,-99.8500,40.0800");
    expect(url).toContain("f=geojson");
  });
});
