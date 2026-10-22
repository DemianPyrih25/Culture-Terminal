import { describe, expect, it } from "vitest";
import { createEntityRegistry, DESCRIPTIVE_TAG_NOTE } from "../../src/registry";

const alpha = {
  entityId: "ent-alpha-01",
  name: "Brand Alpha",
  type: "brand" as const,
  popularity: 0.87654,
  disambiguation: "Sparkling water",
  tags: [{ tagId: "urn:tag:genre:brand:beverage", name: "Beverage", type: "urn:tag:genre" }],
};

describe("createEntityRegistry", () => {
  it("assigns R# and T# refs in order and is idempotent by Qloo id", () => {
    const registry = createEntityRegistry();
    const a = registry.registerEntity(alpha);
    const b = registry.registerEntity({ ...alpha, entityId: "ent-beta-01", name: "Brand Beta", popularity: null });
    const again = registry.registerEntity({ ...alpha, name: "Brand Alpha (renamed)" });
    expect([a.ref, b.ref]).toEqual(["R1", "R2"]);
    expect(again).toBe(a);
    expect(registry.entities()).toHaveLength(2);

    const t1 = registry.registerTag({ tagId: "urn:tag:genre:brand:beverage", name: "Beverage", type: "urn:tag:genre", signalCapable: true });
    const t2 = registry.registerTag({ tagId: "urn:tag:style:qloo:minimal", name: "Minimal", type: "urn:tag:style:qloo", signalCapable: false });
    expect([t1.ref, t2.ref]).toEqual(["T1", "T2"]);
    expect(registry.registerTag({ ...t1, name: "Other" })).toBe(t1);
    expect(registry.tags()).toHaveLength(2);
  });

  it("looks entities and tags up by ref and by Qloo id", () => {
    const registry = createEntityRegistry();
    const a = registry.registerEntity(alpha);
    const t = registry.registerTag({ tagId: "urn:tag:genre:brand:beverage", name: "Beverage", type: "urn:tag:genre", signalCapable: true });
    expect(registry.entity("R1")).toBe(a);
    expect(registry.byEntityId("ent-alpha-01")).toBe(a);
    expect(registry.tag("T1")).toBe(t);
    expect(registry.byTagId("urn:tag:genre:brand:beverage")).toBe(t);
    expect(registry.entity("R9")).toBeNull();
    expect(registry.byEntityId("ent-missing")).toBeNull();
    expect(registry.tag("T9")).toBeNull();
    expect(registry.byTagId("urn:tag:none")).toBeNull();
  });

  it("does not keep a reference to the caller's tag list", () => {
    const registry = createEntityRegistry();
    const tags = [...alpha.tags];
    registry.registerEntity({ ...alpha, tags });
    tags.push({ tagId: "urn:tag:x", name: "X", type: "urn:tag:x" });
    expect(registry.entity("R1")?.tags).toHaveLength(1);
  });

  it("builds the model-facing table with refs and rounded popularity, never Qloo ids", () => {
    const registry = createEntityRegistry();
    registry.registerEntity(alpha);
    registry.registerEntity({ ...alpha, entityId: "ent-beta-01", name: "Brand Beta", popularity: null, disambiguation: null });
    registry.registerTag({ tagId: "urn:tag:genre:brand:beverage", name: "Beverage", type: "urn:tag:genre", signalCapable: true });
    registry.registerTag({ tagId: "urn:tag:style:qloo:minimal", name: "Minimal", type: "urn:tag:style:qloo", signalCapable: false });
    const table = registry.registryTable();
    expect(table).toEqual([
      { ref: "R1", name: "Brand Alpha", type: "brand", disambiguation: "Sparkling water", popularity: 0.88 },
      { ref: "R2", name: "Brand Beta", type: "brand", disambiguation: null, popularity: null },
      { ref: "T1", name: "Beverage", type: "urn:tag:genre", disambiguation: null, popularity: null },
      { ref: "T2", name: "Minimal", type: "urn:tag:style:qloo", disambiguation: DESCRIPTIVE_TAG_NOTE, popularity: null },
    ]);
    const json = JSON.stringify(table);
    expect(json).not.toContain("ent-alpha-01");
    expect(json).not.toContain("urn:tag:genre:brand:beverage");
    expect(json).not.toContain("entityId");
  });

  it("refuses empty Qloo ids", () => {
    const registry = createEntityRegistry();
    expect(() => registry.registerEntity({ ...alpha, entityId: " " })).toThrow(TypeError);
    expect(() => registry.registerTag({ tagId: "", name: "x", type: "x", signalCapable: true })).toThrow(TypeError);
  });
});
