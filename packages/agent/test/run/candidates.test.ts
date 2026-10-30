// R3 (D49): user-named and obvious candidates. The gate resolves CLERK's obvious names exactly and
// quietly, the run builds its candidate areas and markets, and the scan's scored sets always hold them.
// Invented entities only (D29); areas are the shipped gazetteer's.
import type { Intent, Mention, RegisteredEntity } from "@ct/contracts";
import { describe, expect, it } from "vitest";
import { createEntityRegistry } from "../../src/registry";
import { buildRunCandidates, candidateAreas, candidateMarkets, EXAMPLE_CANDIDATE_NAMES, withJobCandidates, withKnownMarkets } from "../../src/run/candidates";
import { expectedMissingText, runResolutionGate, type GateInput } from "../../src/run/gate";
import { gazetteer } from "../../src/run/gazetteer";
import { MARKET_CATALOGUE } from "../../src/run/markets";
import { planScan, type ScanCandidates } from "../../src/run/scan";
import { intentFor, mockQloo, parseAll, planCall, reportWithoutFollowup, respond, run } from "./support";

const NONE = { named_areas: [], named_markets: [], obvious_entities: [], obvious_areas: [], obvious_markets: [] };
const brand = (text: string, role: Mention["role"] = "secondary"): Mention => ({ text, entity_type: "brand", role, public_figure: false });

function gate(intent: Intent) {
  const registry = createEntityRegistry();
  const input: GateInput = { intent, qloo: mockQloo().standalone().forTool(null), registry, pins: {} };
  return { run: () => runResolutionGate(input), registry };
}

describe("the gate and obvious candidates", () => {
  it("resolves obvious names exactly, registers them as obvious, and lists the misses once without a drop", async () => {
    const intent = intentFor({
      mentions: [brand("Brand Alpha", "primary"), brand("Brand Beta", "peer")],
      candidates: { ...NONE, obvious_entities: [{ text: "Brand Gamma", entity_type: "brand" }, { text: "Brand Notfound", entity_type: "brand" }] },
    });
    const g = gate(intent);
    const outcome = await g.run();
    if (outcome.kind !== "resolved") throw new Error(outcome.kind);
    expect(outcome.dropped).toBe(0);
    expect(outcome.limitations).toEqual([]);
    expect(outcome.obvious.map((e) => [e.name, e.candidate])).toEqual([["Brand Gamma", "obvious"]]);
    expect(outcome.expectedMissing).toEqual(["Brand Notfound"]);
    expect(outcome.candidates).toEqual([
      { ref: "R2", source: "user_named" },
      { ref: "R3", source: "obvious" },
    ]);
    // The question's own names are user_named; only exact obvious names reach the resolve event, marked so.
    expect(outcome.entities.map((e) => [e.mention, e.candidate])).toEqual([
      ["Brand Alpha", "user_named"],
      ["Brand Beta", "user_named"],
      ["Brand Gamma", "obvious"],
    ]);
    expect(expectedMissingText(outcome)).toBe("Expected names not found under that name in the data: Brand Notfound.");
    expect(expectedMissingText({ expectedMissing: [], expectedFailed: [] })).toBeNull();
  });

  it("keeps an obvious name that is the question's own entity user_named, and never resolves a private person", async () => {
    const intent = intentFor({
      mentions: [brand("Brand Alpha", "primary"), { text: "Pat Example", entity_type: "person", role: "secondary", public_figure: false }],
      candidates: { ...NONE, obvious_entities: [{ text: "BRAND ALPHA", entity_type: "brand" }, { text: "Pat Example", entity_type: "person" }] },
    });
    const outcome = await gate(intent).run();
    if (outcome.kind !== "resolved") throw new Error(outcome.kind);
    expect(outcome.obvious).toEqual([]);
    expect(outcome.candidates).toEqual([]);
    expect(outcome.primary?.candidate).toBe("user_named");
  });

  it("keeps the strongest source when an entity is registered again", () => {
    const registry = createEntityRegistry();
    const draft = { entityId: "ent-x", name: "Brand X", type: "brand" as const, popularity: null, disambiguation: null, tags: [] };
    const first = registry.registerEntity({ ...draft, candidate: "obvious" });
    registry.registerEntity({ ...draft, candidate: "user_named" });
    registry.registerEntity(draft);
    expect(first.candidate).toBe("user_named");
    expect(registry.registryTable()[0]).toMatchObject({ candidate: "You named" });
    const plain = registry.registerEntity({ ...draft, entityId: "ent-y", name: "Brand Y" });
    expect(plain.candidate).toBeUndefined();
    expect(registry.registryTable()[1]).not.toHaveProperty("candidate");
    const tag = { tagId: "urn:tag:genre:place:bar", name: "Bar", type: "urn:tag:genre:place", signalCapable: true };
    const t = registry.registerTag({ ...tag, conceptMatch: "exact" });
    registry.registerTag({ ...tag, conceptMatch: "category" });
    expect(t.conceptMatch).toBe("exact");
  });
});

describe("candidate areas and markets", () => {
  const geo = gazetteer();
  const [first, second, third] = geo.neighbourhoods("nashville");

  it("matches the question's areas and CLERK's obvious areas in the run's map cities, leaving unknown names out", () => {
    const intent = intentFor({
      job: "site_selection",
      pillar: "location",
      geo: { metro: "nashville", area: first!.name, unsupported_place: null, market: null, target_metro: null, cities: [] },
      candidates: { ...NONE, named_areas: [second!.name, "Nowhere Flats"], obvious_areas: [third!.name, first!.name] },
    });
    expect(candidateAreas(intent, geo)).toEqual([
      { metro: "nashville", id: first!.id, source: "user_named" },
      { metro: "nashville", id: second!.id, source: "user_named" },
      { metro: "nashville", id: third!.id, source: "obvious" },
    ]);
  });

  it("matches a taste_twins question's obvious areas in its target city", () => {
    const [target] = geo.neighbourhoods("austin");
    const intent = intentFor({
      job: "taste_twins",
      pillar: "location",
      geo: { metro: "nashville", area: first!.name, unsupported_place: null, market: null, target_metro: "austin", cities: [] },
      candidates: { ...NONE, obvious_areas: [target!.name] },
    });
    expect(candidateAreas(intent, geo).filter((a) => a.source === "obvious")).toEqual([{ metro: "austin", id: target!.id, source: "obvious" }]);
  });

  it("finds an expected area by the ZIP code CLERK adds when its name is not in a ZIP-mapped city's list", () => {
    const zipArea = geo.neighbourhoods("denver").find((n) => /^zcta_\d{5}$/.test(n.id));
    const named = geo.neighbourhoods("denver").find((n) => n.name.includes("(") && !n.name.endsWith("part)"));
    const zip = zipArea!.id.slice("zcta_".length);
    const label = named!.name.slice(named!.name.indexOf("(") + 1, -1);
    const intent = intentFor({
      job: "taste_twins",
      pillar: "location",
      geo: { metro: "nashville", area: first!.name, unsupported_place: null, market: null, target_metro: "denver", cities: [] },
      candidates: { ...NONE, obvious_areas: [`Larkspur Rise (${zip})`, `${label} (00000)`, "Nowhere Flats (99999)"] },
    });
    expect(candidateAreas(intent, geo).filter((a) => a.source === "obvious")).toEqual([
      { metro: "denver", id: zipArea!.id, source: "obvious" },
      { metro: "denver", id: named!.id, source: "obvious" },
    ]);
  });

  it("keeps only creators among a creator_fit question's obvious names", () => {
    const intent = intentFor({
      job: "creator_fit",
      pillar: "marketing",
      candidates: { ...NONE, obvious_entities: [{ text: "Kestrel Foods", entity_type: "brand" }, { text: "Mara Quill", entity_type: "artist" }, { text: "Tidewater Talks", entity_type: "podcast" }] },
    });
    expect(withJobCandidates(intent).candidates.obvious_entities.map((e) => e.text)).toEqual(["Mara Quill", "Tidewater Talks"]);
    const other = intentFor({ candidates: { ...NONE, obvious_entities: [{ text: "Kestrel Foods", entity_type: "brand" }] } });
    expect(withJobCandidates(other)).toBe(other);
  });

  it("drops candidate names copied from clerk.md's invented examples", () => {
    const intent = intentFor({ candidates: { ...NONE, obvious_entities: [{ text: "Brand Ember", entity_type: "brand" }, { text: "Kestrel Foods", entity_type: "brand" }] } });
    expect(withJobCandidates(intent).candidates.obvious_entities.map((e) => e.text)).toEqual(["Kestrel Foods"]);
    expect(EXAMPLE_CANDIDATE_NAMES.has("Brand Ember")).toBe(true);
    expect(EXAMPLE_CANDIDATE_NAMES.has("Kestrel Foods")).toBe(false);
  });

  it("takes named and compared cities as user_named and obvious markets after them, only from the run's markets", () => {
    const markets = MARKET_CATALOGUE.filter((m) => ["nashville", "austin", "denver", "chicago"].includes(m.id));
    const intent = intentFor({
      geo: { metro: null, area: null, unsupported_place: null, market: null, target_metro: null, cities: ["Austin"] },
      candidates: { ...NONE, named_markets: ["denver", "atlantis"], obvious_markets: ["chicago", "denver", "boise"] },
    });
    expect(candidateMarkets(intent, markets)).toEqual([
      { id: "denver", source: "user_named" },
      { id: "austin", source: "user_named" },
      { id: "chicago", source: "obvious" },
    ]);
    const built = buildRunCandidates({ intent, gate: { candidates: [] }, geo, markets });
    expect(built.markets.map((m) => m.id)).toEqual(["denver", "austin", "chicago"]);
  });

  it("drops candidate market ids config/metros.json does not list", () => {
    const intent = intentFor({ candidates: { ...NONE, named_markets: ["denver", "atlantis"], obvious_markets: ["gotham"] } });
    expect(withKnownMarkets(intent).candidates).toMatchObject({ named_markets: ["denver"], obvious_markets: [] });
    const clean = intentFor({ candidates: { ...NONE, named_markets: ["denver"] } });
    expect(withKnownMarkets(clean)).toBe(clean);
  });
});

describe("the scan's sets hold the candidates", () => {
  const entity = (n: number, type: RegisteredEntity["type"], candidate?: RegisteredEntity["candidate"]): RegisteredEntity => ({
    ref: `R${n}`,
    entityId: `ent-${n}`,
    name: `Brand ${n}`,
    type,
    popularity: null,
    disambiguation: null,
    tags: [],
    ...(candidate ? { candidate } : {}),
  });
  const cands = (entities: RegisteredEntity[], extra: Partial<ScanCandidates> = {}): ScanCandidates => ({ entities, areas: [], markets: [], ...extra });

  it("adds the expected rivals of the primary's type to head_to_head's metro ranking", () => {
    const intent = intentFor({ job: "head_to_head", geo: { metro: "nashville", area: null, unsupported_place: null, market: null, target_metro: null, cities: [] } });
    const plan = planScan("head_to_head", { intent, primary: entity(1, "brand"), peers: [entity(2, "brand")], candidates: cands([entity(3, "brand", "obvious"), entity(4, "artist", "obvious")]) });
    const rank = plan.steps.find((s) => s.tool === "rank_candidates");
    expect(rank?.input).toMatchObject({ candidates: ["R1", "R2", "R3"] });
  });

  it("adds expected sponsors to the slate shortlist and expected analogs to the concept test", () => {
    const sponsor = planScan("sponsorship", {
      intent: intentFor({ job: "sponsorship", pillar: "marketing" }),
      primary: entity(1, "artist"),
      peers: [],
      candidates: cands([entity(5, "brand", "obvious"), entity(6, "brand", "user_named")]),
    });
    expect(sponsor.steps.find((s) => s.tool === "sponsor_slate")?.input).toMatchObject({ shortlist: ["R5", "R6"] });
    const launch = planScan("launch_test", {
      intent: intentFor({ job: "launch_test", pillar: "investment", mentions: [], constraints: { ...intentFor().constraints, concepts: ["kelp tonic"] } }),
      primary: null,
      peers: [],
      candidates: cands([entity(7, "brand", "obvious")]),
    });
    const vector = launch.chained.find((c) => c.tool === "concept_vector");
    const tag = { ref: "T1" as const, tagId: "urn:tag:genre:brand:sea_snacks", name: "Sea Snacks", type: "urn:tag:genre:brand", signalCapable: true };
    expect(vector?.input({ tags: [tag], entities: [], areas: [] })).toMatchObject({ analogs: ["R7"] });
  });

  it("puts candidate markets first in the market grid, after the markets the question names", () => {
    const intent = intentFor({ job: "market_selection", pillar: "marketing" });
    const markets = MARKET_CATALOGUE.filter((m) => ["nashville", "austin", "denver", "chicago", "atlanta"].includes(m.id));
    const plan = planScan("market_selection", {
      intent,
      primary: entity(1, "brand"),
      peers: [entity(2, "brand")],
      markets,
      candidates: cands([], { markets: [{ id: "atlanta", source: "obvious" }, { id: "denver", source: "user_named" }] }),
    });
    const share = plan.steps.find((s) => s.tool === "share_of_taste");
    expect((share?.input as { metros: string[] }).metros.slice(0, 2)).toEqual(["atlanta", "denver"]);
  });

  it("adds candidate areas to site_selection's lift focus areas", () => {
    const geo = gazetteer();
    const [a, b] = geo.neighbourhoods("nashville");
    const intent = intentFor({
      job: "site_selection",
      pillar: "location",
      geo: { metro: "nashville", area: a!.name, unsupported_place: null, market: null, target_metro: null, cities: [] },
      constraints: { ...intentFor().constraints, concepts: ["listening bar"] },
    });
    const plan = planScan("site_selection", { intent, primary: null, peers: [], geo, candidates: cands([], { areas: [{ metro: "nashville", id: b!.id, source: "obvious" }] }) });
    const lift = plan.chained.find((c) => c.tool === "geo_lift");
    const tag = { ref: "T1" as const, tagId: "urn:tag:genre:place:restaurant:bar", name: "Bar", type: "urn:tag:genre:place", signalCapable: true };
    expect(lift?.input({ tags: [tag], entities: [], areas: [] })).toMatchObject({ focus_areas: [a!.id, b!.id] });
  });
});

describe("runAgent: candidates end to end", () => {
  it("registers the expected names, marks them in REGISTRY and states the misses in one limitation", async () => {
    const intent = intentFor({
      candidates: { ...NONE, obvious_entities: [{ text: "Brand Lumen", entity_type: "brand" }, { text: "Brand Notfound", entity_type: "brand" }] },
    });
    const { result, events, fake } = await run({ intent, stream: [respond([planCall()]), ...reportWithoutFollowup()] });
    expect(result.status).toBe("completed");
    parseAll(events);
    const context = String(fake.streamRequests[0]?.messages[0]?.content);
    expect(context).toMatch(/"name":"Brand Lumen","type":"brand".*"candidate":"Expected"/);
    expect(result.report?.limitations).toContainEqual({
      source: "flag",
      flag: "EXPECTED_CANDIDATE_MISSING",
      text: "Expected names not found under that name in the data: Brand Notfound.",
    });
    // A miss costs no confidence: no dropped entity.
    expect(result.report?.verdict.confidence.breakdown.some((l) => l.rule === "dropped_entity")).toBe(false);
  });
});
