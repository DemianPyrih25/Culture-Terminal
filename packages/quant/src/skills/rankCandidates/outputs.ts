import type { DigestRow, EntityType, EvidenceId, Metric, NoValueReason, RankedPayload, SlopePayload } from "@ct/contracts";
import type { FormulaId } from "../../formulas";
import { clamp } from "../../stats";
import { addSkillEvidence, addSkillMetric } from "../common";
import { fixed2, rankText, safeFullName, safeName } from "../format";
import {
  callsOf,
  cellSummary,
  commonRanks,
  missingReason,
  type Candidate,
  type CommonRanks,
  type GridCell,
  type GridRow,
  type ScoreGrid,
} from "./scoring";
import { count, listLabels, pushMetric, rowFlags, shiftText, unscoredText, type RankRun } from "./shared";

/**
 * What one rank_candidates call writes (SPEC §5.3 S8, PLAN §4.3): one evidence bundle, a bounded set
 * of FIT metrics, and a Ranked table for one context or a Slope across two or three. Tenant fit is
 * the [site, city] case: rank shift Δ = pct_site − pct_city and the one weighted formula in P0.
 * Every difference between two contexts compares percentiles among the same candidates: the ones
 * both contexts ranked (commonRanks), never each context's own scored set.
 */

/** Candidates that get citable metrics: the table and the slope hold the rest. */
export const RANKED_METRIC_ROWS = 8;
export const SLOPE_METRIC_ROWS = 6;
/** Climbers drawn highlighted on a slope. */
export const SLOPE_HIGHLIGHTS = 3;
/** Formula of a rank shift between two contexts other than site and city. */
export const RANK_SHIFT_FORMULA: FormulaId = "rank.shift";

/** TenantFit = 100·(0.6·pct_site + 0.4·clip(Δ + 0.5, 0, 1)) (FORMULAS tenant.fit). */
export function tenantFit(pctSite: number, shift: number): number {
  return 100 * (0.6 * pctSite + 0.4 * clamp(shift + 0.5, 0, 1));
}

export type RankLayout =
  | { kind: "ranked"; row: GridRow }
  | { kind: "slope"; rows: GridRow[]; common: CommonRanks }
  | { kind: "tenant"; rows: [city: GridRow, site: GridRow]; common: CommonRanks };

type SlopeLayout = Extract<RankLayout, { kind: "slope" }>;
type TenantLayout = Extract<RankLayout, { kind: "tenant" }>;

/** The [city, site] rows when the call is exactly a site and the city of the same metro, else null. */
export function tenantPair(rows: readonly GridRow[]): [city: GridRow, site: GridRow] | null {
  if (rows.length !== 2) return null;
  const site = rows.find((r) => r.spec.kind === "site");
  const city = rows.find((r) => r.spec.kind === "city");
  return site !== undefined && city !== undefined && site.spec.metro === city.spec.metro ? [city, site] : null;
}

/**
 * One context, or a call where only one context ranked anything, is a Ranked table of that context.
 * Exactly a site and the city of its metro, both ranked with at least MIN_RANKED candidates in
 * common, is tenant fit, read city → site; anything else is a slope in input order.
 */
export function layoutOf(grid: ScoreGrid): RankLayout {
  const n = grid.candidates.length;
  const ranked = grid.rows.filter((r) => r.scored > 0);
  const only = ranked.length === 1 ? ranked[0] : grid.rows.length === 1 ? grid.rows[0] : undefined;
  if (only !== undefined) return { kind: "ranked", row: only };
  const pair = tenantPair(grid.rows);
  if (pair !== null && ranked.length === 2) {
    const common = commonRanks(pair, n);
    if (common.members.length > 0) return { kind: "tenant", rows: pair, common };
  }
  return { kind: "slope", rows: grid.rows, common: commonRanks(grid.rows, n) };
}

export function recordRankEvidence(run: RankRun, grid: ScoreGrid, type: EntityType): EvidenceId | null {
  const calls = callsOf(grid.rows);
  const labels = grid.rows.map((r) => r.spec.label).join(", ");
  const evidence = addSkillEvidence(run.ctx.ledger, {
    skill: "rank_candidates",
    purpose: `Rank ${count(grid.candidates.length, type)} under ${count(grid.rows.length, "context")}`,
    calls,
    status: grid.rows.some((r) => r.gap !== null) ? "partial" : grid.rows.every((r) => r.scored === 0) ? "empty" : "ok",
    summary: `${count(calls.length, "rank call")} (${labels}); ${cellSummary(grid.rows)}.`,
    flags: rowFlags(grid.rows),
  });
  if (evidence === null) return null;
  run.evidenceIds.push(evidence.id);
  return evidence.id;
}

/** Per candidate: its site and city cells among the candidates ranked at both, the rank shift and the tenant fit. */
export interface TenantLine {
  site: GridCell;
  city: GridCell;
  shift: number | null;
  fit: number | null;
}

export function tenantLines(layout: TenantLayout): TenantLine[] {
  const [city = [], site = []] = layout.common.cells;
  return city.map((c, j) => {
    const s = site[j]!;
    const shift = s.pct === null || c.pct === null ? null : s.pct - c.pct;
    return { site: s, city: c, shift, fit: shift === null || s.pct === null ? null : tenantFit(s.pct, shift) };
  });
}

/** "every context", or the contexts that ranked when some did not: where the common set was ranked. */
function commonScope(rows: readonly GridRow[]): string {
  const ranked = rows.filter((r) => r.scored > 0);
  return ranked.length === rows.length ? "every context" : listLabels(ranked.map((r) => r.spec.label));
}

/** Per candidate: the slope's two ends among the common set, the shift last − first, or why there is none. */
interface SlopeEnd {
  first: GridCell;
  last: GridCell;
  shift: number | null;
  reason: NoValueReason | null;
}

/** The cells a slope draws: among the common set when there is one, else each context's own FIT. */
function slopeCells(layout: SlopeLayout): GridCell[][] {
  return layout.common.members.length > 0 ? layout.common.cells : layout.rows.map((r) => r.cells);
}

function slopeEnds(layout: SlopeLayout, n: number): SlopeEnd[] {
  const cells = slopeCells(layout);
  const firstRow = layout.rows[0]!;
  const lastRow = layout.rows[layout.rows.length - 1]!;
  const comparable = layout.common.members.length > 0 && firstRow.scored > 0 && lastRow.scored > 0;
  return Array.from({ length: n }, (_, j) => {
    const first = cells[0]?.[j] ?? { pct: null, rank: null, reason: "not_scored" };
    const last = cells[cells.length - 1]?.[j] ?? { pct: null, rank: null, reason: "not_scored" };
    const shift = comparable && first.pct !== null && last.pct !== null ? last.pct - first.pct : null;
    if (shift !== null) return { first, last, shift, reason: null };
    const silent = [firstRow, lastRow].filter((r) => r.scored === 0);
    if (silent.length > 0) return { first, last, shift: null, reason: missingReason(silent.flatMap((r) => [r.gap, r.cells[j]?.reason])) };
    return { first, last, shift: null, reason: comparable ? missingReason([first.reason, last.reason]) : "insufficient_n" };
  });
}

/** Candidate indices ordered by a score, highest first, unscored dropped; ties keep input order. */
function topBy(scores: readonly (number | null)[], n: number): number[] {
  return scores
    .map((score, j) => ({ score, j }))
    .filter((x): x is { score: number; j: number } => x.score !== null)
    .sort((a, b) => b.score - a.score || a.j - b.j)
    .slice(0, n)
    .map((x) => x.j);
}

function placeIn(row: GridRow, cell: GridCell | undefined): string | null {
  return cell?.rank === null || cell?.rank === undefined ? null : rankText(cell.rank, row.scored);
}

/** Metric ids per candidate, for the digest rows. */
export interface RankMetrics {
  fit: (Metric | null)[];
  shift: (Metric | null)[];
  /** Per candidate, per row: FIT in that context (single context and slopes). */
  pct: (Metric | null)[][];
}

function fitMetric(run: RankRun, c: Candidate, row: GridRow, cell: GridCell, evidence: EvidenceId[]): Metric {
  return pushMetric(
    run,
    addSkillMetric(run.ctx.ledger, {
      key: "rank.fit",
      label: `FIT of ${safeName(c.name)}, ${row.spec.label}`,
      subjectRefs: [c.ref, ...(row.spec.subject === null ? [] : [row.spec.subject])],
      value: cell.pct,
      reason: cell.reason ?? "not_scored",
      display: cell.pct === null ? "" : `${fixed2(cell.pct)} · ${rankText(cell.rank ?? 0, row.scored)}`,
      unit: "pct",
      badge: "DERIVED",
      formulaId: "pct.within_call",
      evidenceIds: evidence,
      n: row.scored,
      comparator: "WITHIN_CALL",
    }),
  );
}

function addTenantMetrics(run: RankRun, grid: ScoreGrid, layout: TenantLayout, evidence: EvidenceId[], out: RankMetrics): void {
  const [city, site] = layout.rows;
  const lines = tenantLines(layout);
  const k = layout.common.members.length;
  // Both orders are named (D10 of the Part 9 close-out): tenant fit weighs the rise over the city too,
  // so it can order two candidates the other way round from their site rank.
  const where = (l: TenantLine) => `site rank ${rankText(l.site.rank ?? 0, k)} · city rank ${rankText(l.city.rank ?? 0, k)}`;
  const subjects = [site.spec.subject, city.spec.subject].filter((s): s is string => s !== null);
  for (const j of topBy(lines.map((l) => l.shift), SLOPE_METRIC_ROWS)) {
    const c = grid.candidates[j]!;
    const line = lines[j]!;
    out.shift[j] = pushMetric(
      run,
      addSkillMetric(run.ctx.ledger, {
        key: "tenant.rank_shift",
        label: `rank shift of ${safeName(c.name)}, ${site.spec.label} vs ${city.spec.label}`,
        subjectRefs: [c.ref, ...subjects],
        value: line.shift,
        reason: "not_scored",
        display: line.shift === null ? "" : `${shiftText(line.shift)} · ${where(line)}`,
        unit: "delta",
        badge: "DERIVED",
        formulaId: "tenant.rank_shift",
        evidenceIds: evidence,
        n: k,
        comparator: "CITY",
      }),
    );
  }
  for (const j of topBy(lines.map((l) => l.fit), SLOPE_METRIC_ROWS)) {
    const c = grid.candidates[j]!;
    const line = lines[j]!;
    out.fit[j] = pushMetric(
      run,
      addSkillMetric(run.ctx.ledger, {
        key: "tenant.fit",
        label: `tenant fit of ${safeName(c.name)} at ${site.spec.label} (weighs the site rank and the rise over the city, so its order can differ from the site rank)`,
        subjectRefs: [c.ref, ...subjects],
        value: line.fit,
        reason: "not_scored",
        display: line.fit === null ? "" : `${Math.round(line.fit)} of 100 · ${where(line)}`,
        unit: "score",
        badge: "DERIVED",
        formulaId: "tenant.fit",
        evidenceIds: evidence,
        n: k,
        comparator: "CITY",
      }),
    );
  }
}

/** Whether a slope publishes rank shifts: only when both ends rank a common set, so some candidate has a shift. */
function slopeShiftFormula(layout: SlopeLayout, n: number): FormulaId | null {
  return slopeEnds(layout, n).some((e) => e.shift !== null) ? RANK_SHIFT_FORMULA : null;
}

/**
 * The metric set, bounded so the digest fits: FIT for the top RANKED_METRIC_ROWS of one context; for
 * tenant fit, the rank shift for the top climbers and TenantFit for the best fits, climbers first in
 * the ledger so a KPI strip reading the first shift shows the top one; for a slope, FIT in each
 * context that ranked for the SLOPE_METRIC_ROWS best candidates, plus the rank shift among the
 * common set once rank.shift is registered.
 */
export function addRankMetrics(run: RankRun, grid: ScoreGrid, layout: RankLayout, evidenceId: EvidenceId | null): RankMetrics {
  const evidence = evidenceId === null ? [] : [evidenceId];
  const n = grid.candidates.length;
  const out: RankMetrics = { fit: Array(n).fill(null), shift: Array(n).fill(null), pct: grid.candidates.map(() => grid.rows.map(() => null)) };

  if (layout.kind === "ranked") {
    const { row } = layout;
    for (const j of topBy(row.cells.map((c) => c.pct), RANKED_METRIC_ROWS)) {
      out.pct[j]![grid.rows.indexOf(row)] = fitMetric(run, grid.candidates[j]!, row, row.cells[j]!, evidence);
    }
    return out;
  }
  if (layout.kind === "tenant") {
    addTenantMetrics(run, grid, layout, evidence, out);
    return out;
  }

  const { rows } = layout;
  const ranked = rows.filter((r) => r.scored > 0);
  const best = grid.candidates.map((_, j) => {
    const pcts = ranked.map((r) => r.cells[j]?.pct ?? null).filter((p): p is number => p !== null);
    return pcts.length === 0 ? null : Math.max(...pcts);
  });
  const shiftFormula = slopeShiftFormula(layout, n);
  const ends = slopeEnds(layout, n);
  const first = rows[0]!;
  const last = rows[rows.length - 1]!;
  const k = layout.common.members.length;
  const among = `among the ${k} ranked in ${commonScope(rows)}`;
  for (const j of topBy(best, SLOPE_METRIC_ROWS)) {
    const c = grid.candidates[j]!;
    for (const row of ranked) out.pct[j]![rows.indexOf(row)] = fitMetric(run, c, row, row.cells[j]!, evidence);
    if (shiftFormula === null) continue;
    const end = ends[j]!;
    out.shift[j] = pushMetric(
      run,
      addSkillMetric(run.ctx.ledger, {
        key: "rank.shift",
        label: `rank shift of ${safeName(c.name)}, ${last.spec.label} vs ${first.spec.label}`,
        subjectRefs: [c.ref, ...[first.spec.subject, last.spec.subject].filter((s): s is string => s !== null)],
        value: end.shift,
        reason: end.reason ?? "not_scored",
        display: end.shift === null ? "" : `${shiftText(end.shift)} · ${rankText(end.first.rank ?? 0, k)} → ${rankText(end.last.rank ?? 0, k)}, ${among}`,
        unit: "delta",
        badge: "DERIVED",
        formulaId: shiftFormula,
        evidenceIds: evidence,
        n: k,
        comparator: "WITHIN_CALL",
      }),
    );
  }
  return out;
}

const popularityCell = (c: Candidate) =>
  c.popularity === null ? { value: null, reason: "not_measured" as const } : { value: c.popularity, reason: null };

const valueCell = (cell: GridCell) =>
  cell.pct === null ? { value: null, reason: cell.reason ?? "not_scored" } : { value: cell.pct, reason: null };

const point = (cell: GridCell) => ({ ...valueCell(cell), rank: cell.pct === null ? null : cell.rank });

/** The Ranked table of one context: scored candidates by rank, then the unscored ones, each with its reason. */
export function rankedPayload(grid: ScoreGrid, row: GridRow, type: EntityType): RankedPayload {
  const order = grid.candidates
    .map((_, j) => j)
    .sort((a, b) => (row.cells[a]?.rank ?? Number.POSITIVE_INFINITY) - (row.cells[b]?.rank ?? Number.POSITIVE_INFINITY) || a - b);
  return {
    columns: [
      { key: "fit", label: "FIT", unit: "pct", comparator: "WITHIN_CALL" },
      { key: "popularity", label: "Popularity", unit: "popularity", comparator: null },
    ],
    groups: [
      {
        key: row.spec.key,
        label: row.spec.label,
        rows: order.map((j) => {
          const c = grid.candidates[j]!;
          const cell = row.cells[j]!;
          return {
            key: c.ref,
            rank: cell.rank,
            label: safeFullName(c.name),
            sublabel: null,
            ref: c.ref,
            tagRef: null,
            type,
            cells: [valueCell(cell), popularityCell(c)],
            flags: [],
            explain: [],
          };
        }),
      },
    ],
    caption: `FIT is the within-call percentile among the ${count(row.scored, type)} scored under ${row.spec.label}; unscored candidates are listed last, not ranked.`,
  };
}

/**
 * The Slope across contexts, left to right. Points are FIT among the candidates every ranked
 * context scored, so a line's delta (last − first) and its drawn slope compare the same set; a
 * candidate outside that set has no points, each with its reason. Without a common set the points
 * are each context's own FIT and no line has a delta. Tenant fit reads city → site and carries
 * TenantFit as each line's score.
 */
export function slopePayload(grid: ScoreGrid, layout: Exclude<RankLayout, { kind: "ranked" }>, type: EntityType): SlopePayload {
  const n = grid.candidates.length;
  const k = layout.common.members.length;
  if (layout.kind === "tenant") {
    const lines = tenantLines(layout);
    const climbers = new Set(topBy(lines.map((l) => (l.shift !== null && l.shift > 0 ? l.shift : null)), SLOPE_HIGHLIGHTS));
    return {
      axes: layout.rows.map((r) => ({ key: r.spec.key, label: r.spec.label })),
      scale: "pct",
      comparator: "CITY",
      valueLabel: `FIT among the ${count(k, type)} ranked at both the site and the city`,
      scoreLabel: "Tenant fit (0–100): weighs the site rank and the rise over the city, so its order can differ from the site rank",
      lines: grid.candidates.map((c, j) => ({
        key: c.ref,
        label: safeFullName(c.name),
        ref: c.ref,
        points: [point(lines[j]!.city), point(lines[j]!.site)],
        delta: lines[j]!.shift,
        highlight: climbers.has(j),
        score: lines[j]!.fit,
      })),
    };
  }
  const cells = slopeCells(layout);
  const ends = slopeEnds(layout, n);
  const climbers = new Set(topBy(ends.map((e) => (e.shift !== null && e.shift > 0 ? e.shift : null)), SLOPE_HIGHLIGHTS));
  return {
    axes: layout.rows.map((r) => ({ key: r.spec.key, label: r.spec.label })),
    scale: "pct",
    comparator: "WITHIN_CALL",
    valueLabel: k > 0 ? `FIT among the ${count(k, type)} ranked in ${commonScope(layout.rows)}` : "FIT (within-call percentile)",
    scoreLabel: null,
    lines: grid.candidates.map((c, j) => ({
      key: c.ref,
      label: safeFullName(c.name),
      ref: c.ref,
      points: cells.map((row) => point(row[j]!)),
      delta: ends[j]?.shift ?? null,
      highlight: climbers.has(j),
      score: null,
    })),
  };
}

export function addRankDataset(run: RankRun, grid: ScoreGrid, layout: RankLayout, type: EntityType): void {
  const evidenceIds = [...run.evidenceIds];
  if (layout.kind === "ranked") {
    const dataset = run.ctx.ledger.addDataset({
      kind: "Ranked",
      title: `Ranked · ${layout.row.spec.label}`,
      evidenceIds,
      formulaIds: ["pct.within_call", "popularity"],
      payload: rankedPayload(grid, layout.row, type),
    });
    run.datasetIds.push(dataset.id);
    return;
  }
  const shift = layout.kind === "slope" ? slopeShiftFormula(layout, grid.candidates.length) : null;
  const formulaIds: FormulaId[] =
    layout.kind === "tenant" ? ["pct.within_call", "tenant.rank_shift", "tenant.fit"] : ["pct.within_call", ...(shift === null ? [] : [shift])];
  const title =
    layout.kind === "tenant"
      ? `Tenant fit · ${layout.rows[1].spec.label} vs ${layout.rows[0].spec.label}`
      : `Rank shift · ${layout.rows.map((r) => r.spec.label).join(" → ")}`;
  const dataset = run.ctx.ledger.addDataset({ kind: "Slope", title, evidenceIds, formulaIds, payload: slopePayload(grid, layout, type) });
  run.datasetIds.push(dataset.id);
}

/**
 * Up to twelve candidates, best first, each with its place in every context and the metrics that hold
 * its numbers. Values are words, whole ranks and metric ids only.
 */
export function rankDigestRows(grid: ScoreGrid, layout: RankLayout, metrics: RankMetrics | null): DigestRow[] {
  const n = grid.candidates.length;
  const rows = layout.kind === "ranked" ? [layout.row] : layout.rows;
  const tenant = layout.kind === "tenant" ? tenantLines(layout) : null;
  const score = grid.candidates.map((_, j) => {
    if (tenant !== null) return tenant[j]?.fit ?? null;
    const pcts = rows.map((r) => r.cells[j]?.pct ?? null).filter((p): p is number => p !== null);
    return pcts.length === 0 ? null : Math.max(...pcts);
  });
  const ranked = topBy(score, n);
  const order = [...ranked, ...grid.candidates.map((_, j) => j).filter((j) => !ranked.includes(j))];
  return order.map((j) => {
    const c = grid.candidates[j]!;
    const values: DigestRow["values"] = {};
    for (const row of rows) values[row.spec.kind === "none" ? "rank" : row.spec.kind] = placeIn(row, row.cells[j]);
    if (rows.length > 1 && new Set(rows.map((r) => r.spec.kind)).size < rows.length) {
      // Two contexts of one kind (two ages, two metros): name each by its label instead.
      for (const row of rows) delete values[row.spec.kind];
      values.ranks = rows.map((r) => `${r.spec.label} ${placeIn(r, r.cells[j]) ?? "–"}`).join(" · ");
    }
    if (metrics !== null) {
      const pct = (metrics.pct[j] ?? []).filter((m): m is Metric => m !== null).map((m) => m.id);
      const fit = metrics.fit[j] ?? null;
      const shift = metrics.shift[j] ?? null;
      if (pct.length > 0) values.fit_metrics = pct.join(", ");
      if (fit !== null) values.tenant_fit_metric = fit.id;
      if (shift !== null) values.shift_metric = shift.id;
    }
    const unscored = unscoredText(grid, j);
    if (unscored !== null) values.unscored = unscored;
    return { ref: c.ref, name: safeName(c.name), values };
  });
}
