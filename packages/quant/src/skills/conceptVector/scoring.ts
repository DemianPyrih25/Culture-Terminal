import type { QlooEntity } from "@ct/contracts";
import { competitionRanks, detectFloor } from "../../stats";
import { passesQualityGate } from "../peerSelection";

/**
 * Concept Vector arithmetic (SPEC S12, FORMULAS cnpt.s50, cnpt.verdict, cnpt.precision). The open
 * call gives the anchor (its 50th scored result) and the ADD list; the scoring call holds the
 * analogs, the anchor and the top result, so every verdict compares scores inside one call (V6).
 */

/** The open call's take: the anchor is its 50th result. */
export const OPEN_TAKE = 50;
/** ADD lists at most this many of the concept's top results. */
export const MAX_ADDS = 5;

export interface OpenRow {
  entity: QlooEntity;
  /** Competition rank by affinity among the scored, gated, non-floor rows (1 = top). */
  rank: number;
}

export interface OpenRead {
  /** Scored rows, best first. */
  ranked: OpenRow[];
  /** The 50th ranked row, or the last when fewer came back; null when none is scored. */
  anchor: OpenRow | null;
  top: OpenRow | null;
  /** Rows dropped by the quality gate. */
  gateDropped: number;
  /** Rows without an affinity or tied at the floor: present, not ranked. */
  unscored: number;
  rows: number;
}

const affinityOf = (e: QlooEntity): number | null => {
  const a = e.query?.affinity;
  return typeof a === "number" && Number.isFinite(a) ? a : null;
};

/** The open call by affinity, never by row order; floor ties and gated rows are not ranked. */
export function readOpenCall(rows: readonly QlooEntity[]): OpenRead {
  const seen = new Set<string>();
  const unique = rows.filter((r) => (seen.has(r.entity_id) ? false : (seen.add(r.entity_id), true)));
  const gated = unique.filter(passesQualityGate);
  const scored = gated.filter((r) => affinityOf(r) !== null);
  const floor = detectFloor(scored.map((r) => affinityOf(r) as number));
  const live = scored.filter((r) => affinityOf(r) !== floor);
  const ranks = competitionRanks(
    live.map((r) => affinityOf(r) as number),
    "desc",
  );
  const ranked = live
    .map((entity, i) => ({ entity, rank: ranks[i] as number }))
    .sort((a, b) => a.rank - b.rank || (a.entity.entity_id < b.entity.entity_id ? -1 : 1));
  return {
    ranked,
    anchor: ranked[Math.min(OPEN_TAKE, ranked.length) - 1] ?? null,
    top: ranked[0] ?? null,
    gateDropped: unique.length - gated.length,
    unscored: gated.length - live.length,
    rows: rows.length,
  };
}

export type Verdict = "KEEP" | "VETO" | "NOT_SCORED";

export interface AnalogVerdict {
  entityId: string;
  verdict: Verdict;
  /** Analog affinity minus the anchor's, both from the scoring call; null when not scored. */
  margin: number | null;
  /** Why an analog is not scored, in words. */
  why: string | null;
}

export interface ScoringRead {
  verdicts: AnalogVerdict[];
  /** Why no analog could be judged (anchor missing or the call's order contradicts the open call); null when judged. */
  blocked: string | null;
}

/**
 * KEEP when an analog scores at least the anchor in the scoring call, VETO when below. An analog
 * missing from the answer, without a score, or at the call's floor is not scored, never a VETO. The
 * anchor must be scored in the call, and the top open result must not score below it: otherwise the
 * call does not reproduce the open ranking and no analog is judged.
 */
export function judgeAnalogs(analogIds: readonly string[], anchorId: string, topId: string | null, rows: readonly QlooEntity[], openFloor: number | null): ScoringRead {
  const byId = new Map(rows.map((r) => [r.entity_id, affinityOf(r)]));
  const values = [...byId.values()].filter((v): v is number => v !== null);
  const floor = detectFloor(openFloor === null ? values : [...values, openFloor, openFloor]);
  const scoreOf = (id: string): number | null => {
    const v = byId.get(id) ?? null;
    return v === null || v === floor ? null : v;
  };
  const anchor = scoreOf(anchorId);
  const notScored = (why: string) => analogIds.map((entityId): AnalogVerdict => ({ entityId, verdict: "NOT_SCORED", margin: null, why }));
  if (anchor === null) {
    const blocked = "the concept's 50th result has no score in the scoring call, so there is no bar to compare with";
    return { verdicts: notScored(blocked), blocked };
  }
  const top = topId === null ? null : scoreOf(topId);
  if (topId !== null && topId !== anchorId && (top === null || top < anchor)) {
    const blocked = "the scoring call did not reproduce the open call's order (its top result scored below the anchor)";
    return { verdicts: notScored(blocked), blocked };
  }
  return {
    blocked: null,
    verdicts: analogIds.map((entityId): AnalogVerdict => {
      if (!byId.has(entityId)) return { entityId, verdict: "NOT_SCORED", margin: null, why: "Qloo did not return it in the scoring call" };
      const v = scoreOf(entityId);
      if (v === null) return { entityId, verdict: "NOT_SCORED", margin: null, why: "Qloo has no measurable score for it under these tags" };
      return { entityId, verdict: v >= anchor ? "KEEP" : "VETO", margin: v - anchor, why: null };
    }),
  };
}

/** KEEP / (KEEP + VETO); null when no analog was judged. */
export function analogPrecision(verdicts: readonly AnalogVerdict[]): { keep: number; veto: number; precision: number | null } {
  const keep = verdicts.filter((v) => v.verdict === "KEEP").length;
  const veto = verdicts.filter((v) => v.verdict === "VETO").length;
  return { keep, veto, precision: keep + veto === 0 ? null : keep / (keep + veto) };
}

/** The open call's best results that are not among the analogs: what Qloo adds. */
export function addsOf(open: OpenRead, analogIds: ReadonlySet<string>, n = MAX_ADDS): OpenRow[] {
  return open.ranked.filter((r) => !analogIds.has(r.entity.entity_id)).slice(0, n);
}

/** The floor value of the open call, if its rows hold one: it marks floor scores in the scoring call too. */
export function openFloor(rows: readonly QlooEntity[]): number | null {
  return detectFloor(rows.filter(passesQualityGate).flatMap((r) => (affinityOf(r) === null ? [] : [affinityOf(r) as number])));
}
