// Small reference implementations of the seams the skills import (stats, subs, badges, findings),
// so the unit tests exercise the skill wiring without depending on the other workstreams' bodies.
// skills.integration.test.ts runs the same flows against the real implementations.
import type { Badge, FindingSuggestion } from "@ct/contracts";
import type { FindingDraft } from "../../../src/findings";
import type { SubsInput, SubsStats } from "../../../src/subs";

export function detectFloor(pooled: readonly number[]): number | null {
  if (pooled.length === 0) return null;
  const min = Math.min(...pooled);
  return pooled.filter((v) => v === min).length >= 2 ? min : null;
}

/** A constant confidence keeps the tests about wiring, not about the §6.4 curve. */
export function metricConfidence(badge: Badge, n: number | null): number | null {
  return badge === "UNAVAILABLE" || n === null || n < 1 ? null : 0.5;
}

function ranksDesc(values: readonly (number | null)[]): (number | null)[] {
  return values.map((v) => (v === null ? null : 1 + values.filter((w) => w !== null && w > v).length));
}

function quantile(sorted: readonly number[], p: number): number {
  const at = p * (sorted.length - 1);
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (at - lo);
}

/** computeSubstitution with competition ranks and a reversed display order (to exercise reordering). */
export function computeSubstitution(input: SubsInput): SubsStats {
  const k = input.refs.length;
  const t = input.targetIndex;
  const sim = input.sim.map((row, i) => row.map((v, j) => (i === j ? null : v)));
  const rankInRow = sim.map(ranksDesc);
  const pctInRow = rankInRow.map((row) => {
    const n = row.filter((r) => r !== null).length;
    return row.map((r) => (r === null ? null : n === 1 ? 1 : 1 - (r - 1) / (n - 1)));
  });
  const hub = sim.map((_, j) => {
    const col = pctInRow.map((row, i) => (i === j ? null : row[j])).filter((v): v is number => v !== null && v !== undefined);
    return col.length < Math.max(2, Math.ceil((k - 1) / 2)) ? null : col.reduce((a, b) => a + b, 0) / col.length;
  });
  const distinctiveness = sim.map((row) => {
    const scored = row.filter((v): v is number => v !== null);
    return scored.length === 0 ? null : 1 - Math.max(...scored);
  });
  const upper: number[] = [];
  for (let i = 0; i < k; i++) for (let j = i + 1; j < k; j++) if (sim[i]![j] !== null) upper.push(sim[i]![j]!);
  const p90 = upper.length >= 2 ? quantile([...upper].sort((a, b) => a - b), 0.9) : null;
  const nearSubstitutes: [number, number][] = [];
  for (let i = 0; i < k; i++) {
    for (let j = i + 1; j < k; j++) {
      const s = sim[i]![j];
      if (p90 !== null && s !== null && s !== undefined && s >= p90 && rankInRow[i]![j] === 1 && rankInRow[j]![i] === 1) {
        nearSubstitutes.push([i, j]);
      }
    }
  }
  let targetScoredRows = 0;
  let targetLastInRows = 0;
  rankInRow.forEach((row, i) => {
    const r = i === t ? null : row[t];
    if (r === null || r === undefined) return;
    targetScoredRows += 1;
    const scored = row.filter((x): x is number => x !== null);
    if (r === Math.max(...scored) && r > Math.min(...scored)) targetLastInRows += 1;
  });
  const targetRow = sim[t]!;
  let targetNearest: number | null = null;
  targetRow.forEach((v, j) => {
    if (v !== null && (targetNearest === null || v > targetRow[targetNearest]!)) targetNearest = j;
  });
  return {
    order: input.refs.map((_, i) => k - 1 - i),
    rankInRow,
    pctInRow,
    hub,
    distinctiveness,
    distinctivenessRank: ranksDesc(distinctiveness),
    p90,
    nearSubstitutes,
    targetLastInRows,
    targetScoredRows,
    tasteIsland: targetScoredRows >= 3 && targetLastInRows >= 0.75 * targetScoredRows,
    targetNearest,
  };
}

function draft(kind: FindingDraft["kind"], text: string, suggestion: FindingSuggestion | null): FindingDraft {
  return { kind, severity: "medium", text, suggestion };
}

export function tasteIslandFinding(args: { targetName: string; lastInRows: number; scoredRows: number; nearestName: string | null }) {
  return draft("TASTE_ISLAND", `${args.targetName} last in ${args.lastInRows} of ${args.scoredRows} rows.`, {
    tool: "cross_domain",
    reason: "find its cultural home",
  });
}

export function nearSubstitutesFinding(args: { aName: string; bName: string }) {
  return draft("NEAR_SUBSTITUTES", `${args.aName} and ${args.bName} are near-substitutes.`, {
    tool: "share_of_taste",
    reason: "compare the pair",
  });
}

export function outsideCategoryNeighbourFinding(args: {
  targetName: string;
  neighbourName: string;
  neighbourCategory: string | null;
  neighbourInMap: boolean;
}) {
  const category = args.neighbourCategory === null ? "" : ` (${args.neighbourCategory})`;
  return draft("OUTSIDE_CATEGORY_NEIGHBOUR", `${args.neighbourName}${category} is outside ${args.targetName}'s category.`, {
    tool: "peer_landscape",
    reason: args.neighbourInMap
      ? `Map ${args.neighbourName}'s own peers, with ${args.neighbourName} as the target.`
      : `Add ${args.neighbourName} to the Substitution Map as a cross-category peer.`,
  });
}

export function droppedCandidatesFinding(args: { names: readonly string[]; context: string }) {
  return args.names.length === 0 ? null : draft("DROPPED_CANDIDATES", `${args.names.join(", ")} not scored in ${args.context}.`, null);
}

export function emptyResultFinding(args: { what: string; suggestion: FindingSuggestion | null }) {
  return draft("EMPTY_RESULT", `${args.what} returned no usable results.`, args.suggestion);
}

export function isOutsideCategoryNeighbour(args: {
  neighbourInCategory: boolean;
  neighbourScore: number | null;
  bestInCategoryScore: number | null;
}): boolean {
  if (args.neighbourInCategory || args.neighbourScore === null) return false;
  return args.bestInCategoryScore === null || args.neighbourScore >= args.bestInCategoryScore;
}
