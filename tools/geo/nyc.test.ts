// The NYC build's own rules (tools/geo/nyc.ts) on invented places, codes and points (D29): how an NTA
// name splits into places, how tabulation areas dissolve into community districts, and which places
// become approximate aliases at each level. The shipped data is checked in packages/geo/test/gazetteers.test.ts.
import { beforeAll, describe, expect, it } from "vitest";
import { MAX_WKT_VERTICES } from "../../packages/geo/src/index";
import { ringProblem } from "../../packages/geo/test/validity";
import { buildAreas, dissolveGroups, km2, prepare, type BuiltArea, type Shape } from "./build";
import { approximateAliases, baseOf, districtName, districtsOf, metresToEdge, MIN_INSIDE_M, placesOf, SUBURB_M, type GnisPlace, type Nta } from "./nyc";

const rect = (w: number, s: number, e: number, n: number): number[][][] => [
  [
    [w, s],
    [e, s],
    [e, n],
    [w, n],
    [w, s],
  ],
];
const polygon = (w: number, s: number, e: number, n: number): Shape => ({ type: "Polygon", coordinates: rect(w, s, e, n) });

/** A built area: its query outline is its first part. */
function area(id: string, name: string, parts: number[][][][]): BuiltArea {
  const first = parts[0] as number[][][];
  return {
    id,
    name,
    aliases: [],
    approximateAliases: [],
    geometry: parts.length === 1 ? { type: "Polygon", coordinates: first } : { type: "MultiPolygon", coordinates: parts },
    query: { type: "Polygon", coordinates: first },
    centroid: { lat: 0, lon: 0 },
    areaKm2: 0,
  };
}

const nta = (code: string, name: string, geometry: Shape, cdta = code.slice(0, 4), type = "0"): Nta => ({
  code,
  name,
  type,
  cdta,
  cdtaName: `${cdta} Fixture District (CD 1 Equivalent)`,
  geometry,
});

describe("NTA names", () => {
  it("splits an NTA name at its hyphens, keeping one-place names whole and brackets with their place", () => {
    expect(placesOf("Alder Point-Birch Hollow-Cedar Bend")).toEqual(["Alder Point", "Birch Hollow", "Cedar Bend"]);
    expect(placesOf("Bedford-Stuyvesant (West)")).toEqual(["Bedford-Stuyvesant (West)"]);
    expect(placesOf("Co-op City")).toEqual(["Co-op City"]);
    expect(placesOf("Dune Park (East)-Elm Row")).toEqual(["Dune Park (East)", "Elm Row"]);
    expect(placesOf("Fern Gate")).toEqual(["Fern Gate"]);
    expect(baseOf("Dune Park (East)")).toBe("Dune Park");
    expect(baseOf("Elm Row")).toBe("Elm Row");
  });

  it("reads a district's name from its CDTA name, and refuses one it cannot read", () => {
    expect(districtName("XA08 Crown Fern (North) (CD 8 Approximation)")).toBe("Crown Fern (North)");
    expect(districtName("XA55  Fern Park (JIA 55 Equivalent)")).toBe("Fern Park");
    expect(() => districtName("Fern Park")).toThrow(/cannot read/);
  });

  it("groups tabulation areas by district, and refuses a district named two ways", () => {
    const one = nta("XA0101", "Alder Point", polygon(-100, 40, -99.99, 40.01));
    const two = { ...nta("XA0102", "Birch Hollow", polygon(-99.99, 40, -99.98, 40.01)), cdtaName: "XA01 Fixture District (CD 1 Equivalent)" };
    expect(districtsOf([one, two])).toEqual([{ key: "XA01", name: "Fixture District", members: ["XA0101", "XA0102"] }]);
    expect(() => districtsOf([one, { ...two, cdtaName: "XA01 Other District (CD 1 Equivalent)" }])).toThrow(/named both/);
  });
});

describe("metresToEdge", () => {
  it("measures to the nearest edge", () => {
    const square = polygon(-100, 40, -99.98, 40.02);
    // 0.01° of latitude is about 1,105 m; of longitude at 40.01°N, about 852 m.
    expect(metresToEdge(square, { lat: 40.01, lon: -99.99 })).toBeCloseTo(852, -1);
    expect(metresToEdge(square, { lat: 40.0005, lon: -99.99 })).toBeCloseTo(55, -1);
  });
});

describe("approximate aliases of tabulation areas", () => {
  // Three invented areas: B has an island part apart from its query outline; C lies on the city line.
  const A = area("a", "Alder Point-Birch Hollow-Cedar Bend-Dune Park (East)-Elm Row", [rect(-100, 40, -99.98, 40.02)]);
  const B = area("b", "Elm Row-Fern Gate-Gull Cove", [rect(-99.98, 40, -99.96, 40.02), rect(-99.95, 40, -99.94, 40.01)]);
  const C = area("c", "Juniper Glen-Kestrel Park", [rect(-100, 40.02, -99.98, 40.04)]);
  const ntas: Nta[] = [
    nta("XA0101", A.name, A.geometry),
    nta("XA0102", B.name, B.geometry),
    nta("XA0103", C.name, C.geometry),
    nta("XA0191", "Hazel Park", polygon(-100, 39.98, -99.98, 40), "XA01", "9"),
  ];
  const gnis: GnisPlace[] = [
    { name: "Alder Point", county: "Kings", lat: 40.01, lon: -99.99 }, // deep inside A
    { name: "Birch Hollow", county: "Kings", lat: 40.0005, lon: -99.99 }, // about 55 m from A's edge
    { name: "Fern Gate", county: "Kings", lat: 40.01, lon: -99.97 }, // deep inside B's main part ...
    { name: "Fern Gate", county: "Kings", lat: 40.5, lon: -99.99 }, // ... and a namesake far off in the city
    { name: "Gull Cove", county: "Kings", lat: 40.005, lon: -99.945 }, // on B's island
    { name: "Kestrel Park", county: "Outer", lat: 40.045, lon: -99.99 }, // a suburb about 550 m past C
    { name: "Juniper Glen", county: "Far", lat: 40.5, lon: -99.99 }, // a namesake 50 km off, outside the city
  ];

  it("admits places one area lists, unless a suburb across the city line bears the name or the place may lie off the query outline", () => {
    const report: string[] = [];
    const members = (a: BuiltArea, i: number): { area: BuiltArea; members: Nta[] } => ({ area: a, members: [ntas[i] as Nta] });
    const out = approximateAliases("nta", [members(A, 0), members(B, 1), members(C, 2)], ntas, gnis, report);
    expect([...out].map(([id, list]) => [id, list.map((x) => `${x.alias} by ${x.by}`)])).toEqual([
      ["a", ["Alder Point by nta", "Birch Hollow by nta", "Cedar Bend by nta"]],
      ["b", ["Fern Gate by gnis"]],
      ["c", ["Juniper Glen by nta"]],
    ]);
    // A one-part area's places stand at its label point; one GNIS places on a part of several stands there.
    expect(out.get("a")?.[0]?.at.lat).toBeCloseTo(40.01, 6);
    expect(out.get("a")?.[0]?.at.lon).toBeCloseTo(-99.99, 6);
    expect(out.get("b")?.[0]?.at).toEqual({ lat: 40.01, lon: -99.97 });
    expect(report).toEqual([
      "alias: Dune Park (East) (a) left out, bracketed",
      "alias: Elm Row (a) left out, also listed by XA0102",
      "alias: Elm Row (b) left out, also listed by XA0101",
      "alias: Gull Cove (b) left out, its NTA has several parts, and no GNIS point of that name lies inside the query outline",
      "alias: Kestrel Park (c) left out, a GNIS place of that name in Outer County, outside the city, 0.6 km away",
    ]);
    expect([MIN_INSIDE_M, SUBURB_M]).toEqual([150, 5_000]);
  });

  it("needs a GNIS point well inside the query outline for a place on an area of several parts", () => {
    const near: GnisPlace[] = [{ name: "Fern Gate", county: "Kings", lat: 40.0005, lon: -99.97 }];
    const report: string[] = [];
    expect(approximateAliases("nta", [{ area: B, members: [ntas[1] as Nta] }], ntas, near, report).get("b")).toBeUndefined();
    expect(report).toContain("alias: Fern Gate (b) left out, its NTA has several parts, and its GNIS point lies 55 m from the border");
  });

  it("gives a one-place area no alias: its name is the place", () => {
    const one = area("d", "Hazel Glen", [rect(-100, 40.1, -99.98, 40.12)]);
    const list = [...ntas, nta("XA0104", one.name, one.geometry)];
    expect(approximateAliases("nta", [{ area: one, members: [list[4] as Nta] }], list, [], [])).toEqual(new Map());
  });
});

describe("approximate aliases of community districts", () => {
  // District XA01, "Mill Bend": a main part of four tabulation areas and an island holding a fifth.
  // District XA02, "Rook Point", north of it. A suburb named Lark Hill lies across the city line.
  const members1: Nta[] = [
    nta("XA0101", "Mill Bend (North)", polygon(-100, 40.02, -99.98, 40.04)),
    nta("XA0102", "Mill Bend (South)", polygon(-100, 40, -99.98, 40.02)),
    nta("XA0103", "Oak Lea-Pine Rise", polygon(-99.98, 40, -99.96, 40.04)),
    nta("XA0104", "Quill Cove", polygon(-99.93, 40, -99.92, 40.01)),
    nta("XA0105", "Lark Hill", polygon(-99.96, 40, -99.95, 40.04)),
  ];
  const members2: Nta[] = [nta("XA0201", "Pine Rise (East)-Rook Point", polygon(-99.98, 40.04, -99.96, 40.06))];
  const X = area("mill_bend", "Mill Bend", [rect(-100, 40, -99.95, 40.04), rect(-99.93, 40, -99.92, 40.01)]);
  const Y = area("rook_point", "Rook Point", [rect(-99.98, 40.04, -99.96, 40.06)]);
  const gnis: GnisPlace[] = [{ name: "Lark Hill", county: "Outer", lat: 40.02, lon: -99.945 }];

  it("admits the places of a district's areas and the base names of split places, apart from shared names and off-outline parts", () => {
    const report: string[] = [];
    const out = approximateAliases("cdta", [{ area: X, members: members1 }, { area: Y, members: members2 }], [...members1, ...members2], gnis, report);
    expect([...out].map(([id, list]) => [id, list.map((x) => x.alias)])).toEqual([
      // "Mill Bend", the base of both split areas, is the district's own name; Lark Hill names an area by itself, so the suburb does not count.
      ["mill_bend", ["Mill Bend (North)", "Mill Bend (South)", "Oak Lea", "Lark Hill"]],
      ["rook_point", ["Pine Rise (East)"]],
    ]);
    expect(report).toEqual([
      "alias: Pine Rise (mill_bend) left out, also listed by XA02",
      "alias: Quill Cove (mill_bend) left out, its NTA lies outside the query outline, and no GNIS point of that name lies inside the query outline",
      "alias: Pine Rise (rook_point) left out, also listed by XA01",
    ]);
  });
});

describe("the district build", () => {
  const ntas: Nta[] = [
    nta("XA0101", "Alder Point", polygon(-100, 40, -99.98, 40.02)),
    nta("XA0102", "Birch Hollow", polygon(-99.98, 40, -99.96, 40.02)),
    nta("XA0103", "Cedar Bend", polygon(-99.94, 40, -99.93, 40.01)),
    { ...nta("XA0201", "Dune Park", polygon(-100, 40.02, -99.96, 40.04)), cdtaName: "XA02 Dune Park (CD 2 Approximation)" },
  ];
  const report: string[] = [];
  let built: BuiltArea[] = [];

  beforeAll(async () => {
    const work = await prepare(
      ntas.map((n) => ({ key: n.code, name: n.name, aliases: [], approximateAliases: [], geometry: n.geometry as Shape })),
      report,
    );
    built = await buildAreas(await dissolveGroups(work, districtsOf(ntas)), 15, report);
  });

  it("dissolves the tabulation areas into one area per district, a detached one as a second part", () => {
    expect(built.map((b) => [b.id, b.name, b.geometry.type])).toEqual([
      ["dune_park", "Dune Park", "Polygon"],
      ["fixture_district", "Fixture District", "MultiPolygon"],
    ]);
    const fixture = built[1] as BuiltArea;
    const parts = ntas.slice(0, 3).map((n) => km2([(n.geometry as { coordinates: number[][][] }).coordinates]));
    expect(fixture.areaKm2).toBeCloseTo(parts.reduce((s, x) => s + x, 0), 1);
    expect(fixture.geometry.type === "MultiPolygon" ? fixture.geometry.coordinates.map((p) => p.length) : []).toEqual([1, 1]);
    for (const b of built) {
      expect(ringProblem(b.query.coordinates[0] ?? []), b.id).toBeNull();
      expect(b.query.coordinates[0]?.length, b.id).toBeLessThanOrEqual(MAX_WKT_VERTICES);
    }
  });

  it("refuses an area in no district or in two", async () => {
    const work = await prepare([{ key: "XA0101", name: "Alder Point", aliases: [], approximateAliases: [], geometry: ntas[0]?.geometry as Shape }], []);
    await expect(dissolveGroups(work, [])).rejects.toThrow(/XA0101 is in no group/);
    const twice = [
      { key: "XA01", name: "One", members: ["XA0101"] },
      { key: "XA02", name: "Two", members: ["XA0101"] },
    ];
    await expect(dissolveGroups(work, twice)).rejects.toThrow(/XA0101 is in XA01 and XA02/);
  });
});
