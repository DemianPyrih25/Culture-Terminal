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

  it("pins urn:tag fingerprints of pinned metro localities", () => {
    const pinned = new Set(["loc-fixture-metro"]);
    expect(ttl("/v2/insights", { "filter.type": "urn:tag", "signal.location": "loc-fixture-metro" }, pinned)).toBeNull();
    expect(ttl("/v2/insights", { "filter.type": "urn:tag", "signal.location": "loc-fixture-other" }, pinned)).toBe(INSIGHTS_TTL_MS);
    expect(isPinnedRequest(canonicalize("/v2/insights", { "filter.type": "urn:tag", "signal.location": "loc-fixture-metro" }))).toBe(false);
  });

  it("pins the Block DNA city brand list of a pinned locality, and nothing else on brands", () => {
    const pinned = new Set(["loc-fixture-metro"]);
    const city = { "filter.type": "urn:entity:brand", "signal.location": "loc-fixture-metro", "filter.popularity.max": 0.9, take: 30 };
    expect(ttl("/v2/insights", city, pinned)).toBeNull();
    expect(ttl("/v2/insights", { ...city, "filter.results.entities": "ent-a,ent-b" }, pinned)).toBe(INSIGHTS_TTL_MS);
    expect(ttl("/v2/insights", { ...city, "signal.interests.entities": "ent-a" }, pinned)).toBe(INSIGHTS_TTL_MS);
    expect(ttl("/v2/insights", { ...city, "signal.location": "loc-fixture-other" }, pinned)).toBe(INSIGHTS_TTL_MS);
  });
});
