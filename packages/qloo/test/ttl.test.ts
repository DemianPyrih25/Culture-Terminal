import type { QlooParams } from "@ct/contracts";
import { describe, expect, it } from "vitest";
import { PROBE_FACTS, type QlooPath } from "../src/allowlist";
import { canonicalize } from "../src/canonical";
import { CATALOGUE_TTL_MS, DAY_MS, INSIGHTS_TTL_MS, isPinnedRequest, successTtlMs } from "../src/ttl";

const ttl = (path: QlooPath, params: QlooParams, pinnedLocalities?: ReadonlySet<string>) =>
  successTtlMs(canonicalize(path, params), { pinnedLocalities });

describe("TTL classes (D25)", () => {
  it("keeps catalogue lookups 30 days", () => {
    expect(CATALOGUE_TTL_MS).toBe(30 * DAY_MS);
    expect(ttl("/search", { query: "Brand Alpha" })).toBe(CATALOGUE_TTL_MS);
    expect(ttl("/entities", { entity_ids: ["ent-alpha-01"] })).toBe(CATALOGUE_TTL_MS);
    expect(ttl("/v2/tags", { "filter.query": "fixture" })).toBe(CATALOGUE_TTL_MS);
    expect(ttl("/v2/audiences", { "filter.parents.types": "urn:audience:leisure" })).toBe(CATALOGUE_TTL_MS);
  });

  it("keeps insights, rank and concept heatmaps 14 days", () => {
    expect(INSIGHTS_TTL_MS).toBe(14 * DAY_MS);
    expect(ttl("/v2/insights", { "filter.type": "urn:entity:brand", "signal.interests.entities": "ent-a" })).toBe(INSIGHTS_TTL_MS);
    expect(
      ttl("/v2/insights", { "filter.type": "urn:heatmap", "filter.location": "loc-fixture", "signal.interests.tags": "urn:tag:genre:place:bar" }),
    ).toBe(INSIGHTS_TTL_MS);
  });

  it("pins the heatmap baseline, and only the plain baseline", () => {
    const baseline = { "filter.type": "urn:heatmap", "filter.location": "loc-fixture", "signal.interests.tags": PROBE_FACTS.heatmapBaselineTag };
    expect(ttl("/v2/insights", baseline)).toBeNull();
    expect(ttl("/v2/insights", { ...baseline, "signal.interests.entities": "ent-a" })).toBe(INSIGHTS_TTL_MS);
  });

  it("pins trending in the frozen window only", () => {
    const series = { "filter.type": "urn:entity:brand", "signal.interests.entities": "ent-a", take: 50 };
    const frozen = { ...series, "filter.start_date": PROBE_FACTS.trendingWindow.start, "filter.end_date": PROBE_FACTS.trendingWindow.end };
    expect(ttl("/v2/trending", frozen)).toBeNull();
    expect(ttl("/v2/trending", { ...frozen, "filter.end_date": "2025-08-31" })).toBe(INSIGHTS_TTL_MS);
  });

  it("pins the city urn:tag fingerprints of a locality, whole list and SOUND list, and no area's", () => {
    const city = { "filter.type": "urn:tag", "signal.location": "loc-fixture-metro", take: 50 };
    expect(ttl("/v2/insights", city)).toBeNull();
    expect(ttl("/v2/insights", { ...city, "filter.tag.types": "urn:tag:genre:music" })).toBeNull();
    // An area or a site is a WKT shape: kept 14 days.
    expect(ttl("/v2/insights", { ...city, "signal.location": "POINT(-86.78 36.16)" })).toBe(INSIGHTS_TTL_MS);
    expect(ttl("/v2/insights", { ...city, "signal.location": "POLYGON((-86.9 36.05,-86.65 36.05,-86.65 36.27,-86.9 36.05))" })).toBe(INSIGHTS_TTL_MS);
    expect(ttl("/v2/insights", { "filter.type": "urn:tag", "signal.location.query": "East Fixture Town", take: 50 })).toBe(INSIGHTS_TTL_MS);
    // Anything that narrows the city list is not the fingerprint.
    expect(ttl("/v2/insights", { ...city, "signal.interests.entities": "ent-a" })).toBe(INSIGHTS_TTL_MS);
  });

  it("narrows city pins to the given localities when a non-empty set is passed", () => {
    const pinned = new Set(["loc-fixture-metro"]);
    const city = { "filter.type": "urn:tag", "signal.location": "loc-fixture-metro" };
    expect(ttl("/v2/insights", city, pinned)).toBeNull();
    expect(ttl("/v2/insights", { ...city, "signal.location": "loc-fixture-other" }, pinned)).toBe(INSIGHTS_TTL_MS);
    expect(isPinnedRequest(canonicalize("/v2/insights", { ...city, "signal.location": "loc-fixture-other" }), { pinnedLocalities: new Set() })).toBe(true);
  });

  it("pins the Block DNA city brand list of a locality, and nothing else on brands", () => {
    const city = { "filter.type": "urn:entity:brand", "signal.location": "loc-fixture-metro", "filter.popularity.max": 0.9, take: 30 };
    expect(ttl("/v2/insights", city)).toBeNull();
    expect(ttl("/v2/insights", { ...city, "filter.results.entities": "ent-a,ent-b" })).toBe(INSIGHTS_TTL_MS);
    expect(ttl("/v2/insights", { ...city, "signal.interests.entities": "ent-a" })).toBe(INSIGHTS_TTL_MS);
    expect(ttl("/v2/insights", { ...city, "signal.location": "POINT(-86.78 36.16)" })).toBe(INSIGHTS_TTL_MS);
    expect(ttl("/v2/insights", { "filter.type": "urn:entity:brand", "signal.location": "loc-fixture-metro", take: 30 })).toBe(INSIGHTS_TTL_MS);
    expect(ttl("/v2/insights", city, new Set(["loc-fixture-other"]))).toBe(INSIGHTS_TTL_MS);
  });
});
