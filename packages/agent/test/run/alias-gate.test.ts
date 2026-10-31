// Known aliases (Part 9 open issue 5, the D20 alias exception): a verified alias lets the gate apply the
// result its own search returned under the official name, and the resolve event says so. Invented names
// only (D29): the mock search offers "<name> Classic" for a query it holds no exact match for.
import type { Mention } from "@ct/contracts";
import { describe, expect, it } from "vitest";
import aliasConfig from "../../../../config/brand_aliases.json";
import { createEntityRegistry } from "../../src/registry";
import { aliasMatch, BRAND_ALIASES, BrandAliasConfig, knownNameReading, leadingNameMatch, verifiedAliases, type BrandAlias } from "../../src/run/aliases";
import { runResolutionGate } from "../../src/run/gate";
import { intentFor, mockQloo } from "./support";

const primary = (text: string): Mention => ({ text, entity_type: "brand", role: "primary", public_figure: false });
const ALIAS: BrandAlias = { alias: "Brand Notfound", names: ["Brand Notfound Classic"], type: "brand" };

function gate(mention: Mention, aliases: readonly BrandAlias[]) {
  return runResolutionGate({ intent: intentFor({ mentions: [mention] }), qloo: mockQloo().standalone().forTool(null), registry: createEntityRegistry(), pins: {}, aliases });
}

describe("the gate with a verified alias", () => {
  it("applies the official name the alias's own search returned, and the resolve event carries it", async () => {
    const outcome = await gate(primary("Brand Notfound"), [ALIAS]);
    if (outcome.kind !== "resolved") throw new Error(outcome.kind);
    expect(outcome.primary).toMatchObject({ name: "Brand Notfound Classic", candidate: "user_named" });
    expect(outcome.entities[0]).toMatchObject({ mention: "Brand Notfound", match: "exact", name: "Brand Notfound Classic", alias: "Brand Notfound Classic" });
  });

  it("stops at the picker without the alias, or when the type differs", async () => {
    expect((await gate(primary("Brand Notfound"), [])).kind).toBe("needs_input");
    expect((await gate(primary("Brand Notfound"), [{ ...ALIAS, type: "artist" }])).kind).toBe("needs_input");
  });

  it("never applies a name the search did not return", () => {
    const results = [{ entity_id: "ent-1", name: "Brand Notfound Studio", types: ["urn:entity:brand"] }];
    expect(aliasMatch({ text: "brand notfound", entity_type: "brand" }, results as never, [ALIAS])).toBeNull();
    expect(aliasMatch({ text: "Brand Notfound", entity_type: "brand" }, [{ ...results[0]!, name: "brand notfound classic" }] as never, [ALIAS])?.name).toBe("brand notfound classic");
  });
});

describe("leadingNameMatch (expected candidates written loosely)", () => {
  const BRAND = "urn:entity:brand";
  const r = (name: string, types = [BRAND]) => ({ entity_id: `id-${name}`, name, types });
  const want = { text: "Fizzwell", entity_type: "brand" as const };

  it("takes the top result that only adds a word or two to the expected name", () => {
    expect(leadingNameMatch(want, [r("Fizzwell Kombucha"), r("Health Weekly")] as never, BRAND)?.name).toBe("Fizzwell Kombucha");
    expect(leadingNameMatch(want, [r("Fizzwell Sparkling Tea"), r("Other")] as never, BRAND)?.name).toBe("Fizzwell Sparkling Tea");
  });

  it("refuses a lower-ranked match, two such matches, a longer name, a word that only starts the same, or another type", () => {
    expect(leadingNameMatch(want, [r("Other Brand"), r("Fizzwell Kombucha")] as never, BRAND)).toBeNull();
    expect(leadingNameMatch(want, [r("Fizzwell Kombucha"), r("Fizzwell Soda")] as never, BRAND)).toBeNull();
    expect(leadingNameMatch(want, [r("Fizzwell Kombucha Company Limited")] as never, BRAND)).toBeNull();
    expect(leadingNameMatch(want, [r("Fizzwellness Labs")] as never, BRAND)).toBeNull();
    expect(leadingNameMatch(want, [r("Fizzwell Kombucha", ["urn:entity:place"])] as never, BRAND)).toBeNull();
  });
});

describe("knownNameReading (the gate's one reading of a name with no exact match)", () => {
  const BRAND = "urn:entity:brand";
  const r = (name: string) => ({ entity_id: `id-${name}`, name, types: [BRAND] });
  const SHORT: BrandAlias = { alias: "QBX", names: ["Quillby Box Kitchen"], type: "brand" };
  const qbx = { text: "QBX", entity_type: "brand" as const };

  it("reads a short alias as the official name its own search returned, leading or not", () => {
    const results = [r("QBX Labs Studio Co"), r("Quillby Box Kitchen")] as never;
    expect(knownNameReading(qbx, results, "not_found", false, [SHORT])?.name).toBe("Quillby Box Kitchen");
    expect(knownNameReading(qbx, results, "ambiguous", true, [SHORT])?.name).toBe("Quillby Box Kitchen");
  });

  it("keeps an ambiguous name a miss, and takes the leading match only when asked and nothing matched", () => {
    const fizz = { text: "Fizzwell", entity_type: "brand" as const };
    const results = [r("Fizzwell Kombucha"), r("Other")] as never;
    expect(knownNameReading(fizz, results, "ambiguous", true, [])).toBeNull();
    expect(knownNameReading(fizz, results, "not_found", false, [])).toBeNull();
    expect(knownNameReading(fizz, results, "not_found", true, [])?.name).toBe("Fizzwell Kombucha");
    expect(knownNameReading(qbx, [r("Quillby Box")] as never, "not_found", true, [SHORT])).toBeNull();
  });
});

describe("config/brand_aliases.json", () => {
  it("parses, lists names only, and only verified entries apply", () => {
    const config = BrandAliasConfig.parse(aliasConfig);
    expect(config.aliases.length).toBeGreaterThanOrEqual(15);
    for (const a of config.aliases) {
      expect(a.names.length).toBeGreaterThan(0);
      expect(JSON.stringify(a)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
    }
    expect(BRAND_ALIASES).toEqual(verifiedAliases(aliasConfig));
    expect(BRAND_ALIASES.length).toBe(config.aliases.filter((a) => a.status === "verified").length);
    const mixed = { aliases: [{ ...config.aliases[0]!, status: "unverified" }, { ...config.aliases[0]!, alias: "Other", status: "verified", verified_by: "check" }] };
    expect(verifiedAliases(mixed).map((a) => a.alias)).toEqual(["Other"]);
  });
});
