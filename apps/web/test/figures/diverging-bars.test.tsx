// DivergingBars: the A04 split and dumbbell, the A08 dumbbell with a delta column, Block DNA
// deltas and the signed butterfly. A missing value is explained, never drawn as a bar of 0.
import type { BarsPayload } from "@ct/contracts";
import { describe, expect, it, vi } from "vitest";
import { DivergingBars, MINUS } from "../../components/figures";
import {
  ageDumbbellSelfDescribed,
  ageIndexPair,
  agePeers,
  blockDna,
  metroSplit,
  metroSplitSelfDescribed,
} from "../../components/figures/fixtures";
import { plotView, rects, render, rowMarkup, tableHeads, tableRows, tableView, text } from "./markup";

// /method ships in Part 7; these tests pin the link each figure will carry then.
vi.mock("@/lib/routes", () => ({ ROUTE_LIVE: { method: true, following: false } }));

const v = (value: number) => ({ value, reason: null });
const series = [
  { key: "A", label: "Brand Alpha", ref: null, group: null },
  { key: "B", label: "Brand Beta", ref: null, group: null },
];

/** A small invented Bars payload. */
function bars(rows: [string, BarsPayload["groups"][number]["bars"][number]["values"]][], extra: Partial<BarsPayload> = {}): BarsPayload {
  return {
    mode: "butterfly",
    comparator: "BASELINE",
    valueLabel: "Index",
    unit: "index",
    series,
    groups: [
      {
        key: "g",
        label: "Group",
        family: null,
        bars: rows.map(([key, values]) => ({ key, label: key, tagRef: null, values, isNew: false, ranks: null })),
      },
    ],
    method: null,
    domain: null,
    caption: null,
    ...extra,
  };
}

describe("DivergingBars · split (A04 figure 1)", () => {
  const html = render(
    <DivergingBars data={metroSplit.payload} display="split" labelHeader="Metro" title="Juniper Cola leads in Portland" />,
  );

  it("draws the lead around the even split with the shaded band and both value columns", () => {
    const plot = plotView(html);
    expect(plot).toContain('role="img"');
    expect(text(plot)).toContain("← Brand Alpha ahead");
    expect(text(plot)).toContain("Juniper Cola ahead →");
    expect(plot).toContain("fill-sunken");
    const portland = rowMarkup(plot, "portland");
    expect(portland).toContain("fill-accent");
    expect(text(portland)).toContain(".66");
    expect(text(portland)).toContain(".34");
    expect(rowMarkup(plot, "austin")).toContain("fill-chart-muted");
  });

  it("bolds a clear leader and keeps a lead inside the band regular", () => {
    expect(rowMarkup(plotView(html), "portland")).toMatch(/font-weight="600"[^>]*>\.66</);
    expect(rowMarkup(plotView(html), "chicago")).not.toContain('font-weight="600"');
  });

  it("explains a metro without data instead of drawing a bar", () => {
    const nashville = rowMarkup(plotView(html), "nashville");
    expect(nashville).toContain("not measured");
    expect(nashville).not.toMatch(/<rect[^>]*class="fill-accent/);
  });

  it("needs both shares: one missing share gives its reason, no bar and no lead", () => {
    const boston = rowMarkup(plotView(html), "boston");
    expect(text(boston)).toContain("dropped by Qloo");
    expect(boston).not.toMatch(/<rect[^>]*class="fill-accent/);
    expect(text(boston)).toContain(".64");
    expect(text(boston)).not.toContain("lead");
    expect(tableRows(tableView(html)).find((r) => r[0] === "Boston")).toEqual(["Boston", ".64", "dropped by Qloo", "dropped by Qloo"]);
  });

  it("lists both shares and the lead in the table view", () => {
    const table = tableView(html);
    expect(tableHeads(table)).toEqual(["Metro", "Juniper Cola", "Brand Alpha", "Lead over 0.50"]);
    const rows = tableRows(table);
    expect(rows[0]).toEqual(["Portland", ".66", ".34", "+.16"]);
    expect(rows.find((r) => r[0] === "Austin")).toEqual(["Austin", ".33", ".67", `${MINUS}.17`]);
    expect(rows.find((r) => r[0] === "Nashville")).toEqual(["Nashville", "not measured", "not measured", "not measured"]);
  });

  it("computes the lead within the pair, so it holds when the shares do not sum to 1", () => {
    const loose = render(
      <DivergingBars data={bars([["m", [v(0.3), v(0.1)]]], { unit: "pct", comparator: "WITHIN_CALL" })} display="split" title="Loose" />,
    );
    // .30 of .40 is .75 of the pair: +.25 over even, not .30 − .50.
    expect(tableRows(tableView(loose))[0]).toEqual(["m", ".30", ".10", "+.25"]);
  });
});

describe("DivergingBars · dumbbell", () => {
  it("joins two series around the 0 baseline of the DNA index (A04 figure 2)", () => {
    const html = render(<DivergingBars data={ageIndexPair.payload} display="dumbbell" baselineLabel="0 = avg" title="Ages" />);
    const plot = plotView(html);
    const row = rowMarkup(plot, "24_and_younger");
    expect(row.match(/<circle/g)).toHaveLength(2);
    expect(row).toContain("fill-line-strong");
    expect(text(plot)).toContain("0 = avg");
    expect(plot).toContain("against the 0 baseline");
    expect(tableHeads(tableView(html))).toEqual(["Item", "Juniper Cola", "Brand Alpha", "Gap vs Brand Alpha"]);
    expect(tableRows(tableView(html))[0]).toEqual(["≤24", "0.18", `${MINUS}0.22`, "+0.40"]);
  });

  it("defaults an index to 0 and centres only an all-positive lift or ratio on 1", () => {
    const index = plotView(render(<DivergingBars data={ageIndexPair.payload} display="dumbbell" title="Index" />));
    expect(index).toContain("against the 0 baseline");
    expect(text(index)).toContain(`${MINUS}0.40`);
    expect(text(index)).not.toContain("1.00");
    const lift = plotView(render(<DivergingBars data={bars([["a", [v(1.2), v(0.8)]]], { unit: "lift" })} display="dumbbell" title="Lift" />));
    expect(lift).toContain("against the 1 baseline");
    const mixed = plotView(render(<DivergingBars data={bars([["a", [v(0.4), v(-0.2)]]], { unit: "lift" })} display="dumbbell" title="Mixed" />));
    expect(mixed).toContain("against the 0 baseline");
    const explicit = plotView(render(<DivergingBars data={ageIndexPair.payload} display="dumbbell" baseline={0.1} title="Explicit" />));
    expect(explicit).toContain("against the 0.1 baseline");
  });

  it("shows the index and a ▲/▼ delta against peers (A08 figure 1)", () => {
    const html = render(
      <DivergingBars data={agePeers.payload} display="dumbbell" deltaColumn deltaHeader="VS PEERS" title="Peaks at 25–29" />,
    );
    const plot = plotView(html);
    expect(text(plot)).toContain("VS PEERS");
    expect(text(plot)).toContain("Index");
    expect(text(rowMarkup(plot, "25_to_29"))).toContain("▲ 0.24");
    expect(text(rowMarkup(plot, "35_to_44"))).toContain("▼ 0.09");
    expect(text(plot)).toContain("Gender");
    // 55+ has peers but no value for the subject: one grey dot, the reason, no delta.
    const missing = rowMarkup(plot, "55_and_older");
    expect(missing.match(/<circle/g)).toHaveLength(1);
    expect(missing).toContain("not measured");
    expect(text(missing)).not.toContain("▲");
    const rows = tableRows(tableView(html));
    expect(rows.find((r) => r[0] === "55+")).toEqual(["55+", "not measured", `${MINUS}0.11`, "not measured"]);
  });

  it("draws one series against the baseline, with the reason for a missing value", () => {
    const one = bars([["up", [v(0.2)]], ["down", [v(-0.1)]], ["gap", [{ value: null, reason: "not_measured" }]]], {
      mode: "diverging",
      series: [series[0]!],
    });
    const plot = plotView(render(<DivergingBars data={one} display="dumbbell" title="One series" />));
    expect(rowMarkup(plot, "up").match(/<circle/g)).toHaveLength(1);
    expect(rowMarkup(plot, "up")).toContain("fill-line-strong");
    expect(rowMarkup(plot, "gap")).not.toContain("<circle");
    expect(text(rowMarkup(plot, "gap"))).toContain("not measured");
  });
});

describe("DivergingBars · diverging (Block DNA)", () => {
  const html = render(<DivergingBars data={blockDna.payload} labelHeader="Tag" title="New on the block" />);

  it("names its comparator and draws over and under in two colours", () => {
    const plot = plotView(html);
    expect(text(plot)).toContain("Δ vs city");
    expect(text(plot)).toContain("Above city →");
    expect(text(rowMarkup(plot, "T21"))).toContain("+14");
    expect(rowMarkup(plot, "T24")).toContain("fill-danger");
    expect(text(rowMarkup(plot, "T24"))).toContain(`${MINUS}8`);
    expect(text(rowMarkup(plot, "T21"))).toContain("New");
    expect(html).toContain("Location method · POLYGON");
  });

  it("prints the payload's fixed caption under the plot", () => {
    expect(html).toMatch(/data-fixed-caption="true">Venue-goer taste signals, not residents or census\.</);
  });

  it("keeps a tag that was not scored, with its reason, and the raw ranks in the table", () => {
    expect(text(rowMarkup(plotView(html), "T30"))).toContain("not scored");
    const table = tableView(html);
    expect(tableHeads(table)).toEqual(["Tag", "Riverside District (Δ vs city)", "Rank here", "Rank in city", "New"]);
    const rows = tableRows(table);
    expect(rows.filter((r) => r.length === 1).map((r) => r[0])).toEqual(["Venue-goer taste tags", "Vibe", "What"]);
    expect(rows.find((r) => r[0] === "Natural wine")).toEqual(["Natural wine", "+14", "3", "17", "new"]);
    expect(rows.find((r) => r[0] === "Brunch")).toEqual(["Brunch", "not scored", "—", "9", ""]);
  });
});

describe("DivergingBars · butterfly", () => {
  it("mirrors two series around the centre labels, with a zero line per panel", () => {
    const html = render(<DivergingBars data={ageIndexPair.payload} display="butterfly" labelHeader="Age" title="Mirrored" />);
    const plot = plotView(html);
    expect(text(plot)).toContain("Juniper Cola");
    expect(text(plot)).toContain("Brand Alpha");
    const young = rowMarkup(plot, "25_to_29");
    expect(young).toContain('class="fill-accent" data-sign="positive"');
    expect(young).toContain('class="fill-second" data-sign="negative"');
    expect(young.match(/data-zero=/g)).toHaveLength(2);
    expect(text(young)).toContain("0.36");
    expect(text(young)).toContain(`${MINUS}0.05`);
    // The baseline is 0 here, so there is no dashed 1.00 line.
    expect(plot).not.toContain('stroke-dasharray="2 2"');
  });

  it("draws a negative value differently from its positive mirror", () => {
    const html = render(
      <DivergingBars data={bars([["up", [v(0.4), v(0.4)]], ["down", [v(-0.4), v(-0.4)]]])} display="butterfly" title="Signs" />,
    );
    const plot = plotView(html);
    const [upA, upB] = rects(rowMarkup(plot, "up"));
    const [downA, downB] = rects(rowMarkup(plot, "down"));
    expect(upA!.cls).toBe("fill-accent");
    expect(upB!.cls).toBe("fill-chart-muted");
    expect(downA!.cls).toBe("fill-second");
    expect(downB!.cls).toBe("fill-second");
    expect(downA!.x).not.toBe(upA!.x);
    expect(downB!.x).not.toBe(upB!.x);
    // Each panel's zero line (drawn half a pixel right of its position for a crisp stroke).
    const zeroOf = (k: number) =>
      Number(new RegExp(`<line x1="([\\d.]+)"[^>]*data-zero="${k}"`).exec(rowMarkup(plot, "up"))![1]) - 0.5;
    // Left panel: +0.4 grows outward (left) from the zero line, −0.4 back toward the centre (right).
    const zeroA = zeroOf(0);
    expect(upA!.x + upA!.width).toBeCloseTo(zeroA, 0);
    expect(downA!.x).toBeCloseTo(zeroA, 0);
    // Right panel mirrors it.
    const zeroB = zeroOf(1);
    expect(upB!.x).toBeCloseTo(zeroB, 0);
    expect(downB!.x + downB!.width).toBeCloseTo(zeroB, 0);
    expect(upA!.width).toBeCloseTo(downA!.width, 1);
  });

  it("marks a non-zero baseline on both panels", () => {
    const html = render(<DivergingBars data={bars([["a", [v(0.5), v(0.2)]]])} display="butterfly" baseline={0.25} title="Base" />);
    expect(plotView(html).match(/stroke-dasharray="2 2"/g)).toHaveLength(2);
  });

  it("falls back to diverging for a one-series payload", () => {
    const html = render(<DivergingBars data={blockDna.payload} display="butterfly" title="One series" />);
    expect(text(plotView(html))).toContain("Δ vs city");
  });
});

describe("DivergingBars · display, baseline and even band from the payload", () => {
  it("draws the split the payload asks for, with its band, and no display option", () => {
    const plot = plotView(render(<DivergingBars data={metroSplitSelfDescribed.payload} labelHeader="Metro" title="Split" />));
    expect(text(plot)).toContain("Juniper Cola ahead →");
    // ±.03 around the even split, wider than the default ±.02.
    const band = rects(rowMarkup(plot, "portland")).find((r) => r.cls === "fill-sunken")!;
    const fallback = rects(rowMarkup(plotView(render(<DivergingBars data={metroSplit.payload} display="split" title="Split" />)), "portland")).find(
      (r) => r.cls === "fill-sunken",
    )!;
    expect(band.width).toBeGreaterThan(fallback.width);
  });

  it("draws the dumbbell the payload asks for around its baseline", () => {
    const plot = plotView(render(<DivergingBars data={ageDumbbellSelfDescribed.payload} title="Dumbbell" />));
    expect(plot).toContain("fill-chart-muted");
    expect(plot).toMatch(/<circle[^>]*r="4.75"/);
    expect(text(plot)).toContain("Below baseline");
  });

  it("lets a display option override the payload", () => {
    const plot = plotView(render(<DivergingBars data={ageDumbbellSelfDescribed.payload} display="butterfly" title="Butterfly" />));
    expect(plot).not.toMatch(/<circle[^>]*r="4.75"/);
  });

  it("centres a payload baseline other than the default", () => {
    const data = bars([["a", [v(1.2), v(0.9)]]], { mode: "butterfly", unit: "index", baseline: 1, display: "dumbbell" });
    const table = tableView(render(<DivergingBars data={data} title="Index" />));
    expect(tableHeads(table)).toContain("Gap vs Brand Beta");
    expect(text(plotView(render(<DivergingBars data={data} title="Index" />)))).toContain("1.00");
  });
});
