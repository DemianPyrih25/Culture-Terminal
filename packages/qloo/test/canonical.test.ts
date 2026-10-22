import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildQueryString, canonicalize, redactParams } from "../src/canonical";
import { formatNumber } from "../src/geometry";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

describe("canonicalize", () => {
  it("gives the same key whatever the parameter order", () => {
    const a = canonicalize("/v2/insights", { "filter.type": "urn:entity:brand", take: 10, "signal.interests.entities": "ent-alpha-01" });
    const b = canonicalize("/v2/insights", { "signal.interests.entities": "ent-alpha-01", take: 10, "filter.type": "urn:entity:brand" });
    expect(a.key).toBe(b.key);
    expect(Object.keys(a.query)).toEqual(["filter.type", "signal.interests.entities", "take"]);
  });

  it("sorts and de-duplicates order-free lists, given as arrays or comma strings", () => {
    const a = canonicalize("/v2/insights", {
      "filter.type": "urn:entity:brand",
      "signal.interests.entities": ["ent-gamma-03", "ent-alpha-01", "ent-beta-02"],
      "filter.results.entities": "ent-beta-02, ent-alpha-01",
    });
    const b = canonicalize("/v2/insights", {
      "filter.type": "urn:entity:brand",
      "signal.interests.entities": "ent-beta-02,ent-gamma-03,ent-alpha-01,ent-alpha-01",
      "filter.results.entities": ["ent-alpha-01", "ent-beta-02"],
    });
    expect(a.key).toBe(b.key);
    expect(a.params["signal.interests.entities"]).toEqual(["ent-alpha-01", "ent-beta-02", "ent-gamma-03"]);
    expect(a.query["signal.interests.entities"]).toBe("ent-alpha-01,ent-beta-02,ent-gamma-03");
  });

  it("normalises number forms", () => {
    const keys = [10, "10", 10.0, " 10 "].map((take) => canonicalize("/search", { query: "Brand Alpha", take }).key);
    expect(new Set(keys).size).toBe(1);
    const pop = [0.5, "0.50", "0.5"].map(
      (v) => canonicalize("/v2/insights", { "filter.type": "urn:entity:brand", "filter.popularity.max": v }).query["filter.popularity.max"],
    );
    expect(pop).toEqual(["0.5", "0.5", "0.5"]);
  });

  it("writes numbers without exponents or trailing zeros", () => {
    expect(formatNumber(1e-7)).toBe("0.0000001");
    expect(formatNumber(2.5e-3)).toBe("0.0025");
    expect(formatNumber(1e21)).toBe("1000000000000000000000");
    expect(formatNumber(-1.25e22)).toBe("-12500000000000000000000");
    expect(formatNumber(-0)).toBe("0");
    expect(formatNumber(0.1)).toBe("0.1");
    expect(() => formatNumber(Number.NaN)).toThrow(RangeError);
  });

  it("rounds WKT coordinates to 5 dp and drops optional whitespace", () => {
    const a = canonicalize("/v2/insights", { "filter.type": "urn:tag", "signal.location": "POINT(-86.781649 36.162749)" });
    const b = canonicalize("/v2/insights", { "filter.type": "urn:tag", "signal.location": " point ( -86.78165   36.16275 ) " });
    expect(a.query["signal.location"]).toBe("POINT(-86.78165 36.16275)");
    expect(a.key).toBe(b.key);
    const polygon = canonicalize("/v2/insights", {
      "filter.type": "urn:tag",
      "signal.location": "POLYGON(( -86.9 36.05 , -86.65 36.05, -86.65 36.27,-86.9 36.270000, -86.9 36.05 ))",
    });
    expect(polygon.query["signal.location"]).toBe("POLYGON((-86.9 36.05,-86.65 36.05,-86.65 36.27,-86.9 36.27,-86.9 36.05))");
  });

  it("rounds the /search lat,lon pair too", () => {
    const req = canonicalize("/search", { query: "Fixture Cafe", "filter.location": "36.1627449, -86.7816" });
    expect(req.query["filter.location"]).toBe("36.16274,-86.7816");
  });

  it("hashes v1|GET|path?qs with the probe's encoding", () => {
    const req = canonicalize("/v2/insights", {
      "filter.type": "urn:entity:brand",
      "signal.location.query": "East Fixture Town",
      "signal.interests.entities": ["ent-beta-02", "ent-alpha-01"],
    });
    expect(req.qs).toBe(
      "filter.type=urn:entity:brand&signal.interests.entities=ent-alpha-01,ent-beta-02&signal.location.query=East%20Fixture%20Town",
    );
    expect(req.key).toBe(sha(`v1|GET|/v2/insights?${req.qs}`));
    expect(req.filterType).toBe("urn:entity:brand");
  });

  it("uses a separate key namespace for mock mode", () => {
    const live = canonicalize("/search", { query: "Brand Alpha" });
    const mock = canonicalize("/search", { query: "Brand Alpha" }, "mock-v1");
    expect(mock.qs).toBe(live.qs);
    expect(mock.key).not.toBe(live.key);
    expect(mock.key).toBe(sha(`mock-v1|GET|/search?${live.qs}`));
  });

  it("keeps booleans and sets filterType only where filter.type applies", () => {
    const req = canonicalize("/v2/tags", { "filter.query": "fixture", "feature.semantic_search": "true" });
    expect(req.params["feature.semantic_search"]).toBe(true);
    expect(req.query["feature.semantic_search"]).toBe("true");
    expect(req.filterType).toBeNull();
    expect(canonicalize("/v2/trending", { "filter.type": "urn:entity:brand" }).filterType).toBe("urn:entity:brand");
  });

  it("builds query strings in key order", () => {
    expect(buildQueryString({ b: "2", a: "x y" })).toBe("a=x%20y&b=2");
  });
});

describe("redactParams", () => {
  it("shortens polygons, long lists and long values, and masks key-like parameters", () => {
    const ids = ["ent-a", "ent-b", "ent-c", "ent-d", "ent-e"].join(",");
    const out = redactParams({
      "signal.location": "POLYGON((-86.9 36.05,-86.65 36.05,-86.65 36.27,-86.9 36.27,-86.9 36.05))",
      "filter.location": "POINT(-86.78165 36.16275)",
      "signal.interests.entities": ids,
      "filter.results.entities": "ent-a,ent-b,ent-c",
      query: "x".repeat(200),
      api_key: "should-never-appear",
    });
    expect(out["signal.location"]).toBe("POLYGON (5 pts)");
    expect(out["filter.location"]).toBe("POINT(-86.78165 36.16275)");
    expect(out["signal.interests.entities"]).toBe("ent-a,ent-b,… (+3)");
    expect(out["filter.results.entities"]).toBe("ent-a,ent-b,ent-c");
    expect(out.query?.length).toBe(96);
    expect(out.api_key).toBe("[redacted]");
  });
});
