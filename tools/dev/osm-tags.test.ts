// The OpenStreetMap tag checker's decisions, without the network. Tags, counts and ids are invented.
import { describe, expect, it } from "vitest";
import type { OsmTagsConfig } from "@ct/publicdata";
import { memoryIo } from "./cli/io";
import {
  type AdminArea,
  applyVerdicts,
  judgeMetro,
  judgeTags,
  main,
  pruneGroups,
  regexFrom,
  regexValues,
  type TagStat,
  tagsOf,
} from "./osm-tags";

const DATE = "2026-10-30";
const stat = (uses: number, wiki = true): TagStat => ({ uses, wiki });

describe("osm-tags check", () => {
  it("reads the two regex shapes the config uses, and nothing else", () => {
    expect(regexValues("^(cafe|bar)$")).toEqual({ values: ["cafe", "bar"], form: "alternation" });
    expect(regexValues("(^|;) *(pizza) *(;|$)")).toEqual({ values: ["pizza"], form: "list" });
    expect(regexValues("^caf")).toBeNull();
    expect(regexValues("^(cafe|.*)$")).toBeNull();
    expect(regexFrom(["a", "b"], "alternation")).toBe("^(a|b)$");
    expect(regexFrom(["pizza"], "list")).toBe("(^|;) *(pizza) *(;|$)");
  });

  it("lists every tag a type depends on", () => {
    const groups = [
      [
        { key: "amenity", value: "^(restaurant|fast_food)$", op: "regex" as const },
        { key: "cuisine", value: "(^|;) *(pizza) *(;|$)", op: "regex" as const },
      ],
      [{ key: "shop", value: null, op: "exists" as const }],
    ];
    expect(tagsOf(groups)).toEqual([
      { key: "amenity", value: "restaurant" },
      { key: "amenity", value: "fast_food" },
      { key: "cuisine", value: "pizza" },
      { key: "shop", value: null },
    ]);
    expect(tagsOf([[{ key: "amenity", value: "^caf", op: "regex" }]])).toBeNull();
  });

  it("passes a type only when every tag has 10,000 uses and a wiki page", () => {
    const stats = new Map([
      ["amenity=cafe", stat(20_000)],
      ["amenity=rare", stat(9_999)],
      ["amenity=nowiki", stat(50_000, false)],
    ]);
    expect(judgeTags([{ key: "amenity", value: "cafe" }], stats, DATE)).toEqual({ ok: true, line: "taginfo 2026-10-30: amenity=cafe 20,000 uses; wiki pages present" });
    expect(judgeTags([{ key: "amenity", value: "rare" }], stats, DATE)).toEqual({ ok: false, line: "amenity=rare 9,999 uses" });
    expect(judgeTags([{ key: "amenity", value: "nowiki" }], stats, DATE).ok).toBe(false);
    expect(judgeTags([{ key: "amenity", value: "unknown" }], stats, DATE)).toEqual({ ok: false, line: "amenity=unknown not checked" });
    expect(judgeTags(null, stats, DATE).ok).toBe(false);
  });

  it("drops a failing value from an alternation rather than the whole activity measure", () => {
    const stats = new Map([
      ["amenity=cafe", stat(20_000)],
      ["amenity=rare", stat(10)],
      ["shop=*", stat(1_000_000)],
    ]);
    const groups = [[{ key: "amenity", value: "^(cafe|rare)$", op: "regex" as const }], [{ key: "shop", value: null, op: "exists" as const }]];
    expect(pruneGroups(groups, stats)).toEqual([[{ key: "amenity", value: "^(cafe)$", op: "regex" }], [{ key: "shop", value: null, op: "exists" }]]);
    expect(pruneGroups([[{ key: "amenity", value: "^(rare)$", op: "regex" }]], stats)).toBeNull();
  });

  it("passes a metro when each county id is one admin_level 6 area with its FIPS code", () => {
    const counties = [{ name: "Testville County", fips: "09001", wikidata: "Q900001" }];
    const area = (over: Partial<AdminArea> = {}): AdminArea => ({ wikidata: "Q900001", relationId: 101, adminLevel: "6", fips: "9001", name: "Testville County", ...over });
    expect(judgeMetro(counties, [area()], DATE)).toEqual({
      ok: true,
      line: 'overpass 2026-10-30: admin_level=6 boundary, one area each: Q900001 relation 101 "Testville County"',
    });
    expect(judgeMetro(counties, [], DATE).ok).toBe(false);
    expect(judgeMetro(counties, [area(), area({ relationId: 102 })], DATE).ok).toBe(false);
    expect(judgeMetro(counties, [area({ adminLevel: "8" })], DATE).ok).toBe(false);
    expect(judgeMetro(counties, [area({ fips: "9002" })], DATE).ok).toBe(false);
    expect(judgeMetro(counties, [area({ fips: null })], DATE).ok).toBe(true);
  });

  it("verifies what passes and removes what fails", () => {
    const config: OsmTagsConfig = {
      attribution: "© OpenStreetMap contributors",
      licence: "ODbL-1.0",
      activity: { key: "activity", label: "Shops", groups: [[{ key: "shop", value: null, op: "exists" }]], status: "candidate", verified_by: "" },
      place_types: [
        { key: "cafe", label: "Cafés", aliases: [], concepts: [], group: "tenant", groups: [[{ key: "amenity", value: "cafe", op: "eq" }]], status: "candidate", verified_by: "" },
        { key: "rare", label: "Rare", aliases: [], concepts: [], group: "specialty", groups: [[{ key: "amenity", value: "rare", op: "eq" }]], status: "candidate", verified_by: "" },
      ],
      metros: {
        testville: { counties: [{ name: "Testville County", fips: "09001", wikidata: "Q900001", land_km2: 10 }], wikidata: ["Q900001"], land_km2: 10, status: "candidate", verified_by: "" },
        nowhere: { counties: [{ name: "Nowhere County", fips: "09003", wikidata: "Q900003", land_km2: 5 }], wikidata: ["Q900003"], land_km2: 5, status: "candidate", verified_by: "" },
      },
    };
    const stats = new Map([
      ["shop=*", stat(1_000_000)],
      ["amenity=cafe", stat(20_000)],
      ["amenity=rare", stat(5)],
    ]);
    const areas: AdminArea[] = [{ wikidata: "Q900001", relationId: 101, adminLevel: "6", fips: "9001", name: "Testville County" }];
    const { config: out, verdicts } = applyVerdicts(config, stats, areas, DATE);
    expect(out.activity.status).toBe("verified");
    expect(out.place_types.map((t) => [t.key, t.status])).toEqual([["cafe", "verified"]]);
    expect(Object.keys(out.metros)).toEqual(["testville"]);
    expect(out.metros.testville?.status).toBe("verified");
    expect(verdicts.filter((v) => !v.ok).map((v) => v.name)).toEqual(["type rare", "metro nowhere"]);
    // The input is left as it was.
    expect(config.place_types).toHaveLength(2);
  });

  it("refuses an unknown command and a warm-up without OSM_USER_AGENT", async () => {
    const io = memoryIo();
    expect(await main(["nope"], io)).toBe(2);
    const saved = process.env.OSM_USER_AGENT;
    delete process.env.OSM_USER_AGENT;
    try {
      expect(await main(["warm"], io)).toBe(2);
      expect(io.stderr.join("\n")).toMatch(/OSM_USER_AGENT is not set/);
    } finally {
      if (saved !== undefined) process.env.OSM_USER_AGENT = saved;
    }
  });
});
