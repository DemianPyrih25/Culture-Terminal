// run-skill's tag refs: --tags registers a URN the way find_tags does, with the name and type
// @ct/quant's findTags/tags.ts derives, and the registry view prints whole URNs. Public taxonomy
// URNs and invented ones only (D29).
import { createEntityRegistry } from "@ct/agent";
import * as quant from "@ct/quant";
import { describe, expect, it } from "vitest";
import { registerTagUrn, registryRefs, renderRegistry, tagNameFromUrn, tagTypeOf } from "./skill-input";

describe("tag URNs as find_tags reads them", () => {
  it("are @ct/quant's own readers, not copies", () => {
    expect(tagTypeOf).toBe(quant.tagTypeOf);
    expect(tagNameFromUrn).toBe(quant.tagNameFromUrn);
  });

  it.each([
    ["urn:tag:genre:place:restaurant:coffee_shop", "urn:tag:genre:place", "Coffee shop"],
    ["urn:tag:category:place:cafe", "urn:tag:category:place", "Cafe"],
    ["urn:tag:cuisine:qloo:invented_ramen", "urn:tag:cuisine:qloo", "Invented ramen"],
    ["urn:tag:keyword:invented_word", "urn:tag:keyword", "Invented word"],
  ])("reads %s as type %s, name %s", (urn, type, name) => {
    expect(tagTypeOf(urn)).toBe(type);
    expect(tagNameFromUrn(urn)).toBe(name);
  });

  it("registers a taxonomy tag as a signal and a descriptive one as a label", () => {
    const registry = createEntityRegistry();
    expect(registerTagUrn(registry, "urn:tag:genre:place:restaurant:coffee_shop")).toMatchObject({
      ref: "T1",
      name: "Coffee shop",
      type: "urn:tag:genre:place",
      signalCapable: true,
    });
    expect(registerTagUrn(registry, "urn:tag:ambience:qloo:invented_retro")).toMatchObject({ ref: "T2", signalCapable: false });
    // A repeat keeps its first ref.
    expect(registerTagUrn(registry, "urn:tag:genre:place:restaurant:coffee_shop").ref).toBe("T1");
  });
});

describe("renderRegistry", () => {
  const registry = createEntityRegistry();
  registry.registerEntity({ entityId: "invented-entity-0001", name: "Brand Alpha", type: "brand", disambiguation: null, popularity: 0.5, tags: [] });
  const long = "urn:tag:genre:place:restaurant:invented_cuisine_with_a_rather_long_leaf_name";
  registerTagUrn(registry, long);
  registerTagUrn(registry, "urn:tag:customer_identity:qloo:invented_neighbourhood_regulars_of_long_standing");

  it("prints every ref, entities by name only, tags with their whole URN", () => {
    const text = renderRegistry(registry).join("\n");
    expect(text).toMatch(/R1\s+brand\s+Brand Alpha\s+—\s+0\.50/);
    expect(text).toContain(long);
    expect(text).toContain("urn:tag:customer_identity:qloo:invented_neighbourhood_regulars_of_long_standing (descriptive: no signal)");
    expect(text).not.toContain("invented-entity-0001");
  });

  it("prints only the refs asked for, or (none)", () => {
    const lines = renderRegistry(registry, { only: new Set(["T1"]) });
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(/^ {2}T1\s/);
    expect(renderRegistry(registry, { only: new Set() })).toEqual(["  (none)"]);
    expect(renderRegistry(createEntityRegistry())).toEqual(["  (empty)"]);
  });

  it("knows every ref the registry holds", () => {
    expect(registryRefs(registry)).toEqual(new Set(["R1", "T1", "T2"]));
  });
});
