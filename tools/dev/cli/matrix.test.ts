import type { MatrixCell, MatrixPayload, NoValueReason } from "@ct/contracts";
import { describe, expect, it } from "vitest";
import { distinctivenessRanks, matrixCellText, rankGlyph, renderSubstitutionMap, unscoredPairs } from "./matrix";

// Invented brands; R1 is the target.
const NAMES = ["Brand Alpha", "Brand Beta", "Brand Gamma", "Brand Delta"];
type Pair = number | NoValueReason;
const PAIRS: Record<string, Pair> = { "0-1": 0.8, "0-2": 0.6, "0-3": "not_scored", "1-2": 0.7, "1-3": 0.5, "2-3": "dropped" };

function cell(value: Pair, rank: number | null): MatrixCell {
  return typeof value === "number" ? { value, reason: null, rank } : { value: null, reason: value, rank: null };
}

/** The payload the skill would build for PAIRS, with whole ranks within each row. */
function payload(overrides: Partial<MatrixPayload> = {}): MatrixPayload {
  const axis = NAMES.map((label, i) => ({ key: `R${i + 1}`, label, ref: `R${i + 1}` as const, group: null }));
  const pair = (i: number, j: number): Pair => PAIRS[`${Math.min(i, j)}-${Math.max(i, j)}`] as Pair;
  const cells = NAMES.map((_, i) => {
    const row = NAMES.map((__, j) => (i === j ? ("self" as const) : pair(i, j)));
    const scored = row.filter((v): v is number => typeof v === "number").sort((a, b) => b - a);
    return row.map((v) => (v === "self" ? { value: null, reason: "self" as NoValueReason, rank: null } : cell(v, typeof v === "number" ? scored.indexOf(v) + 1 : null)));
  });
  return {
    mode: "similarity",
    valueLabel: "Audience taste similarity",
    unit: "similarity",
    comparator: "PEERS",
    rows: axis,
    cols: axis.map((a) => ({ ...a })),
    cells,
    margin: { label: "Hub score", values: [0.75, 1, 0.25, 0].map((value) => ({ value, reason: null })) },
    targetKey: "R1",
    annotations: [{ text: "Near-substitutes: Brand Alpha and Brand Beta", rowKey: "R1", colKey: "R2" }],
    ...overrides,
  };
}

describe("rankGlyph", () => {
  it("draws circled digits for ranks 1–20 and brackets beyond", () => {
    expect([1, 2, 7, 20].map(rankGlyph)).toEqual(["①", "②", "⑦", "⑳"]);
    expect(rankGlyph(21)).toBe("(21)");
  });
});

describe("matrixCellText", () => {
  it("shows the similarity with its glyph, a dot on the diagonal and a dash without a score", () => {
    expect(matrixCellText({ value: 0.8, reason: null, rank: 1 }, false)).toBe("0.80 ①");
    expect(matrixCellText({ value: null, reason: "self", rank: null }, true)).toBe("·");
    expect(matrixCellText({ value: null, reason: "not_scored", rank: null }, false)).toBe("—");
  });
});

describe("renderSubstitutionMap", () => {
  const lines = renderSubstitutionMap(payload());

  it("prints a header of refs with the hub and distinctiveness columns", () => {
    expect(lines[0]?.trim().split(/\s{2,}/)).toEqual(["R1", "R2", "R3", "R4", "hub score", "distinct"]);
  });

  it("marks the target row and renders unscored cells as a dash", () => {
    const target = lines[1] ?? "";
    expect(target.startsWith("▸ R1 Brand Alpha")).toBe(true);
    expect(target).toMatch(/·\s+0\.80 ①\s+0\.60 ②\s+—\s+0\.75/);
    expect(lines[4]).toMatch(/^ {2}R4 Brand Delta\s+—\s+0\.50 ①\s+—\s+·\s+0\.00/);
  });

  it("lines every column up across rows", () => {
    // Every glyph here is one UTF-16 unit, so string offsets are display columns.
    const at = lines[0]?.indexOf("R4") ?? -1;
    expect(at).toBeGreaterThan(0);
    expect(lines.slice(1, 5).map((l) => l.slice(at).split(/\s{2,}/)[0])).toEqual(["—", "0.50 ③", "—", "·"]);
  });

  it("ranks distinctiveness from the cells, 1 = most distinctive", () => {
    expect(lines[4]).toMatch(/1 of 4$/);
    expect(lines[3]).toMatch(/2 of 4$/);
  });

  it("lists the annotations and each unscored pair once", () => {
    expect(lines).toContain("▲ Near-substitutes: Brand Alpha and Brand Beta");
    expect(lines.at(-1)).toBe("not scored: R1×R4 not_scored, R3×R4 dropped");
    expect(unscoredPairs(payload())).toEqual(["R1×R4 not_scored", "R3×R4 dropped"]);
  });

  it("shows no hub or distinctiveness for a map the budget cut short", () => {
    const cut = payload();
    cut.cells[2]![3] = { value: null, reason: "budget_truncated", rank: null };
    cut.cells[3]![2] = { value: null, reason: "budget_truncated", rank: null };
    cut.margin = { label: "Hub score", values: cut.cols.map(() => ({ value: null, reason: "budget_truncated" as const })) };
    expect(distinctivenessRanks(cut)).toEqual([null, null, null, null]);
    const rows = renderSubstitutionMap(cut, { indent: "  " }).slice(1, 5);
    for (const row of rows) expect(row).toMatch(/—\s+—$/);
    expect(rows.every((r) => r.startsWith("  "))).toBe(true);
  });
});
