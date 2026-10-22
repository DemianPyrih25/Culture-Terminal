// The Substitution Map as an aligned text table: one row per entity in the dataset's display order,
// each cell the symmetric similarity with its rank-in-row glyph, "—" for a pair without a score,
// then the hub score and the distinctiveness rank.
import type { MatrixCell, MatrixPayload } from "@ct/contracts";
import { computeSubstitution } from "@ct/quant";
import { formatFixed2, NONE } from "./format";
import { renderTable, truncate, type Column } from "./table";

const SELF = "·";
const TARGET_MARK = "▸";
const LABEL_MAX = 28;
const MISSING_CELL: MatrixCell = { value: null, reason: "unavailable", rank: null };

/** ①…⑳ for ranks 1–20, "(21)" beyond. */
export function rankGlyph(rank: number): string {
  return Number.isInteger(rank) && rank >= 1 && rank <= 20 ? String.fromCodePoint(0x2460 + rank - 1) : `(${rank})`;
}

/** "0.42 ②", "·" on the diagonal, "—" without a score. */
export function matrixCellText(cell: MatrixCell, self: boolean): string {
  if (self) return SELF;
  if (cell.value === null) return NONE;
  return cell.rank === null ? formatFixed2(cell.value) : `${formatFixed2(cell.value)} ${rankGlyph(cell.rank)}`;
}

/**
 * Distinctiveness rank per row (1 = most distinctive), recomputed by QUANT's computeSubstitution
 * from the cells: the dataset carries hub scores but not distinctiveness. A map the budget cut short
 * has none, as in the skill's own metrics.
 */
export function distinctivenessRanks(payload: MatrixPayload): (number | null)[] {
  const none = payload.rows.map(() => null);
  const truncated = payload.cells.some((row) => row.some((c) => c.reason === "budget_truncated"));
  if (truncated || payload.rows.length < 2) return none;
  const targetIndex = Math.max(0, payload.rows.findIndex((r) => r.key === payload.targetKey));
  try {
    const stats = computeSubstitution({
      refs: payload.rows.map((r) => r.key),
      targetIndex,
      sim: payload.cells.map((row, i) => row.map((c, j) => (i === j ? null : c.value))),
    });
    return stats.distinctivenessRank;
  } catch {
    return none;
  }
}

/** Upper-triangle pairs without a score, e.g. "R2×R5 dropped". */
export function unscoredPairs(payload: MatrixPayload): string[] {
  const out: string[] = [];
  payload.cells.forEach((row, i) =>
    row.forEach((cell, j) => {
      if (j <= i || cell.value !== null) return;
      out.push(`${payload.rows[i]?.key ?? "?"}×${payload.cols[j]?.key ?? "?"} ${cell.reason ?? "unavailable"}`);
    }),
  );
  return out;
}

export function renderSubstitutionMap(payload: MatrixPayload, options: { indent?: string } = {}): string[] {
  const indent = options.indent ?? "";
  const distinct = distinctivenessRanks(payload);
  const ranked = distinct.filter((r) => r !== null).length;
  const columns: Column[] = [
    { header: "" },
    ...payload.cols.map((c) => ({ header: c.key })),
    { header: payload.margin?.label.toLowerCase() ?? "hub", align: "right" as const },
    { header: "distinct", align: "right" as const },
  ];
  const rows = payload.rows.map((row, i) => {
    const mark = row.key === payload.targetKey ? TARGET_MARK : " ";
    const label = `${mark} ${truncate(`${row.key} ${row.label}`, LABEL_MAX)}`;
    const cells = payload.cols.map((col, j) => matrixCellText(payload.cells[i]?.[j] ?? MISSING_CELL, col.key === row.key));
    // The margin is aligned with cols; the matrix is square, so a row's hub sits at its column.
    const colIndex = payload.cols.findIndex((c) => c.key === row.key);
    const hub = colIndex < 0 ? undefined : payload.margin?.values[colIndex];
    const rank = distinct[i] ?? null;
    return [label, ...cells, formatFixed2(hub?.value), rank === null ? NONE : `${rank} of ${ranked}`];
  });
  const lines = renderTable(columns, rows, { indent });
  for (const a of payload.annotations) lines.push(`${indent}▲ ${a.text}`);
  const unscored = unscoredPairs(payload);
  if (unscored.length > 0) lines.push(`${indent}not scored: ${unscored.join(", ")}`);
  return lines;
}
