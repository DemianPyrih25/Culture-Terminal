// R3 (D49) row marks: a name or area the question gave reads "You named", one a specialist would check
// first reads "Expected", in the answer's charts and in the figure tables; R4 presence chips mark only
// market rows; a CATEGORY row (R2) is measured against the category only and never kept or dropped.
// Fixtures are invented.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PRESENCE_CHIP_LABEL, type DatasetOf, type RankedPayload } from "@ct/contracts";
import { ChartBodyView } from "../../components/answer/chart-bodies";
import { RankedTable, rankedTableSpec, slateToRanked } from "../../components/figures";
import { displayFlags, sourceWord } from "../../components/figures/ranked-table";
import { nearestAudiences, sponsorSlate } from "../../components/figures/fixtures";
import { datasetMarks, markBody, markTable } from "../../lib/answer/marks";
import { verdictGroups } from "../../lib/answer/job-shapes";
import type { ChartBody } from "../../lib/answer";
import { text } from "../figures/markup";

const marked: DatasetOf<"Ranked"> = {
  ...nearestAudiences,
  payload: {
    ...nearestAudiences.payload,
    groups: nearestAudiences.payload.groups.map((g) => ({
      ...g,
      rows: g.rows.map((r, i) => (i === 0 ? { ...r, source: "user_named" as const } : i === 1 ? { ...r, source: "obvious" as const } : r)),
    })),
  },
};
const rows = marked.payload.groups[0]!.rows;

describe("the marks", () => {
  it("reads a row's source as You named or Expected, and nothing for the data's own", () => {
    expect(sourceWord({ source: "user_named" })).toBe("You named");
    expect(sourceWord({ source: "obvious" })).toBe("Expected");
    expect(sourceWord({ source: "data" })).toBeNull();
    expect(sourceWord({})).toBeNull();
  });

  it("collects them by row label, and marks presence only on rows keyed by a market id", () => {
    const marks = datasetMarks(marked, ["austin"]);
    expect(marks.get(rows[0]!.label.toLowerCase())).toEqual(["You named"]);
    expect(marks.get(rows[1]!.label.toLowerCase())).toEqual(["Expected"]);
    expect([...marks.values()].flat()).not.toContain(PRESENCE_CHIP_LABEL);
    const markets: DatasetOf<"Ranked"> = {
      ...marked,
      payload: { ...marked.payload, groups: [{ key: "m", label: "Markets", rows: [{ ...rows[2]!, key: "metro:austin", label: "Austin" }, { ...rows[3]!, key: "metro:denver", label: "Denver" }] }] } as RankedPayload,
    };
    const m = datasetMarks(markets, ["austin"]);
    expect(m.get("austin")).toEqual([PRESENCE_CHIP_LABEL]);
    expect(m.get("denver")).toBeUndefined();
  });

  it("puts the chips on the chart rows and a Marked column in the table, without moving a row", () => {
    const body: ChartBody = {
      type: "bars",
      rows: rows.map((r) => ({ label: r.label, sublabel: null, fraction: 0.5, display: "0.50", tone: "muted" as const, tag: null })),
    };
    const marks = datasetMarks(marked);
    const out = markBody(body, marks);
    expect(out.type === "bars" && out.rows.map((r) => r.label)).toEqual(rows.map((r) => r.label));
    expect(out.type === "bars" && out.rows[0]?.marks).toEqual(["You named"]);
    const html = renderToStaticMarkup(<ChartBodyView body={out} label="Peers" />);
    expect(text(html)).toContain("You named");
    expect(text(html)).toContain("Expected");
    const table = markTable({ columns: [{ label: "Name" }], rows: rows.map((r) => [r.label]) }, marks);
    expect(table?.columns.at(-1)?.label).toBe("Marked");
    expect(table?.rows[0]?.at(-1)).toBe("You named");
  });
});

describe("the figure tables", () => {
  it("shows the chips after the name in the table variant and lists them in the table view", () => {
    const html = renderToStaticMarkup(<RankedTable title="Peers" data={marked.payload} variant="table" />);
    expect(html).toContain('data-candidate="user_named"');
    expect(html).toContain('data-candidate="obvious"');
    const spec = rankedTableSpec(marked.payload, "Peers", {});
    expect(JSON.stringify(spec.rows)).toContain("You named");
  });

  it("carries a slate entry's source into its ranked row", () => {
    const slate = { ...sponsorSlate.payload, rows: sponsorSlate.payload.rows.map((r, i) => (i === 0 && r.best ? { ...r, best: { ...r.best, source: "user_named" as const } } : r)) };
    const ranked = slateToRanked(slate);
    expect(ranked.groups[0]!.rows.some((r) => r.source === "user_named")).toBe(true);
  });
});

describe("category-level rows (R2)", () => {
  const verdicts: RankedPayload = {
    columns: [{ key: "gap", label: "Against the bar", unit: "delta", comparator: "BASELINE" }],
    groups: [
      {
        key: "analogs",
        label: "Analogs",
        rows: [
          { ...rows[0]!, key: "a", label: "Analog A", cells: [{ value: 0.1, reason: null }], flags: ["CATEGORY", "KEEP"] },
          { ...rows[1]!, key: "b", label: "Analog B", cells: [{ value: -0.1, reason: null }], flags: ["CATEGORY"] },
        ],
      },
    ],
    caption: null,
  };

  it("are never kept or dropped, and read as measured against the category only", () => {
    expect(displayFlags(["CATEGORY", "KEEP", "TARGET"])).toEqual(["CATEGORY"]);
    const { body, counts } = verdictGroups(verdicts);
    expect(counts).toMatchObject({ keep: 0, veto: 0, category: 2 });
    expect(body.type === "verdicts" && body.groups.map((g) => g.verdict)).toEqual(["category"]);
    const html = renderToStaticMarkup(<ChartBodyView body={body} label="Analogs" />);
    expect(text(html)).toContain("Measured against the category only: no keep or veto");
    expect(text(html)).not.toMatch(/Kept:|Dropped:/);
  });

  it("show no keep or veto word in the figure table either", () => {
    const html = renderToStaticMarkup(<RankedTable title="Analogs" data={verdicts} variant="table" />);
    expect(text(html)).toContain("Measured against the category only");
    expect(text(html)).not.toContain("AI guess kept");
    expect(html).not.toContain('data-veto="true"');
  });
});
