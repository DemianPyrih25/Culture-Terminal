// SlopeChart: the tenant slope (city → site) with climbers, shifts and TenantFit; three contexts with
// a dropped point; a rank scale; label spreading. A missing point is explained, never drawn.
import type { SlopeLine, SlopePayload } from "@ct/contracts";
import { describe, expect, it, vi } from "vitest";
import { SlopeChart, shiftHead, shiftText, slopeShift, spreadLabels } from "../../components/figures";
import { slopeHighlight, slopeLabelled, slopeTableSpec } from "../../components/figures/slope-chart";
import { FIXTURE_SOURCES, marketSlope, tenantSlope } from "../../components/figures/fixtures";
import { plotView, render, rowMarkup, tableHeads, tableRows, tableView, text } from "./markup";

// /method ships in Part 7; these tests pin the link each figure will carry then.
vi.mock("@/lib/routes", () => ({ ROUTE_LIVE: { method: true, following: false } }));

const html = render(
  <SlopeChart
    data={tenantSlope.payload}
    title="A wine bar and a record shop climb most"
    caption="FIT among the 9 brands ranked in both calls."
    source={FIXTURE_SOURCES.tenant}
    formulaId="tenant.fit"
  />,
);

/** The end label of a line on one side. */
function endLabel(markup: string, key: string, side: "start" | "end"): string {
  const m = markup.match(new RegExp(`<g data-end="${side}" data-for="${key}">([\\s\\S]*?)</g>`));
  if (!m) throw new Error(`no ${side} label for ${key}`);
  return text(m[1]!);
}

describe("SlopeChart · tenant slope", () => {
  it("draws one line per placed candidate with climbers highlighted", () => {
    const plot = plotView(html);
    expect(plot).toContain('role="img"');
    for (const key of ["R21", "R22", "R25"]) expect(rowMarkup(plot, key)).toContain('data-tone="highlight"');
    expect(rowMarkup(plot, "R29")).toContain('data-tone="default"');
    expect(rowMarkup(plot, "R22")).toContain("stroke-accent");
    expect(rowMarkup(plot, "R29")).toContain("stroke-chart-muted");
    expect(text(plot)).toContain("Austin");
    expect(text(plot)).toContain("East Cesar Chavez");
  });

  it("labels both ends with name and value, and the right end with the shift and the score", () => {
    const plot = plotView(html);
    expect(endLabel(plot, "R22", "start")).toBe("Low Tide Records.25");
    expect(endLabel(plot, "R22", "end")).toBe(".88Low Tide Records▲ .6393");
    expect(endLabel(plot, "R29", "end")).toBe(".00Granite Outfitters▼ .880");
    expect(endLabel(plot, "R26", "end")).toContain("= .00");
    expect(text(plot)).toContain("Δ vs Austin");
    expect(text(plot)).toContain("Tenant fit");
  });

  it("lists a candidate with no point under the plot, with its reason", () => {
    const plot = plotView(html);
    expect(plot).not.toContain('data-row="R30"');
    expect(text(plot)).toContain("Not placedSaltmarsh Seltzer Bar (not scored)");
  });

  it("keeps the table view complete: both axes with ranks, the shift, the score", () => {
    const table = tableView(html);
    expect(tableHeads(table)).toEqual(["Name", "Austin", "East Cesar Chavez", "Shift vs Austin", "Tenant fit (0–100)", "Climber"]);
    const rows = tableRows(table);
    expect(rows.find((r) => r[0] === "Low Tide Records")).toEqual(["Low Tide Records", ".25 · #7", ".88 · #2", "+.63", "92.5", "climber"]);
    expect(rows.find((r) => r[0] === "Saltmarsh Seltzer Bar")).toEqual([
      "Saltmarsh Seltzer Bar",
      "not scored",
      "not scored",
      "not scored",
      "not measured",
      "",
    ]);
  });

  it("drops the score column at half width and names lines on the right only", () => {
    const compact = plotView(render(<SlopeChart data={tenantSlope.payload} width={328} title="Compact" />));
    expect(text(compact)).not.toContain("TENANT FIT");
    expect(endLabel(compact, "R22", "start")).toBe(".25");
    expect(endLabel(compact, "R22", "end")).toContain("Low Tide");
  });
});

describe("SlopeChart · three contexts", () => {
  const plot = plotView(render(<SlopeChart data={marketSlope.payload} title="Markets" />));

  it("draws every axis and breaks a line at a dropped point, explaining it at the end", () => {
    for (const axis of ["National", "Nashville", "Austin"]) expect(text(plot)).toContain(axis);
    const dropped = rowMarkup(plot, "R9");
    // National → Nashville is drawn; the Austin end has no circle.
    expect([...dropped.matchAll(/<circle/g)]).toHaveLength(2);
    expect(endLabel(plot, "R9", "end")).toBe("Ember Root Beer · dropped by Qloo—");
    expect(text(plot)).toContain("Δ vs National");
  });

  it("highlights only the lines that climb", () => {
    for (const line of marketSlope.payload.lines) {
      expect(line.highlight, line.label).toBe(line.delta !== null && line.delta > 0);
      expect(rowMarkup(plot, line.key)).toContain(`data-tone="${line.highlight ? "highlight" : "default"}"`);
    }
    expect(endLabel(plot, "R7", "end")).toContain("▲");
  });
});

describe("SlopeChart · highlight and labels", () => {
  it("marks the same climbers in the table view as in the plot when the caller picks them", () => {
    const out = render(<SlopeChart data={tenantSlope.payload} highlightKeys={["R29"]} title="Picked" />);
    const plot = plotView(out);
    expect(rowMarkup(plot, "R29")).toContain('data-tone="highlight"');
    expect(rowMarkup(plot, "R22")).toContain('data-tone="default"');
    const rows = tableRows(tableView(out));
    const climbers = rows.filter((r) => r.at(-1) === "climber").map((r) => r[0]);
    expect(climbers).toEqual(["Granite Outfitters"]);
    expect(slopeTableSpec(tenantSlope.payload, "t", {}, slopeHighlight(tenantSlope.payload, []))
      .rows.every((r) => !("cells" in r) || r.cells.at(-1) === "")).toBe(true);
  });

  /** n lines on a pct scale; line i shifts by `shift(i)`. */
  const many = (n: number, shift: (i: number) => number, highlight: (i: number) => boolean): SlopeLine[] =>
    Array.from({ length: n }, (_, i) => ({
      key: `L${i}`,
      label: `Line ${i}`,
      ref: null,
      points: [
        { value: 0.5, reason: null, rank: null },
        { value: 0.5 + shift(i), reason: null, rank: null },
      ],
      delta: shift(i),
      highlight: highlight(i),
      score: null,
    }));

  it("labels every line up to 24", () => {
    const lines = many(24, (i) => i / 100, () => false);
    expect(slopeLabelled(lines, new Set()).size).toBe(24);
  });

  it("above 24 labels the climbers, then the largest other shifts, 24 in all", () => {
    // 40 lines; shifts grow with i, so the largest are L39, L38, ...; the climbers are among them.
    const lines = many(40, (i) => i / 100, (i) => i >= 37);
    const labelled = slopeLabelled(lines, slopeHighlight({ ...tenantSlope.payload, lines }));
    expect(labelled.size).toBe(24);
    for (const k of ["L37", "L38", "L39"]) expect(labelled.has(k)).toBe(true);
    // The other 21: the next largest shifts, L16 to L36.
    expect([...labelled].filter((k) => !["L37", "L38", "L39"].includes(k)).sort()).toEqual(
      Array.from({ length: 21 }, (_, i) => `L${16 + i}`).sort(),
    );
  });

  it("labels every climber, and only them, when there are more than 24", () => {
    const lines = many(40, (i) => (40 - i) / 100, (i) => i < 30);
    const labelled = slopeLabelled(lines, slopeHighlight({ ...tenantSlope.payload, lines }));
    expect(labelled.size).toBe(30);
    expect([...labelled].every((k) => Number(k.slice(1)) < 30)).toBe(true);
  });
});

describe("slope helpers", () => {
  const line = (delta: number | null) => ({ ...tenantSlope.payload.lines[0]!, delta });

  it("reads improvement as up: a higher pct, or a lower rank", () => {
    expect(slopeShift(line(0.25), "pct")).toBe(0.25);
    expect(slopeShift(line(-3), "rank")).toBe(3);
    expect(slopeShift(line(null), "pct")).toBeNull();
    expect(shiftText(line(0.25), "pct", { leadingZero: false })).toBe("▲ .25");
    expect(shiftText(line(-3), "rank", {})).toBe("▲ 3");
    expect(shiftText(line(2), "rank", {})).toBe("▼ 2");
    expect(shiftText(line(0), "pct", { leadingZero: false })).toBe("= .00");
  });

  it("names the comparator in the shift head", () => {
    expect(shiftHead(tenantSlope.payload)).toBe("Δ vs Austin");
  });

  it("prints rank-scale points as ranks and shifts in places", () => {
    const ranks: SlopePayload = {
      axes: [
        { key: "a", label: "Nashville" },
        { key: "b", label: "Austin" },
      ],
      scale: "rank",
      comparator: "WITHIN_CALL",
      valueLabel: "Rank",
      scoreLabel: null,
      lines: [
        {
          key: "x",
          label: "Brand X",
          ref: null,
          points: [
            { value: 5, reason: null, rank: 5 },
            { value: 2, reason: null, rank: 2 },
          ],
          delta: -3,
          highlight: true,
          score: null,
        },
      ],
    };
    const out = render(<SlopeChart data={ranks} title="Ranks" />);
    expect(endLabel(plotView(out), "x", "end")).toBe("#2Brand X▲ 3");
    expect(tableRows(tableView(out))[0]).toEqual(["Brand X", "#5", "#2", "up 3 places", "climber"]);
  });

  it("spreads labels apart, inside the plot when there is room", () => {
    const at = spreadLabels(
      [
        { key: "a", y: 50 },
        { key: "b", y: 51 },
        { key: "c", y: 52 },
      ],
      0,
      200,
    );
    const ys = ["a", "b", "c"].map((k) => at.get(k)!).sort((x, y) => x - y);
    expect(ys[1]! - ys[0]!).toBeGreaterThanOrEqual(13);
    expect(ys[2]! - ys[1]!).toBeGreaterThanOrEqual(13);
    const edge = spreadLabels(
      [
        { key: "a", y: 198 },
        { key: "b", y: 199 },
      ],
      0,
      200,
    );
    expect(Math.max(...edge.values())).toBeLessThanOrEqual(200);
  });
});
