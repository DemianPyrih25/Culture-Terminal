// MatrixGrid (A05 figure 2): the heatmap, its accessible name, not-measured cells, annotations and
// the table view.
import { describe, expect, it, vi } from "vitest";
import { MatrixGrid, formatNumber, matrixCodes } from "../../components/figures";
import { FIXTURE_SOURCES, annotatedSimilarityMap, codedSimilarityMap, shareGrid, similarityMap } from "../../components/figures/fixtures";
import { groupByTitle, plotView, render, tableHeads, tableRows, tableView, text } from "./markup";

// /method ships in Part 7; these tests pin the link each figure will carry then.
vi.mock("@/lib/routes", () => ({ ROUTE_LIVE: { method: true, following: false } }));

const data = similarityMap.payload;
const html = render(
  <MatrixGrid
    data={data}
    title="Its two nearest peers are not its rivals"
    caption="Pairwise audience similarity."
    source={FIXTURE_SOURCES.pairs}
    formulaId="subs.similarity"
  />,
);

/** The centre x of each annotation mark, by its number. */
function marks(markup: string): Map<number, number> {
  return new Map(
    [...markup.matchAll(/data-annotation="(\d+)"><circle cx="([\d.]+)"/g)].map((m) => [Number(m[1]), Number(m[2])] as const),
  );
}

describe("MatrixGrid", () => {
  it("frames the plot with its title, source and method link", () => {
    expect(html).not.toContain("FIGURE");
    expect(html).toContain("Its two nearest peers are not its rivals");
    expect(html).toContain('href="/method#subs.similarity"');
    expect(html).toContain("req 0002…f002");
  });

  it("is an image with an accessible title", () => {
    const plot = plotView(html);
    expect(plot).toContain('role="img"');
    expect(plot).toContain('aria-label="Its two nearest peers are not its rivals"');
    expect(plot).toContain("<title>Its two nearest peers are not its rivals</title>");
  });

  it("dashes the diagonal and hatches not-measured cells instead of drawing 0", () => {
    const plot = plotView(html);
    expect(plot.match(/data-cell="self"/g)).toHaveLength(6);
    expect(plot.match(/data-cell="missing"/g)).toHaveLength(2);
    expect(plot).toContain("Saltmarsh Seltzer × Kettle Ridge Tonic: not scored");
    expect(plot).toContain("not measured");
    expect(plot).not.toMatch(/>\.00</);
  });

  it("outlines the target row and keys its codes", () => {
    const plot = plotView(html);
    expect(plot).toContain('data-target="row"');
    expect(plot).toContain("JC</span> Juniper Cola");
    expect(plot).toContain("Kettle Ridge Tonic: nearest to Juniper Cola");
  });

  it("prints white only where it reads better than text-2 on the ramp", () => {
    const plot = plotView(html);
    expect(groupByTitle(plot, "Brand Alpha × Brand Beta: .71")).toContain("fill-white");
    expect(groupByTitle(plot, "Kettle Ridge Tonic × Granite Hollow Ale: .64")).toContain("fill-white");
    // .53 is mid-ramp: white would sit near 2.9:1, text-2 near 3.5:1.
    expect(groupByTitle(plot, "Brand Beta × Saltmarsh Seltzer: .53")).toContain("fill-ink-2");
  });

  it("lists every value and every absence in the table view", () => {
    const table = tableView(html);
    expect(tableHeads(table)).toEqual(["Entity", ...data.cols.map((c) => c.label)]);
    const rows = tableRows(table);
    data.rows.forEach((row, i) => {
      const cells = rows[i]!;
      expect(cells[0]).toContain(row.label);
      data.cells[i]!.forEach((cell, j) => {
        const shown = cells[j + 1];
        if (cell.value === null) expect(shown).toBe(cell.reason === "self" ? "same entity" : "not scored");
        else expect(shown).toBe(formatNumber(cell.value, "similarity", { leadingZero: false }));
      });
    });
    const margin = rows[rows.length - 1]!;
    expect(margin[0]).toBe("Hub score");
    expect(margin).toContain("not scored");
    expect(table).toContain('data-missing="true"');
  });

  it("adds rank glyphs on request, in the plot and the table", () => {
    const ranked = render(<MatrixGrid data={data} title="Ranks" glyph="rank" width={680} />);
    expect(tableView(ranked)).toContain(".47 · #1");
    // The corner glyph is the rank number in each scored cell; the plain grid has none.
    expect(plotView(ranked).match(/data-glyph="rank"/g)).toHaveLength(28);
    expect(plotView(html)).not.toContain('data-glyph="rank"');
  });

  it("draws a share grid with sections and the subject column outlined", () => {
    const share = render(<MatrixGrid data={shareGrid.payload} title="Share" width={680} />);
    const plot = plotView(share);
    expect(plot).toContain("Metro");
    expect(plot).toContain("Age");
    expect(plot).toContain('data-target="column"');
    expect(plot).toContain("Nashville");
    const rows = tableRows(tableView(share));
    expect(rows.some((r) => r.length === 1 && r[0] === "Metro")).toBe(true);
    expect(rows.find((r) => r[0] === "Portland")).toEqual(["Portland", ".52", ".48", "dropped by Qloo"]);
  });
});

describe("MatrixGrid · annotations", () => {
  it("marks a column note by its head and a cell note in the cell", () => {
    const plot = plotView(html);
    expect([...marks(plot).keys()].sort()).toEqual([1, 2]);
    expect(text(plot)).toContain("1Kettle Ridge Tonic: nearest to Juniper Cola");
    expect(text(plot)).toContain("2Closest pair: Brand Alpha and Brand Beta");
  });

  it("marks a row-only note beside its row head", () => {
    const annotated = plotView(render(<MatrixGrid data={annotatedSimilarityMap.payload} title="Notes" width={680} />));
    const at = marks(annotated);
    expect([...at.keys()].sort()).toEqual([1, 2]);
    // The row note sits in the head column, left of the first cell.
    const firstCell = Number(/<g data-cell="(?:self|value|missing)">(?:<title>[^<]*<\/title>)?<rect x="([\d.]+)"/.exec(annotated)![1]);
    expect(at.get(2)!).toBeLessThan(firstCell);
    expect(text(annotated)).toContain("2Saltmarsh Seltzer: one pair not scored");
  });

  it("drops a note whose keys do not resolve", () => {
    const stray = render(
      <MatrixGrid
        data={{ ...data, annotations: [{ text: "Points at nothing", rowKey: null, colKey: "R99" }] }}
        title="Stray"
      />,
    );
    expect(stray).not.toContain("Points at nothing");
    expect(stray).not.toContain("data-annotation=");
  });

  it("keeps the cell mark clear of the rank glyph", () => {
    const ranked = plotView(render(<MatrixGrid data={data} title="Ranks" glyph="rank" width={680} />));
    const cell = groupByTitle(ranked, "Brand Alpha × Brand Beta: .71");
    const glyphX = Number(/<text x="([\d.]+)"[^>]*data-glyph="rank"/.exec(cell)![1]);
    const cellX = Number(/<rect x="([\d.]+)"/.exec(cell)![1]);
    const markX = marks(ranked).get(2)!;
    // With glyphs the mark takes the top-left corner; the glyph keeps the top-right.
    expect(markX).toBeLessThan(cellX + 10);
    expect(glyphX - markX).toBeGreaterThan(20);
    const plain = plotView(render(<MatrixGrid data={data} title="Plain" width={680} />));
    expect(marks(plain).get(2)!).toBeGreaterThan(cellX + 50);
  });
});

describe("MatrixGrid · codes from the payload", () => {
  it("prints AxisItem.code instead of a derived code, and the caller's codes win over both", () => {
    const coded = render(<MatrixGrid data={codedSimilarityMap.payload} title="Coded" />);
    expect(text(plotView(coded))).toContain("JNP");
    expect(text(plotView(coded))).toContain("KRT");
    expect(text(plotView(coded))).not.toContain("JC ");
    const codes = matrixCodes(codedSimilarityMap.payload, { R1: "ZZ" });
    expect(codes.get("R1")).toBe("ZZ");
    expect(codes.get("R2")).toBe("ALF");
    expect(matrixCodes(similarityMap.payload).get("R1")).toBe("JC");
  });
});
