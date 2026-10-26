import {
  insightsResponseSchema,
  InsightsFilterType,
  QlooAudiencesResponse,
  QlooEntitiesResponse,
  type QlooParams,
  QlooSearchResponse,
  QlooTagsResponse,
  QlooTrendingResponse,
} from "@ct/contracts";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { ALLOW, ANY_TYPE, PROBE_FACTS, type QlooPath } from "../src/allowlist";
import { canonicalize } from "../src/canonical";
import { createMockTransport, type MockTransportOptions } from "../src/mock";

// Synthetic transport: every request below uses invented names and ids only (D29).

const decoder = new TextDecoder();
/** The client's canonical form, under the mock cache namespace as QLOO_MOCK=1 runs it. */
const request = (path: QlooPath, params: QlooParams) => canonicalize(path, params, "mock-v1");

async function call(path: QlooPath, params: QlooParams, options?: MockTransportOptions) {
  const response = await createMockTransport(options)(request(path, params));
  return { response, body: JSON.parse(decoder.decode(response.body)) as Record<string, unknown> };
}

async function firstId(query: string, type: string): Promise<string> {
  const { body } = await call("/search", { query, types: [type], take: 5 });
  return (QlooSearchResponse.parse(body).results[0] as { entity_id: string }).entity_id;
}

const UUID_SHAPE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const POLYGON = "POLYGON((-86.75 36.18, -86.74 36.18, -86.74 36.19, -86.75 36.19, -86.75 36.18))";

interface Case {
  path: QlooPath;
  type: string;
  params: QlooParams;
}

/** One realistic request per allowlisted path × filter.type, using every allowlisted parameter at least once. */
async function allowlistCases(): Promise<Case[]> {
  const brand = await firstId("Brand Alpha", "urn:entity:brand");
  const brandB = await firstId("Brand Beta", "urn:entity:brand");
  const artist = await firstId("Artist Nova", "urn:entity:artist");
  const nashville = await firstId("Nashville", "urn:entity:locality");
  const austin = await firstId("Austin", "urn:entity:locality");
  const place = await firstId("Lantern Row Coffee", "urn:entity:place");
  const insights = (type: string, params: QlooParams): Case => ({ path: "/v2/insights", type, params: { "filter.type": type, ...params } });
  const media = (type: string): Case =>
    insights(type, {
      "signal.interests.entities": [artist, brand],
      "signal.interests.tags": ["urn:tag:genre:music:mock_americana"],
      "feature.explainability": true,
      "filter.popularity.max": 0.95,
      take: 15,
    });
  return [
    { path: "/search", type: ANY_TYPE, params: { query: "Porchlight Coffee", types: ["urn:entity:place"], take: 5, "filter.location": "36.18,-86.75", "filter.radius": 2 } },
    { path: "/entities", type: ANY_TYPE, params: { entity_ids: [brand, artist, "ent-alpha-01"] } },
    insights("urn:entity:brand", {
      "signal.interests.entities": [brand],
      "signal.interests.tags": ["urn:tag:genre:brand:mock_snacks"],
      "signal.demographics.audiences": ["urn:audience:leisure:mock_trail_runners"],
      "signal.demographics.age": "35_and_younger",
      "signal.location": nashville,
      "filter.popularity.max": 0.99,
      "filter.tags": ["urn:tag:genre:brand:mock_beverages"],
      "filter.exclude.entities": [brandB],
      "filter.exclude.tags": ["urn:tag:genre:brand:mock_apparel"],
      "feature.explainability": true,
      take: 20,
    }),
    insights("urn:entity:brand", { "signal.location.query": "Austin", "filter.results.entities": [brand, brandB, artist] }),
    media("urn:entity:artist"),
    insights("urn:entity:artist", { "signal.interests.entities": [brand], "filter.results.entities": [artist] }),
    media("urn:entity:podcast"),
    media("urn:entity:tv_show"),
    media("urn:entity:movie"),
    insights("urn:entity:person", { "signal.location": austin, take: 10 }),
    insights("urn:entity:person", { "signal.location": nashville, "filter.results.entities": ["ent-person-01", "ent-person-02", "ent-person-03"] }),
    insights("urn:entity:person", { "signal.demographics.age": ["24_and_younger"], "filter.results.entities": ["ent-person-01", "ent-person-02", "ent-person-03"] }),
    insights("urn:entity:destination", { "signal.interests.entities": [artist], "filter.geocode.country_code": "US", take: 50, page: 2 }),
    insights("urn:entity:destination", { "signal.interests.entities": [artist], "filter.results.entities": ["ent-dest-01", "ent-dest-02"] }),
    insights("urn:entity:place", { "filter.location": austin, "filter.tags": ["urn:tag:category:place:cafe"], take: 50, page: 1 }),
    insights("urn:entity:place", { "signal.interests.entities": [artist], "filter.results.entities": [place] }),
    insights("urn:entity:place", { "signal.location": austin, "filter.results.entities": [place] }),
    insights("urn:heatmap", { "filter.location": nashville, "signal.interests.tags": [PROBE_FACTS.heatmapBaselineTag] }),
    insights("urn:heatmap", { "filter.location": austin, "signal.interests.tags": ["urn:tag:genre:place:mock_ramen", "urn:tag:genre:place:restaurant:bar"] }),
    insights("urn:heatmap", { "filter.location": austin, "signal.interests.entities": [brand] }),
    insights("urn:tag", { "signal.location": POLYGON, take: 50 }),
    insights("urn:tag", { "signal.location.query": "East Nashville, Nashville", "filter.tag.types": ["urn:tag:customer_identity:qloo"], take: 50 }),
    insights("urn:demographics", { "signal.interests.entities": [brand, brandB, artist], take: 50 }),
    { path: "/v2/tags", type: ANY_TYPE, params: { "filter.query": "craft beer", "feature.semantic_search": true, "filter.parents.types": ["urn:entity:brand"], take: 10 } },
    { path: "/v2/tags", type: ANY_TYPE, params: { "filter.query": "cafe", "filter.parents.types": ["urn:entity:place"], "filter.tag.types": ["urn:tag:category:place"], take: 10 } },
    { path: "/v2/audiences", type: ANY_TYPE, params: { "filter.parents.types": ["urn:audience:leisure"], take: 50 } },
    {
      path: "/v2/trending",
      type: ANY_TYPE,
      params: {
        "filter.type": "urn:entity:brand",
        "signal.interests.entities": [brand],
        "filter.start_date": PROBE_FACTS.trendingWindow.start,
        "filter.end_date": PROBE_FACTS.trendingWindow.end,
        take: 50,
      },
    },
  ];
}

function schemaFor(c: Case): z.ZodType {
  switch (c.path) {
    case "/search":
      return QlooSearchResponse;
    case "/entities":
      return QlooEntitiesResponse;
    case "/v2/tags":
      return QlooTagsResponse;
    case "/v2/audiences":
      return QlooAudiencesResponse;
    case "/v2/trending":
      return QlooTrendingResponse;
    case "/v2/insights":
      return insightsResponseSchema(InsightsFilterType.parse(c.type));
  }
}

/** The number of rows in whichever results list the body carries. */
function rowCount(body: Record<string, unknown>): number {
  const results = body.results;
  if (Array.isArray(results)) return results.length;
  const lists = Object.values(results as Record<string, unknown>).filter(Array.isArray);
  return lists.reduce((n, list) => n + list.length, 0);
}

describe("mock transport: allowlist coverage", () => {
  it("answers every allowlisted path × filter.type with 200, a schema-valid body and rows", async () => {
    const cases = await allowlistCases();
    const covered = new Set(cases.map((c) => `${c.path}|${c.type}`));
    for (const [path, types] of Object.entries(ALLOW)) {
      for (const type of Object.keys(types)) expect(covered, `${path} × ${type}`).toContain(`${path}|${type}`);
    }
    const used = new Set<string>();
    for (const c of cases) {
      const table = ALLOW[c.path][c.type] ?? {};
      for (const key of Object.keys(c.params)) {
        expect(table, `${c.path} × ${c.type} allowlists ${key}`).toHaveProperty([key]);
        used.add(`${c.path}|${c.type}|${key}`);
      }
      const { response, body } = await call(c.path, c.params);
      expect(response.status, `${c.path} × ${c.type}`).toBe(200);
      expect(schemaFor(c).safeParse(body).success, `${c.path} × ${c.type} parses`).toBe(true);
      expect(rowCount(body), `${c.path} × ${c.type} has rows`).toBeGreaterThan(0);
    }
    for (const [path, types] of Object.entries(ALLOW)) {
      for (const [type, table] of Object.entries(types)) {
        for (const key of Object.keys(table)) expect(used, `${path} × ${type} exercises ${key}`).toContain(`${path}|${type}|${key}`);
      }
    }
  });

  it("answers unknown combinations with HTTP 400 and an error message", async () => {
    const bad: Array<[QlooPath, QlooParams]> = [
      ["/v2/insights", { "filter.type": "urn:entity:spaceship", "signal.interests.entities": ["ent-alpha-01"] }],
      ["/v2/insights", { "signal.interests.entities": ["ent-alpha-01"] }],
      ["/v2/insights", { "filter.type": "urn:demographics" }],
      ["/v2/insights", { "filter.type": "urn:heatmap", "filter.location": "ent-city-01" }],
      ["/v2/insights", { "filter.type": "urn:heatmap", "signal.interests.tags": ["urn:tag:genre:place:restaurant"], "operator.signal.interests.tags": "xor" }],
      ["/v2/trending", { "filter.type": "urn:entity:brand", "signal.interests.entities": ["ent-alpha-01"] }],
      ["/v2/trending", { "filter.type": "urn:entity:brand", "signal.interests.entities": ["ent-alpha-01"], "filter.start_date": "2025-09-30", "filter.end_date": "2025-04-01" }],
      ["/v2/trending", { "filter.type": "urn:heatmap", "signal.interests.entities": ["ent-alpha-01"], "filter.start_date": "2025-04-01", "filter.end_date": "2025-09-30" }],
      ["/search", { types: ["urn:entity:brand"] }],
      ["/search", { query: "Brand Alpha", types: ["brand"] }],
      ["/entities", {}],
      ["/v2/insights", { "filter.type": "urn:entity:brand", "signal.interests.entities": ["ent-alpha-01"], take: "many" }],
    ];
    for (const [path, params] of bad) {
      const { response, body } = await call(path, params);
      expect(response.status, JSON.stringify(params)).toBe(400);
      expect(typeof body.error).toBe("string");
    }
  });
});

describe("mock transport: determinism and headers", () => {
  it("returns the same bytes for every allowlisted request, across transport instances", async () => {
    // The process-wide /search memory is the one state bodies read: the cases search their seeds
    // first, so two fresh transports must agree byte for byte.
    for (const c of await allowlistCases()) {
      const canonical = request(c.path, c.params);
      const a = await createMockTransport()(canonical);
      const b = await createMockTransport()(canonical);
      expect(Buffer.from(a.body).equals(Buffer.from(b.body)), `${c.path} × ${c.type}`).toBe(true);
      expect(a.headers).toEqual(b.headers);
    }
  });

  it("sends rate-limit headers and a non-UUID request id derived from the canonical key", async () => {
    const one = await call("/search", { query: "Brand Alpha", types: ["urn:entity:brand"] });
    const two = await call("/search", { query: "Brand Beta", types: ["urn:entity:brand"] });
    for (const { response } of [one, two]) {
      expect(response.headers.requestId).toMatch(/^mock-[0-9a-f]{16}$/);
      expect(response.headers.requestId).not.toMatch(UUID_SHAPE);
      expect(response.headers.monthLimit).toBe(50_000);
      expect(response.headers.monthRemaining).toBeGreaterThan(38_000);
      expect(response.headers.secondLimit).toBeGreaterThan(0);
      expect(response.headers.secondRemaining).not.toBeNull();
      expect(response.headers.secondReset).not.toBeNull();
    }
    expect(one.response.headers.requestId).not.toBe(two.response.headers.requestId);
  });

  it("never emits UUID-shaped values in any body", async () => {
    for (const c of await allowlistCases()) {
      const { response } = await call(c.path, c.params);
      expect(decoder.decode(response.body)).not.toMatch(UUID_SHAPE);
    }
  });
});

describe("mock transport: latency and faults", () => {
  it("waits latencyMs per attempt and reports wall time", async () => {
    const started = performance.now();
    const { response } = await call("/v2/audiences", { take: 5 }, { latencyMs: 40 });
    expect(performance.now() - started).toBeGreaterThanOrEqual(35);
    expect(response.ms).toBeGreaterThanOrEqual(35);
  });

  it("rejects with the abort reason when the signal fires during the latency", async () => {
    const transport = createMockTransport({ latencyMs: 5_000 });
    const controller = new AbortController();
    const pending = transport(request("/v2/audiences", {}), controller.signal);
    controller.abort(new Error("caller gave up"));
    await expect(pending).rejects.toThrow("caller gave up");
    const aborted = AbortSignal.abort(new Error("already aborted"));
    await expect(createMockTransport()(request("/v2/audiences", {}), aborted)).rejects.toThrow("already aborted");
  });

  it("injects faults by query substring, a limited number of times", async () => {
    const transport = createMockTransport({
      faults: [
        { match: "query=Brand Alpha", status: 429, times: 2 },
        { match: "query=Locked", status: 401 },
        { match: "/v2/tags?", status: 500, times: 1 },
        { match: "query=Busy", status: 200, body: { error_msg: "slow down" } },
      ],
    });
    const search = (query: string) => transport(request("/search", { query, types: ["urn:entity:brand"] }));
    const first = await search("Brand Alpha");
    expect(first.status).toBe(429);
    expect(first.headers.secondRemaining).toBe(0);
    expect(JSON.parse(decoder.decode(first.body))).toEqual({ error: "rate limit exceeded" });
    expect((await search("Brand Alpha")).status).toBe(429);
    expect((await search("Brand Alpha")).status).toBe(200);
    expect((await search("Locked Brand")).status).toBe(401);
    expect((await search("Locked Brand")).status).toBe(401);
    const busy = await search("Busy Brand");
    expect(busy.status).toBe(200);
    expect(JSON.parse(decoder.decode(busy.body))).toEqual({ error_msg: "slow down" });
    const tags = () => transport(request("/v2/tags", { "filter.query": "beer" }));
    expect((await tags()).status).toBe(500);
    expect((await tags()).status).toBe(200);
  });
});
