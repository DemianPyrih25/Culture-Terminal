// The Reality Check's arithmetic (SPEC §6.6 item 3, eval/reality_cases.json "scoring"): the real
// choice's percentile among the candidates scored with it, the popularity-matched distractors drawn
// per case, and the chance that five random secondary markets include a booked one. Pure, so the
// same scores and pool always give the same result, and a rerun draws the same distractors.
import { createRng } from "@ct/quant";

/** Distractors per case beside the real choice and GHOST's picks (SPEC §6.6). */
export const DISTRACTORS = 5;
/** GHOST's picks that enter a case: its top five, in its own order. */
export const GHOST_TOP = 5;

/**
 * The fraction of the other scored candidates that `score` beats, a tie counting half: 1 when Qloo
 * scored the real choice above every other candidate, 0 below all of them, 0.5 the random
 * expectation. Null with no other scored candidate.
 */
export function percentileAmong(score: number, others: readonly number[]): number | null {
  if (others.length === 0) return null;
  let beats = 0;
  let ties = 0;
  for (const other of others) {
    if (score > other) beats += 1;
    else if (score === other) ties += 1;
  }
  return (beats + ties / 2) / others.length;
}

/** 1 + the candidates scored strictly higher: ties share the better rank. */
export function rankAmong(score: number, others: readonly number[]): number {
  return 1 + others.filter((other) => other > score).length;
}

/** A uniform draw in [0, 1) fixed by the case and the entry, so reruns order ties and draws alike. */
export function caseDraw(caseId: string, key: string): number {
  return createRng(`reality|${caseId}|${key}`)();
}

export interface PoolEntry {
  /** Entity id, market id or gazetteer area id: unique within one pool. */
  key: string;
  popularity: number | null;
}

/**
 * The `n` pool entries whose popularity is nearest `target`, never one in `exclude` (the real choice,
 * GHOST's picks, the seed). Equal distances are ordered by the case's draw. Entries without a
 * popularity cannot be matched and are left out; when the target itself has none, the `n` are a
 * draw from the whole pool instead, still fixed by the case id.
 */
export function popularityMatched<T extends PoolEntry>(
  caseId: string,
  target: number | null,
  pool: readonly T[],
  exclude: ReadonlySet<string>,
  n: number = DISTRACTORS,
): T[] {
  const seen = new Set<string>();
  const eligible = pool.filter((entry) => {
    if (exclude.has(entry.key) || seen.has(entry.key)) return false;
    seen.add(entry.key);
    return target === null || (entry.popularity !== null && Number.isFinite(entry.popularity));
  });
  const keyed = eligible.map((entry) => ({
    entry,
    distance: target === null ? 0 : Math.abs((entry.popularity ?? 0) - target),
    draw: caseDraw(caseId, entry.key),
  }));
  keyed.sort((a, b) => a.distance - b.distance || a.draw - b.draw || (a.entry.key < b.entry.key ? -1 : 1));
  return keyed.slice(0, Math.max(0, n)).map((k) => k.entry);
}

/**
 * The chance that `picks` markets drawn at random from `universe` include at least one of the
 * `booked` ones (hypergeometric): what a comedian case's GHOST hit is reported beside. Null for an
 * empty universe.
 */
export function hitChance(universe: number, booked: number, picks: number = GHOST_TOP): number | null {
  if (universe <= 0) return null;
  const k = Math.min(Math.max(0, picks), universe);
  const b = Math.min(Math.max(0, booked), universe);
  let missAll = 1;
  for (let i = 0; i < k; i++) missAll *= Math.max(0, universe - b - i) / (universe - i);
  return 1 - missAll;
}
