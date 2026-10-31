// RankedTable: the A05 lollipop, the A07 table (from a Slate), the A08 lists and margin bars.
import type { RankedPayload } from "@ct/contracts";
import { describe, expect, it } from "vitest";
import { RankedTable, comparisonSet, formatNumber, slateToRanked } from "../../components/figures";
import {
  EXPECTED_RIVALS,
  FIXTURE_SOURCES,
  SLATE_CAPTION,
  areaBrandShifts,
  domainLists,
  marginBrands,
  nearestAudiences,
  nearestWithRivals,
  sponsorSlate,
} from "../../components/figures/fixtures";
import { plotView, rects, render, rowMarkup, tableHeads, tableRows, tableView, text } from "./markup";

const rows = nearestAudiences.payload.groups[0]!.rows;
const lollipop = render(
  <RankedTable
    data={nearestAudiences.payload}
    width={384}
    title="Its nearest audience is a tonic, not a rival"
    caption="Audience similarity, 0–1. Grey: rivals we expected."
    comparisonKeys={EXPECTED_RIVALS}
    cut={{ after: 5, label: "Top five above" }}
    source={FIXTURE_SOURCES.insights}
    formulaId="subs.similarity"
  />,
);

/** A one-column Ranked payload from invented values. */
function ranked(unit: RankedPayload["columns"][number]["unit"], values: [string, number | null][]): RankedPayload {
  return {
    columns: [{ key: "v", label: "Value", unit, comparator: null }],
    groups: [
      {
        key: "g",
        label: "Group",
        rows: values.map(([key, value], i) => ({
          key,
          rank: i + 1,
          label: key,
          sublabel: null,
          ref: null,
          tagRef: null,
          type: null,
          cells: [value === null ? { value: null, reason: "not_scored" as const } : { value, reason: null }],
          flags: [],
          explain: [],
        })),
      },
    ],
    caption: null,
  };
}

describe("RankedTable · lollipop", () => {
  it("is an image with an accessible title and axis ticks", () => {
    const plot = plotView(lollipop);
    expect(plot).toContain('role="img"');
    expect(plot).toContain("<title>Its nearest audience is a tonic, not a rival</title>");
    expect(plot).toContain("Top five above");
    // Axis ticks at 0, 0.2, 0.4, 0.6 for similarities up to .47.
    expect(plot.match(/font-size="12" class="fill-ink-2 font-mono tabular-nums">[^<]+</g)?.map((t) => t.split(">")[1]!.slice(0, -1))).toEqual([
      "0",
      "0.2",
      "0.4",
      "0.6",
    ]);
  });

  it("highlights the top row and greys the expected rivals", () => {
    const plot = plotView(lollipop);
    expect(rowMarkup(plot, "R5")).toContain('data-tone="highlight"');
    for (const key of EXPECTED_RIVALS) expect(rowMarkup(plot, key)).toContain('data-tone="comparison"');
    expect(rowMarkup(plot, "R7")).toContain('data-tone="default"');
  });

  it("draws no dot for a row that was not scored", () => {
    const missing = rowMarkup(plotView(lollipop), "R10");
    expect(missing).not.toContain("<circle");
    expect(missing).toContain("not scored");
    expect(rowMarkup(plotView(lollipop), "R5")).toContain("<circle");
  });

  it("lists every value, rank and absence in the table view, kept for screen readers", () => {
    const table = tableView(lollipop);
    expect(lollipop).toContain('class="sr-only" data-view="table"');
    expect(tableHeads(table)).toEqual(["Name", "Rank", "Similarity to Juniper Cola (vs peers)", "Flags"]);
    const body = tableRows(table);
    rows.forEach((row, i) => {
      const cell = row.cells[0]!;
      expect(body[i]![0]).toBe(row.label);
      expect(body[i]![1]).toBe(row.rank === null ? "—" : String(row.rank));
      expect(body[i]![2]).toBe(cell.value === null ? "not scored" : formatNumber(cell.value, "similarity", { leadingZero: false }));
    });
    expect(body.find((r) => r[0] === "Brand Alpha")![3]).toBe("expected");
  });
});

describe("RankedTable · table (Slate)", () => {
  const data = slateToRanked(sponsorSlate.payload);
  const html = render(
    <RankedTable
      data={data}
      variant="table"
      labelHeader="Best fit"
      sublabelHeader="Category"
      tick={0.8}
      flagNotes={{ UTR: 5 }}
      title="Beer leads"
    />,
  );

  it("ranks categories by best fit and keeps a missing category last with its reason", () => {
    const order = data.groups[0]!.rows.map((r) => [r.sublabel, r.rank]);
    expect(order).toEqual([
      ["Beer", 1],
      ["Whiskey", 2],
      ["Outdoor", 3],
      ["Trucks", 4],
      ["Boots & apparel", 5],
      ["Energy drink", 6],
      ["Fintech", null],
    ]);
    expect(data.groups[0]!.rows[6]!.cells[0]).toEqual({ value: null, reason: "budget_truncated" });
  });

  it("shows category, best fit, the bar with its tick and the flag", () => {
    const plot = plotView(html);
    expect(plot).toContain("<table");
    expect(text(plot)).toContain("Under the radar5");
    expect(rowMarkup(plot, "beer")).toContain("bg-sunken");
    // Below the 0.80 tick the bar turns grey; the missing category has no bar at all.
    expect(rowMarkup(plot, "energy_drinks")).toContain("fill-chart-muted");
    expect(rowMarkup(plot, "fintech")).not.toContain("<svg");
    expect(text(rowMarkup(plot, "fintech"))).toContain("not fetched (budget)");
  });

  it("prints the Slate's fixed caption under the plot", () => {
    expect(SLATE_CAPTION).toContain("no fee, availability or ROI data");
    expect(html).toContain(`data-fixed-caption="true">${SLATE_CAPTION}<`);
  });

  it("keeps every category in a table view that stays hidden until toggled", () => {
    // The plot is an HTML table already: a second, screen-reader-only copy would be read twice.
    expect(html).toContain('<div hidden="" data-view="table" class="min-w-0 overflow-x-auto">');
    expect(html).not.toContain('class="sr-only" data-view="table"');
    const body = tableRows(tableView(html));
    expect(body).toHaveLength(7);
    expect(body.find((r) => r[2] === "Beer")).toEqual(["Granite Hollow Ale", "1", "Beer", "0.86", "Under the radar"]);
    expect(body.find((r) => r[2] === "Fintech")).toEqual(["No fit found", "—", "Fintech", "not fetched (budget)", ""]);
  });

  it("draws a negative value left of zero in the negative colour", () => {
    const plot = plotView(render(<RankedTable data={ranked("delta", [["up", 0.4], ["down", -0.3]])} variant="table" title="Signed" />));
    const [up] = rects(rowMarkup(plot, "up")).filter((r) => r.cls.startsWith("fill-accent"));
    const [down] = rects(rowMarkup(plot, "down")).filter((r) => r.cls === "fill-second");
    expect(down).toBeDefined();
    expect(down!.width).toBeGreaterThan(0);
    expect(down!.x + down!.width).toBeCloseTo(up!.x, 1);
  });
});

describe("RankedTable · lists and bars", () => {
  it("draws one list per group with the reason for a missing value", () => {
    const html = render(<RankedTable data={domainLists.payload} variant="lists" title="Media" />);
    const plot = plotView(html);
    expect(plot.match(/<table/g)).toHaveLength(3);
    expect(text(plot)).toContain("Music · artists");
    expect(text(rowMarkup(plot, "V4"))).toContain("not measured");
    expect(html).toContain('<div hidden="" data-view="table" class="min-w-0 overflow-x-auto">');
    const body = tableRows(tableView(html));
    expect(body.filter((r) => r.length === 1).map((r) => r[0])).toEqual(["Music · artists", "Podcasts", "TV · series"]);
    expect(body.find((r) => r[0] === "The Velvet Lanterns")).toEqual(["The Velvet Lanterns", "1", ".97"]);
  });

  it("sizes each list's value column to its head", () => {
    const widths = (label: string) => {
      const data = { ...domainLists.payload, columns: [{ ...domainLists.payload.columns[0]!, label }] };
      const plot = plotView(render(<RankedTable data={data} variant="lists" title="Media" />));
      return [...plot.matchAll(/<col style="width:(\d+)px"/g)].map((m) => Number(m[1]));
    };
    expect(widths("Pctl")).toEqual([48, 48, 48]);
    // "Percentile" (12 px) needs more than the 48 px default, or it runs into the next list's head.
    expect(Math.min(...widths("Percentile"))).toBeGreaterThan(60);
  });

  it("draws margin bars, with a baseline mark only when asked for one", () => {
    const html = render(
      <RankedTable data={marginBrands.payload} variant="bars" title="Outdoor" />,
    );
    const plot = plotView(html);
    expect(plot).toContain('role="img"');
    expect(plot).not.toContain('class="fill-surface"');
    // A category shows beside its name when there is room for it.
    expect(text(plot)).toContain("Pale Harborapparel");
    const ticked = plotView(render(<RankedTable data={marginBrands.payload} variant="bars" tick={0.8} title="Ticked" />));
    expect(ticked.match(/class="fill-surface"/g)).toHaveLength(5);
    expect(ticked).toContain("the paper tick marks 0.80");
  });

  it("marks 1 by default only for an all-positive lift", () => {
    const lift = plotView(render(<RankedTable data={ranked("lift", [["a", 1.4], ["b", 0.7]])} variant="bars" title="Lift" />));
    expect(lift).toContain("the paper tick marks 1.00");
    const index = plotView(render(<RankedTable data={ranked("index", [["a", 0.4], ["b", -0.2]])} variant="bars" title="Index" />));
    expect(index).not.toContain("the paper tick marks");
  });

  it("draws a negative value left of zero, never as an empty track", () => {
    const html = render(<RankedTable data={areaBrandShifts.payload} variant="bars" numberStyle={{ digits: 0 }} title="Shifts" />);
    const plot = plotView(html);
    const [gain] = rects(rowMarkup(plot, "B11"));
    const [loss] = rects(rowMarkup(plot, "B14"));
    expect(gain!.cls).toBe("fill-accent");
    expect(loss!.cls).toBe("fill-second");
    expect(loss!.width).toBeGreaterThan(0);
    // Both bars meet at the zero line: the loss ends where the gain starts.
    expect(loss!.x + loss!.width).toBeCloseTo(gain!.x, 1);
    expect(text(rowMarkup(plot, "B14"))).toContain("−7");
    expect(rowMarkup(plot, "B15")).not.toMatch(/<rect[^>]*fill-(data|negative)/);
    expect(text(rowMarkup(plot, "B15"))).toContain("not scored");
    expect(html).toContain("Venue-goer taste signals, not residents or census.");
  });
});

describe("RankedTable · comparison rows from the payload", () => {
  it("greys rows marked RankedRow.comparison without comparisonKeys, in every variant and the table", () => {
    const plot = plotView(render(<RankedTable data={nearestWithRivals.payload} width={384} title="Rivals" />));
    for (const key of EXPECTED_RIVALS) expect(rowMarkup(plot, key)).toContain('data-tone="comparison"');
    expect(rowMarkup(plot, "R5")).toContain('data-tone="highlight"');
    const bars = plotView(render(<RankedTable data={nearestWithRivals.payload} variant="bars" title="Rivals" />));
    expect(rowMarkup(bars, "R2")).toContain("fill-chart-muted");
    expect(rowMarkup(bars, "R7")).toContain('class="fill-accent"');
    const lists = render(<RankedTable data={nearestWithRivals.payload} variant="lists" title="Rivals" />);
    expect(rowMarkup(plotView(lists), "R3")).toContain('data-tone="comparison"');
    const rows = tableRows(tableView(lists));
    expect(rows.find((r) => r[0] === "Brand Alpha")!.at(-1)).toBe("expected");
  });

  it("adds the caller's keys to the payload's", () => {
    expect([...comparisonSet(nearestWithRivals.payload, ["R9"])].sort()).toEqual(["R2", "R3", "R4", "R9"]);
    expect(comparisonSet(nearestAudiences.payload).size).toBe(0);
  });
});
