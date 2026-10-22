import { describe, expect, it } from "vitest";
import { syntheticResult } from "./fixtures";
import { renderAgentResult } from "./report-view";

describe("renderAgentResult", () => {
  const text = renderAgentResult(syntheticResult("cli-test"), null).join("\n");

  it("renders metric tokens as their display values with badges and keeps evidence citations", () => {
    expect(text).toContain("headline   Brand Alpha stands apart at 1 of 5 (DERIVED)");
    expect(text).toContain("thesis     Brand Alpha ranks 1 of 5 (DERIVED) on distinctiveness among its peers [E1].");
    expect(text).not.toContain("{{M");
  });

  it("shows the signal, the confidence band with its breakdown and the coverage", () => {
    expect(text).toContain("signal     strong · confidence HIGH (90/100) · 1 of 1 evidence bundles ok");
    expect(text).toContain("-10 thin result");
  });

  it("separates the Qloo data from our read in each argument", () => {
    expect(text).toContain("A1 competition · STRONG · M2 E1");
    expect(text).toContain("QLOO DATA  Its nearest peer sits at 0.50 (MEASURED) [E1].");
    expect(text).toContain("OUR READ   A niche with room of its own.");
  });

  it("lists limitations with their flags and the receipt", () => {
    expect(text).toContain("  - CANDIDATES_UNSCORED: Entities without a score are shown as not measured.");
    expect(text).toContain("  - Audience taste similarity, not switching or sales.");
    expect(text).toContain("Qloo       6 network · 2 cached · 1 reused");
    expect(text).toContain("endpoints  /v2/insights brand ×6");
    expect(text).toContain("numbers    3/3 traced");
    expect(text).toContain("RUN completed");
    expect(text).toContain("CHECKER ✓ 3/3 numbers traced · 0 issue(s)");
  });

  it("shows the picker for a needs_input run, which has no report", () => {
    const lines = renderAgentResult(syntheticResult("cli-test", { status: "needs_input", report: null, reason: "pick an entity" }), {
      type: "needs_input",
      mention: "Brand Twin",
      entityType: "brand",
      reason: "ambiguous",
      candidates: [
        { key: "c1", name: "Brand Twin", disambiguation: "2004", popularity: 0.4 },
        { key: "c2", name: "Brand Twin", disambiguation: "2019", popularity: null },
      ],
    });
    expect(lines).toContain("NEEDS A CHOICE: 'Brand Twin' (brand) is ambiguous; nothing was substituted (D20).");
    expect(lines).toContain("  1. Brand Twin (2004) · pop 0.40");
    expect(lines).toContain("  2. Brand Twin (2019)");
    expect(lines).toContain("RUN needs_input: pick an entity");
    // No ids known: the way to find them.
    expect(lines.join("\n")).toContain('pnpm run-skill resolve_entities "brand twin" --type brand and pass one as --pins "<name>=<entityId>"');
  });

  it("gives each candidate the --pins answer that chooses it, keyed by the normalised mention", () => {
    const picker = {
      type: "needs_input" as const,
      mention: "The Brand Twin, Inc.",
      entityType: "brand" as const,
      reason: "ambiguous" as const,
      candidates: [
        { key: "pk_one", name: "Brand Twin", disambiguation: "2004", popularity: 0.4 },
        { key: "pk_two", name: "Brand Twin", disambiguation: "2019", popularity: null },
      ],
    };
    const lines = renderAgentResult(syntheticResult("cli-test", { status: "needs_input", report: null, reason: "pick an entity" }), picker, new Map([["pk_one", "ent-invented-twin-1"]]));
    const at = lines.indexOf("  1. Brand Twin (2004) · pop 0.40");
    // The comma and the "=" of a raw name would break --pins; the normalised key has neither.
    expect(lines[at + 1]).toBe('     --pins "brand twin=ent-invented-twin-1"');
    expect(lines[at + 2]).toBe("  2. Brand Twin (2019)");
    expect(lines).toContain("  Run the same question again with one of the --pins above to choose, or ask with a more specific name.");
  });
});
