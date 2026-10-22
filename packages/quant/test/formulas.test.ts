// The FORMULAS registry is UI copy for /method and every tooltip: complete, honest and guard-clean.
import { describe, expect, it } from "vitest";
import { FORMULA_IDS, FORMULAS, isFormulaId, type Formula } from "../src/formulas";
import { displayRanks } from "../src/skills/format";

// The decimal rule of `pnpm guard` (tools/guard/no-qloo-data.ts): 3+ fractional digits look like a
// copied Qloo score and are rejected in UI copy.
const LONG_DECIMAL = /(?<![A-Za-z0-9.])\d*\.\d{3,}(?!\.?\d)/;

// Wording the CHECKER phrase linter (SPEC §6.2 V4) and D13 forbid anywhere in user-facing copy.
const FORBIDDEN = /\b(poach\w*|steal\w*|undervalued|overvalued|underpriced|price target|guaranteed|drives sales|causes)\b/i;

function texts(f: Formula): string[] {
  return [f.name, f.formula_tex, f.plain_english, ...f.caveats];
}

describe("FORMULAS", () => {
  it("has exactly one entry per FORMULA_ID, keyed by its own id", () => {
    expect(new Set(FORMULA_IDS).size).toBe(FORMULA_IDS.length);
    expect(Object.keys(FORMULAS).sort()).toEqual([...FORMULA_IDS].sort());
    for (const id of FORMULA_IDS) expect(FORMULAS[id].id).toBe(id);
  });

  it("fills every field with non-empty text and at least one caveat", () => {
    for (const id of FORMULA_IDS) {
      const f = FORMULAS[id];
      expect(f.name.trim(), id).not.toBe("");
      expect(f.formula_tex.trim(), id).not.toBe("");
      expect(f.plain_english.trim(), id).not.toBe("");
      expect(f.caveats.length, id).toBeGreaterThan(0);
      for (const c of f.caveats) expect(c.trim(), id).not.toBe("");
    }
  });

  it("holds no decimal with 3 or more fractional digits", () => {
    for (const id of FORMULA_IDS) {
      for (const text of texts(FORMULAS[id])) expect(LONG_DECIMAL.test(text), `${id}: ${text}`).toBe(false);
    }
  });

  it("avoids forbidden investment, causal and poaching language", () => {
    for (const id of FORMULA_IDS) {
      for (const text of texts(FORMULAS[id])) expect(FORBIDDEN.test(text), `${id}: ${text}`).toBe(false);
    }
  });

  it("states the frozen constants of the spec formulas", () => {
    expect(FORMULAS["tenant.fit"].formula_tex).toMatch(/0\.6.*0\.4.*\\Delta_j \+ 0\.5/);
    expect(FORMULAS["lift.cell"].formula_tex).toMatch(/u_c \+ 0\.05.*v_c \+ 0\.05/);
    expect(FORMULAS["lift.cell"].formula_tex).toContain(String.raw`u_c \ge 0.5`);
    expect(FORMULAS["lift.confidence"].formula_tex).toContain("n_N / 12");
    expect(FORMULAS["quality_gate"].formula_tex).toContain("0.01");
    expect(FORMULAS["subs.near_substitutes"].formula_tex).toContain("Q_{0.9}");
    expect(FORMULAS["subs.taste_island"].formula_tex).toContain("0.75");
    expect(FORMULAS["mom.label"].formula_tex).toMatch(/0\.02.*p < 0\.1/);
    expect(FORMULAS["mom.freshness"].formula_tex).toContain("m / 12");
    expect(FORMULAS["xdom.edge"].formula_tex).toContain("1.1");
    expect(FORMULAS["confidence.metric"].formula_tex).toContain(String.raw`1 - 1/\sqrt{n}`);
    expect(FORMULAS["confidence.run"].formula_tex).toMatch(/100 - 15.*- 10.*- 10.*- 20.*- 10.*- 5.*- 5/);
  });

  it("carries the honest-snapshot caveats where they apply", () => {
    const caveatText = (id: (typeof FORMULA_IDS)[number]): string => FORMULAS[id].caveats.join(" ");
    expect(caveatText("pct.within_call")).toMatch(/not sales, share or causation/);
    expect(caveatText("pct.within_call")).toMatch(/inside one Qloo call/);
    expect(caveatText("subs.similarity")).toMatch(/not switching, share or sales/);
    expect(caveatText("dna.age_index")).toMatch(/not population shares/);
    expect(caveatText("mom.delta_26w")).toMatch(/Historical window/);
    expect(caveatText("xdom.edge")).toMatch(/not causation/);
    expect(caveatText("tenant.fit")).toMatch(/not credit, rent capacity, sales/);
  });

  it("describes the grid glyph as the competition rank rowRanks computes", () => {
    // rowRanks is displayRanks over the row: the example in the copy must be what the grid shows.
    expect(displayRanks([0.9, 0.5, 0.5, 0.2])).toEqual([1, 2, 2, 4]);
    expect(FORMULAS["subs.rank_in_row"].plain_english).toContain("(1, 2, 2, 4)");
    expect(FORMULAS["subs.rank_in_row"].plain_english).not.toMatch(/averag/);
    // Hub and near-substitutes read the averaged ranks of computeSubstitution, a different symbol.
    expect(FORMULAS["subs.hub"].formula_tex).toContain(String.raw`\bar{r}_{ij}`);
    expect(FORMULAS["subs.near_substitutes"].formula_tex).toContain(String.raw`\bar{r}_{ij} = \bar{r}_{ji} = 1`);
  });

  it("is frozen", () => {
    expect(Object.isFrozen(FORMULAS)).toBe(true);
    expect(Object.isFrozen(FORMULAS["subs.hub"])).toBe(true);
  });
});

describe("isFormulaId", () => {
  it("accepts registered ids only", () => {
    expect(isFormulaId("subs.hub")).toBe(true);
    expect(isFormulaId("subs.poaching")).toBe(false);
    expect(isFormulaId("")).toBe(false);
  });
});
