import {
  type QlooEntity,
  QlooEntitiesResponse,
  QlooEntityInsightsResponse,
  type QlooParams,
  type QlooSearchEntity,
  QlooSearchResponse,
} from "@ct/contracts";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { QlooPath } from "../src/allowlist";
import { canonicalize } from "../src/canonical";
import { createMockTransport } from "../src/mock";
import { lookupRecord, universe } from "../src/mock/entities";
import { entityId } from "../src/mock/ids";
import { METROS } from "../src/mock/metros";
import { nameForId, normalizeName } from "../src/mock/names";

// Synthetic transport: invented names and ids only (D29).

const transport = createMockTransport();
const decoder = new TextDecoder();
/** The client's canonical form, under the mock cache namespace as QLOO_MOCK=1 runs it. */
const request = (path: QlooPath, params: QlooParams) => canonicalize(path, params, "mock-v1");

async function body(path: QlooPath, params: QlooParams): Promise<unknown> {
  const response = await transport(request(path, params));
  expect(response.status, `${path} ${JSON.stringify(params)}`).toBe(200);
  return JSON.parse(decoder.decode(response.body));
}

async function search(query: string, type = "urn:entity:brand", take = 5): Promise<QlooSearchEntity[]> {
  return QlooSearchResponse.parse(await body("/search", { query, types: [type], take })).results;
}

async function insights(params: QlooParams): Promise<QlooEntity[]> {
  return QlooEntityInsightsResponse.parse(await body("/v2/insights", { "filter.type": "urn:entity:brand", ...params })).results.entities;
}

async function insightsBody(params: QlooParams) {
  return QlooEntityInsightsResponse.parse(await body("/v2/insights", params));
}

/** Resolution-gate style normal form, enough to compare names here. */
const norm = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !["inc", "co", "company", "llc", "ltd", "the"].includes(w))
    .join(" ");

const affinityOf = (rows: QlooEntity[], id: string): number | undefined => rows.find((r) => r.entity_id === id)?.query?.affinity;

const ENTITY_TYPES = [
  "urn:entity:brand",
  "urn:entity:artist",
  "urn:entity:podcast",
  "urn:entity:tv_show",
  "urn:entity:movie",
  "urn:entity:person",
  "urn:entity:destination",
  "urn:entity:place",
] as const;

interface MarketConfig {
  id: string;
  query: string;
  state_name: string;
  center?: { lat: number; lon: number };
}

/** Every locality the app resolves by name: the config/metros.json gazetteer, reserved metros and markets. */
function configuredLocalities(): MarketConfig[] {
  const config = JSON.parse(readFileSync(new URL("../../../config/metros.json", import.meta.url), "utf8")) as Record<string, unknown>;
  return ["gazetteer", "reserved", "markets"].flatMap((key) => (config[key] ?? []) as MarketConfig[]);
}

describe("mock /search", () => {
  it("echoes the exact name first with the requested type, then 2–4 non-exact variants", async () => {
    for (const [query, type] of [
      ["Brand Alpha", "urn:entity:brand"],
      ["artist nova", "urn:entity:artist"],
      ["Yellow Valley", "urn:entity:tv_show"],
    ] as const) {
      const results = await search(query, type, 10);
      const [first, ...rest] = results;
      expect(norm(first?.name ?? "")).toBe(norm(query));
      expect(first?.types).toEqual([type]);
      expect(rest.length).toBeGreaterThanOrEqual(2);
      expect(rest.length).toBeLessThanOrEqual(4);
      for (const variant of rest) expect(norm(variant.name)).not.toBe(norm(query));
      for (const r of results) {
        expect(r.entity_id).toMatch(/^mock-ent-[0-9a-f]{12}$/);
        expect(r.popularity).toBeGreaterThan(0);
        expect(r.popularity).toBeLessThan(1);
      }
    }
  });

  it("title-cases an all-lowercase query and resolves spellings of one name to one id", async () => {
    const [lower] = await search("brand alpha");
    const [suffixed] = await search("The Brand Alpha Inc.");
    expect(lower?.name).toBe("Brand Alpha");
    expect(suffixed?.entity_id).toBe(lower?.entity_id);
  });

  it("gives brands one invented genre:brand tag from the family set plus descriptive facets", async () => {
    const [brand] = await search("Brand Alpha");
    const genres = (brand?.tags ?? []).filter((t) => t.type === "urn:tag:genre:brand");
    expect(genres).toHaveLength(1);
    expect(genres[0]?.tag_id).toMatch(/^urn:tag:genre:brand:mock_(beverages|apparel|snacks|outdoor|beauty)$/);
    const namespaces = new Set((brand?.tags ?? []).map((t) => t.type));
    expect(namespaces.size).toBeGreaterThanOrEqual(5);
  });

  it("returns only variants for a 'notfound' query", async () => {
    const results = await search("Brand Notfound Example");
    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(results.some((r) => norm(r.name) === norm("Brand Notfound Example"))).toBe(false);
  });

  it("returns two exact matches told apart by disambiguation for a 'twin' query", async () => {
    const results = await search("Twin Harbor", "urn:entity:tv_show");
    const exact = results.filter((r) => norm(r.name) === norm("Twin Harbor"));
    expect(exact).toHaveLength(2);
    expect(exact[0]?.entity_id).not.toBe(exact[1]?.entity_id);
    expect(exact[0]?.disambiguation).not.toBe(exact[1]?.disambiguation);
    expect(results.slice(0, 2)).toEqual(exact);
  });

  it("respects take", async () => {
    expect(await search("Brand Alpha", "urn:entity:brand", 1)).toHaveLength(1);
  });

  it("places a located place search near the given point, with geocode and address", async () => {
    const [place] = await search("Nova Corner Espresso", "urn:entity:place");
    const located = QlooSearchResponse.parse(
      await body("/search", { query: "Nova Corner Espresso", types: ["urn:entity:place"], "filter.location": "36.18,-86.75", "filter.radius": 1 }),
    ).results[0];
    const location = (located as { location?: { lat: number; lon: number } }).location;
    expect(Math.abs((location?.lat ?? 0) - 36.18)).toBeLessThan(0.02);
    expect(Math.abs((location?.lon ?? 0) + 86.75)).toBeLessThan(0.02);
    expect(located?.properties).toMatchObject({ geocode: { city: "Nashville", country_code: "US" }, neighborhood: "East Nashville" });
    expect(typeof located?.properties?.address).toBe("string");
    expect(place?.entity_id).not.toBe(located?.entity_id);
  });

  it("names the market city around a located place outside the mock metros, and no city when none is near", async () => {
    const located = async (point: string) =>
      QlooSearchResponse.parse(
        await body("/search", { query: "Lakeside Espresso Bar", types: ["urn:entity:place"], "filter.location": point, "filter.radius": 1 }),
      ).results[0];
    const chicago = await located("41.88,-87.63");
    const at = (chicago as { location?: { lat: number; lon: number } }).location;
    expect(Math.abs((at?.lat ?? 0) - 41.88)).toBeLessThan(0.02);
    expect(Math.abs((at?.lon ?? 0) + 87.63)).toBeLessThan(0.02);
    expect(chicago?.disambiguation).toBe("Chicago, IL");
    expect(chicago?.properties).toMatchObject({ geocode: { city: "Chicago", admin1_region: "Illinois", country_code: "US" } });
    expect(chicago?.properties?.neighborhood).toBeUndefined();
    const remote = await located("44.0,-103.0");
    expect(remote?.disambiguation).toBeNull();
    expect(remote?.properties?.geocode).toMatchObject({ city: null, metro: null, admin1_region: null, country_code: null });
    for (const row of [chicago, remote]) expect(JSON.stringify(row)).not.toContain("Austin");
  });

  it("returns destinations without geocode or location, as live destination search did", async () => {
    const [nashville] = await search("Nashville", "urn:entity:destination");
    expect(nashville?.properties?.geocode).toBeUndefined();
    expect((nashville as { location?: unknown }).location).toBeUndefined();
    const [row] = (
      await insightsBody({ "filter.type": "urn:entity:destination", "signal.interests.entities": ["ent-alpha-01"], "filter.results.entities": [nashville?.entity_id ?? ""] })
    ).results.entities;
    expect(row?.properties?.geocode).toMatchObject({ admin1_region: "Tennessee", country_code: "US" });
  });

  it("disambiguates known metro localities with their state", async () => {
    const [nashville] = await search("Nashville", "urn:entity:locality");
    expect(nashville?.disambiguation).toBe("Tennessee, United States");
  });

  it("resolves every config/metros.json locality by exact name and state, from the id alone too", async () => {
    const localities = configuredLocalities();
    expect(localities.length).toBeGreaterThan(30);
    for (const market of localities) {
      const [first] = await search(market.query, "urn:entity:locality");
      expect(norm(first?.name ?? ""), market.id).toBe(norm(market.query));
      expect(first?.disambiguation ?? "", market.id).toContain(market.state_name);
      const at = (first as { location?: { lat: number; lon: number } }).location;
      expect(at?.lat, market.id).toBeGreaterThan(24);
      expect(at?.lat, market.id).toBeLessThan(50);
      expect(at?.lon, market.id).toBeGreaterThan(-125);
      expect(at?.lon, market.id).toBeLessThan(-66);
      if (market.center) {
        expect(Math.abs((at?.lat ?? 0) - market.center.lat), market.id).toBeLessThan(0.1);
        expect(Math.abs((at?.lon ?? 0) - market.center.lon), market.id).toBeLessThan(0.1);
      }
      // A pinned locality id describes itself without this process's search memory.
      const fromId = lookupRecord(first?.entity_id ?? "", "urn:entity:locality");
      expect(fromId.name, market.id).toBe(first?.name);
      expect(fromId.disambiguation, market.id).toBe(first?.disambiguation);
    }
  });
});

describe("mock /entities", () => {
  it("describes every id in the /search shape, consistent with insights rows", async () => {
    const rows = await insights({ "signal.interests.entities": ["ent-alpha-01"], take: 3 });
    const ids = [...rows.map((r) => r.entity_id), "ent-alpha-01"];
    const described = QlooEntitiesResponse.parse(await body("/entities", { entity_ids: ids })).results;
    expect(described).toHaveLength(ids.length);
    for (const row of rows) {
      const match = described.find((d) => d.entity_id === row.entity_id);
      expect(match?.name).toBe(row.name);
      expect(match?.types).toEqual(["urn:entity:brand"]);
    }
  });

  it("recovers the type of mock ids", async () => {
    const [artist] = QlooEntityInsightsResponse.parse(
      await body("/v2/insights", { "filter.type": "urn:entity:artist", "signal.interests.entities": ["ent-alpha-01"], take: 1 }),
    ).results.entities;
    const [described] = QlooEntitiesResponse.parse(await body("/entities", { entity_ids: [artist?.entity_id ?? ""] })).results;
    expect(described?.types).toEqual(["urn:entity:artist"]);
    expect(described?.name).toBe(artist?.name);
  });

  it("remembers searched names process-wide, so rows for those ids show them in every transport", async () => {
    const [found] = await search("Brand Gamma");
    const id = found?.entity_id ?? "";
    const json = async (path: QlooPath, params: QlooParams) =>
      JSON.parse(decoder.decode((await createMockTransport()(request(path, params))).body)) as unknown;
    const [described] = QlooEntitiesResponse.parse(await json("/entities", { entity_ids: [id] })).results;
    expect(described?.name).toBe("Brand Gamma");
    const [row] = QlooEntityInsightsResponse.parse(
      await json("/v2/insights", { "filter.type": "urn:entity:brand", "signal.interests.entities": ["ent-alpha-01"], "filter.results.entities": [id] }),
    ).results.entities;
    expect(row?.name).toBe("Brand Gamma");
  });

  it("describes a mock id this process never searched with an invented name that repeats no universe name", async () => {
    // What a new process sees for an id a cached /search handed out before a restart.
    const id = entityId("urn:entity:brand", normalizeName("Brand Omega"));
    const [unseen] = QlooEntitiesResponse.parse(await body("/entities", { entity_ids: [id] })).results;
    expect(unseen?.types).toEqual(["urn:entity:brand"]);
    expect(unseen?.name).not.toBe("Brand Omega");
    expect(universe("urn:entity:brand").map((r) => r.name)).not.toContain(unseen?.name);
    const [searched] = await search("Brand Omega");
    expect(searched?.entity_id).toBe(id);
    expect(searched?.popularity).toBe(unseen?.popularity);

    for (const type of ENTITY_TYPES) {
      const taken = new Set((type === "urn:entity:place" ? METROS.flatMap((m) => universe(type, m)) : universe(type)).map((r) => r.name));
      for (let i = 0; i < 300; i++) expect(taken.has(nameForId(type, `ent-probe-${i}`)), `${type} ent-probe-${i}`).toBe(false);
    }
  });
});

describe("mock /v2/insights entities", () => {
  it("ranks `take` invented entities by descending affinity, 20 by default", async () => {
    const [seed] = await search("Brand Alpha");
    const rows = await insights({ "signal.interests.entities": [seed?.entity_id ?? ""] });
    expect(rows).toHaveLength(20);
    const affinities = rows.map((r) => r.query?.affinity ?? -1);
    expect([...affinities].sort((a, b) => b - a)).toEqual(affinities);
    expect(rows.every((r) => r.subtype === "urn:entity:brand" && r.type === "urn:entity")).toBe(true);
    expect(await insights({ "signal.interests.entities": [seed?.entity_id ?? ""], take: 7 })).toHaveLength(7);
  });

  it("scores entity pairs symmetrically", async () => {
    const ids = ["ent-alpha-01", "ent-beta-02", "ent-gamma-03", "ent-delta-04", "ent-epsilon-05"];
    for (const a of ids) {
      for (const b of ids) {
        if (a === b) continue;
        const ab = affinityOf(await insights({ "signal.interests.entities": [a], "filter.results.entities": [b] }), b);
        const ba = affinityOf(await insights({ "signal.interests.entities": [b], "filter.results.entities": [a] }), a);
        expect(ab).toBeDefined();
        expect(ab).toBe(ba);
      }
    }
  });

  it("keeps pair scores symmetric across filter types, for fixture ids and mock ids alike", async () => {
    const score = async (type: string, signal: string, candidate: string) =>
      affinityOf((await insightsBody({ "filter.type": type, "signal.interests.entities": [signal], "filter.results.entities": [candidate] })).results.entities, candidate);
    for (let i = 0; i < 40; i++) {
      const [a, b] = [`ent-a-${i}`, `ent-b-${i}`];
      const ab = await score("urn:entity:brand", a, b);
      expect(ab).toBeDefined();
      expect(await score("urn:entity:artist", b, a), `pair ${i}`).toBe(ab);
    }
    const [brand] = await search("Brand Alpha");
    const [artist] = await search("Artist Nova", "urn:entity:artist");
    const brandId = brand?.entity_id ?? "";
    const artistId = artist?.entity_id ?? "";
    expect(await score("urn:entity:brand", artistId, brandId)).toBe(await score("urn:entity:artist", brandId, artistId));
  });

  it("keeps a candidate's score independent of the candidate set, and equal to its open-call score", async () => {
    const open = await insights({ "signal.interests.entities": ["ent-alpha-01"], take: 30 });
    const ids = open.map((r) => r.entity_id);
    const full = await insights({ "signal.interests.entities": ["ent-alpha-01"], "filter.results.entities": ids, take: 50 });
    const subset = await insights({ "signal.interests.entities": ["ent-alpha-01"], "filter.results.entities": ids.slice(5, 12) });
    for (const id of ids.slice(5, 12)) {
      expect(affinityOf(subset, id)).toBe(affinityOf(full, id));
      expect(affinityOf(full, id)).toBe(affinityOf(open, id));
    }
  });

  it("gives about one candidate in eight the shared floor value, below every scored candidate", async () => {
    const candidates = Array.from({ length: 48 }, (_, i) => `ent-cand-${String(i + 1).padStart(2, "0")}`);
    const rows = await insights({ "signal.interests.entities": ["ent-alpha-01"], "filter.results.entities": candidates, take: 50 });
    expect(rows).toHaveLength(48);
    const values = rows.map((r) => r.query?.affinity ?? Number.NaN);
    const floor = Math.min(...values);
    const tied = values.filter((v) => v === floor).length;
    expect(tied).toBeGreaterThanOrEqual(2);
    expect(tied).toBeLessThanOrEqual(14);
    const scored = values.filter((v) => v !== floor);
    expect(Math.min(...scored)).toBeGreaterThan(floor);
    // The floor is one value shared across rows, not a per-row minimum.
    const other = await insights({ "signal.interests.entities": ["ent-beta-02"], "filter.results.entities": candidates, take: 50 });
    expect(Math.min(...other.map((r) => r.query?.affinity ?? Number.NaN))).toBe(floor);
  });

  it("gives a descriptive *:qloo:* tag signal a flat floor row (G1)", async () => {
    const rows = await insights({ "signal.interests.tags": ["urn:tag:product_category:qloo:mock_sparkling"], take: 10 });
    expect(new Set(rows.map((r) => r.query?.affinity)).size).toBe(1);
  });

  it("returns rows without affinity when there is no signal (G1 control)", async () => {
    const rows = await insights({ "filter.results.entities": ["ent-alpha-01", "ent-beta-02"] });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.query?.affinity === undefined)).toBe(true);
  });

  it("reshapes scores and drops about one candidate in eight per location or age context", async () => {
    const [nashville] = await search("Nashville", "urn:entity:locality");
    const candidates = Array.from({ length: 40 }, (_, i) => `ent-cand-${String(i + 1).padStart(2, "0")}`);
    const base = await insights({ "signal.interests.entities": ["ent-alpha-01"], "filter.results.entities": candidates, take: 50 });
    const byId = await insights({ "signal.interests.entities": ["ent-alpha-01"], "signal.location": nashville?.entity_id ?? "", "filter.results.entities": candidates, take: 50 });
    const byName = await insights({ "signal.interests.entities": ["ent-alpha-01"], "signal.location.query": "Nashville", "filter.results.entities": candidates, take: 50 });
    const byAge = await insights({ "signal.demographics.age": "55_and_older", "filter.results.entities": candidates, take: 50 });
    const byAudience = await insights({ "signal.demographics.audiences": ["urn:audience:leisure:mock_golfers"], "filter.results.entities": candidates, take: 50 });
    for (const rows of [byId, byAge, byAudience]) {
      expect(rows.length).toBeLessThan(40);
      expect(rows.length).toBeGreaterThanOrEqual(28);
    }
    expect(byId.map((r) => r.entity_id)).not.toEqual(base.map((r) => r.entity_id).filter((id) => byId.some((r) => r.entity_id === id)));
    // A locality id and the name it resolves from give identical rows (G2).
    expect(byName).toEqual(byId);
  });

  it("echoes the queried locality under query.localities.signal", async () => {
    const result = await insightsBody({ "filter.type": "urn:entity:brand", "signal.location.query": "Austin", take: 5 });
    const [austin] = await search("Austin", "urn:entity:locality");
    expect(result.query?.localities?.signal?.entity_id).toBe(austin?.entity_id);
    expect(result.query?.localities?.signal?.name).toBe("Austin");
  });

  it("honours filter.tags, filter.exclude.entities, filter.exclude.tags and filter.popularity.max", async () => {
    const tag = "urn:tag:genre:brand:mock_outdoor";
    const tagged = await insights({ "signal.interests.entities": ["ent-alpha-01"], "filter.tags": [tag], take: 30 });
    expect(tagged.length).toBeGreaterThan(10);
    expect(tagged.every((r) => r.tags?.some((t) => t.id === tag))).toBe(true);
    const foreign = "urn:tag:genre:brand:energy_drink";
    const foreignRows = await insights({ "signal.interests.entities": ["ent-alpha-01"], "filter.tags": [foreign], take: 30 });
    expect(foreignRows.length).toBeGreaterThan(10);
    expect(foreignRows.every((r) => r.tags?.some((t) => t.id === foreign))).toBe(true);

    const open = await insights({ "signal.interests.entities": ["ent-alpha-01"], take: 10 });
    const excluded = open.slice(0, 3).map((r) => r.entity_id);
    const rest = await insights({ "signal.interests.entities": ["ent-alpha-01"], "filter.exclude.entities": excluded, take: 10 });
    expect(rest.some((r) => excluded.includes(r.entity_id))).toBe(false);

    const noOutdoor = await insights({ "signal.interests.entities": ["ent-alpha-01"], "filter.exclude.tags": [tag], take: 50 });
    expect(noOutdoor.some((r) => r.tags?.some((t) => t.id === tag))).toBe(false);

    const capped = await insights({ "signal.interests.entities": ["ent-alpha-01"], "filter.popularity.max": 0.5, take: 30 });
    expect(capped.length).toBe(30);
    expect(capped.every((r) => (r.popularity ?? 1) <= 0.5)).toBe(true);
  });

  it("pages without overlap and filters destinations by country code", async () => {
    const params = { "filter.type": "urn:entity:destination", "signal.interests.entities": ["ent-alpha-01"], "filter.geocode.country_code": "US", take: 50 };
    const page1 = (await insightsBody({ ...params, page: 1 })).results.entities;
    const page2 = (await insightsBody({ ...params, page: 2 })).results.entities;
    expect(page1).toHaveLength(50);
    expect(page2).toHaveLength(50);
    const ids = new Set(page1.map((r) => r.entity_id));
    expect(page2.some((r) => ids.has(r.entity_id))).toBe(false);
    for (const row of [...page1, ...page2]) {
      expect(row.properties?.geocode?.country_code).toBe("US");
      expect(row.location).toBeDefined();
    }
    const world = (await insightsBody({ ...params, "filter.geocode.country_code": "JP", take: 50 })).results.entities;
    expect(world.every((r) => r.properties?.geocode?.country_code === "JP")).toBe(true);
  });

  it("attaches per-seed explainability shares and top-level effects when asked", async () => {
    const seeds = ["ent-alpha-01", "ent-beta-02"];
    const result = await insightsBody({ "filter.type": "urn:entity:artist", "signal.interests.entities": seeds, "feature.explainability": true, take: 15 });
    const rows = result.results.entities;
    expect(rows).toHaveLength(15);
    for (const row of rows) {
      const shares = row.query?.explainability?.["signal.interests.entities"] ?? [];
      expect(shares.map((s) => s.entity_id).sort()).toEqual(seeds);
      expect(Math.abs(shares.reduce((s, x) => s + x.score, 0) - 1)).toBeLessThan(0.001);
    }
    const effects = result.query?.explainability?.["signal.interests.entities"];
    for (const list of [effects?.effect_on_top3_recs, effects?.effect_on_top5_recs, effects?.effect_on_top10_recs, effects?.effect_on_all_recs]) {
      expect(list?.map((e) => e.entity_id).sort()).toEqual(seeds);
    }
    const plain = await insightsBody({ "filter.type": "urn:entity:artist", "signal.interests.entities": seeds, take: 15 });
    expect(plain.query).toBeUndefined();
    expect(plain.results.entities.every((r) => r.query?.explainability === undefined)).toBe(true);
  });

  it("returns metro places with geocode, address and a location inside the metro, carrying the filter tag", async () => {
    const [austin] = await search("Austin", "urn:entity:locality");
    const params = { "filter.type": "urn:entity:place", "filter.location": austin?.entity_id ?? "", "filter.tags": ["urn:tag:category:place:cafe"], take: 50 };
    const page1 = (await insightsBody({ ...params, page: 1 })).results.entities;
    const page2 = (await insightsBody({ ...params, page: 2 })).results.entities;
    expect(page1).toHaveLength(50);
    expect(page2.length).toBeGreaterThan(0);
    for (const row of [...page1, ...page2]) {
      expect(row.subtype).toBe("urn:entity:place");
      expect(row.tags?.some((t) => t.id === "urn:tag:category:place:cafe")).toBe(true);
      expect(row.properties?.geocode?.city).toBe("Austin");
      expect(typeof row.properties?.address).toBe("string");
      expect(row.location?.lat).toBeGreaterThan(30.1);
      expect(row.location?.lat).toBeLessThan(30.45);
      expect(row.location?.lon).toBeGreaterThan(-97.95);
      expect(row.location?.lon).toBeLessThan(-97.55);
    }
    const ids = new Set(page1.map((r) => r.entity_id));
    expect(page2.some((r) => ids.has(r.entity_id))).toBe(false);
  });
});
