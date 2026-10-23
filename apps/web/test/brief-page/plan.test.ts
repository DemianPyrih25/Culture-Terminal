// Where the sidenotes go: each footnote once, level with the first row that cites it, the margin reading
// 1, 2, 3 down a finished brief; figures paired when they fit half the column; and the margin layout
// that pushes a row's notes clear of the ones above.
import { describe, expect, it, vi } from "vitest";
import { buildBriefModel, type Inline } from "../../lib/brief";
import { citedIn, citingRows, expectedRivalRefs, figureRows, isCompactFigure, placeNotes, ROW } from "../../components/brief/plan";
import { stackNotes } from "../../components/brief/sidenote-layout";
import { after, events, stateOf, upTo } from "./support";

vi.mock("server-only", () => ({}));

const SAMPLE = events("brand-health");
const final = buildBriefModel(stateOf(SAMPLE), after(SAMPLE));

describe("sidenote placement", () => {
  it("places every footnote once, in reading order down a finished brief", () => {
    const placed = [...placeNotes(final).values()].flat();
    expect(placed).toEqual(final.footnotes.map((f) => f.n));
    expect(placed).toEqual([...placed].sort((a, b) => a - b));
  });

  it("puts a footnote beside the first row that cites it", () => {
    const notes = placeNotes(final);
    const firstRow = new Map<number, string>();
    for (const row of citingRows(final)) for (const n of row.cites) if (!firstRow.has(n)) firstRow.set(n, row.key);
    for (const [key, numbers] of notes) for (const n of numbers) expect(firstRow.get(n) ?? ROW.sources).toBe(key);
    // The answer cites first, so its notes open the margin.
    expect(notes.get(ROW.answer)?.[0]).toBe(1);
  });

  it("orders a live row's notes by number, though the brief numbers them as they arrive", () => {
    const list = upTo(SAMPLE, "plan");
    const live = buildBriefModel(stateOf(list), after(list));
    const keyFigures = placeNotes(live).get(ROW.keyFigures) ?? [];
    expect(keyFigures.length).toBeGreaterThan(1);
    expect(keyFigures).toEqual([...keyFigures].sort((a, b) => a - b));
  });

  it("reads each cited number once per block, in order", () => {
    const metric = final.answer.thesis?.find((p): p is Extract<Inline, { kind: "metric" }> => p.kind === "metric");
    if (!metric) throw new Error("no metric in the thesis");
    const cite: Inline = { kind: "cite", evidenceId: "E1", footnote: 99 };
    expect(citedIn([metric, cite, metric], null, [cite])).toEqual([metric.footnote, 99]);
  });
});

describe("figure rows", () => {
  it("pairs small similarity matrices and leaves a lone one on its own row", () => {
    expect(final.evidence.figures.every(isCompactFigure)).toBe(true);
    expect(figureRows(final.evidence.figures).map((row) => row.map((f) => f.number))).toEqual([[1, 2], [3]]);
  });

  it("greys the rivals the priors named: the secondary mentions that matched", () => {
    const state = stateOf(SAMPLE);
    const rivals = expectedRivalRefs(state.resolves);
    expect(rivals.length).toBeGreaterThan(0);
    for (const ref of rivals) expect(state.resolves.find((r) => r.ref === ref)?.role).toBe("secondary");
  });
});

describe("the margin layout", () => {
  it("leaves notes that fit where they are and pushes the rest clear of the notes above", () => {
    const { shifts, bottom } = stackNotes(
      [
        { top: 0, height: 40 },
        { top: 100, height: 300 },
        { top: 150, height: 20 },
        { top: 600, height: 10 },
      ],
      16,
    );
    expect(shifts).toEqual([0, 0, 266, 0]);
    expect(bottom).toBe(610);
  });

  it("moves notes down level with the paragraph that cites them, never above their row, and still clear of the notes above", () => {
    const { shifts, bottom } = stackNotes(
      [
        // The answer: its notes wait for the thesis under the head.
        { top: 0, height: 200, anchor: 114 },
        // A prior whose "Measured" line sits under notes still running: they push it further.
        { top: 250, height: 40, anchor: 280 },
        // An anchor above the row's top (a citation in an earlier row) never lifts the notes.
        { top: 500, height: 20, anchor: 300 },
        // No anchor: the row's top.
        { top: 600, height: 10, anchor: null },
      ],
      16,
    );
    expect(shifts).toEqual([114, 80, 0, 0]);
    expect(bottom).toBe(610);
  });
});
