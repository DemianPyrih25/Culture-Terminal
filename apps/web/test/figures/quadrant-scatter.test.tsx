// QuadrantScatter (A07 figure 2): quadrant shading, labelled highlights, grey candidates and the
// points Qloo could not place.
import { describe, expect, it } from "vitest";
import { QuadrantScatter } from "../../components/figures";
import { FIXTURE_SOURCES, SLATE_CAPTION, sponsorQuadrant } from "../../components/figures/fixtures";
import { plotView, render, tableHeads, tableRows, tableView, text } from "./markup";

const data = sponsorQuadrant.payload;
const html = render(
  <QuadrantScatter
    data={data}
    title="Only one category winner sits in the under-the-radar corner"
    source={FIXTURE_SOURCES.scatter}
    formulaId="slate.under_the_radar"
  />,
);

describe("QuadrantScatter", () => {
  it("is an image with an accessible title and both axis labels", () => {
    const plot = plotView(html);
    expect(plot).toContain('role="img"');
    expect(plot).toContain("<title>Only one category winner sits in the under-the-radar corner</title>");
    expect(text(plot)).toContain("Popularity →");
    expect(text(plot)).toContain("Fit →");
    expect(text(plot)).toContain("100th pctl");
  });

  it("tints the under-the-radar quadrant and labels all four", () => {
    const plot = plotView(html);
    expect(plot).toContain('data-quadrant="HIDDEN_POCKET"');
    for (const label of ["Under the radar", "Priced in", "Famous · poor fit", "Weak fit · niche"]) {
      expect(text(plot)).toContain(label);
    }
  });

  it("rings and labels the featured pick, labels highlights and greys the rest", () => {
    const plot = plotView(html);
    expect(plot).toMatch(/data-point="R11" data-tone="featured"/);
    expect(text(plot)).toContain("Granite Hollow Ale · 0.86");
    expect(plot).toMatch(/data-point="R12" data-tone="highlight"/);
    const grey = data.points.filter((p) => !p.labelled).length;
    expect(grey).toBeGreaterThan(10);
    expect(plot.match(/class="fill-chart-muted" data-point="C\d+"/g)).toHaveLength(grey);
    expect(text(plot)).toContain("Blackfern Rye");
  });

  it("lists the omitted entities with their reasons instead of plotting them", () => {
    const plot = plotView(html);
    expect(text(plot)).toContain("Not placed:");
    expect(text(plot)).toContain("Brand Kappa (below the quality gate)");
    expect(plot).not.toContain('data-point="Brand Kappa"');
  });

  it("prints the payload's fixed caption under the plot", () => {
    expect(html).toContain(`data-fixed-caption="true">${SLATE_CAPTION}<`);
  });

  it("lists every point and every omission in the table view, on the plot's percentile scale", () => {
    const table = tableView(html);
    expect(tableHeads(table)).toEqual(["Name", "Fit", "Popularity (percentile)", "Quadrant", "Group", "Flags"]);
    const rows = tableRows(table);
    expect(rows).toHaveLength(data.points.length + data.omitted.length);
    expect(rows[0]).toEqual(["Granite Hollow Ale", "0.86", "18", "Under the radar", "Beer", "under the radar"]);
    expect(rows.find((r) => r[0] === "Brand Lambda")).toEqual([
      "Brand Lambda",
      "dropped by Qloo",
      "dropped by Qloo",
      "not placed",
      "",
      "",
    ]);
    // Tooltips read the same scale as the axis.
    expect(plotView(html)).toContain("Granite Hollow Ale: Fit 0.86, Popularity 18th pctl");
  });

  it("prints raw x values when a fixed domain replaces the percentile axis", () => {
    const fixed = render(<QuadrantScatter data={data} xDomain={{ min: 0, max: 1 }} title="Fixed" />);
    expect(text(plotView(fixed))).not.toContain("pctl");
    const table = tableView(fixed);
    expect(tableHeads(table)[2]).toBe("Popularity");
    expect(tableRows(table)[0]![2]).toBe("0.18");
  });
});
