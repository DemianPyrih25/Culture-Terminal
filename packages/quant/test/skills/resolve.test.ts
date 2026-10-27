import { digestFits, ModelDigest, ResolvedMention, type EntityRegistry, type EventInput } from "@ct/contracts";
import { describe, expect, it, vi } from "vitest";
import { SKILL_LIMITATIONS } from "../../src/limitations";
import { classifyMatches, resolveEntitiesSkill, searchParams } from "../../src/skills/resolve";
import { fakeProbe, fakeQloo, fakeRun, FakeRegistry, registerInvented, searchResult, type Invented } from "./support/fakes";

vi.mock("../../src/badges", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/badges")>()),
  metricConfidence: (await import("./support/seamDoubles")).metricConfidence,
}));

const NOVA: Invented = { id: "ent-nova-01", name: "Brand Nova", category: "urn:tag:genre:brand:beverage", popularity: 0.4 };
const NOVA_TWIN: Invented = { id: "ent-nova-02", name: "Brand Nova", category: null, popularity: 0.3 };
const NOVA_PLUS: Invented = { id: "ent-nova-03", name: "Brand Nova Plus", category: null, popularity: 0.99 };
const ORBIT: Invented = { id: "ent-orbit-04", name: "Orbit Goods", category: null, popularity: 0.6 };
const CAFE: Invented = { id: "ent-cafe-05", name: "Café Lumen", category: null, popularity: 0.2 };

const mention = (text: string, type: "brand" | "artist" | "place" | "podcast" = "brand") => ({ text, type });

function parse(raw: unknown) {
  return resolveEntitiesSkill.input.parse(raw);
}

describe("classifyMatches", () => {
  it("applies a single exact name of the right type", () => {
    const c = classifyMatches(mention("brand nova"), [searchResult(NOVA_PLUS), searchResult(NOVA)]);
    expect(c.matchClass).toBe("exact");
    expect(c.exact.map((r) => r.entity_id)).toEqual([NOVA.id]);
    expect(c.alternatives.map((a) => a.name)).toEqual(["Brand Nova Plus"]);
  });

  it("never lets popularity choose: a more popular near-miss is only an alternative", () => {
    const c = classifyMatches(mention("Brand Nova"), [searchResult(NOVA_PLUS)]);
    expect(c.matchClass).toBe("not_found");
    expect(c.exact).toEqual([]);
    expect(c.alternatives[0]).toMatchObject({ name: "Brand Nova Plus", popularity: 0.99 });
  });

  it("calls two exact matches ambiguous and offers both first", () => {
    const c = classifyMatches(mention("Brand Nova"), [
      searchResult(ORBIT),
      searchResult(NOVA, "urn:entity:brand", "Beverage maker"),
      searchResult(NOVA_TWIN, "urn:entity:brand", "Apparel label"),
    ]);
    expect(c.matchClass).toBe("ambiguous");
    expect(c.exact).toHaveLength(2);
    expect(c.alternatives.map((a) => a.disambiguation)).toEqual(["Beverage maker", "Apparel label", null]);
  });

  it("requires the mention's type", () => {
    const c = classifyMatches(mention("Brand Nova", "artist"), [searchResult(NOVA)]);
    expect(c.matchClass).toBe("not_found");
  });

  it("matches through normalisation and ignores a repeated entity", () => {
    const c = classifyMatches(mention("The Brand Nova Co."), [searchResult(NOVA), searchResult(NOVA)]);
    expect(c.matchClass).toBe("exact");
    expect(c.alternatives).toEqual([]);
  });

  it("matches nothing for a name that normalises to nothing", () => {
    expect(classifyMatches(mention("!!!"), [searchResult({ ...NOVA, name: "???" })]).matchClass).toBe("not_found");
  });

  it("reads a podcast billed with its host as the show, only when no result carries the name exactly", () => {
    const billed: Invented = { id: "ent-pod-06", name: "Night Shift Notes with Dana Vale", category: null, popularity: 0.5 };
    const plain: Invented = { id: "ent-pod-07", name: "Night Shift Notes", category: null, popularity: 0.2 };
    const pod = (r: Invented) => searchResult(r, "urn:entity:podcast");
    const one = classifyMatches(mention("Night Shift Notes", "podcast"), [pod(billed)]);
    expect(one.matchClass).toBe("exact");
    expect(one.exact.map((r) => r.entity_id)).toEqual([billed.id]);
    // The exact name wins over the billed one; other types never drop a "with" clause.
    expect(classifyMatches(mention("Night Shift Notes", "podcast"), [pod(billed), pod(plain)]).exact.map((r) => r.entity_id)).toEqual([plain.id]);
    expect(classifyMatches(mention("Night Shift Notes", "brand"), [searchResult(billed)]).matchClass).toBe("not_found");
    // The full billed title still matches itself, and another show's billing is no match.
    expect(classifyMatches(mention("Night Shift Notes with Dana Vale", "podcast"), [pod(billed)]).matchClass).toBe("exact");
    expect(classifyMatches(mention("Night Shift", "podcast"), [pod(billed)]).matchClass).toBe("not_found");
  });

  it("keeps a 'with' clause that is part of a podcast's title, so a shorter name never matches it (D20)", () => {
    const pod = (id: string, name: string) => searchResult({ id, name, category: null, popularity: 0.4 }, "urn:entity:podcast");
    // One word, a pronoun, an article or a common noun is a title, not a host's name.
    expect(classifyMatches(mention("Nap", "podcast"), [pod("ent-pod-11", "Nap With Me")]).matchClass).toBe("not_found");
    expect(classifyMatches(mention("Chats", "podcast"), [pod("ent-pod-12", "Chats with Ondine")]).matchClass).toBe("not_found");
    expect(classifyMatches(mention("Supper", "podcast"), [pod("ent-pod-13", "Supper with the Comets")]).matchClass).toBe("not_found");
    expect(classifyMatches(mention("Drinks", "podcast"), [pod("ent-pod-14", "Drinks with Friends Like Us")]).matchClass).toBe("not_found");
    // Two hosts still bill.
    expect(classifyMatches(mention("Late Lane", "podcast"), [pod("ent-pod-15", "Late Lane with Dana Vale and Sam Ortiz")]).matchClass).toBe("exact");
  });

  it("caps alternatives at five", () => {
    const many = Array.from({ length: 8 }, (_, i) => searchResult({ id: `ent-other-${i}`, name: `Other ${i}`, category: null }));
    expect(classifyMatches(mention("Brand Nova"), many).alternatives).toHaveLength(5);
  });
});

describe("searchParams", () => {
  it("searches the top five of the mention's type", () => {
    expect(searchParams({ text: " Brand Nova ", type: "brand", metro: null })).toEqual({
      query: "Brand Nova",
      types: "urn:entity:brand",
      take: 5,
    });
  });

  it("searches places around the metro centre, latitude first, radius in miles", () => {
    expect(searchParams({ text: "Café Lumen", type: "place", metro: "nashville" })).toEqual({
      query: "Café Lumen",
      types: "urn:entity:place",
      take: 5,
      "filter.location": "36.1627,-86.7816",
      "filter.radius": 25,
    });
  });

  it("searches places in a large county or a market with a radius that reaches its bbox (D44)", () => {
    expect(searchParams({ text: "Café Lumen", type: "place", metro: "los_angeles" })).toMatchObject({
      "filter.location": "34.0522,-118.2437",
      "filter.radius": 84,
    });
    expect(searchParams({ text: "Café Lumen", type: "place", metro: "portland" })).toMatchObject({
      "filter.location": "45.52,-122.68",
      "filter.radius": 25,
    });
  });

  it("does not search a place without a metro, or in a market config/metros.json does not list", () => {
    expect(searchParams({ text: "Café Lumen", type: "place", metro: null })).toBeNull();
    expect(searchParams({ text: "Café Lumen", type: "place", metro: "riverton" })).toBeNull();
  });
});

describe("resolve_entities skill", () => {
  const results: Record<string, Invented[]> = {
    "Brand Nova": [NOVA_PLUS, NOVA],
    "Twin Nova": [NOVA, NOVA_TWIN],
    "Missing Thing": [ORBIT],
    "Café Lumen": [CAFE],
  };
  const search = (params: Record<string, unknown>) => {
    const query = String(params.query);
    const list = query === "Twin Nova" ? [NOVA, NOVA_TWIN].map((e) => ({ ...e, name: "Twin Nova" })) : (results[query] ?? []);
    const type = String(params.types);
    return list.map((e) => searchResult(e, type));
  };

  it("registers exact matches, records one evidence bundle per call and drops the rest", async () => {
    const { api, calls } = fakeQloo({ search });
    const run = fakeRun(api);
    const input = parse({
      mentions: [
        { text: "Brand Nova", type: "brand", metro: null },
        { text: "Twin Nova", type: "brand", metro: null },
        { text: "Missing Thing", type: "brand", metro: null },
      ],
      trigger_finding_id: null,
      step_id: "S1",
    });

    const result = await resolveEntitiesSkill.run(input, run.ctx);

    expect(calls).toHaveLength(3);
    expect(calls.every((c) => c.method === "search" && c.params.take === 5)).toBe(true);
    expect(run.registry.entities().map((e) => e.entityId)).toEqual([NOVA.id]);
    expect(run.registry.entities()[0]?.tags).toEqual([{ tagId: NOVA.category, name: "beverage", type: "urn:tag:genre" }]);

    expect(run.ledger.evidences).toHaveLength(3);
    expect(run.ledger.evidences.map((e) => e.status)).toEqual(["ok", "partial", "partial"]);
    expect(run.ledger.evidences[2]?.summary).toBe(
      "'Missing Thing' not found in Qloo's hackathon dataset; closest candidates offered, not applied.",
    );
    expect(run.ledger.evidences[1]?.summary).toContain("matches several entities");

    expect(run.ledger.metrics).toHaveLength(1);
    expect(run.ledger.metrics[0]).toMatchObject({
      key: "popularity",
      formulaId: "popularity",
      badge: "MEASURED",
      value: 0.4,
      display: "0.40",
      subjectRefs: ["R1"],
      evidenceIds: ["E1"],
    });

    expect(result.status).toBe("partial");
    expect(result.flags).toEqual(["SECONDARY_ENTITY_DROPPED"]);
    expect(result.evidenceIds).toEqual(["E1", "E2", "E3"]);
    expect(result.metricIds).toEqual(["M1"]);
    // The flag's own sentence is buildLimitations' job (FLAG_TEXT); the skill adds its method bullet only.
    expect(resolveEntitiesSkill.limitations(result.flags)).toEqual([...SKILL_LIMITATIONS.resolve_entities]);

    const digest = ModelDigest.parse(result.forModel);
    expect(digest.registered).toEqual([{ ref: "R1", name: "Brand Nova", type: "brand" }]);
    expect(digest.top_rows.map((r) => [r.ref, r.values.match])).toEqual([
      ["R1", "exact"],
      [null, "ambiguous"],
      [null, "not_found"],
    ]);
    expect(digest.top_rows[2]?.values.alternatives).toBe("Orbit Goods");
    expect(JSON.stringify(digest)).not.toContain("ent-");
    expect(digestFits(digest, { tool: "resolve_entities", step: "S1" })).toBe(true);
  });

  it("emits the tool's resolutions for the trace, refs only on exact matches", async () => {
    const { api } = fakeQloo({ search });
    const run = fakeRun(api);
    await resolveEntitiesSkill.run(
      parse({
        mentions: [
          { text: "Brand Nova", type: "brand", metro: null },
          { text: "Missing Thing", type: "brand", metro: null },
        ],
        trigger_finding_id: null,
        step_id: null,
      }),
      run.ctx,
    );
    expect(run.events).toHaveLength(1);
    const event = run.events[0] as Extract<EventInput, { type: "resolve" }>;
    expect(event.type).toBe("resolve");
    const entities = event.entities.map((m) => ResolvedMention.parse(m));
    expect(entities.map((m) => [m.match, m.ref, m.source, m.role])).toEqual([
      ["exact", "R1", "tool", "secondary"],
      ["not_found", null, "tool", "secondary"],
    ]);
  });

  it("does not list an entity the registry already knew as newly registered", async () => {
    const registry = new FakeRegistry();
    registerInvented(registry, NOVA);
    const { api } = fakeQloo({ search });
    const run = fakeRun(api, registry);
    const result = await resolveEntitiesSkill.run(
      parse({ mentions: [{ text: "Brand Nova", type: "brand", metro: null }], trigger_finding_id: null, step_id: null }),
      run.ctx,
    );
    expect(result.status).toBe("ok");
    expect(result.forModel.registered).toEqual([]);
    expect(result.forModel.top_rows[0]?.ref).toBe("R1");
  });

  it("searches places inside the metro and skips a place with no metro", async () => {
    const { api, calls } = fakeQloo({ search });
    const run = fakeRun(api);
    const result = await resolveEntitiesSkill.run(
      parse({
        mentions: [
          { text: "Café Lumen", type: "place", metro: "austin" },
          { text: "Café Lumen", type: "place", metro: null },
        ],
        trigger_finding_id: null,
        step_id: null,
      }),
      run.ctx,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.params).toMatchObject({ "filter.location": "30.2672,-97.7431", "filter.radius": 25 });
    expect(run.registry.entities()[0]).toMatchObject({ name: "Café Lumen", type: "place" });
    expect(result.status).toBe("partial");
    expect(result.flags).toContain("SECONDARY_ENTITY_DROPPED");
    expect(result.forModel.top_rows[1]?.values.match).toBe("not_searched");
    expect(result.forModel.notices).toHaveLength(1);
  });

  it("returns a partial result when the budget runs out", async () => {
    const { api, calls } = fakeQloo({ search, budget: 1 });
    const run = fakeRun(api);
    const result = await resolveEntitiesSkill.run(
      parse({
        mentions: [
          { text: "Brand Nova", type: "brand", metro: null },
          { text: "Missing Thing", type: "brand", metro: null },
        ],
        trigger_finding_id: null,
        step_id: null,
      }),
      run.ctx,
    );
    expect(calls).toHaveLength(1);
    expect(result.status).toBe("partial");
    expect(result.flags).toEqual(["BUDGET_TRUNCATED"]);
    expect(result.forModel.top_rows.map((r) => r.values.match)).toEqual(["exact", "budget_truncated"]);
    expect(resolveEntitiesSkill.limitations(result.flags)).toEqual(resolveEntitiesSkill.limitations([]));
  });

  it("propagates failures that are not budget errors", async () => {
    const { api } = fakeQloo({
      search: () => {
        throw new Error("network down");
      },
    });
    const run = fakeRun(api);
    await expect(
      resolveEntitiesSkill.run(
        parse({ mentions: [{ text: "Brand Nova", type: "brand", metro: null }], trigger_finding_id: null, step_id: null }),
        run.ctx,
      ),
    ).rejects.toThrow("network down");
  });

  it("estimates one call per uncached distinct mention", async () => {
    const probe = fakeProbe((path, params) => path === "/search" && params.query === "Brand Nova");
    const input = parse({
      mentions: [
        { text: "Brand Nova", type: "brand", metro: null },
        { text: "Missing Thing", type: "brand", metro: null },
        { text: "Missing Thing", type: "brand", metro: null },
        { text: "Café Lumen", type: "place", metro: "nashville" },
        { text: "Café Lumen", type: "place", metro: null },
      ],
      trigger_finding_id: null,
      step_id: null,
    });
    expect(await resolveEntitiesSkill.estimateCalls(input, probe, {} as EntityRegistry)).toBe(2);
    expect(probe.asked).toHaveLength(3);
  });
});
