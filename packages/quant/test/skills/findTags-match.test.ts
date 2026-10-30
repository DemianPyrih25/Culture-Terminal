// R2 (D48): how find_tags classes a searched concept against the question's concept parts.
import { describe, expect, it } from "vitest";
import { conceptMatchOf, exactPart, rememberExact, rememberNearest } from "../../src/skills/findTags/match";
import { FakeRegistry } from "./support/fakes";

describe("find_tags concept match", () => {
  it("is exact for a question part, category for a broader one, proxy for a look-alike", () => {
    const r = new FakeRegistry();
    const parts = ["invented oat milk latte"];
    expect(exactPart("Invented  Oat Milk Latte", parts)).toBe("invented oat milk latte");
    expect(conceptMatchOf("invented oat milk latte", parts, r)).toBe("exact");
    expect(conceptMatchOf("latte", parts, r)).toBe("category");
    expect(conceptMatchOf("milk tea", parts, r)).toBe("proxy");
  });

  it("reads a nearest category the run offered as category level", () => {
    const r = new FakeRegistry();
    rememberNearest(r, ["Dairy Alternatives"]);
    expect(conceptMatchOf("dairy alternatives", ["invented oat milk latte"], r)).toBe("category");
    // Another run's memory never leaks in.
    expect(conceptMatchOf("dairy alternatives", ["invented oat milk latte"], new FakeRegistry())).toBe("proxy");
  });

  it("puts no restriction on searches once every part has its exact tag, or when the question has none", () => {
    const r = new FakeRegistry();
    rememberExact(r, "invented listening bar");
    expect(conceptMatchOf("cocktail bar", ["invented listening bar"], r)).toBeUndefined();
    expect(conceptMatchOf("cocktail bar", [], new FakeRegistry())).toBeUndefined();
  });
});
