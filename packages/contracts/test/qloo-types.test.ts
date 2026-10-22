import { describe, expect, it } from "vitest";
import { insightsResponseSchema, QlooEntityInsightsResponse } from "../src/index";

// Synthetic bodies in the response shapes the probe recorded: invented entities and values only (D29).

const placeRow = (n: number, geocode: Record<string, unknown> | null) => ({
  entity_id: `fixture-place-${n}`,
  name: `Fixture Venue ${n}`,
  type: "urn:entity",
  subtype: "urn:entity:place",
  popularity: 0.5,
  properties: { description: "An invented listening bar.", geocode },
  tags: [{ id: "urn:tag:category:place:fixture_bar", name: "Fixture Bar", type: "urn:tag:category:place", weight: null }],
  location: { lat: 36.1, lon: -86.7, geohash: "dnfixture" },
  query: { affinity: 0.4, distance: 1200 },
});

const placeBody = {
  success: true,
  results: {
    entities: [
      placeRow(1, { name: null, metro: null, admin1_region: "XX", admin2_region: "Fixture County", country_code: "XX" }),
      placeRow(2, {
        name: "Marlowe Ridge",
        city: "Fixture City",
        metro: "Fixture Metro",
        admin1_region: "XX",
        admin2_region: "Fixture County",
        country: "Fixtureland",
        country_code: "XX",
      }),
      placeRow(3, null),
    ],
  },
};

const artistBody = {
  success: true,
  results: {
    entities: [
      {
        entity_id: "fixture-artist-1",
        name: "The Juniper Lanterns",
        type: "urn:entity",
        subtype: "urn:entity:artist",
        popularity: 0.8,
        tags: [
          { id: "urn:tag:genre:music:fixture_folk", name: "Fixture Folk", type: "urn:tag:genre:music" },
          { type: "urn:tag:fixture" },
        ],
        query: {
          affinity: 0.7,
          explainability: { "signal.interests.entities": [{ entity_id: "fixture-seed-1", score: 0.6 }] },
        },
      },
    ],
  },
};

describe("insights response schemas", () => {
  it("accepts place rows whose geocode name and metro are null, or whose geocode is null", () => {
    expect(insightsResponseSchema("urn:entity:place").safeParse(placeBody).success).toBe(true);
  });

  it("accepts entity tags that carry only a type", () => {
    const parsed = QlooEntityInsightsResponse.parse(artistBody);
    expect(parsed.results.entities[0]?.tags?.filter((t) => t.id !== undefined && t.name !== undefined)).toHaveLength(1);
    expect(insightsResponseSchema("urn:entity:artist").safeParse(artistBody).success).toBe(true);
  });

  it("still rejects a row without an entity id", () => {
    const [first, ...rest] = placeBody.results.entities;
    const broken = { ...placeBody, results: { entities: [{ ...first, entity_id: undefined }, ...rest] } };
    expect(insightsResponseSchema("urn:entity:place").safeParse(broken).success).toBe(false);
  });
});
