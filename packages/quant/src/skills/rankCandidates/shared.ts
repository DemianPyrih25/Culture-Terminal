import {
  isDeniedAudience,
  type DatasetId,
  type DigestRow,
  type EntityRef,
  type EntityRegistry,
  type EntityType,
  type EvidenceId,
  type Finding,
  type Flag,
  type Metric,
  type MetricId,
  type NoValueReason,
  type SkillCtx,
  type SkillResult,
  type SkillStatus,
} from "@ct/contracts";
import { droppedCandidatesFinding, type FindingDraft } from "../../findings";
import { skillResult, type DigestTarget } from "../digest";
import { fixed2, safeName } from "../format";
import type { Candidate, GridRow, ScoreGrid } from "./scoring";

/** Plumbing RANK and SHARE share: the run accumulator, candidate checks, flags, notices and the digest. */

/** Everything one call accumulates for its ledger output and digest. */
export interface RankRun {
  ctx: SkillCtx;
  flags: Set<Flag>;
  evidenceIds: EvidenceId[];
  metrics: Metric[];
  findings: Finding[];
  datasetIds: DatasetId[];
  notices: string[];
}

export function newRun(ctx: SkillCtx, notices: readonly string[] = []): RankRun {
  return { ctx, flags: new Set(), evidenceIds: [], metrics: [], findings: [], datasetIds: [], notices: [...notices] };
}

export function addFindingDraft(run: RankRun, draft: FindingDraft, metricIds: readonly MetricId[]): Finding {
  const finding = run.ctx.ledger.addFinding({ ...draft, metricIds: [...metricIds] });
  run.findings.push(finding);
  return finding;
}

export function pushMetric(run: RankRun, metric: Metric): Metric {
  run.metrics.push(metric);
  return metric;
}

export function finish(run: RankRun, target: DigestTarget, status: SkillStatus, rows: readonly DigestRow[]): SkillResult {
  return skillResult(
    {
      status,
      evidenceIds: run.evidenceIds,
      datasetIds: run.datasetIds,
      metrics: run.metrics,
      rows,
      findings: run.findings,
      flags: run.flags,
      registered: [],
      notices: run.notices,
    },
    target,
  );
}


const article = (noun: string) => (/^[aeiou]/.test(noun) ? `an ${noun}` : `a ${noun}`);

/** Registered entities of the expected type, in input order, with a notice for each ref left out. */
export function usableEntities(
  refs: readonly EntityRef[],
  type: EntityType,
  registry: EntityRegistry,
  role: string,
): { entities: Candidate[]; notices: string[] } {
  const entities: Candidate[] = [];
  const notices: string[] = [];
  for (const ref of refs) {
    const e = registry.entity(ref);
    if (e === null) notices.push(`${ref} is not in the registry; left out of the ${role}.`);
    else if (e.type !== type) notices.push(`${ref} (${safeName(e.name)}) is ${article(e.type)}, not ${article(type)}; left out of the ${role}.`);
    else if (!entities.some((c) => c.entityId === e.entityId)) {
      entities.push({ ref: e.ref, entityId: e.entityId, name: e.name, popularity: e.popularity });
    }
  }
  return { entities, notices };
}

/** "1 brand", "5 brands". */
export function count(n: number, noun: string): string {
  return `${n} ${n === 1 ? noun : `${noun}s`}`;
}

/** "A", "A and B", "A, B and C", "A, B, C and 2 more". */
export function listLabels(labels: readonly string[], max = 3): string {
  const shown = labels.slice(0, max);
  const rest = labels.length - shown.length;
  if (rest > 0) return `${shown.join(", ")} and ${rest} more`;
  if (shown.length <= 1) return shown[0] ?? "";
  return `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
}

/** "+0.42", "-0.13": a signed two-decimal display for deltas. */
export function signed2(x: number): string {
  return `${x > 0 ? "+" : ""}${fixed2(x)}`;
}

/** A rank shift in words when it rounds to nothing ("no shift", never a bare "0.00" that reads as a score), else signed2. */
export function shiftText(x: number): string {
  return Math.abs(Number(fixed2(x))) === 0 ? "no shift" : signed2(x);
}

/** The client refused the row's audience before sending it: qloo_param on an audience context (D21). */
function refusedAudience(row: GridRow): boolean {
  return row.spec.kind === "audience" && row.failure?.code === "qloo_param";
}

/**
 * A refused audience that is a sensitive segment, denied on every desk (communities, politics,
 * beliefs; contracts isDeniedAudience), rather than a family this desk's AUDIENCES list leaves out.
 */
export function deniedSegment(row: GridRow): boolean {
  return refusedAudience(row) && row.spec.subject !== null && isDeniedAudience(row.spec.subject);
}

/** The data-quality flags the grid raises, added to the run (S1 vocabulary). */
export function addGridFlags(run: RankRun, grid: ScoreGrid): void {
  const c = grid.cells;
  const flags: Flag[] = [];
  if (c.dropped > 0 || c.notScored > 0 || c.lone > 0 || c.failed > 0) flags.push("CANDIDATES_UNSCORED");
  if (c.dropped > 0) flags.push("DROPPED_CANDIDATES");
  if (c.notScored > 0) flags.push("NOT_SCORED");
  if (grid.rows.some((r) => r.gap === "budget_truncated")) flags.push("BUDGET_TRUNCATED");
  if (grid.rows.some(deniedSegment)) flags.push("SENSITIVE_SEGMENT_BLOCKED");
  for (const f of flags) run.flags.add(f);
}

/** The flags one bundle's rows raise, for its evidence row. */
export function rowFlags(rows: readonly GridRow[]): Flag[] {
  const cells = rows.flatMap((r) => r.cells);
  const has = (reason: NoValueReason) => cells.some((cell) => cell.reason === reason);
  const flags: Flag[] = [];
  if (has("dropped") || has("not_scored") || has("insufficient_n") || has("error")) flags.push("CANDIDATES_UNSCORED");
  if (rows.some((r) => r.gap === "budget_truncated")) flags.push("BUDGET_TRUNCATED");
  if (has("dropped")) flags.push("DROPPED_CANDIDATES");
  if (has("not_scored")) flags.push("NOT_SCORED");
  return flags;
}

/** What the model reads about contexts that produced no ranking: not callable, refused, failed or with one scored candidate. */
export function gapNotices(grid: ScoreGrid, noun: string): string[] {
  const notices: string[] = [];
  const planned = grid.rows.filter((r) => r.spec.signal !== null).length;
  for (const row of grid.rows) {
    if (row.spec.gap !== null) notices.push(row.spec.gap.notice);
    else if (deniedSegment(row)) notices.push(`${row.spec.label}: a sensitive segment, refused on every desk (D21), so the context was not called.`);
    else if (refusedAudience(row)) notices.push(`${row.spec.label}: not on this desk's AUDIENCES list, so the context was not called.`);
  }
  const truncated = grid.rows.filter((r) => r.gap === "budget_truncated");
  if (truncated.length > 0) {
    notices.push(
      `The call budget stopped ${truncated.length} of ${planned} context calls (${listLabels(truncated.map((r) => r.spec.label))}); their cells are not measured.`,
    );
  }
  const failed = grid.rows.filter((r) => r.gap === "error");
  if (failed.length > 0) {
    const codes = [...new Set(failed.map((r) => r.failure?.code ?? "qloo_error"))].join(", ");
    notices.push(
      `${failed.length} of ${planned} context calls failed (${codes}): ${listLabels(failed.map((r) => r.spec.label))}; their cells are not measured.`,
    );
  }
  const lone = grid.rows.filter((r) => r.cells.some((c) => c.reason === "insufficient_n"));
  if (lone.length > 0) {
    notices.push(`Only one ${noun} was scored in ${listLabels(lone.map((r) => r.spec.label))}, so that context ranks nothing.`);
  }
  return notices;
}

/** DROPPED_CANDIDATES: candidates Qloo omitted in at least one context, with those contexts named. */
export function addDroppedFinding(run: RankRun, grid: ScoreGrid): void {
  const dropped = grid.candidates.filter((_, j) => grid.rows.some((r) => r.cells[j]?.reason === "dropped"));
  if (dropped.length === 0) return;
  const rows = grid.rows.filter((r) => r.cells.some((c) => c.reason === "dropped"));
  const context = `the ${listLabels(rows.map((r) => r.spec.label))} ${rows.length === 1 ? "context" : "contexts"}`;
  const draft = droppedCandidatesFinding({ names: dropped.map((c) => safeName(c.name)), context });
  if (draft !== null) addFindingDraft(run, draft, []);
}

/** "Austin: dropped; 55+: not_scored": a row's unscored cells for the digest, at most three named. */
export function unscoredText(grid: ScoreGrid, j: number): string | null {
  const gaps = grid.rows.flatMap((r) => {
    const reason = r.cells[j]?.reason;
    return reason === null || reason === undefined ? [] : [`${r.spec.label}: ${reason}`];
  });
  if (gaps.length === 0) return null;
  const shown = gaps.slice(0, 3).join("; ");
  return gaps.length > 3 ? `${shown}; and ${gaps.length - 3} more` : shown;
}

/** Whether every row with a call ranked nothing. */
export function nothingRanked(grid: ScoreGrid): boolean {
  return grid.rows.every((r) => r.scored === 0);
}

/**
 * The status S1 uses: partial when a context is missing (not callable, budget, failure), empty
 * when the calls ranked nothing, ok otherwise.
 */
export function gridStatus(grid: ScoreGrid): SkillStatus {
  const missing = grid.rows.some((r) => r.gap !== null);
  if (missing) return "partial";
  return nothingRanked(grid) ? "empty" : "ok";
}
