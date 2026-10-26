import {
  entityTypeUrn,
  type CacheProbe,
  type EntityRef,
  type EntityType,
  type NoValueReason,
  type QlooCallMeta,
  type QlooEntity,
  type QlooParams,
  type SkillCtx,
} from "@ct/contracts";
import { detectFloor, withinCallPercentiles } from "../../stats";
import { attemptAllKeepingFailures, countUncached } from "../common";
import { displayRanks } from "../format";
import type { ContextSpec } from "./contexts";

/**
 * One rank call per context over a fixed candidate list, then the grid both RANK and SHARE read:
 * within-call percentiles and display ranks per context, with every unscored cell explained. Scores
 * are compared only inside their own call (CHECKER V6). Rows are matched by entity id and never read
 * in response order: age-signal ranks come back unsorted (PROBE Part 5 consequence 8).
 */

export interface Candidate {
  ref: EntityRef;
  entityId: string;
  name: string;
  popularity: number | null;
}

/** A context needs two scored candidates to rank anything: a lone scored one is first only by default. */
export const MIN_RANKED = 2;

export interface GridCell {
  /** Within-call percentile among the row's scored candidates (pct.within_call); null when unscored. */
  pct: number | null;
  /** Whole display rank among them, 1 = top, ties share the best rank; null when unscored. */
  rank: number | null;
  /** Why the cell is unscored; null when it has a value. */
  reason: NoValueReason | null;
}

export interface GridRow {
  spec: ContextSpec;
  /** The call behind the row; null when it was not made or failed. */
  meta: QlooCallMeta | null;
  /** Why the whole row has no response: not callable or refused before sending (unavailable), budget_truncated or error. */
  gap: NoValueReason | null;
  /** The Qloo client's error code when the call failed. */
  failure: { code: string; error: unknown } | null;
  /** Aligned with the candidates. */
  cells: GridCell[];
  /** Raw affinity of each ranked candidate in this call; null when unscored. Only compared inside the row. */
  affinity: (number | null)[];
  /** Candidates ranked in this row: zero when fewer than MIN_RANKED were scored. */
  scored: number;
}

export interface CellCounts {
  total: number;
  scored: number;
  notScored: number;
  dropped: number;
  lone: number;
  truncated: number;
  failed: number;
  unavailable: number;
}

export interface ScoreGrid {
  candidates: readonly Candidate[];
  /** In context order. */
  rows: GridRow[];
  cells: CellCounts;
}

/** A context's response, or the gap that stands in for it. */
export type RowResponse =
  | { kind: "ok"; entities: readonly QlooEntity[]; meta: QlooCallMeta }
  | { kind: "gap"; reason: NoValueReason; failure?: { code: string; error: unknown } };

/** The rank call's parameters: the context signal over the exact candidate list (take = its size, ≤ 50). */
export function rankParams(signal: QlooParams, candidateIds: readonly string[]): QlooParams {
  return { ...signal, "filter.results.entities": [...candidateIds], take: candidateIds.length };
}

function scoresOf(candidates: readonly Candidate[], entities: readonly QlooEntity[]): (number | null)[] {
  const byId = new Map(entities.map((e) => [e.entity_id, e.query?.affinity]));
  return candidates.map((c) => {
    const a = byId.get(c.entityId);
    return typeof a === "number" && Number.isFinite(a) ? a : null;
  });
}

const present = (v: number | null): v is number => v !== null;

/**
 * Fills the grid from the responses. A candidate missing from its response, or present without an
 * affinity, is dropped (G2). A row's floor (PROBE consequence 2) is a tie at its own minimum, else
 * the floor of every row pooled, since one row may hold a single floor value (as crossDomain reads
 * it); so the same response gives the same unscored cells whatever other contexts share the call. A
 * floor score is never ranked, and a row with one scored candidate ranks nothing.
 */
export function fillGrid(
  candidates: readonly Candidate[],
  specs: readonly ContextSpec[],
  responses: readonly RowResponse[],
): ScoreGrid {
  const raw = specs.map((_, r) => {
    const res = responses[r];
    return res?.kind === "ok" ? scoresOf(candidates, res.entities) : null;
  });
  const pooled = detectFloor(raw.flatMap((row) => row?.filter(present) ?? []));

  const rows = specs.map((spec, r): GridRow => {
    const res: RowResponse = responses[r] ?? { kind: "gap", reason: spec.gap?.reason ?? "budget_truncated" };
    if (res.kind === "gap") {
      return {
        spec,
        meta: null,
        gap: res.reason,
        failure: res.failure ?? null,
        cells: candidates.map(() => ({ pct: null, rank: null, reason: res.reason })),
        affinity: candidates.map(() => null),
        scored: 0,
      };
    }
    const scores = raw[r] ?? scoresOf(candidates, res.entities);
    const floor = detectFloor(scores.filter(present)) ?? pooled;
    const reasons: (NoValueReason | null)[] = scores.map((s) => (s === null ? "dropped" : s === floor ? "not_scored" : null));
    const kept = scores.map((s, j) => (reasons[j] === null ? s : null));
    const n = kept.filter(present).length;
    if (n < MIN_RANKED) {
      return {
        spec,
        meta: res.meta,
        gap: null,
        failure: null,
        cells: kept.map((s, j) => ({ pct: null, rank: null, reason: s === null ? (reasons[j] ?? "dropped") : "insufficient_n" })),
        affinity: candidates.map(() => null),
        scored: 0,
      };
    }
    const { pct } = withinCallPercentiles(kept, null);
    const ranks = displayRanks(kept);
    return {
      spec,
      meta: res.meta,
      gap: null,
      failure: null,
      cells: kept.map((_, j) => ({ pct: pct[j] ?? null, rank: ranks[j] ?? null, reason: reasons[j] ?? null })),
      affinity: kept,
      scored: n,
    };
  });

  const all = rows.flatMap((row) => row.cells);
  const count = (reason: NoValueReason | null) => all.filter((c) => c.reason === reason).length;
  return {
    candidates,
    rows,
    cells: {
      total: all.length,
      scored: count(null),
      notScored: count("not_scored"),
      dropped: count("dropped"),
      lone: count("insufficient_n"),
      truncated: count("budget_truncated"),
      failed: count("error"),
      unavailable: count("unavailable"),
    },
  };
}

/** Gaps that explain a missing value before any cell's own reason does. */
const CALL_GAPS: readonly NoValueReason[] = ["budget_truncated", "error", "unavailable"];

/** The reason that explains a missing value best: a call gap first, else the first cell reason, else not_scored. */
export function missingReason(reasons: readonly (NoValueReason | null | undefined)[]): NoValueReason {
  return CALL_GAPS.find((g) => reasons.includes(g)) ?? reasons.find((r): r is NoValueReason => r !== null && r !== undefined) ?? "not_scored";
}

/** Percentiles of the candidates every compared row ranked, re-ranked inside each row over that set. */
export interface CommonRanks {
  /** Candidate indices ranked in every compared row; empty when fewer than MIN_RANKED are. */
  members: number[];
  /** Aligned with the rows, then the candidates: the re-ranked cell, or why the candidate is outside the set. */
  cells: GridCell[][];
}

/**
 * Differences between contexts (rank shift, TenantFit, slope deltas, youth tilt) compare percentiles
 * among the same candidates, so they read these: each row re-ranked over the candidates every row
 * that ranked anything scored. A re-rank inside one call equals a call over that set alone (G1
 * candidate-set invariance). A row that ranked nothing takes no part and keeps its own cells; a
 * candidate outside the set carries its own reason where it is unscored, and elsewhere the reason it
 * is missing from another row (as S10 does); when the set is too small every cell is insufficient_n.
 */
export function commonRanks(rows: readonly GridRow[], n: number): CommonRanks {
  const ranked = rows.filter((r) => r.scored > 0);
  const inAll = Array.from({ length: n }, (_, j) => j).filter((j) => ranked.every((r) => (r.cells[j]?.pct ?? null) !== null));
  const members = ranked.length > 0 && inAll.length >= MIN_RANKED ? inAll : [];
  const isMember = new Set(members);
  const outside = (j: number): NoValueReason =>
    ranked.map((r) => r.cells[j]?.reason ?? null).find((reason): reason is NoValueReason => reason !== null) ?? "insufficient_n";
  const cells = rows.map((row) => {
    if (row.scored === 0) return row.cells;
    const kept = row.affinity.map((a, j) => (isMember.has(j) ? a : null));
    const { pct } = withinCallPercentiles(kept, null);
    const ranks = displayRanks(kept);
    return row.cells.map((cell, j): GridCell => {
      if (isMember.has(j)) return { pct: pct[j] ?? null, rank: ranks[j] ?? null, reason: null };
      return { pct: null, rank: null, reason: cell.reason ?? outside(j) };
    });
  });
  return { members, cells };
}

/**
 * Makes the rank calls for every callable context. A call the budget refuses, or the Qloo client
 * fails after its own retries, becomes a gap in its row, so the other contexts still count. An
 * audience the client refuses (qloo_param: not on this desk's list, or a segment denied on every
 * desk, D21) was never sent, so its row is unavailable rather than failed; the failure is kept so
 * the flags and notices can say which.
 */
export async function scoreContexts(
  ctx: SkillCtx,
  type: EntityType,
  candidates: readonly Candidate[],
  specs: readonly ContextSpec[],
): Promise<ScoreGrid> {
  const filterType = entityTypeUrn(type);
  const ids = candidates.map((c) => c.entityId);
  const attempts = await attemptAllKeepingFailures(
    specs.map(({ signal }) => (signal === null ? null : () => ctx.qloo.insights(filterType, rankParams(signal, ids)))),
    ctx.signal,
  );
  const responses = specs.map((spec, r): RowResponse => {
    const a = attempts[r];
    if (a?.kind === "ok") return { kind: "ok", entities: a.value.data.results.entities, meta: a.value.meta };
    if (a?.kind === "failed") {
      const refused = a.code === "qloo_param" && spec.kind === "audience";
      return { kind: "gap", reason: refused ? "unavailable" : "error", failure: { code: a.code, error: a.error } };
    }
    if (a?.kind === "truncated") return { kind: "gap", reason: "budget_truncated" };
    return { kind: "gap", reason: spec.gap?.reason ?? "unavailable" };
  });
  return fillGrid(candidates, specs, responses);
}

/**
 * Network calls the contexts would cost now: identical requests count once and cached ones are free.
 * A context that only a missing seam kept from being built (a market or gazetteer area while
 * estimating) counts as one call.
 */
export async function estimateRankCalls(
  probe: CacheProbe,
  type: EntityType,
  candidateIds: readonly string[],
  specs: readonly ContextSpec[],
): Promise<number> {
  const filterType = entityTypeUrn(type);
  const requests = specs.map((s) => (s.signal === null ? null : { "filter.type": filterType, ...rankParams(s.signal, candidateIds) }));
  const pending = specs.filter((s) => s.signal === null && s.pending).length;
  return (await countUncached(probe, "/v2/insights", requests)) + pending;
}

/** The rows' calls, in context order. */
export function callsOf(rows: readonly GridRow[]): QlooCallMeta[] {
  return rows.flatMap((row) => (row.meta === null ? [] : [row.meta]));
}

/** "2 of 9 cells scored (1 dropped by Qloo, 1 tied at the floor, not scored)": a bundle's summary tail. */
export function cellSummary(rows: readonly GridRow[]): string {
  const cells = rows.flatMap((row) => row.cells);
  const n = (reason: NoValueReason | null) => cells.filter((c) => c.reason === reason).length;
  const parts = [
    n("not_scored") > 0 ? `${n("not_scored")} tied at the floor, not scored` : null,
    n("dropped") > 0 ? `${n("dropped")} dropped by Qloo` : null,
    n("insufficient_n") > 0 ? `${n("insufficient_n")} alone in a context, not ranked` : null,
    n("budget_truncated") > 0 ? `${n("budget_truncated")} not called (budget)` : null,
    n("error") > 0 ? `${n("error")} lost to failed calls` : null,
    n("unavailable") > 0 ? `${n("unavailable")} in contexts that could not be called` : null,
  ].filter((s) => s !== null);
  return `${n(null)} of ${cells.length} cells scored${parts.length > 0 ? ` (${parts.join(", ")})` : ""}`;
}
