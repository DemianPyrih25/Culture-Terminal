// The coverage card on /method: every place type and sponsor category of the configs, each with the
// gate that verified it or its named fallback (PLAN §11.2), read from the configs, never copied.
import { SponsorCategory } from "@ct/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { coverageFacts } from "./coverage";
import { COVERAGE_COPY, CoverageSection } from "./coverage-section";

const facts = coverageFacts();
const html = renderToStaticMarkup(<CoverageSection facts={facts} />);

describe("coverage on /method", () => {
  it("lists the 18 place types, each with a verified heatmap signal", () => {
    expect(facts.placeTypes).toHaveLength(18);
    for (const p of facts.placeTypes) {
      expect(p.signal, p.key).toMatch(/^(?:G\d{1,2}|P5|C[1-6])$/);
      expect(html).toContain(`data-place="${p.key}"`);
    }
    // C1b verified bookstore and pizza as venue filters, so no type relies on a tag found at run time.
    for (const key of ["bookstore", "pizza"]) expect(facts.placeTypes.find((p) => p.key === key)?.filter, key).toBe("C1b");
    expect(facts.placeTypes.filter((p) => p.filterSearched).map((p) => p.key)).toEqual([]);
    expect(html).not.toContain(COVERAGE_COPY.filterSearched);
    // A type with no verified venue filter (restaurant, bar) draws no venue sample, and the card says its competitors are unknown.
    expect(facts.placeTypes.filter((p) => p.filter === null).map((p) => p.key).sort()).toEqual(["bar", "restaurant"]);
    expect(html).toContain(COVERAGE_COPY.noFilter);
    expect(COVERAGE_COPY.noFilter).toMatch(/competitor count is unknown/);
  });

  it("lists every contracts sponsor category with its gate, or the semantic search fallback", () => {
    expect(facts.sponsors.map((s) => s.key).sort()).toEqual([...SponsorCategory.options].sort());
    for (const s of facts.sponsors) expect(s.gate !== null || s.searched, s.key).toBe(true);
    expect(facts.sponsors.filter((s) => s.searched).map((s) => s.key)).toEqual(["outdoor_sporting_retail"]);
    expect(html).toContain(COVERAGE_COPY.searched);
    expect(html).toContain("Brand filter: verified C2");
  });

  it("states the named lists, gender and audience coverage", () => {
    for (const row of COVERAGE_COPY.other) expect(html).toContain(row.term);
    expect(html).toContain(`id="coverage"`);
  });
});
