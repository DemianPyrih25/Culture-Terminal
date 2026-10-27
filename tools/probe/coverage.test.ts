import type { QlooEntity, QlooHeatmapCell, QlooTagSearchItem } from "@ct/contracts";
import { describe, expect, it } from "vitest";
import {
  audienceCatalogue,
  carrying,
  compareHeatmaps,
  contextsDiffer,
  heatmapStats,
  invariance,
  pickBrandTag,
  pickPlaceTags,
  PLACE_TYPES,
  PROBE_EXTENSIONS,
  scoredStats,
  SPONSOR_SPECS,
  verdicts,
} from "./coverage";

// Invented tags, entities and cells only (D29): no Qloo values or ids.

const tag = (id: string, name: string): QlooTagSearchItem => ({ id, name, type: id.split(":").slice(0, 4).join(":") });
const row = (id: string, affinity?: number, tags: string[] = []): QlooEntity => ({
  entity_id: id,
  name: id,
  tags: tags.map((t) => ({ id: t, name: t, type: "urn:tag:genre:brand" })),
  ...(affinity === undefined ? {} : { query: { affinity } }),
});
const cell = (geohash: string, affinity: number, tagAffinity: number | null = affinity): QlooHeatmapCell => ({
  location: { latitude: 0, longitude: 0, geohash },
  query: { affinity, tag_affinity: tagAffinity },
});

describe("coverage probe: tag picks", () => {
  it("takes the first fitting genre and category place tags, a preferred one first", () => {
    const tags = [
      tag("urn:tag:category:place:mock_noodle_house", "Mock Noodle House"),
      tag("urn:tag:genre:place:restaurant:mock_wine_cellar", "Mock Wine Cellar"),
      tag("urn:tag:genre:place:restaurant:mock_wine_bar", "Mock Wine Bar"),
      tag("urn:tag:category:place:mock_wine_bar", "Mock Wine Bar"),
    ];
    expect(pickPlaceTags(tags, { match: /wine/, prefer: /wine.?bar/ })).toEqual({
      genre: "urn:tag:genre:place:restaurant:mock_wine_bar",
      category: "urn:tag:category:place:mock_wine_bar",
      genreSeen: 2,
      categorySeen: 2,
    });
    expect(pickPlaceTags(tags, { match: /pizz/ })).toMatchObject({ genre: null, category: null });
  });

  it("matches the tag leaf and name, never the type prefix", () => {
    // "place" sits in every prefix; a pattern on it must not match the whole list.
    const tags = [tag("urn:tag:genre:place:mock_bakery", "Mock Bakery")];
    expect(pickPlaceTags(tags, { match: /place/ }).genre).toBeNull();
  });

  it("reports the runtime pick of a brand lookup and whether it fits the category", () => {
    const tags = [
      tag("urn:tag:genre:brand:mock_apps", "Mock Apps"),
      tag("urn:tag:genre:brand:mock_apps:mock_payments", "Mock Payments"),
      tag("urn:tag:product_category:qloo:mock_payments", "Mock Payments"),
    ];
    expect(pickBrandTag(tags, /payment/)).toEqual({
      runtime: "urn:tag:genre:brand:mock_apps",
      fitting: "urn:tag:genre:brand:mock_apps:mock_payments",
      runtimeFits: false,
    });
    expect(pickBrandTag(tags, /apps/)).toMatchObject({ runtimeFits: true });
    expect(pickBrandTag([], /apps/)).toEqual({ runtime: null, fitting: null, runtimeFits: false });
  });

  it("probes 15 place types and 13 sponsor categories under unique keys", () => {
    expect(new Set(PLACE_TYPES.map((p) => p.key)).size).toBe(15);
    expect(PLACE_TYPES.filter((p) => p.origin === "new").map((p) => p.key)).toEqual([
      "gym",
      "beauty_salon",
      "pizza",
      "fitness_studio",
      "burger",
      "sushi",
    ]);
    expect(new Set(SPONSOR_SPECS.map((s) => s.key)).size).toBe(13);
    expect(SPONSOR_SPECS.filter((s) => s.origin === "new")).toHaveLength(5);
  });

  it("extends the allowlist only on insights types, one gate each", () => {
    for (const e of PROBE_EXTENSIONS) {
      expect(e.filterType).toMatch(/^urn:entity:/);
      expect(["C3", "C4", "C5"]).toContain(e.gate);
    }
  });
});

describe("coverage probe: heatmaps", () => {
  it("counts cells, tag_affinity and the dominant geohash length", () => {
    const cells = [cell("aaaaaa", 0.9), cell("aaaaab", 0.5), cell("aaaaaac", 0.1, null)];
    expect(heatmapStats(cells)).toEqual({ cells: 3, withTagAffinity: 2, geohashLengths: { "6": 2, "7": 1 }, geohashLength: 6 });
    expect(heatmapStats([])).toMatchObject({ cells: 0, geohashLength: null });
    expect(verdicts.heatmap(heatmapStats(cells))).toBe(false);
    expect(verdicts.heatmap(heatmapStats(cells.slice(0, 2)))).toBe(true);
  });

  it("compares a concept map with the baseline on shared cells", () => {
    const base = [cell("a1", 0.1), cell("a2", 0.2), cell("a3", 0.3), cell("a4", 0.4)];
    const concept = [cell("a1", 0.15), cell("a2", 0.25), cell("a3", 0.35), cell("zz", 0.9)];
    const r = compareHeatmaps(concept, base);
    expect(r.shared).toBe(3);
    expect(r.pearson).toBeCloseTo(1, 9);
    expect(r.top50).toBe(3);
  });
});

describe("coverage probe: rank checks", () => {
  it("finds candidate-set invariance when a ranked subset keeps the open call's affinities", () => {
    const open = [row("e1", 0.9), row("e2", 0.8), row("e3", 0.7), row("e4", 0.6)];
    const same = invariance(open, [row("e2", 0.8), row("e4", 0.6)], ["e2", "e4"]);
    expect(same).toEqual({ candidates: 2, returned: 2, outside: 0, maxAbsDiff: 0, compared: 2 });
    expect(verdicts.invariant(same)).toBe(true);
    const shifted = invariance(open, [row("e2", 0.85), row("e4", 0.6)], ["e2", "e4"]);
    expect(verdicts.invariant(shifted)).toBe(false);
    const dropped = invariance(open, [row("e2", 0.8)], ["e2", "e4"]);
    expect(verdicts.invariant(dropped)).toBe(false);
    const outside = invariance(open, [row("e2", 0.8), row("e9", 0.5)], ["e2", "e4"]);
    expect(outside.outside).toBe(1);
  });

  it("reads a context row as applied only when most rows are scored and they discriminate", () => {
    const scored = scoredStats([row("e1", 0.4), row("e2", 0.2), row("e3", 0.2), row("e4")]);
    expect(scored).toEqual({ rows: 4, withAffinity: 3, distinct: 2, floorTies: 2 });
    expect(verdicts.applied(scored)).toBe(true);
    // G1: a rank with no applied signal returns rows without affinity.
    expect(verdicts.applied(scoredStats([row("e1"), row("e2")]))).toBe(false);
    expect(verdicts.applied(scoredStats([row("e1", 0.3), row("e2", 0.3)]))).toBe(false);
  });

  it("tells two context rows apart by affinity or by membership", () => {
    const a = [row("e1", 0.5), row("e2", 0.4)];
    expect(contextsDiffer(a, [row("e1", 0.5), row("e2", 0.4)])).toEqual({ shared: 2, differ: false, listOverlap: 2 });
    expect(contextsDiffer(a, [row("e1", 0.6), row("e2", 0.4)]).differ).toBe(true);
    expect(contextsDiffer(a, [row("e7", 0.5), row("e8", 0.4)])).toEqual({ shared: 0, differ: true, listOverlap: 0 });
  });

  it("counts rows carrying a filter tag", () => {
    const rows = [row("e1", 0.5, ["urn:tag:genre:brand:mock_tea"]), row("e2", 0.4, ["urn:tag:genre:brand:mock_soda"])];
    expect(carrying(rows, "urn:tag:genre:brand:mock_tea")).toBe(1);
    expect(verdicts.filter(2, 1, 1)).toBe(false);
    expect(verdicts.filter(2, 2, 1)).toBe(true);
    expect(verdicts.filter(0, 0, 1)).toBe(false);
  });

  it("verifies a brand filter only when the rows also belong to the category, not just carry its tag", () => {
    expect(verdicts.members(10, 10)).toBe(true);
    expect(verdicts.members(10, 8)).toBe(true);
    expect(verdicts.members(10, 2)).toBe(false);
    expect(verdicts.members(0, 0)).toBe(false);
  });
});

describe("coverage probe: audience catalogue", () => {
  it("keeps well-formed keys of the requested family and drops denied ones", () => {
    const family = audienceCatalogue("leisure", [
      { id: "urn:audience:leisure:mock_kayakers", name: "Mock Kayakers" },
      { id: "urn:audience:leisure:political_junkie", name: "Denied By D21" },
      { id: "urn:audience:hobbies_and_interests:mock_knitters", name: "Other Family" },
      { id: "not-an-audience", name: "Broken" },
    ]);
    expect(family).toEqual({
      family: "leisure",
      count: 4,
      keyed: 3,
      inFamily: 2,
      denied: 1,
      entries: [{ urn: "urn:audience:leisure:mock_kayakers", name: "Mock Kayakers" }],
    });
  });
});
