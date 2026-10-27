import { describe, expect, it } from "vitest";
import {
  AUDIENCE_CATALOGUE_FAMILIES,
  AUDIENCE_CATALOGUE_KV_KEY,
  audienceCatalogueKvKey,
  audienceCatalogueParams,
  audienceFamilySegments,
  MOCK_AUDIENCE_CATALOGUE_KV_KEY,
  readAudienceCatalogue,
  storedAudienceCatalogue,
} from "../src/audience-catalogue";
import { validateRequest } from "../src/validate";
import { harness } from "./support/fakes";

// Invented segments only (D29): the families are Qloo's public parents, the leaves are made up.
const FETCHED_AT = new Date("2026-10-27T03:00:00.000Z");

describe("audience catalogue", () => {
  it("reads the six D21 families with one allowlisted /v2/audiences request each", () => {
    expect(AUDIENCE_CATALOGUE_FAMILIES).toEqual([
      "hobbies_and_interests",
      "leisure",
      "spending_habits",
      "professional_area",
      "life_stage",
      "investing_interests",
    ]);
    for (const family of AUDIENCE_CATALOGUE_FAMILIES) {
      expect(() => validateRequest("/v2/audiences", audienceCatalogueParams(family), { pillar: null })).not.toThrow();
    }
  });

  it("keeps live and synthetic segments under separate kv keys", () => {
    expect(audienceCatalogueKvKey("dev")).toBe(AUDIENCE_CATALOGUE_KV_KEY);
    expect(audienceCatalogueKvKey("prod")).toBe(AUDIENCE_CATALOGUE_KV_KEY);
    expect(audienceCatalogueKvKey("mock")).toBe(MOCK_AUDIENCE_CATALOGUE_KV_KEY);
    expect(MOCK_AUDIENCE_CATALOGUE_KV_KEY).toBe("audience_catalogue.mock");
  });

  it("keeps well-formed keys of the requested family, drops denied and stray rows, and never reads entity ids", () => {
    const read = audienceFamilySegments("leisure", [
      { id: "urn:audience:leisure:test_trail_runners", name: "Trail Runners" },
      { id: "urn:audience:leisure:political_junkie", name: "Denied One" },
      { id: "urn:audience:hobbies_and_interests:test_misfiled", name: "Misfiled" },
      { id: "urn:audience:leisure:test_trail_runners", name: "Duplicate" },
      { id: "not an audience", name: "Broken" },
      { id: "urn:audience:leisure:test_blank", name: "  " },
    ]);
    expect(read.segments).toEqual([
      { key: "urn:audience:leisure:test_trail_runners", label: "Trail Runners" },
      { key: "urn:audience:leisure:test_blank", label: "test_blank" },
    ]);
    expect(read).toMatchObject({ rows: 6, denied: 1, dropped: 3 });
    expect(JSON.stringify(read)).not.toMatch(/entity_id/);
  });

  it("strips control characters and links from labels", () => {
    const bell = String.fromCharCode(7);
    const read = audienceFamilySegments("life_stage", [
      { id: "urn:audience:life_stage:test_new_parents", name: `New${bell} Parents https://example.invalid/x` },
    ]);
    expect(read.segments[0]?.label).toBe("New Parents");
  });

  it("writes a value in family order that reads back as the same segments", () => {
    const value = storedAudienceCatalogue(
      [
        audienceFamilySegments("life_stage", [{ id: "urn:audience:life_stage:test_engaged", name: "Engaged" }]),
        audienceFamilySegments("leisure", [{ id: "urn:audience:leisure:test_coffee", name: "Coffee" }]),
      ],
      FETCHED_AT,
    );
    expect(Object.keys(value.families)).toEqual(["leisure", "life_stage"]);
    expect(readAudienceCatalogue(value)).toEqual({
      state: "pinned",
      fetchedAt: "2026-10-27T03:00:00.000Z",
      segments: [
        { key: "urn:audience:leisure:test_coffee", label: "Coffee" },
        { key: "urn:audience:life_stage:test_engaged", label: "Engaged" },
      ],
    });
  });

  it("reads a missing value as no segments and a malformed one as malformed", () => {
    expect(readAudienceCatalogue(undefined)).toEqual({ state: "missing", segments: [], fetchedAt: null });
    expect(readAudienceCatalogue({ version: 2, families: {} }).state).toBe("malformed");
    const withEntityIds = {
      version: 1,
      fetchedAt: FETCHED_AT.toISOString(),
      families: { leisure: [{ key: "urn:audience:leisure:test_coffee", label: "Coffee", entity_id: "ent-x" }] },
    };
    expect(readAudienceCatalogue(withEntityIds).state).toBe("malformed");
  });

  it("drops denied, misfiled and repeated segments a hand-written value holds", () => {
    const read = readAudienceCatalogue({
      version: 1,
      fetchedAt: FETCHED_AT.toISOString(),
      families: {
        leisure: [
          { key: "urn:audience:leisure:political_junkie", label: "Denied" },
          { key: "urn:audience:leisure:test_coffee", label: "Coffee" },
          { key: "urn:audience:spending_habits:test_misfiled", label: "Misfiled" },
        ],
        communities: [{ key: "urn:audience:communities:test_group", label: "Denied family" }],
        life_stage: [{ key: "urn:audience:leisure:test_coffee", label: "Again" }],
      },
    });
    expect(read.segments).toEqual([{ key: "urn:audience:leisure:test_coffee", label: "Coffee" }]);
  });


  it("is read by the client from its environment's kv key, with no Qloo call", async () => {
    const { client, store, transport } = harness();
    expect(await client.audienceCatalogue?.()).toEqual({ state: "missing", segments: [], fetchedAt: null });
    const value = storedAudienceCatalogue([audienceFamilySegments("leisure", [{ id: "urn:audience:leisure:test_coffee", name: "Coffee" }])], FETCHED_AT);
    await store.setKv(AUDIENCE_CATALOGUE_KV_KEY, value);
    await store.setKv(MOCK_AUDIENCE_CATALOGUE_KV_KEY, { version: 1, fetchedAt: FETCHED_AT.toISOString(), families: {} });
    expect((await client.audienceCatalogue?.())?.segments).toEqual([{ key: "urn:audience:leisure:test_coffee", label: "Coffee" }]);
    expect(transport.requests).toHaveLength(0);
  });
});
