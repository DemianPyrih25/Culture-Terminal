// The resolution gate over the mock Qloo transport: exact-only matching, pins, drops and failures (D20).
import type { Mention } from "@ct/contracts";
import { normaliseName } from "@ct/quant";
import type { QlooCallRecord } from "@ct/qloo";
import { describe, expect, it } from "vitest";
import { createEntityRegistry } from "../../src/registry";
import { GATE_SEARCH_MAX, gateEvidence, PRIVATE_PERSON_REASON, privatePersonRefusal, runResolutionGate, type GateInput } from "../../src/run/gate";
import { pickerKey } from "../../src/run/picker";
import { intentFor, mockQloo, parseAll, run, typesOf } from "./support";

const brand = (text: string, role: Mention["role"] = "secondary"): Mention => ({ text, entity_type: "brand", role, public_figure: false });

function gate(mentions: Mention[], options: { pins?: Record<string, string>; faults?: Parameters<typeof mockQloo>[0]; metro?: "nashville" | null; market?: string | null } = {}) {
  const calls: QlooCallRecord[] = [];
  const client = mockQloo(options.faults ?? []);
  const registry = createEntityRegistry();
  const input: GateInput = {
    intent: intentFor({ mentions, geo: { metro: options.metro ?? null, area: null, unsupported_place: null, market: options.market ?? null } }),
    qloo: client.standalone({ onCall: (r) => calls.push(r) }).forTool(null),
    registry,
    pins: options.pins ?? {},
  };
  return { run: () => runResolutionGate(input), calls, registry, client };
}

describe("runResolutionGate", () => {
  it("applies exact matches only: the primary and a peer resolve, a missing secondary is dropped", async () => {
    const g = gate([brand("Brand Alpha", "primary"), brand("Brand Beta", "peer"), brand("Brand Notfound")]);
    const outcome = await g.run();
    if (outcome.kind !== "resolved") throw new Error(outcome.kind);
    expect(outcome.primary).toMatchObject({ ref: "R1", name: "Brand Alpha", type: "brand" });
    expect(outcome.peers.map((p) => p.name)).toEqual(["Brand Beta"]);
    expect(outcome.dropped).toBe(1);
    expect(outcome.limitations).toEqual(["'Brand Notfound' not found in Qloo's hackathon dataset; closest candidates offered, not applied."]);
    expect(outcome.entities.map((e) => [e.mention, e.role, e.match, e.ref])).toEqual([
      ["Brand Alpha", "primary", "exact", "R1"],
      ["Brand Beta", "peer", "exact", "R2"],
      ["Brand Notfound", "secondary", "not_found", null],
    ]);
    expect(outcome.entities[2]?.alternatives.length).toBeGreaterThan(0);
    expect(g.registry.entities()).toHaveLength(2);
    expect(g.calls.every((c) => c.path === "/search" && c.toolCallId === null)).toBe(true);
  });

  it("searches a repeated mention once, keeping it as the primary", async () => {
    const g = gate([brand("brand alpha"), brand("Brand Alpha", "primary"), brand("BRAND ALPHA, Inc.")]);
    const outcome = await g.run();
    if (outcome.kind !== "resolved") throw new Error(outcome.kind);
    expect(outcome.primary?.name).toBe("Brand Alpha");
    expect(outcome.entities.map((e) => e.role)).toEqual(["primary"]);
    expect(g.calls).toHaveLength(1);
  });

  it("looks up persons only as public figures", async () => {
    const person = (text: string, role: Mention["role"], public_figure: boolean): Mention => ({ text, entity_type: "person", role, public_figure });
    const refused = gate([person("Pat Example", "primary", false)]);
    expect(await refused.run()).toEqual({ kind: "refused", reason: PRIVATE_PERSON_REASON });
    expect(refused.calls).toHaveLength(0);

    const mixed = gate([person("Comedian Vega", "primary", true), person("Pat Example", "secondary", false)]);
    const outcome = await mixed.run();
    if (outcome.kind !== "resolved") throw new Error(outcome.kind);
    expect(outcome.primary?.type).toBe("person");
    expect(outcome.dropped).toBe(1);
    expect(outcome.limitations[0]).toContain("not marked as a public figure");
    expect(mixed.calls).toHaveLength(1);
  });

  it("searches places inside the question's metro, and asks for one when there is none", async () => {
    const place = (role: Mention["role"]): Mention => ({ text: "Cafe Lumen", entity_type: "place", role, public_figure: false });
    const located = gate([place("primary")], { metro: "nashville" });
    const outcome = await located.run();
    expect(outcome.kind).toBe("resolved");
    expect(located.calls[0]?.query["filter.location"]).toBeDefined();

    const unlocated = gate([place("primary")]);
    const asked = await unlocated.run();
    if (asked.kind !== "needs_input") throw new Error(asked.kind);
    expect(asked.picker).toMatchObject({ type: "needs_input", mention: "Cafe Lumen", entityType: "place", reason: "not_found", candidates: [] });
    expect(asked.reason).toContain("a map city or market");
    expect(unlocated.calls).toHaveLength(0);
  });

  it("searches a place around the market CLERK put it in, and not in a market config/metros.json does not list (D44)", async () => {
    const place: Mention = { text: "Cafe Lumen", entity_type: "place", role: "primary", public_figure: false };
    const inMarket = gate([place], { market: "portland" });
    expect((await inMarket.run()).kind).not.toBe("needs_input");
    expect(inMarket.calls[0]?.query).toMatchObject({ "filter.location": "45.52,-122.68", "filter.radius": "25" });

    const unknown = gate([place], { market: "riverton" });
    expect((await unknown.run()).kind).toBe("needs_input");
    expect(unknown.calls).toHaveLength(0);
  });

  it("offers the candidates of a non-exact primary under opaque keys", async () => {
    const g = gate([brand("Brand Notfound", "primary"), brand("Brand Beta", "peer")]);
    const outcome = await g.run();
    if (outcome.kind !== "needs_input") throw new Error(outcome.kind);
    expect(outcome.entities.map((e) => e.match)).toEqual(["not_found", "exact"]);
    const search = g.calls[0];
    expect(search?.path).toBe("/search");
    expect(outcome.picker.candidates.length).toBeGreaterThan(1);
    expect(outcome.picker.candidates.map((c) => c.name).every((n) => n.includes("Brand Notfound"))).toBe(true);
    expect(JSON.stringify(outcome.picker)).not.toContain("mock-ent-");
  });

  it("applies a pin from the mention's own search, or describes it with /entities", async () => {
    const probe = gate([brand("Brand Notfound", "primary")]);
    const asked = await probe.run();
    if (asked.kind !== "needs_input") throw new Error(asked.kind);
    const results = (await probe.client.standalone().forTool(null).search({ query: "Brand Notfound", types: "urn:entity:brand", take: 5 })).data.results;
    const chosen = results.find((r) => pickerKey(r.entity_id) === asked.picker.candidates[0]?.key);
    if (chosen === undefined) throw new Error("no candidate");

    const pinned = gate([brand("Brand Notfound", "primary")], { pins: { [normaliseName("Brand Notfound")]: chosen.entity_id } });
    const fromSearch = await pinned.run();
    if (fromSearch.kind !== "resolved") throw new Error(fromSearch.kind);
    expect(fromSearch.primary).toMatchObject({ entityId: chosen.entity_id, name: chosen.name });
    expect(fromSearch.entities[0]).toMatchObject({ match: "exact", ref: "R1", alternatives: [] });
    expect(pinned.calls.map((c) => c.path)).toEqual(["/search"]);

    const other = (await probe.client.standalone().forTool(null).search({ query: "Brand Zeta", types: "urn:entity:brand", take: 5 })).data.results[0];
    if (other === undefined) throw new Error("no entity");
    const described = gate([brand("Brand Notfound", "primary")], { pins: { "brand notfound": other.entity_id } });
    const fromEntities = await described.run();
    if (fromEntities.kind !== "resolved") throw new Error(fromEntities.kind);
    expect(fromEntities.primary?.entityId).toBe(other.entity_id);
    expect(described.calls.map((c) => c.path)).toEqual(["/search", "/entities"]);
  });

  it("fails when the primary's lookup fails, and drops a secondary whose lookup fails", async () => {
    const primaryDown = gate([brand("Brand Alpha", "primary")], { faults: [{ match: "query=Brand Alpha", status: 400 }] });
    const failed = await primaryDown.run();
    expect(failed.kind).toBe("failed");

    const secondaryDown = gate([brand("Brand Alpha", "primary"), brand("Brand Beta")], { faults: [{ match: "query=Brand Beta", status: 400 }] });
    const outcome = await secondaryDown.run();
    if (outcome.kind !== "resolved") throw new Error(outcome.kind);
    expect(outcome.dropped).toBe(1);
    expect(outcome.limitations[0]).toContain("could not be looked up");
  });
});

describe("runResolutionGate: pins, the search cap and its evidence", () => {
  it("never reads an inherited object key as a pin", async () => {
    const g = gate([brand("Constructor", "primary")]);
    const outcome = await g.run();
    if (outcome.kind !== "resolved") throw new Error(outcome.kind);
    expect(outcome.primary).toMatchObject({ ref: "R1", name: "Constructor" });
    expect(g.calls.map((c) => c.path)).toEqual(["/search"]);
  });

  it("looks up at most GATE_SEARCH_MAX mentions, the primary first, and drops the rest", async () => {
    const names = ["Brand Beta", "Brand Gamma", "Brand Delta", "Brand Epsilon", "Brand Zeta", "Brand Eta", "Brand Theta", "Brand Iota", "Brand Kappa"];
    const g = gate([...names.map((n) => brand(n)), brand("Brand Alpha", "primary")]);
    const outcome = await g.run();
    if (outcome.kind !== "resolved") throw new Error(outcome.kind);
    expect(g.calls).toHaveLength(GATE_SEARCH_MAX);
    expect(outcome.primary?.name).toBe("Brand Alpha");
    expect(outcome.entities.map((e) => e.mention)).toEqual(["Brand Alpha", ...names.slice(0, GATE_SEARCH_MAX - 1)]);
    expect(outcome.dropped).toBe(names.length + 1 - GATE_SEARCH_MAX);
    expect(outcome.limitations).toEqual([
      `'Brand Iota' was not looked up: a question is resolved for at most ${GATE_SEARCH_MAX} named entities.`,
      `'Brand Kappa' was not looked up: a question is resolved for at most ${GATE_SEARCH_MAX} named entities.`,
    ]);
  });

  it("turns drops into one SECONDARY_ENTITY_DROPPED evidence bundle over the gate's calls", async () => {
    const clean = await gate([brand("Brand Alpha", "primary"), brand("Brand Beta", "peer")]).run();
    if (clean.kind !== "resolved") throw new Error(clean.kind);
    expect(clean.calls).toHaveLength(2);
    expect(gateEvidence(clean)).toBeNull();

    const g = gate([brand("Brand Alpha", "primary"), brand("Brand Notfound")]);
    const outcome = await g.run();
    if (outcome.kind !== "resolved") throw new Error(outcome.kind);
    const evidence = gateEvidence(outcome);
    expect(evidence).toMatchObject({ skill: "resolve_entities", status: "partial", flags: ["SECONDARY_ENTITY_DROPPED"] });
    expect(evidence?.calls.map((c) => c.qlooCallId)).toEqual(g.calls.map((c) => c.qlooCallId));
    expect(evidence?.summary).toContain("1 named entity was left out.");
    expect(evidence?.summary).toContain("'Brand Notfound' not found");
  });

  it("refuses a primary private person in code, without Qloo", () => {
    const person = (role: Mention["role"], public_figure: boolean): Mention => ({ text: "Pat Example", entity_type: "person", role, public_figure });
    expect(privatePersonRefusal(intentFor({ mentions: [person("primary", false)] }))).toBe(PRIVATE_PERSON_REASON);
    expect(privatePersonRefusal(intentFor({ mentions: [person("primary", true)] }))).toBeNull();
    expect(privatePersonRefusal(intentFor({ mentions: [brand("Brand Alpha", "primary"), person("secondary", false)] }))).toBeNull();
    expect(privatePersonRefusal(intentFor({ mentions: [] }))).toBeNull();
  });
});

describe("runAgent with a failing gate", () => {
  it("ends failed with a typed error event and no ANALYST call", async () => {
    const { result, events, fake } = await run({ qloo: mockQloo([{ match: "query=Brand Alpha", status: 400 }]) });
    expect(result.status).toBe("failed");
    expect(result.model).toBeNull();
    expect(typesOf(events)).toEqual(["run.created", "clerk", "qloo", "error", "usage"]);
    expect(events.find((e) => e.type === "error")).toMatchObject({ code: "internal", retryable: false });
    expect(fake.streamRequests).toHaveLength(0);
    parseAll(events);
  });
});
