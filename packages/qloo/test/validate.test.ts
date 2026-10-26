import type { Pillar, QlooParams } from "@ct/contracts";
import { describe, expect, it } from "vitest";
import type { QlooPath } from "../src/allowlist";
import { NoSignalError, QlooParamError } from "../src/errors";
import { validateRequest } from "../src/validate";

const run = (path: QlooPath, params: QlooParams, pillar: Pillar | null = "investment") => () =>
  validateRequest(path, params, { pillar });

const brand = (extra: QlooParams = {}): QlooParams => ({
  "filter.type": "urn:entity:brand",
  "signal.interests.entities": ["ent-alpha-01"],
  ...extra,
});

function paramError(fn: () => void): QlooParamError {
  try {
    fn();
  } catch (err) {
    if (err instanceof QlooParamError) return err;
    throw err;
  }
  throw new Error("expected a QlooParamError");
}

describe("validateRequest: allowlist", () => {
  it("accepts allowlisted requests", () => {
    expect(run("/v2/insights", brand({ take: 50, "filter.popularity.max": 0.9 }))).not.toThrow();
    expect(run("/search", { query: "Brand Alpha", types: "urn:entity:brand", take: 100 })).not.toThrow();
    expect(run("/entities", { entity_ids: ["ent-alpha-01"] })).not.toThrow();
    expect(run("/v2/tags", { "filter.query": "fixture", "feature.semantic_search": true, take: 10 })).not.toThrow();
  });

  it("rejects a path that is not allowlisted", () => {
    expect(run("/v2/analysis/compare" as QlooPath, {})).toThrow(/not on the Qloo allowlist/);
  });

  it("rejects an unknown parameter and names it", () => {
    const err = paramError(run("/v2/insights", brand({ "signal.interests.vibes": "x" })));
    expect(err.param).toBe("signal.interests.vibes");
    expect(err.message).toMatch(/not allowlisted for \/v2\/insights urn:entity:brand/);
  });

  it("rejects a parameter allowlisted for another filter type", () => {
    expect(run("/v2/insights", { "filter.type": "urn:entity:person", "signal.location": "loc-fixture", page: 2 })).toThrow(
      /page is not allowlisted/,
    );
  });

  it("rejects an unknown or missing filter.type on insights", () => {
    expect(paramError(run("/v2/insights", { "filter.type": "urn:entity:book", "signal.interests.entities": "ent-a" })).param).toBe(
      "filter.type",
    );
    expect(run("/v2/insights", { "signal.interests.entities": "ent-a" })).toThrow(/filter.type is required/);
  });

  it("throws the frozen reason for forbidden parameters", () => {
    expect(run("/v2/insights", brand({ "bias.trends": "off" }))).toThrow(/D15/);
    expect(run("/search", { query: "Brand Alpha", "bias.trends": "off" })).toThrow(/forbidden/);
    expect(run("/v2/insights", brand({ "filter.location": "loc-fixture" }))).toThrow(/brands have no location/);
    expect(run("/v2/insights", { "filter.type": "urn:tag", "signal.location": "loc-fixture", "signal.location.radius": 600 })).toThrow(
      /G8: no effect/,
    );
  });
});

describe("validateRequest: value rules", () => {
  it("caps take at 50 for insights and trending and 100 for search", () => {
    expect(run("/v2/insights", brand({ take: 51 }))).toThrow(/take=51 exceeds 50/);
    expect(run("/v2/trending", { "filter.type": "urn:entity:brand", "signal.interests.entities": "ent-a", take: 51 })).toThrow(/exceeds 50/);
    expect(run("/search", { query: "Brand Alpha", take: 101 })).toThrow(/exceeds 100/);
    expect(run("/search", { query: "Brand Alpha", take: 0 })).toThrow(/positive integer/);
    expect(run("/search", { query: "Brand Alpha", take: 2.5 })).toThrow(/positive integer/);
    expect(run("/search", { query: "Brand Alpha", take: "lots" })).toThrow(/finite number/);
  });

  it("allows at most 50 ids in a list", () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `ent-fixture-${i}`);
    expect(run("/v2/insights", brand({ "filter.results.entities": ids(50) }))).not.toThrow();
    expect(run("/v2/insights", brand({ "filter.results.entities": ids(51) }))).toThrow(/51 items/);
    expect(run("/v2/insights", brand({ "filter.results.entities": ids(51).join(",") }))).toThrow(/51 items/);
  });

  it("rejects empty values and malformed lists", () => {
    expect(run("/search", { query: "  " })).toThrow(/empty/);
    expect(run("/v2/insights", brand({ "filter.results.entities": "ent-a,,ent-b" }))).toThrow(/empty item/);
    expect(run("/v2/insights", brand({ "filter.results.entities": ["ent-a,ent-b"] }))).toThrow(/without commas/);
    expect(run("/search", { query: ["Brand Alpha"] })).toThrow(/one value, not a list/);
  });

  it("caps urn:demographics batches at 30 entities", () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `ent-fixture-${i}`);
    expect(run("/v2/insights", { "filter.type": "urn:demographics", "signal.interests.entities": ids(30), take: 50 })).not.toThrow();
    expect(run("/v2/insights", { "filter.type": "urn:demographics", "signal.interests.entities": ids(31) })).toThrow(/at most 30/);
  });

  it("accepts tag signals from the taxonomy only", () => {
    expect(run("/v2/insights", { "filter.type": "urn:heatmap", "filter.location": "loc-fixture", "signal.interests.tags": "urn:tag:genre:place:restaurant" })).not.toThrow();
    expect(run("/v2/insights", { "filter.type": "urn:heatmap", "filter.location": "loc-fixture", "signal.interests.tags": "urn:tag:cuisine:qloo:fixture" })).toThrow(
      /taxonomy tags only/,
    );
    expect(run("/v2/insights", { "filter.type": "urn:heatmap", "filter.location": "loc-fixture", "signal.interests.tags": "urn:tag:category:place:fixture" })).toThrow(
      /on urn:heatmap takes urn:tag:genre:/,
    );
    expect(run("/v2/insights", { "filter.type": "urn:entity:place", "filter.location": "loc-fixture", "filter.tags": "urn:tag:category:place:fixture" })).not.toThrow();
  });

  it("keeps heatmap concept tags and entity analogs in separate calls", () => {
    const heatmap = { "filter.type": "urn:heatmap", "filter.location": "loc-fixture" };
    expect(run("/v2/insights", { ...heatmap, "signal.interests.entities": "ent-fixture" })).not.toThrow();
    expect(run("/v2/insights", { ...heatmap, "signal.interests.tags": "urn:tag:genre:place:fixture", "signal.interests.entities": "ent-fixture" })).toThrow(
      /not both/,
    );
  });

  it("checks booleans and dates", () => {
    expect(run("/v2/tags", { "filter.query": "fixture", "feature.semantic_search": "yes" })).toThrow(/true or false/);
    expect(
      run("/v2/trending", { "filter.type": "urn:entity:brand", "signal.interests.entities": "ent-a", "filter.start_date": "04/01/2025" }),
    ).toThrow(/YYYY-MM-DD/);
  });
});

describe("validateRequest: locations", () => {
  const tagAt = (location: string) => ({ "filter.type": "urn:tag", "signal.location": location });

  it("accepts lon-first WKT and locality ids", () => {
    expect(run("/v2/insights", tagAt("POINT(-86.7816 36.1627)"))).not.toThrow();
    expect(run("/v2/insights", tagAt("POLYGON((-86.9 36.05,-86.65 36.05,-86.65 36.27,-86.9 36.05))"))).not.toThrow();
    expect(run("/v2/insights", tagAt("loc-fixture-nashville"))).not.toThrow();
  });

  it("detects a swapped POINT(lat lon) for US coordinates", () => {
    expect(run("/v2/insights", tagAt("POINT(36.1627 -86.7816)"))).toThrow(/swapped/);
    expect(run("/v2/insights", tagAt("POINT(34.05 -118.24)"))).toThrow(/swapped/);
    expect(run("/v2/insights", tagAt("POLYGON((-86.9 36.05,36.27 -86.65,-86.65 36.27,-86.9 36.05))"))).toThrow(/swapped/);
  });

  it("rejects malformed or out-of-range WKT and stray coordinate text", () => {
    expect(run("/v2/insights", tagAt("POINT(-86.78)"))).toThrow(/malformed coordinate/);
    expect(run("/v2/insights", tagAt("POLYGON((-86.9 36.05,-86.65 36.05)"))).toThrow(/unbalanced/);
    expect(run("/v2/insights", tagAt("LINESTRING(-86.9 36.05,-86.65 36.05)"))).toThrow(/POINT, POLYGON or MULTIPOLYGON/);
    expect(run("/v2/insights", tagAt("POINT(-200 36.05)"))).toThrow(/out of range/);
    expect(run("/v2/insights", tagAt("36.16,-86.78"))).toThrow(/neither WKT nor a locality id/);
  });

  it("takes lat,lon on /search and detects it swapped", () => {
    expect(run("/search", { query: "Fixture Cafe", "filter.location": "36.1627,-86.7816", "filter.radius": 2 })).not.toThrow();
    expect(run("/search", { query: "Fixture Cafe", "filter.location": "-86.7816,36.1627" })).toThrow(/swapped/);
    expect(run("/search", { query: "Fixture Cafe", "filter.location": "POINT(-86.78 36.16)" })).toThrow(/lat,lon/);
  });
});

describe("validateRequest: signals", () => {
  it("throws NoSignalError for an insights call without a signal", () => {
    const call = run("/v2/insights", { "filter.type": "urn:entity:brand", "filter.results.entities": ["ent-alpha-01"], take: 10 });
    expect(call).toThrow(NoSignalError);
    expect(call).toThrow(QlooParamError);
  });

  it("accepts every signal family", () => {
    expect(run("/v2/insights", { "filter.type": "urn:entity:brand", "signal.demographics.age": "24_and_younger" })).not.toThrow();
    expect(run("/v2/insights", { "filter.type": "urn:entity:brand", "signal.location.query": "Fixture Town" })).not.toThrow();
    expect(run("/v2/insights", { "filter.type": "urn:entity:brand", "signal.interests.tags": "urn:tag:genre:brand:fixture" })).not.toThrow();
    expect(
      run("/v2/insights", { "filter.type": "urn:entity:brand", "signal.demographics.audiences": "urn:audience:leisure:fixture_fans" }),
    ).not.toThrow();
  });

  it("allows the probe-verified filter-only places call and nothing looser", () => {
    expect(
      run("/v2/insights", { "filter.type": "urn:entity:place", "filter.location": "loc-fixture", "filter.tags": "urn:tag:category:place:cafe" }),
    ).not.toThrow();
    expect(run("/v2/insights", { "filter.type": "urn:entity:place", "filter.location": "loc-fixture" })).toThrow(NoSignalError);
  });
});

describe("validateRequest: audience allowlist (D21)", () => {
  const withAudience = (urn: string, pillar: Pillar | null) =>
    run("/v2/insights", { "filter.type": "urn:entity:brand", "signal.demographics.audiences": urn }, pillar);
  const desks: (Pillar | null)[] = ["investment", "location", "marketing", "audience", null];

  it("denies the sensitive families on every desk", () => {
    for (const family of ["communities", "political_preferences", "lifestyle_preferences_beliefs", "global_issues"]) {
      for (const desk of desks) expect(withAudience(`urn:audience:${family}:fixture`, desk)).toThrow(/denied on every desk/);
    }
    for (const desk of desks) expect(withAudience("urn:audience:leisure:political_junkie", desk)).toThrow(/denied on every desk/);
  });

  it("limits the LOCATION desk to hobbies_and_interests and leisure", () => {
    expect(withAudience("urn:audience:leisure:fixture_fans", "location")).not.toThrow();
    expect(withAudience("urn:audience:hobbies_and_interests:fixture_fans", "location")).not.toThrow();
    expect(withAudience("urn:audience:spending_habits:fixture_fans", "location")).toThrow(/not allowed for the location desk/);
  });

  it("gives investing_interests to INVESTMENT only, and standalone tools the union", () => {
    expect(withAudience("urn:audience:investing_interests:fixture", "investment")).not.toThrow();
    expect(withAudience("urn:audience:investing_interests:fixture", "marketing")).toThrow(/not allowed/);
    expect(withAudience("urn:audience:investing_interests:fixture", "audience")).toThrow(/not allowed/);
    expect(withAudience("urn:audience:investing_interests:fixture", null)).not.toThrow();
    expect(withAudience("urn:audience:unknown_family:fixture", null)).toThrow(/not allowed for standalone tools/);
  });

  it("checks audience family URNs wherever they appear", () => {
    expect(run("/v2/audiences", { "filter.parents.types": "urn:audience:communities" }, null)).toThrow(/denied on every desk/);
    expect(run("/v2/audiences", { "filter.parents.types": "urn:audience:leisure" }, "location")).not.toThrow();
    expect(withAudience("urn:audience:leisure", "investment")).toThrow(/not an audience key/);
  });
});
