import type { EntityRef, MatrixPayload, NoValueReason, QlooEntity, QlooParams } from "@ct/contracts";
import { detectFloor } from "../stats";
import type { SubsStats } from "../subs";
import { displayRanks } from "./format";

/**
 * The S1 similarity matrix. Probe G1 froze PROBE_FACTS.pairSymmetric = true (score(A→B) equals
 * score(B→A)) and candidate-set invariance, so k−1 triangular calls fill the whole symmetric matrix:
 * call i scores S_{i+1..k} against the signal S_i.
 */

export interface TriangularCall {
  /** Index of the signal entity: the matrix row this call fills. */
  row: number;
  /** Indices of the candidates: the cells it fills, mirrored into the lower half. */
  cols: number[];
  params: QlooParams;
}

export function triangularCalls(entityIds: readonly string[]): TriangularCall[] {
  const k = entityIds.length;
  return entityIds.slice(0, -1).map((signal, row) => {
    const cols = Array.from({ length: k - row - 1 }, (_, n) => row + 1 + n);
    return {
      row,
      cols,
      params: {
        "signal.interests.entities": [signal],
        "filter.results.entities": entityIds.slice(row + 1),
        take: k,
      },
    };
  });
}

export interface CellState {
  value: number | null;
  reason: NoValueReason | null;
}

export interface ScoredMatrix {
  /** cells[i][j] = cells[j][i]; the diagonal is "self". */
  cells: CellState[][];
  /** The shared "no relationship" score detected across all calls, or null. */
  floor: number | null;
  /** Members missing from at least one response that requested them as candidates. */
  droppedMembers: number[];
  /** Unordered pairs by outcome; `failed` pairs belong to a call the Qloo client failed. */
  pairs: { total: number; scored: number; notScored: number; dropped: number; truncated: number; failed: number };
}

/** Why a scoring call has no response: the budget refused it, or the Qloo client failed it. */
export type CallGap = Extract<NoValueReason, "budget_truncated" | "error">;

/**
 * Fills the matrix from the triangular responses, or the gap that stands in for a missing one. A
 * candidate absent from its response, or present without an affinity, is dropped (G2). Scores are
 * pooled one per pair before floor detection: mirroring them first would make every minimum a tie.
 */
export function fillMatrix(
  entityIds: readonly string[],
  plan: readonly TriangularCall[],
  responses: readonly (readonly QlooEntity[] | CallGap)[],
): ScoredMatrix {
  const k = entityIds.length;
  const cells: CellState[][] = entityIds.map((_, i) =>
    entityIds.map((__, j) => (i === j ? { value: null, reason: "self" } : { value: null, reason: "budget_truncated" })),
  );
  const set = (i: number, j: number, cell: CellState) => {
    cells[i]![j] = cell;
    cells[j]![i] = { ...cell };
  };

  const dropped = new Set<number>();
  plan.forEach((call, c) => {
    const response = responses[c] ?? "budget_truncated";
    if (typeof response === "string") {
      for (const j of call.cols) set(call.row, j, { value: null, reason: response });
      return;
    }
    const scores = new Map(response.map((e) => [e.entity_id, e.query?.affinity]));
    for (const j of call.cols) {
      const score = scores.get(entityIds[j]!);
      if (typeof score === "number") set(call.row, j, { value: score, reason: null });
      else {
        set(call.row, j, { value: null, reason: "dropped" });
        dropped.add(j);
      }
    }
  });

  const upper: [number, number][] = [];
  for (let i = 0; i < k; i++) for (let j = i + 1; j < k; j++) upper.push([i, j]);
  const pooled = upper.flatMap(([i, j]) => {
    const v = cells[i]![j]!.value;
    return v === null ? [] : [v];
  });
  const floor = pooled.length > 0 ? detectFloor(pooled) : null;
  if (floor !== null) {
    for (const [i, j] of upper) if (cells[i]![j]!.value === floor) set(i, j, { value: null, reason: "not_scored" });
  }

  const reasonCount = (reason: NoValueReason | null) => upper.filter(([i, j]) => cells[i]![j]!.reason === reason).length;
  return {
    cells,
    floor,
    droppedMembers: [...dropped].sort((a, b) => a - b),
    pairs: {
      total: upper.length,
      scored: reasonCount(null),
      notScored: reasonCount("not_scored"),
      dropped: reasonCount("dropped"),
      truncated: reasonCount("budget_truncated"),
      failed: reasonCount("error"),
    },
  };
}

/**
 * Why the map is missing whole calls: the budget first, then a failed call; null when every scoring
 * call returned. Results that compare rows are recorded as not measured with this reason.
 */
export function mapGap(matrix: ScoredMatrix): CallGap | null {
  if (matrix.pairs.truncated > 0) return "budget_truncated";
  return matrix.pairs.failed > 0 ? "error" : null;
}

/**
 * Every scoring call returned. Results that compare rows (hub, distinctiveness rank, taste island,
 * near-substitutes) need this: a row with one scored cell ranks that cell first and last at once.
 */
export function isComplete(matrix: ScoredMatrix): boolean {
  return mapGap(matrix) === null;
}

export function similarityOf(matrix: ScoredMatrix): (number | null)[][] {
  return matrix.cells.map((row) => row.map((c) => c.value));
}

/**
 * Whole competition ranks of row i's scored cells, 1 = most similar: a tie shares the best rank
 * ("1224"). The grid glyph and the digest's rank to the target both read this, so they always agree.
 */
export function rowRanks(matrix: ScoredMatrix, i: number): (number | null)[] {
  return displayRanks((matrix.cells[i] ?? []).map((c) => c.value));
}

/** Scored cells in row i (equal to column i: the matrix is symmetric). */
export function scoredInRow(matrix: ScoredMatrix, i: number): number {
  return (matrix.cells[i] ?? []).filter((c) => c.value !== null).length;
}

/** Why a complete map has no hub for member j: no scored row at all, or too few (hubMinRows). */
export function hubGap(matrix: ScoredMatrix, j: number): NoValueReason {
  return scoredInRow(matrix, j) === 0 ? "not_scored" : "insufficient_n";
}

export interface MapMember {
  ref: EntityRef;
  name: string;
}

function isPermutation(order: readonly number[], k: number): boolean {
  return order.length === k && new Set(order).size === k && order.every((i) => Number.isInteger(i) && i >= 0 && i < k);
}

/**
 * The MatrixGrid payload in clustered display order: colour = similarity, glyph = rank in row, Hub
 * margin. The glyph is rowRanks, so tied cells share the best rank and every row with a scored cell
 * shows a 1. Hub needs every row: on a map missing a call the margin reads that gap's reason rather
 * than a centrality the missing calls made up, and a member scored in too few rows reads
 * insufficient_n.
 */
export function substitutionMapPayload(args: {
  members: readonly MapMember[];
  matrix: ScoredMatrix;
  stats: SubsStats;
  targetIndex: number;
  annotations: MatrixPayload["annotations"];
}): MatrixPayload {
  const { members, matrix, stats } = args;
  const k = members.length;
  const order = isPermutation(stats.order, k) ? stats.order : members.map((_, i) => i);
  const axis = order.map((i) => ({ key: members[i]!.ref, label: members[i]!.name, ref: members[i]!.ref, group: null }));
  const glyphs = matrix.cells.map((_, i) => rowRanks(matrix, i));
  const gap = mapGap(matrix);
  return {
    mode: "similarity",
    valueLabel: "Audience taste similarity",
    unit: "similarity",
    comparator: "PEERS",
    rows: axis,
    cols: axis.map((a) => ({ ...a })),
    cells: order.map((i) =>
      order.map((j) => {
        const cell = matrix.cells[i]![j]!;
        return { value: cell.value, reason: cell.reason, rank: cell.value === null ? null : (glyphs[i]?.[j] ?? null) };
      }),
    ),
    margin: {
      label: "Hub score",
      values: order.map((j) => {
        if (gap !== null) return { value: null, reason: gap };
        const hub = stats.hub[j] ?? null;
        return hub === null ? { value: null, reason: hubGap(matrix, j) } : { value: hub, reason: null };
      }),
    },
    targetKey: members[args.targetIndex]?.ref ?? null,
    annotations: args.annotations.slice(0, 2),
  };
}
