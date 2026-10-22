import { describe, expect, it } from "vitest";
import { normaliseName } from "../../src/skills/normalise";

describe("normaliseName", () => {
  it.each([
    ["Brand Alpha", "brand alpha"],
    ["  BRAND   alpha  ", "brand alpha"],
    ["Café Nova", "cafe nova"],
    ["Théâtre Øst", "theatre øst"],
    ["The Brand Alpha", "brand alpha"],
    ["Brand Alpha, Inc.", "brand alpha"],
    ["Brand Alpha Co.", "brand alpha"],
    ["Brand Alpha Company LLC", "brand alpha"],
    ["Brand Alpha Ltd", "brand alpha"],
    ["The Brand Alpha Co.", "brand alpha"],
    ["Brand-Alpha", "brand alpha"],
    ["Brand & Alpha", "brand alpha"],
    ["Nova's Kitchen", "novas kitchen"],
    ["A.B.C. Goods", "abc goods"],
    ["ﬁne Goods", "fine goods"],
  ])("%j → %j", (input, expected) => {
    expect(normaliseName(input)).toBe(expected);
  });

  it("drops only a leading 'the' and only trailing suffixes", () => {
    expect(normaliseName("Brand The Alpha")).toBe("brand the alpha");
    expect(normaliseName("Co Brand Alpha")).toBe("co brand alpha");
    expect(normaliseName("Alpha Company Goods")).toBe("alpha company goods");
  });

  it("never reduces a name to nothing", () => {
    expect(normaliseName("The")).toBe("the");
    expect(normaliseName("Company")).toBe("company");
    expect(normaliseName("The Co")).toBe("co");
    expect(normaliseName("!!!")).toBe("");
  });

  it("keeps word order significant", () => {
    expect(normaliseName("Nova Café")).not.toBe(normaliseName("Café Nova"));
  });
});
