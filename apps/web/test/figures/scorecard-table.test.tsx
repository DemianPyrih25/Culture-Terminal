// ScorecardTable: the priors (A/Prior) with verdicts, bound prose and the live waiting states.
import { describe, expect, it } from "vitest";
import { ScorecardList, ScorecardTable, expectedText, plainProse } from "../../components/figures";
import { SCORECARD_BINDINGS, priorsScorecard } from "../../components/figures/fixtures";
import { plotView, render, tableRows, tableView, text } from "./markup";

const data = priorsScorecard.payload;

describe("ScorecardTable", () => {
  const html = render(<ScorecardTable data={data} bindings={SCORECARD_BINDINGS} title="Four priors" />);

  it("writes each prior as an expectation with its verdict", () => {
    const plot = plotView(html);
    expect(text(plot)).toContain("H1We expected: competes with Brand Alpha and Brand Beta.");
    expect(plot).toContain('data-state="REFUTED"');
    expect(plot).toContain('data-state="CONFIRMED"');
    expect(plot).toContain('data-state="INCONCLUSIVE"');
    expect(text(plot)).toContain("Confirmed");
  });

  it("binds metric tokens and turns citations into footnotes", () => {
    const plot = plotView(html);
    expect(text(plot)).toContain("Measured: the nearest audience is Kettle Ridge Tonic at 0.47; Brand Beta reaches 0.29, sixth.3");
    expect(plot).toContain('data-metric="M1"');
    expect(plot).toContain('data-evidence="E1"');
    expect(text(plot)).toContain("across Mar–Aug 2026");
    expect(text(plot)).not.toContain("{{");
  });

  it("lists every prior as text in a table view hidden until toggled", () => {
    // The list is readable HTML already, so the table is not a second copy for screen readers.
    expect(html).toContain('<div hidden="" data-view="table" class="min-w-0 overflow-x-auto">');
    const rows = tableRows(tableView(html));
    expect(rows).toHaveLength(4);
    expect(rows[1]).toEqual([
      "H2",
      "skews younger than its category.",
      "Youth tilt above the category median.",
      "confirmed",
      "youth tilt +0.19 vs the category median.[4]",
    ]);
  });

  it("shows waiting priors during a live run", () => {
    const list = render(
      <ScorecardList data={data} pending={{ H3: "AWAITING_DATA", H4: "AWAITING_CHECK" }} waitingNote="Written before data · 09:12:04" />,
    );
    expect(list).toContain('data-state="AWAITING_DATA"');
    expect(text(list)).toContain("Awaiting check");
    expect(text(list)).toContain("Written before data · 09:12:04");
    expect(text(list)).not.toContain("folk holds");
  });

  it("prints n/a for a metric it was not given, never a bare token", () => {
    expect(plainProse("youth tilt {{M9}} vs the median.[E9]")).toBe("youth tilt n/a vs the median.");
    expect(expectedText("We expected: a rise.")).toBe("We expected: a rise.");
  });
});
