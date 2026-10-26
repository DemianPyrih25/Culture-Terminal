import { describe, expect, it } from "vitest";
import { catalogueMarket, classifyLocality, gazetteerArea, GHOST_MARKETS, LOCALITY_TYPE, splitPlace, usStateName } from "../../src/ghost/places";
import { GHOST_SEARCH_MAX, resolveGhostPicks } from "../../src/ghost/resolve";
import { answer, entity, entityIdOf, FAKE_GEO, FAKE_MARKETS, FakeSearch, registryOf } from "./support";

const LOCALITY = LOCALITY_TYPE;

describe("resolveGhostPicks: the exact-match rule (D20)", () => {
  it("resolves a brand only on one exact normalised name of the brand type", async () => {
    const search = new FakeSearch({
      "Brand Beta": [entity("ent-brand-beta", "Brand Beta, Inc.", "urn:entity:brand", { popularity: 0.62 })],
      "Brand Gamma": [entity("ent-gamma-1", "Brand Gamma"), entity("ent-gamma-2", "Brand Gamma")],
      "Brand Delta": [entity("ent-delta-x", "Brand Delta Outlet")],
      "Brand Eta": [entity("ent-eta", "Brand Eta", "urn:entity:artist")],
    });
    const picks = await resolveGhostPicks({
      answer: answer({ competitors: ["Brand Beta", "Brand Gamma", "Brand Delta", "Brand Eta"] }),
      search: search.search,
      geo: FAKE_GEO,
      markets: FAKE_MARKETS,
    });
    expect(picks.map((p) => [p.name, p.exact, p.lookup])).toEqual([
      ["Brand Beta", true, "search"],
      ["Brand Gamma", false, "search"], // ambiguous: two exact names
      ["Brand Delta", false, "search"], // a near match is never applied
      ["Brand Eta", false, "search"], // the right name, the wrong type
    ]);
    expect(picks[0]).toMatchObject({ entityId: "ent-brand-beta", matchedName: "Brand Beta, Inc.", popularity: 0.62, rank: 1, ref: null });
    // The same /search the resolve_entities skill sends, so the cache serves names the run already looked up.
    expect(search.calls[0]).toEqual({ query: "Brand Beta", types: "urn:entity:brand", take: 5 });
  });

  it("takes the run's ref for an entity the registry holds, and registers nothing", async () => {
    const { registry, ref } = registryOf([["Brand Alpha", 0.4], ["Brand Beta", 0.62]]);
    const search = new FakeSearch({ "Brand Beta": [entity(entityIdOf("Brand Beta"), "Brand Beta")], "Brand Kappa": [entity("ent-kappa", "Brand Kappa")] });
    const picks = await resolveGhostPicks({ answer: answer({ partners: ["Brand Beta", "Brand Kappa"] }), search: search.search, registry, geo: FAKE_GEO });
    expect(picks.map((p) => p.ref)).toEqual([ref("Brand Beta"), null]);
    expect(picks[1]).toMatchObject({ exact: true, entityId: "ent-kappa" });
    expect(registry.entities()).toHaveLength(2);
  });
});

describe("resolveGhostPicks: places", () => {
  it("matches markets against the catalogue and neighbourhoods against the gazetteer without a search", async () => {
    const search = new FakeSearch();
    const picks = await resolveGhostPicks({
      answer: answer({ markets: ["Harbor City, QA", "Riverton, Brevia"], neighbourhoods: ["Lantern Row", "Cedar Bend, Austin"] }),
      search: search.search,
      geo: FAKE_GEO,
      markets: FAKE_MARKETS,
    });
    expect(search.calls).toEqual([]);
    expect(picks.map((p) => [p.name, p.lookup, p.market, p.area, p.matchedName, p.exact])).toEqual([
      ["Harbor City, QA", "catalogue", "harbor_city", null, "Harbor City", true],
      ["Riverton, Brevia", "catalogue", "riverton_b", null, "Riverton", true],
      ["Lantern Row", "gazetteer", null, { metro: "nashville", id: "lantern_row" }, "Lantern Row", true],
      ["Cedar Bend, Austin", "gazetteer", null, { metro: "austin", id: "cedar_bend" }, "Cedar Bend", true],
    ]);
  });

  it("looks a place up as a Qloo locality when the catalogue or gazetteer cannot settle it", async () => {
    const search = new FakeSearch({
      Riverton: [entity("ent-riv-q", "Riverton", LOCALITY, { disambiguation: "Quillan, Freeland" }), entity("ent-riv-b", "Riverton", LOCALITY, { disambiguation: "Brevia, Freeland" })],
      "Port Ember": [entity("ent-port-ember", "Port Ember", LOCALITY, { popularity: 0.3 })],
      "Old Town": [entity("ent-old-1", "Old Town", LOCALITY), entity("ent-old-2", "Old Town", LOCALITY)],
    });
    const picks = await resolveGhostPicks({
      answer: answer({ markets: ["Riverton", "Port Ember, QC"], neighbourhoods: ["Old Town"] }),
      search: search.search,
      geo: FAKE_GEO,
      markets: FAKE_MARKETS,
    });
    // Rank order across lists: both first picks, then the second market.
    expect(search.calls).toEqual([
      { query: "Riverton", types: LOCALITY, take: 10 },
      { query: "Old Town", types: LOCALITY, take: 10 },
      { query: "Port Ember", types: LOCALITY, take: 10 },
    ]);
    expect(picks.map((p) => [p.name, p.lookup, p.exact, p.entityId])).toEqual([
      ["Riverton", "search", false, null], // two catalogue markets and two localities share the name
      ["Port Ember, QC", "search", true, "ent-port-ember"],
      ["Old Town", "search", false, null], // two gazetteer metros and two localities share it
    ]);
  });

  it("settles a shared neighbourhood name by the question's metro", async () => {
    const picks = await resolveGhostPicks({ answer: answer({ neighbourhoods: ["Old Town"] }), search: new FakeSearch().search, geo: FAKE_GEO, metro: "austin" });
    expect(picks[0]).toMatchObject({ lookup: "gazetteer", area: { metro: "austin", id: "old_town_a" } });
  });

  it("never matches an area of another city than the question's, and leaves it to the locality search", async () => {
    const search = new FakeSearch();
    const picks = await resolveGhostPicks({
      answer: answer({ neighbourhoods: ["Lantern Row", "Cedar Bend", "Cedar Bend, Austin"] }),
      search: search.search,
      geo: FAKE_GEO,
      metro: "nashville",
    });
    expect(picks.map((p) => [p.name, p.lookup, p.area, p.exact])).toEqual([
      ["Lantern Row", "gazetteer", { metro: "nashville", id: "lantern_row" }, true],
      ["Cedar Bend", "search", null, false],
      ["Cedar Bend, Austin", "search", null, false],
    ]);
    expect(search.queries()).toEqual(["Cedar Bend", "Cedar Bend"]);
  });

  it("narrows a city outside the catalogue by its two-letter state code", async () => {
    const search = new FakeSearch({
      Fernvale: [
        entity("ent-fern-co", "Fernvale", LOCALITY, { disambiguation: "Colorado, United States" }),
        entity("ent-fern-or", "Fernvale", LOCALITY, { disambiguation: "Oregon, United States" }),
      ],
    });
    const picks = await resolveGhostPicks({ answer: answer({ markets: ["Fernvale, CO", "Fernvale, Oregon", "Fernvale, WY"] }), search: search.search, geo: FAKE_GEO, markets: FAKE_MARKETS });
    expect(picks.map((p) => [p.name, p.lookup, p.exact, p.entityId])).toEqual([
      ["Fernvale, CO", "search", true, "ent-fern-co"],
      ["Fernvale, Oregon", "search", true, "ent-fern-or"],
      ["Fernvale, WY", "search", false, null], // a state neither result names narrows nothing: still two
    ]);
  });
});

describe("resolveGhostPicks: the search cap (SPEC §6.6)", () => {
  const names = (prefix: string) => Array.from({ length: 5 }, (_, i) => `${prefix} ${i + 1}`);

  it("makes at most ten searches, each list's top picks first, and logs the rest", async () => {
    const search = new FakeSearch();
    const lines: string[] = [];
    const picks = await resolveGhostPicks({
      answer: answer({ competitors: names("Rival"), tenants: names("Tenant"), partners: names("Partner"), markets: ["Harbor City"] }),
      search: search.search,
      geo: FAKE_GEO,
      markets: FAKE_MARKETS,
      log: (line) => lines.push(line),
    });
    expect(search.calls).toHaveLength(GHOST_SEARCH_MAX);
    // Ranks 1 to 3 of all three lists, then rank 4 of the first: the catalogue market costs nothing.
    expect(search.queries()).toEqual([
      "Rival 1", "Tenant 1", "Partner 1",
      "Rival 2", "Tenant 2", "Partner 2",
      "Rival 3", "Tenant 3", "Partner 3",
      "Rival 4",
    ]);
    const skipped = picks.filter((p) => p.lookup === "skipped").map((p) => p.name);
    expect(skipped).toEqual(["Rival 5", "Tenant 4", "Tenant 5", "Partner 4", "Partner 5"]);
    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe('GHOST search cap (10): tenants #4 "Tenant 4" not looked up');
    expect(picks.find((p) => p.name === "Harbor City")?.lookup).toBe("catalogue");
  });

  it("accepts a lower cap but never a higher one", async () => {
    const low = new FakeSearch();
    await resolveGhostPicks({ answer: answer({ competitors: names("Rival") }), search: low.search, max: 2, geo: FAKE_GEO });
    expect(low.calls).toHaveLength(2);
    const high = new FakeSearch();
    await resolveGhostPicks({ answer: answer({ competitors: names("Rival"), partners: names("Partner"), tenants: names("Tenant") }), search: high.search, max: 50, geo: FAKE_GEO });
    expect(high.calls).toHaveLength(GHOST_SEARCH_MAX);
  });

  it("leaves a pick whose search failed unchecked, and logs it", async () => {
    const lines: string[] = [];
    const search = new FakeSearch({ "Rival 2": [entity("ent-r2", "Rival 2")] }, new Set(["Rival 1"]));
    const picks = await resolveGhostPicks({ answer: answer({ competitors: ["Rival 1", "Rival 2"] }), search: search.search, geo: FAKE_GEO, log: (l) => lines.push(l) });
    expect(picks.map((p) => [p.lookup, p.exact])).toEqual([["failed", false], ["search", true]]);
    expect(lines).toEqual(['GHOST search failed: competitors #1 "Rival 1": synthetic search failure for Rival 1']);
  });

  it("searches nothing once the signal has aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const search = new FakeSearch();
    await expect(resolveGhostPicks({ answer: answer({ competitors: ["Rival 1"] }), search: search.search, geo: FAKE_GEO, signal: controller.signal })).rejects.toThrow();
    expect(search.calls).toEqual([]);
  });

  it("returns nothing for an answer with no picks", async () => {
    const search = new FakeSearch();
    expect(await resolveGhostPicks({ answer: answer(), search: search.search, geo: FAKE_GEO })).toEqual([]);
    expect(search.calls).toEqual([]);
  });
});

describe("place helpers", () => {
  it("splits a qualifier off after the first comma", () => {
    expect(splitPlace("Riverton, QB")).toEqual({ head: "Riverton", qualifier: "QB" });
    expect(splitPlace("Harbor City")).toEqual({ head: "Harbor City", qualifier: null });
    expect(splitPlace("Lantern Row, ")).toEqual({ head: "Lantern Row", qualifier: null });
  });

  it("matches a catalogue market by label or search name, narrowed by state code or name", () => {
    expect(catalogueMarket("riverton, qa", FAKE_MARKETS)?.id).toBe("riverton_q");
    expect(catalogueMarket("Riverton, Quillan", FAKE_MARKETS)?.id).toBe("riverton_q");
    expect(catalogueMarket("Riverton", FAKE_MARKETS)).toBeNull();
    expect(catalogueMarket("Harbor City, QB", FAKE_MARKETS)).toBeNull();
    expect(GHOST_MARKETS.every((m) => m.stateName !== null)).toBe(true);
    expect(catalogueMarket("Nashville, Tennessee")?.id).toBe("nashville");
    expect(catalogueMarket("Nashville, TN")?.id).toBe("nashville");
  });

  it("finds a gazetteer area by its whole name or the part before a comma", () => {
    expect(gazetteerArea("Mill Quarter, Nashville", FAKE_GEO)?.id).toBe("mill_quarter");
    expect(gazetteerArea("Old Town, Austin", FAKE_GEO)?.id).toBe("old_town_a");
    expect(gazetteerArea("Old Town", FAKE_GEO)).toBeNull();
    expect(gazetteerArea("Nowhere Flats", FAKE_GEO)).toBeNull();
  });

  it("looks only in the question's metro when there is one", () => {
    expect(gazetteerArea("Old Town", FAKE_GEO, "nashville")?.id).toBe("old_town_n");
    expect(gazetteerArea("Cedar Bend", FAKE_GEO, "austin")?.id).toBe("cedar_bend");
    expect(gazetteerArea("Cedar Bend", FAKE_GEO, "nashville")).toBeNull();
    expect(gazetteerArea("Old Town, Nashville", FAKE_GEO, "nashville")?.id).toBe("old_town_n");
    // A qualifier naming the other metro rules the pick out rather than reading it as the question's area.
    expect(gazetteerArea("Old Town, Austin", FAKE_GEO, "nashville")).toBeNull();
    expect(gazetteerArea("Cedar Bend, Austin", FAKE_GEO, "nashville")).toBeNull();
  });

  it("classifies localities by exact name, narrowed by a qualifier the disambiguation names", () => {
    const quillan = entity("ent-riv-q", "Riverton", LOCALITY, { disambiguation: "Quillan, Freeland" });
    const brevia = entity("ent-riv-b", "Riverton", LOCALITY, { disambiguation: "Brevia, Freeland" });
    const brand = entity("ent-riv-brand", "Riverton", "urn:entity:brand");
    expect(classifyLocality("Riverton, Brevia", [quillan, brevia, brand])?.entity_id).toBe("ent-riv-b");
    expect(classifyLocality("Riverton, QB", [quillan, brevia, brand])).toBeNull(); // not a USPS code, and the disambiguation does not spell it
    expect(classifyLocality("Riverton", [quillan, brevia, brand])).toBeNull();
    expect(classifyLocality("Riverton", [quillan, quillan, brand])?.entity_id).toBe("ent-riv-q");
  });

  it("reads a USPS state code as the state it stands for", () => {
    expect(usStateName("CO")).toBe("Colorado");
    expect(usStateName("d.c.")).toBe("District of Columbia");
    expect(usStateName("QB")).toBeNull();
    expect(usStateName("Colorado")).toBeNull();
    const dc = entity("ent-cap-dc", "Capitol Bend", LOCALITY, { disambiguation: "District of Columbia, United States" });
    const va = entity("ent-cap-va", "Capitol Bend", LOCALITY, { disambiguation: "Virginia, United States" });
    expect(classifyLocality("Capitol Bend, DC", [dc, va])?.entity_id).toBe("ent-cap-dc");
    expect(classifyLocality("Capitol Bend, D.C.", [dc, va])?.entity_id).toBe("ent-cap-dc");
    expect(classifyLocality("Capitol Bend, VA", [dc, va])?.entity_id).toBe("ent-cap-va");
    expect(classifyLocality("Capitol Bend, Virginia", [dc, va])?.entity_id).toBe("ent-cap-va");
  });
});
