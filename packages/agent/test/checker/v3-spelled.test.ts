// CHECKER V3 (Part 9 open issue 9): a number above ten spelled out ("fifty") is rejected like its digits on
// the first attempt, never let through as a mere warning while a repair turn is left. Invented names (D29).
import { describe, expect, it } from "vitest";
import { V3_REJECT_ABOVE } from "../../src/checker";
import { checkHonest, editDraft } from "./honesty-fixtures";

describe("V3: spelled-out numbers", () => {
  it("rejects a lone spelled-out number on the first attempt, like a digit", () => {
    expect(V3_REJECT_ABOVE).toBe(0);
    for (const words of ["fifty", "Twelve", "twenty-one", "a dozen"]) {
      const result = checkHonest(editDraft((d) => (d.thesis = `${d.thesis} It reached ${words} cities.`)));
      const v3 = result.issues.filter((i) => i.rule === "V3");
      expect(v3, words).toEqual([expect.objectContaining({ action: "reject", path: "thesis" })]);
      expect(result.reject).toBe(true);
    }
  });

  it("is a warning only on the last attempt, and counts in numbers traced", () => {
    const last = checkHonest(editDraft((d) => (d.thesis = `${d.thesis} It reached fifty cities.`)), { attempt: 2 });
    expect(last.issues.filter((i) => i.rule === "V3")).toEqual([expect.objectContaining({ action: "warn", subjects: ["fifty"] })]);
    expect(last.numbersTraced.total).toBeGreaterThan(last.numbersTraced.traced);
  });

  it("leaves words up to ten and number words inside a registered name alone", () => {
    const small = checkHonest(editDraft((d) => (d.thesis = `${d.thesis} It reached three cities.`)));
    expect(small.issues.filter((i) => i.rule === "V3")).toEqual([]);
  });
});
