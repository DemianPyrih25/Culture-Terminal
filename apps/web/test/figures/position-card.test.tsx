// PositionCard (§5.4): five axes in a fixed order, each with its position, peer rank, badge and a
// link to its exhibit; no composite score (D14); an axis without a value says why.
import { describe, expect, it, vi } from "vitest";
import { PeerStrip, PositionCard } from "../../components/figures";
import { FIXTURE_SOURCES, tastePosition, tastePositionNoSignal } from "../../components/figures/fixtures";
import { plotView, render, tableHeads, tableRows, tableView, text } from "./markup";

// /method ships in Part 7; these tests pin the link each figure will carry then.
vi.mock("@/lib/routes", () => ({ ROUTE_LIVE: { method: true, following: false } }));

const html = render(
  <PositionCard
    data={tastePosition.payload}
    figureHrefs={{ D1: "#figure-2", D19: "#figure-6" }}
    title="Distinctive and young"
    source={FIXTURE_SOURCES.position}
    formulaId="subs.distinctiveness"
  />,
);

/** The markup of one axis row. */
function axisRow(markup: string, axis: string): string {
  const start = markup.indexOf(`data-axis="${axis}"`);
  if (start < 0) throw new Error(`no axis ${axis}`);
  return markup.slice(start, markup.indexOf("</tr>", start));
}

describe("PositionCard", () => {
  it("shows the five axes in order with what each displays", () => {
    const plot = plotView(html);
    const order = [...plot.matchAll(/data-axis="([a-z_]+)"/g)].map((m) => m[1]);
    expect(order).toEqual(["distinctiveness", "reach", "next_gen_tilt", "metro_breadth", "momentum"]);
    expect(text(axisRow(plot, "distinctiveness"))).toContain("Distinctivenessnearest: Kettle Ridge Tonic2 of 7");
    expect(text(axisRow(plot, "metro_breadth"))).toContain("wins 3 of 6");
    expect(text(axisRow(plot, "momentum"))).toContain("Rising");
  });

  it("places the subject among its peers, slot by slot", () => {
    const plot = plotView(html);
    const strip = axisRow(plot, "reach");
    expect(strip).toContain('aria-label="rank 4 of 7 among peers"');
    expect([...strip.matchAll(/<circle/g)]).toHaveLength(7);
    expect(strip).toMatch(/<circle cx="35" cy="5" r="3.75" class="fill-accent" data-subject="true"/);
    // The words repeat only where the display says something else.
    expect(text(axisRow(plot, "reach"))).not.toContain("4 of 74 of 7");
    expect(text(axisRow(plot, "momentum"))).toContain("1 of 3");
    expect(text(axisRow(plot, "metro_breadth"))).toContain("—");
  });

  it("badges each axis and links the ones whose exhibit is on the page", () => {
    const plot = plotView(html);
    expect(axisRow(plot, "distinctiveness")).toContain('data-badge="MEASURED"');
    expect(text(axisRow(plot, "next_gen_tilt"))).toContain("Derived");
    expect(text(axisRow(plot, "momentum"))).toContain("Historical");
    expect(axisRow(plot, "distinctiveness")).toContain('href="#figure-2"');
    expect(axisRow(plot, "momentum")).toContain('href="#figure-6"');
    expect(axisRow(plot, "reach")).not.toContain("href=");
  });

  it("never prints a composite score", () => {
    const words = text(html).toLowerCase();
    expect(words).not.toMatch(/overall|composite|total score/);
    expect(words).not.toContain("score");
  });

  it("explains an axis without a value, momentum with the No signal hatch", () => {
    const card = plotView(render(<PositionCard data={tastePositionNoSignal.payload} compact title="No signal" />));
    const row = axisRow(card, "momentum");
    expect(row).toContain('data-badge="UNAVAILABLE"');
    expect(text(row)).toContain("No signal");
    expect(text(row)).toContain("Not measured");
    expect(row).toContain("bg-hatch");
  });

  it("keeps the HTML card out of the reading order twice: the table view waits for the toggle", () => {
    expect(html).toMatch(/<div hidden="" data-view="table" class="min-w-0 overflow-x-auto">/);
    const table = tableView(html);
    expect(tableHeads(table)).toEqual(["Axis", "Shown", "Value", "Peer rank", "Badge", "Note"]);
    const rows = tableRows(table);
    expect(rows[0]).toEqual(["Distinctiveness", "2 of 7", "0.53", "2 of 7", "Measured", "nearest: Kettle Ridge Tonic"]);
    expect(rows[3]).toEqual(["Metro breadth", "wins 3 of 6", "3", "—", "Derived", "head-to-head metros against Brand Alpha"]);
    const missing = tableRows(tableView(render(<PositionCard data={tastePositionNoSignal.payload} title="No signal" />)));
    expect(missing[4]).toEqual(["Momentum", "No signal", "no signal", "—", "Not measured", "too few weeks in the window"]);
  });

  it("draws a long peer set as a track with a marker", () => {
    const track = render(<PeerStrip rank={{ rank: 10, of: 30 }} />);
    expect([...track.matchAll(/<circle/g)]).toHaveLength(1);
    expect(track).toContain('aria-label="rank 10 of 30 among peers"');
  });
});
