// The TeX reader behind /method's formulas: every FORMULAS entry is set without leftover source, and
// the pieces it knows (fractions, scripts, roots, accents, \text, clauses) come out as expected.
import { FORMULA_IDS, FORMULAS } from "@ct/quant";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { parseTex, TexFormula, texClauses, texToText } from "../../components/method/tex";

describe("the formula TeX", () => {
  it("sets every FORMULAS entry with no command left over", () => {
    for (const id of FORMULA_IDS) {
      const tex = FORMULAS[id].formula_tex;
      expect(texToText(tex), id).not.toContain("\\");
      const html = renderToStaticMarkup(<TexFormula tex={tex} />);
      expect(html, id).not.toContain("\\");
    }
  });

  it("reads fractions, scripts and operators in a line", () => {
    expect(texToText(String.raw`\mathrm{pct}_i = 1 - \frac{r_i - 1}{n - 1}`)).toBe("pct_i = 1 − (r_i − 1)/(n − 1)");
    expect(texToText(String.raw`j^{*}_{c} = \arg\max_{j \in c} A_j`)).toBe("j_c^* = arg max_(j ∈ c) A_j");
    expect(texToText(String.raw`\mathrm{conf} = m \cdot \big(1 - 1/\sqrt{n}\big)`)).toBe("conf = m · (1 − 1/√n)");
    expect(texToText(String.raw`\#\{ k \ne i \} \ge 0.5`)).toBe("#{ k ≠ i } ≥ 0.5");
  });

  it("splits clauses at \\quad and keeps \\text spacing", () => {
    const nodes = parseTex(String.raw`a = 1, \quad \text{for cells with } u \ge 0.5`);
    expect(texClauses(nodes)).toHaveLength(2);
    expect(texToText(String.raw`a = 1, \quad \text{for cells with } u \ge 0.5`)).toBe("a = 1; for cells with u ≥ 0.5");
  });

  it("draws a stacked fraction and italic variables, and gives screen readers the line", () => {
    const html = renderToStaticMarkup(<TexFormula tex={String.raw`L_c = \frac{u_c + 0.05}{v_c + 0.05}`} />);
    expect(html).toContain('<span class="sr-only">L_c = (u_c + 0.05)/(v_c + 0.05)</span>');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("<i>L</i><sub><i>c</i></sub>");
    expect(html).toContain("border-t border-current");
  });

  it("prints an unknown command as written", () => {
    expect(texToText(String.raw`\unknowncmd x`)).toContain("\\unknowncmd");
  });
});
