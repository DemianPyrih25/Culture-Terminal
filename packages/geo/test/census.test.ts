// The census crosswalk (census.ts): ZIP-area membership and clipping, tract tables with their stand-in
// tract, the ACS requests a unit set needs, createGeo's censusUnits, on invented areas, ZIPs and tracts
// (D29); then the shipped tables: every New York and Austin area gets tracts, every ZIP-area city's areas
// get ZCTAs, the tables name only shipped areas, stay small and load lazily.
import { readFileSync } from "node:fs";
import type { MetroId } from "@ct/contracts";
import type { Polygon } from "geojson";
import { describe, expect, it } from "vitest";
import {
  censusGeosOf,
  censusUnitsOf,
  censusUnitsOfMetro,
  createGeo,
  GAZETTEER_CATALOG,
  memberZctas,
  TRACT_LOADERS,
  type CensusCrosswalk,
  type CensusUnits,
  type GazetteerCatalog,
  type TractUnits,
  type ZctaUnits,
} from "../src/index";
import { countiesOf, CENSUS_CROSSWALK } from "../src/census";

const area = (id: string, name: string, aliases?: string[]) => ({ id, name, ...(aliases ? { aliases } : {}), centroid: { lat: 40, lon: -100 }, areaKm2: 5 });

/** An invented ZIP-area city under "nashville" and an invented tract city under "austin". */
const CATALOG: GazetteerCatalog = {
  nashville: {
    source: "fixture",
    areas: [
      area("zcta_00011", "ZIP 00011", ["ZIP 00011", "00011"]),
      // A host with two tiny ZCTAs merged in.
      area("zcta_00012", "ZIP 00012", ["ZIP 00012", "00012", "ZIP 00016", "00016", "ZIP 00018", "00018"]),
      area("zcta_00013", "ZIP 00013 (Fixture part)", ["ZIP 00013", "00013"]),
      // Clipped, but labelled with its place name.
      area("zcta_00014", "ZIP 00014 (Maple Hollow)", ["ZIP 00014", "00014"]),
      // Slightly clipped: listed, not a part.
      area("zcta_00015", "ZIP 00015", ["ZIP 00015", "00015"]),
    ],
  },
  austin: {
    source: "fixture",
    areas: [area("north_fixture", "North Fixture"), area("south_fixture", "South Fixture"), area("pocket_fixture", "Pocket Fixture"), area("lake_fixture", "Lake Fixture")],
  },
};

let tractLoads = 0;
let clipLoads = 0;
const CROSSWALK: CensusCrosswalk = {
  tracts: {
    austin: async () => {
      tractLoads++;
      return {
        metro: "austin",
        source: "fixture",
        areas: { north_fixture: ["99003000200", "99003000100"], south_fixture: ["99005000300", "99003000400"] },
        nearest: { pocket_fixture: "99003000100" },
      };
    },
  },
  zctaClip: async () => {
    clipLoads++;
    return { source: "fixture", inside: { nashville: { zcta_00013: 40, zcta_00014: 61, zcta_00015: 95 } } };
  },
};

const OPTIONS = { catalog: CATALOG, crosswalk: CROSSWALK };

describe("census units on invented areas", () => {
  it("gives a ZIP area its own ZCTA and every merged one, never another area's", () => {
    expect(memberZctas({ id: "zcta_00012", aliases: ["ZIP 00012", "00012", "ZIP 00016", "00016", "ZIP 00018"] })).toEqual(["00012", "00016", "00018"]);
    expect(memberZctas({ id: "north_fixture" })).toBeNull();
    // A bare five-digit alias or an approximate name is not a member.
    expect(memberZctas({ id: "zcta_00011", aliases: ["00099", "ZIP 0009", "Zip 00098"] })).toEqual(["00011"]);
  });

  it("says when whole-ZIP figures describe more than the area: by part label or by land share", async () => {
    const units = (await censusUnitsOfMetro("nashville", OPTIONS)) as ZctaUnits[];
    expect(units.map((u) => [u.areaId, u.zctas, u.clipped, u.insidePct])).toEqual([
      ["zcta_00011", ["00011"], false, null],
      ["zcta_00012", ["00012", "00016", "00018"], false, null],
      ["zcta_00013", ["00013"], true, 40],
      ["zcta_00014", ["00014"], true, 61],
      ["zcta_00015", ["00015"], false, 95],
    ]);
    expect(units.every((u) => u.kind === "zcta" && u.metro === "nashville")).toBe(true);
  });

  it("gives a tract-city area its sorted tracts and their counties, or the stand-in tract", async () => {
    const north = (await censusUnitsOf("austin", "north_fixture", OPTIONS)) as TractUnits;
    expect(north).toEqual({
      kind: "tract",
      metro: "austin",
      areaId: "north_fixture",
      tracts: ["99003000100", "99003000200"],
      nearestOnly: false,
      counties: [{ state: "99", county: "003" }],
    });
    const south = (await censusUnitsOf("austin", "south_fixture", OPTIONS)) as TractUnits;
    expect(south.counties).toEqual([
      { state: "99", county: "003" },
      { state: "99", county: "005" },
    ]);
    const pocket = (await censusUnitsOf("austin", "pocket_fixture", OPTIONS)) as TractUnits;
    expect([pocket.tracts, pocket.nearestOnly]).toEqual([["99003000100"], true]);
    // No tract and no stand-in: an empty unit set the skill reports, not a guess.
    const lake = (await censusUnitsOf("austin", "lake_fixture", OPTIONS)) as TractUnits;
    expect([lake.tracts, lake.counties, lake.nearestOnly]).toEqual([[], [], false]);
  });

  it("answers null for an area the catalog does not list, or a metro without one", async () => {
    expect(await censusUnitsOf("austin", "nowhere", OPTIONS)).toBeNull();
    expect(await censusUnitsOf("nyc", "north_fixture", OPTIONS)).toBeNull();
    expect(await censusUnitsOfMetro("nyc", OPTIONS)).toEqual([]);
  });

  it("loads a table only for a metro that needs it, and only when asked", async () => {
    const tracts = tractLoads;
    const clips = clipLoads;
    await censusUnitsOf("austin", "north_fixture", OPTIONS);
    expect([tractLoads - tracts, clipLoads - clips]).toEqual([1, 0]);
    await censusUnitsOf("nashville", "zcta_00011", OPTIONS);
    expect([tractLoads - tracts, clipLoads - clips]).toEqual([1, 1]);
  });

  it("covers a unit set with one ZCTA request and one tract request per county", async () => {
    const units: CensusUnits[] = [
      ...(await censusUnitsOfMetro("austin", OPTIONS)),
      (await censusUnitsOf("nashville", "zcta_00012", OPTIONS)) as CensusUnits,
      (await censusUnitsOf("nashville", "zcta_00011", OPTIONS)) as CensusUnits,
    ];
    expect(censusGeosOf(units)).toEqual([
      { kind: "zcta", zctas: ["00011", "00012", "00016", "00018"] },
      { kind: "tract", state: "99", county: "003" },
      { kind: "tract", state: "99", county: "005" },
    ]);
    expect(censusGeosOf([])).toEqual([]);
  });

  it("refuses a malformed tract GEOID", () => {
    expect(() => countiesOf(["9900300010"])).toThrow(/11-digit/);
  });

  it("is served by createGeo for the areas it serves, polygons not needed", async () => {
    const square: Polygon = { type: "Polygon", coordinates: [[[-100, 40], [-99.98, 40], [-99.98, 40.02], [-100, 40.02], [-100, 40]]] };
    const geo = createGeo({
      gazetteers: { austin: { metro: "austin", source: "fixture", areas: [{ id: "north_fixture", name: "North Fixture", geometry: square }] } },
      census: CROSSWALK,
    });
    expect(((await geo.censusUnits("austin", "north_fixture")) as TractUnits).tracts).toEqual(["99003000100", "99003000200"]);
    // An area of the tract table this Geo does not serve.
    expect(await geo.censusUnits("austin", "south_fixture")).toBeNull();
    expect((await geo.censusUnitsOfMetro("austin")).map((u) => u.areaId)).toEqual(["north_fixture"]);
    // The lazy default: catalog names now, crosswalk tables on first ask, no polygons loaded.
    const never = (): Promise<never> => Promise.reject(new Error("polygons are not loaded in this test"));
    const lazy = createGeo({ loaders: { nashville: never, austin: never }, catalog: CATALOG, census: CROSSWALK });
    expect(((await lazy.censusUnits("nashville", "zcta_00014")) as ZctaUnits).clipped).toBe(true);
    expect(lazy.ready("nashville")).toBe(false);
  });
});

/** Austin planning areas smaller than the tracts around them: the nearest tract stands in (tools/geo/tracts.ts reports each). */
const NEAREST_ONLY: Partial<Record<MetroId, readonly string[]>> = {
  nyc: [],
  austin: ["east_cesar_chavez", "north_loop", "southeast", "west_congress"],
};
const STATE_FIPS: Partial<Record<MetroId, string>> = { nyc: "36", austin: "48" };

describe.each(Object.keys(TRACT_LOADERS) as MetroId[])("the shipped %s tract table", (metro) => {
  it("gives every area at least one tract, reporting the stand-ins", async () => {
    const units = (await censusUnitsOfMetro(metro)) as TractUnits[];
    const ids = (GAZETTEER_CATALOG[metro]?.areas ?? []).map((a) => a.id);
    expect(units.map((u) => u.areaId)).toEqual(ids);
    expect(units.filter((u) => u.tracts.length === 0).map((u) => u.areaId)).toEqual([]);
    expect(units.filter((u) => u.nearestOnly).map((u) => u.areaId)).toEqual(NEAREST_ONLY[metro]);
    for (const u of units) for (const c of u.counties) expect(c.state).toBe(STATE_FIPS[metro]);
  });

  it("names only shipped areas and assigns each tract to one area", async () => {
    const load = TRACT_LOADERS[metro];
    if (load === undefined) throw new Error(`no tract table for ${metro}`);
    const table = await load();
    const ids = new Set((GAZETTEER_CATALOG[metro]?.areas ?? []).map((a) => a.id));
    expect(table.metro).toBe(metro);
    expect(table.source).toMatch(/public domain/);
    for (const id of [...Object.keys(table.areas), ...Object.keys(table.nearest ?? {})]) expect(ids.has(id), id).toBe(true);
    for (const id of Object.keys(table.nearest ?? {})) expect(table.areas[id], id).toBeUndefined();
    const all = Object.values(table.areas).flat();
    expect(new Set(all).size).toBe(all.length);
    for (const t of all) expect(t).toMatch(/^\d{11}$/);
  });
});

describe("the shipped ZIP clip table", () => {
  const zipMetros = (Object.keys(GAZETTEER_CATALOG) as MetroId[]).filter((m) => TRACT_LOADERS[m] === undefined);

  it("gives every area of every ZIP-area city its ZCTAs, a part label always clipped", async () => {
    expect(zipMetros).toHaveLength(11);
    for (const metro of zipMetros) {
      const areas = GAZETTEER_CATALOG[metro]?.areas ?? [];
      const units = (await censusUnitsOfMetro(metro)) as ZctaUnits[];
      expect(units.map((u) => u.areaId), metro).toEqual(areas.map((a) => a.id));
      for (const [i, u] of units.entries()) {
        expect(u.zctas.length, u.areaId).toBeGreaterThan(0);
        if (/ part\)$/.test(areas[i]?.name ?? "")) expect(u.clipped, u.areaId).toBe(true);
      }
    }
  });

  it("lists only shipped ZIP areas, as whole percents under 99", async () => {
    const table = await CENSUS_CROSSWALK.zctaClip();
    for (const [metro, shares] of Object.entries(table.inside) as [MetroId, Record<string, number>][]) {
      const ids = new Set((GAZETTEER_CATALOG[metro]?.areas ?? []).map((a) => a.id));
      for (const [id, pct] of Object.entries(shares)) {
        expect(ids.has(id) && id.startsWith("zcta_"), `${metro} ${id}`).toBe(true);
        expect(Number.isInteger(pct) && pct >= 0 && pct <= 98, `${metro} ${id}`).toBe(true);
      }
    }
  });
});

describe("the crosswalk modules", () => {
  it("stay small and load only on first use", () => {
    const read = (file: string): string => readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
    expect(read("data/tracts-nyc.ts").length).toBeLessThan(60_000);
    expect(read("data/tracts-austin.ts").length).toBeLessThan(10_000);
    expect(read("data/zcta-clip.ts").length).toBeLessThan(10_000);
    // census.ts reaches its tables by dynamic import only, as the gazetteer loaders do.
    expect(read("census.ts")).not.toMatch(/^import [^;]*from "\.\/data\//m);
    expect(read("index.ts")).not.toMatch(/data\//);
  });
});
