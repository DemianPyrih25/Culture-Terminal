import {
  AgeBucket,
  QlooAudiencesResponse,
  QlooDemographicsResponse,
  type QlooHeatmapCell,
  QlooHeatmapResponse,
  type QlooParams,
  QlooSearchResponse,
  QlooTagInsightsResponse,
  QlooTagsResponse,
  QlooTrendingResponse,
} from "@ct/contracts";
import { describe, expect, it } from "vitest";
import { PROBE_FACTS, type QlooPath } from "../src/allowlist";
import { AUDIENCE_ALLOWLIST } from "../src/audiences";
import { canonicalize } from "../src/canonical";
import { createMockTransport } from "../src/mock";

// Synthetic transport: invented names and ids only; metro coordinates are public (D29).

const transport = createMockTransport();
const decoder = new TextDecoder();
/** The client's canonical form, under the mock cache namespace as QLOO_MOCK=1 runs it. */
const request = (path: QlooPath, params: QlooParams) => canonicalize(path, params, "mock-v1");

async function body(path: QlooPath, params: QlooParams): Promise<unknown> {
  const response = await transport(request(path, params));
  expect(response.status, `${path} ${JSON.stringify(params)}`).toBe(200);
  return JSON.parse(decoder.decode(response.body));
}

async function locality(name: string): Promise<string> {
  const results = QlooSearchResponse.parse(await body("/search", { query: name, types: ["urn:entity:locality"] })).results;
  return results[0]?.entity_id ?? "";
}

async function heatmap(location: string, tags: readonly string[], extra: QlooParams = {}): Promise<QlooHeatmapCell[]> {
  const params = { "filter.type": "urn:heatmap", "filter.location": location, "signal.interests.tags": tags, ...extra };
  return QlooHeatmapResponse.parse(await body("/v2/insights", params)).results.heatmap;
}

/** Spearman rank correlation (no tie handling needed for continuous synthetic values). */
function spearman(xs: readonly number[], ys: readonly number[]): number {
  const ranks = (vs: readonly number[]) => {
    const order = vs.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
    const r = new Array<number>(vs.length);
    order.forEach(({ i }, pos) => (r[i] = pos));
    return r;
  };
  const rx = ranks(xs);
  const ry = ranks(ys);
  const n = xs.length;
  const d2 = rx.reduce((s, r, i) => s + (r - (ry[i] ?? 0)) ** 2, 0);
  return 1 - (6 * d2) / (n * (n * n - 1));
}

const BASELINE = PROBE_FACTS.heatmapBaselineTag;
const CONCEPT = ["urn:tag:genre:place:mock_ramen", "urn:tag:category:place:cafe"];

describe("mock heatmap", () => {
  it("covers Nashville at geohash-6 and Austin at geohash-7 with a few hundred cells inside each metro", async () => {
    const metros = [
      { id: await locality("Nashville"), precision: 6, lat: [35.9, 36.4], lon: [-87.05, -86.5] },
      { id: await locality("Austin"), precision: 7, lat: [30.15, 30.4], lon: [-97.9, -97.6] },
    ];
    for (const m of metros) {
      const cells = await heatmap(m.id, [BASELINE]);
      expect(cells.length).toBeGreaterThanOrEqual(200);
      expect(cells.length).toBeLessThanOrEqual(1_000);
      for (const c of cells) {
        expect(c.location.geohash).toHaveLength(m.precision);
        expect(c.location.latitude).toBeGreaterThan(m.lat[0] ?? 0);
        expect(c.location.latitude).toBeLessThan(m.lat[1] ?? 0);
        expect(c.location.longitude).toBeGreaterThan(m.lon[0] ?? 0);
        expect(c.location.longitude).toBeLessThan(m.lon[1] ?? 0);
        expect(c.query.affinity).toBeGreaterThanOrEqual(0);
        expect(c.query.affinity).toBeLessThanOrEqual(1);
      }
    }
  });

  it("picks the metro from a name in filter.location and defaults to Austin", async () => {
    expect((await heatmap("Nashville, TN", [BASELINE]))[0]?.location.geohash).toHaveLength(6);
    expect((await heatmap("ent-city-01", [BASELINE]))[0]?.location.geohash).toHaveLength(7);
  });

  it("tracks popularity for the baseline and plants pockets that set a concept apart", async () => {
    const id = await locality("Nashville");
    const baseline = await heatmap(id, [BASELINE]);
    const concept = await heatmap(id, CONCEPT, { "operator.signal.interests.tags": "union" });
    const nonZero = baseline.filter((c) => c.query.affinity > 0);
    expect(spearman(nonZero.map((c) => c.query.affinity), nonZero.map((c) => c.query.popularity ?? 0))).toBeGreaterThan(0.6);

    const baseByHash = new Map(baseline.map((c) => [c.location.geohash, c.query.affinity_rank ?? 0]));
    const shared = concept.filter((c) => baseByHash.has(c.location.geohash));
    expect(shared.length).toBeGreaterThan(concept.length * 0.9);
    expect(shared.length).toBeLessThan(concept.length + baseline.length);
    // Cells where the concept ranks far above the baseline: the planted pockets.
    const lifted = shared.filter((c) => (c.query.affinity_rank ?? 0) - (baseByHash.get(c.location.geohash) ?? 0) > 0.25);
    expect(lifted.length).toBeGreaterThanOrEqual(5);
    expect(concept.some((c) => c.query.affinity === 0)).toBe(true);
  });

  it("returns no cells for descriptive *:qloo:* tags alone (G6)", async () => {
    expect(await heatmap(await locality("Austin"), ["urn:tag:cuisine:qloo:mock_ramen", "urn:tag:amenity:qloo:mock_patio"])).toEqual([]);
  });
});

describe("mock urn:tag fingerprints", () => {
  const POINT = "POINT(-86.74725 36.1868)";
  const POLYGON = "POLYGON((-86.752 36.182, -86.7425 36.182, -86.7425 36.1916, -86.752 36.1916, -86.752 36.182))";

  async function fingerprint(params: QlooParams) {
    return QlooTagInsightsResponse.parse(await body("/v2/insights", { "filter.type": "urn:tag", take: 50, ...params }));
  }

  it("returns 50 rows covering WHO, VIBE, WHAT and SOUND with affinity and a panel size", async () => {
    const result = await fingerprint({ "signal.location": POLYGON });
    expect(result.results.tags).toHaveLength(50);
    const subtypes = new Set(result.results.tags.map((t) => t.subtype));
    for (const family of ["urn:tag:customer_identity:qloo", "urn:tag:ambience:qloo", "urn:tag:genre:music"]) expect(subtypes).toContain(family);
    expect(subtypes.has("urn:tag:genre:place") || subtypes.has("urn:tag:category:place")).toBe(true);
    expect(result.results.tags.every((t) => typeof t.query?.affinity === "number")).toBe(true);
    expect(result.query?.geospatial?.panel_size?.context).toBeGreaterThan(result.query?.geospatial?.panel_size?.target ?? 0);
  });

  it("gives a POINT and a POLYGON around it byte-identical rows (G8)", async () => {
    const point = await fingerprint({ "signal.location": POINT });
    const polygon = await fingerprint({ "signal.location": POLYGON });
    expect(point).toEqual(polygon);
  });

  it("respects filter.tag.types (50 of 50 WHO tags)", async () => {
    const result = await fingerprint({ "signal.location": POLYGON, "filter.tag.types": ["urn:tag:customer_identity:qloo"] });
    expect(result.results.tags).toHaveLength(50);
    expect(result.results.tags.every((t) => t.tag_id.startsWith("urn:tag:customer_identity:qloo:"))).toBe(true);
  });

  it("differs between an area and its city, and matches the locality id with its name", async () => {
    const city = await fingerprint({ "signal.location": await locality("Nashville") });
    const byName = await fingerprint({ "signal.location.query": "Nashville" });
    const area = await fingerprint({ "signal.location": POLYGON });
    expect(byName).toEqual(city);
    expect(area.results.tags.map((t) => t.tag_id)).not.toEqual(city.results.tags.map((t) => t.tag_id));
  });
});

describe("mock urn:demographics", () => {
  it("returns one block per entity up to take, six age buckets and gender in −1..1, with rare gaps", async () => {
    const ids = Array.from({ length: 30 }, (_, i) => `ent-demo-${String(i + 1).padStart(2, "0")}`);
    const params = { "filter.type": "urn:demographics", "signal.interests.entities": ids };
    const blocks = QlooDemographicsResponse.parse(await body("/v2/insights", { ...params, take: 50 })).results.demographics;
    expect(blocks.length).toBeLessThanOrEqual(30);
    expect(blocks.length).toBeGreaterThanOrEqual(24);
    for (const block of blocks) {
      expect(ids).toContain(block.entity_id);
      expect(Object.keys(block.query.age).sort()).toEqual([...AgeBucket.options].sort());
      for (const v of [...Object.values(block.query.age), block.query.gender.male, block.query.gender.female]) {
        expect(v).toBeGreaterThanOrEqual(-1);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
    const capped = QlooDemographicsResponse.parse(await body("/v2/insights", params)).results.demographics;
    expect(capped.length).toBeLessThanOrEqual(20);
  });

  it("leaves about one entity in fifteen without a block", async () => {
    const ids = Array.from({ length: 30 }, (_, i) => `ent-gap-${String(i + 1).padStart(2, "0")}`);
    const more = Array.from({ length: 30 }, (_, i) => `ent-gap-${String(i + 31).padStart(2, "0")}`);
    let missing = 0;
    for (const batch of [ids, more]) {
      const blocks = QlooDemographicsResponse.parse(
        await body("/v2/insights", { "filter.type": "urn:demographics", "signal.interests.entities": batch, take: 50 }),
      ).results.demographics;
      missing += batch.length - blocks.length;
    }
    expect(missing).toBeGreaterThanOrEqual(1);
    expect(missing).toBeLessThanOrEqual(12);
  });
});

describe("mock /v2/trending", () => {
  const window = { "filter.start_date": PROBE_FACTS.trendingWindow.start, "filter.end_date": PROBE_FACTS.trendingWindow.end, take: 50 };

  it("returns 46 step-shaped points newest first inside the window, with a string rank", async () => {
    for (const type of PROBE_FACTS.trendingTypes) {
      const points = QlooTrendingResponse.parse(
        await body("/v2/trending", { "filter.type": type, "signal.interests.entities": ["ent-trend-01"], ...window }),
      ).results.trending;
      expect(points).toHaveLength(46);
      const dates = points.map((p) => p.date);
      expect([...dates].sort().reverse()).toEqual(dates);
      expect(dates[0]).toBe(PROBE_FACTS.trendingWindow.end);
      expect(dates[45]).toBe(PROBE_FACTS.trendingWindow.start);
      for (const p of points) {
        expect(p.population_percentile).toBeGreaterThan(0);
        expect(p.population_percentile).toBeLessThan(1);
        expect(p.population_rank).toMatch(/^\d+$/);
      }
      const carried = points.slice(1).filter((p, i) => p.population_percentile === points[i]?.population_percentile).length;
      expect(carried).toBeGreaterThan(10);
    }
  });

  it("varies across entities, includes flat placeholders, and is empty for artists and persons (G11)", async () => {
    const distinct = new Set<number>();
    let flat = 0;
    for (let i = 1; i <= 30; i++) {
      const points = QlooTrendingResponse.parse(
        await body("/v2/trending", { "filter.type": "urn:entity:brand", "signal.interests.entities": [`ent-series-${i}`], ...window }),
      ).results.trending;
      const values = new Set(points.map((p) => p.population_percentile));
      if (values.size === 1) flat++;
      distinct.add(values.size);
    }
    expect(flat).toBeGreaterThanOrEqual(1);
    expect(flat).toBeLessThan(10);
    expect(distinct.size).toBeGreaterThan(3);
    for (const type of ["urn:entity:artist", "urn:entity:person"]) {
      const points = QlooTrendingResponse.parse(
        await body("/v2/trending", { "filter.type": type, "signal.interests.entities": ["ent-trend-01"], ...window }),
      ).results.trending;
      expect(points).toEqual([]);
    }
  });
});

describe("mock /v2/tags and /v2/audiences", () => {
  it("returns 5–10 concept tags with parent types, including taxonomy tags signals can use", async () => {
    for (const [query, parent] of [
      ["craft beer", "urn:entity:brand"],
      ["natural wine", "urn:entity:place"],
      ["cafe", "urn:entity:place"],
    ] as const) {
      const tags = QlooTagsResponse.parse(
        await body("/v2/tags", { "filter.query": query, "feature.semantic_search": true, "filter.parents.types": [parent], take: 20 }),
      ).results.tags;
      expect(tags.length).toBeGreaterThanOrEqual(5);
      expect(tags.length).toBeLessThanOrEqual(10);
      expect(tags.every((t) => t.parents?.some((p) => p.type === parent))).toBe(true);
      expect(tags.some((t) => /^urn:tag:(genre|category):/.test(t.id))).toBe(true);
      expect(tags.some((t) => t.id.includes(":qloo:"))).toBe(true);
    }
    const cafe = QlooTagsResponse.parse(await body("/v2/tags", { "filter.query": "cafe", "filter.parents.types": ["urn:entity:place"] })).results.tags;
    expect(cafe.map((t) => t.id)).toContain("urn:tag:category:place:cafe");
  });

  it("restricts concept tags to filter.tag.types", async () => {
    const tags = QlooTagsResponse.parse(
      await body("/v2/tags", { "filter.query": "craft beer", "filter.parents.types": ["urn:entity:brand"], "filter.tag.types": ["urn:tag:genre:brand"] }),
    ).results.tags;
    expect(tags.length).toBeGreaterThanOrEqual(5);
    expect(tags.every((t) => t.type === "urn:tag:genre:brand")).toBe(true);
  });

  it("lists audiences across parents, denied ones included, and filters by parent type", async () => {
    const all = QlooAudiencesResponse.parse(await body("/v2/audiences", { take: 50 })).results.audiences;
    const parents = new Set(all.flatMap((a) => (a.parents ?? []).map((p) => p.type)));
    for (const parent of ["leisure", "hobbies_and_interests", "communities", "political_preferences"]) expect(parents).toContain(`urn:audience:${parent}`);
    for (const a of all) expect(a.id).toMatch(/^urn:audience:[a-z_]+:mock_[a-z0-9_]+$/);

    const leisure = QlooAudiencesResponse.parse(await body("/v2/audiences", { "filter.parents.types": ["urn:audience:leisure"], take: 50 })).results.audiences;
    expect(leisure.length).toBeGreaterThan(0);
    expect(leisure.every((a) => a.id.startsWith("urn:audience:leisure:"))).toBe(true);
    expect(QlooAudiencesResponse.parse(await body("/v2/audiences", { take: 3 })).results.audiences).toHaveLength(3);
  });

  it("lists at least one audience for every family a desk may use (D21)", async () => {
    const families = new Set(Object.values(AUDIENCE_ALLOWLIST.desks).flat());
    for (const family of families) {
      const rows = QlooAudiencesResponse.parse(await body("/v2/audiences", { "filter.parents.types": [`urn:audience:${family}`], take: 50 })).results.audiences;
      expect(rows.length, family).toBeGreaterThan(0);
      expect(rows.every((a) => a.id.startsWith(`urn:audience:${family}:`)), family).toBe(true);
    }
  });
});
