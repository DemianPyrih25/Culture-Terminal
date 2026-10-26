// MomentumStrip (S4, D19): step-shaped weekly series on a shared scale, the window shaded and the
// time after it hatched, the STALE badge always shown, NO SIGNAL never drawn as a flat line.
import type { MomentumPayload } from "@ct/contracts";
import { describe, expect, it, vi } from "vitest";
import { MomentumStrip, momentumDomain, stepPath, windowEndMonth } from "../../components/figures";
import { FIXTURE_SOURCES, MOMENTUM_WINDOW, momentumStrip } from "../../components/figures/fixtures";
import { plotView, render, rowMarkup, tableRows, tableView, text } from "./markup";

// /method ships in Part 7; these tests pin the link each figure will carry then.
vi.mock("@/lib/routes", () => ({ ROUTE_LIVE: { method: true, following: false } }));

const data = momentumStrip.payload;
const html = render(
  <MomentumStrip
    data={data}
    asOf="2026-10-14"
    number={5}
    title="Juniper Cola rose through the window"
    source={FIXTURE_SOURCES.trending}
    formulaId="mom.delta_26w"
  />,
);

describe("MomentumStrip", () => {
  it("always shows the STALE badge with its window, and no signal after the window", () => {
    expect(html).toContain('data-badge="STALE"');
    expect(text(html)).toContain(`STALE${data.badgeText}`);
    expect(text(html)).toContain("No signal after Aug 2026");
    expect(plotView(html)).toContain(`data-no-signal-after="${MOMENTUM_WINDOW.end}"`);
    expect(text(plotView(html))).toContain("TRENDING WINDOW · MAR–AUG 2026");
  });

  it("draws a step line per series with signal, its trend, Δ over 26 weeks and peer rank", () => {
    const plot = plotView(html);
    const rising = rowMarkup(plot, "R1");
    expect(rising).toContain('data-state="ok"');
    expect(rising).toMatch(/<path d="M[\d.]+ [\d.]+H[\d.]+V/);
    expect(text(rising)).toContain("▲ Rising");
    expect(text(rising)).toContain("+.17");
    expect(text(rising)).toContain("1 of 3");
    expect(text(rowMarkup(plot, "R2"))).toContain("– Flat");
    expect(text(rowMarkup(plot, "R3"))).toContain("▼ Declining");
    expect(rowMarkup(plot, "R3")).toContain("fill-negative");
  });

  it("marks winsorised outliers with a caret and a scale break in the subline", () => {
    const plot = plotView(html);
    const clipped = data.series[0]!.points.filter((p) => p.clipped);
    expect(clipped).toHaveLength(1);
    expect(rowMarkup(plot, "R1")).toContain(`data-clipped="${clipped[0]!.date}"`);
    expect(text(rowMarkup(plot, "R3"))).toContain("brand · scale break");
    expect(text(rowMarkup(plot, "R3"))).toContain("scale break, latest segment kept");
  });

  it("hatches a series without signal and never draws it as a line", () => {
    const plot = plotView(html);
    const flat = rowMarkup(plot, "R4");
    expect(flat).toContain('data-hatch="no_signal"');
    expect(text(flat)).toContain("NO SIGNAL");
    expect(flat).not.toContain("stroke-data");
    const none = rowMarkup(plot, "R11");
    expect(none).toContain('data-hatch="unavailable"');
    expect(text(none)).toContain("NOT MEASURED");
    expect(text(none)).toContain("unavailable");
  });

  it("lists every week in the table view, and why a series has none", () => {
    const rows = tableRows(tableView(html));
    expect(rows).toContainEqual(["Juniper Cola · brand"]);
    expect(rows).toContainEqual(["Trend", "Rising", data.badgeText]);
    expect(rows).toContainEqual(["Δ over 26 weeks", "+.17", "Theil–Sen slope × 26"]);
    expect(rows).toContainEqual(["Week of 2026-05-25", ".88", "winsorised outlier (^)"]);
    expect(rows).toContainEqual(["Week of 2026-03-02", ".62", ""]);
    expect(rows.filter((r) => r[0]?.startsWith("Week of"))).toHaveLength(26 + 26 + 18);
    expect(rows).toContainEqual(["Trend", "no signal", data.badgeText]);
    expect(rows).toContainEqual(["Trend", "unavailable", data.badgeText]);
  });

  it("keeps the trend column only at half width", () => {
    const compact = text(plotView(render(<MomentumStrip data={data} width={328} title="Compact" />)));
    expect(compact).toContain("TREND");
    expect(compact).not.toContain("PEERS");
  });

  it("frames an empty strip without a scale", () => {
    const empty: MomentumPayload = { ...data, series: [] };
    const out = render(<MomentumStrip data={empty} title="Empty" />);
    expect(out).not.toContain('data-scale="true"');
    expect(text(out)).toContain("No signal after Aug 2026");
  });
});

describe("momentum helpers", () => {
  it("fits the shared scale to the drawn series in steps of 0.05", () => {
    expect(momentumDomain(data.series)).toEqual({ min: 0.55, max: 0.9 });
    expect(momentumDomain([])).toEqual({ min: 0, max: 1 });
  });

  it("steps each week across, then up or down to the next", () => {
    const x = (t: number) => (t - Date.UTC(2026, 2, 2)) / 86_400_000;
    const y = (v: number) => 100 - v * 100;
    const d = stepPath(
      [
        { date: "2026-03-02", pct: 0.5 },
        { date: "2026-03-09", pct: 0.6 },
      ],
      x,
      y,
      Date.UTC(2026, 2, 31),
    );
    expect(d).toBe("M0 50H7V40H14");
  });

  it("names the month the window ends", () => {
    expect(windowEndMonth(MOMENTUM_WINDOW)).toBe("Aug 2026");
  });
});
