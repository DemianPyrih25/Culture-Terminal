import type {
  BlockFamily,
  EvidenceId,
  Flag,
  QlooCallMeta,
  QlooEntityInsightsResponse,
  QlooParams,
  QlooResult,
  QlooTagInsightsResponse,
  SkillCtx,
  SkillId,
  SkillStatus,
  NoValueReason,
} from "@ct/contracts";
import { addSkillEvidence, attemptAllKeepingFailures, type Attempt } from "../common";
import { BRAND_POPULARITY_MAX, BRAND_TAKE, MUSIC_TAG_TYPE, rankTagRows, TAG_TAKE, type RankedList } from "./fingerprint";
import type { BlockArea, LadderRung } from "./location";
import type { LadderStep } from "./outputs";

/**
 * The Qloo side of a tag fingerprint, shared by block_dna (an area or a whole city) and taste_twins:
 * the request builders, the location ladder walk and the evidence bookkeeping. The request builders
 * are the ones tools/dev/cli/warm-metros.ts pins the city sides with, so a skill that builds its city
 * requests here gets them from the cache.
 */

export const TAG = "urn:tag";
export const BRAND = "urn:entity:brand";
/** A call with fewer rows than this is a thin result (§6.4). */
export const THIN_ROWS = 5;
/** WHO, VIBE and WHAT share the unfiltered lists; SOUND has its own pair. */
export const LIST_FAMILIES: readonly BlockFamily[] = ["WHO", "VIBE", "WHAT"];
export const SOUND: readonly BlockFamily[] = ["SOUND"];
/** Client errors no other rung can fix: the key or the rate limit, not the location. They end the ladder. */
const LADDER_STOPPERS: ReadonlySet<string> = new Set(["qloo_auth", "qloo_rate_limited"]);

/** A fingerprint call: the whole list, or the music list for SOUND. No radius: G8 found it ignored. */
export function tagParams(location: QlooParams, music: boolean): QlooParams {
  return { ...location, ...(music ? { "filter.tag.types": [MUSIC_TAG_TYPE] } : {}), take: TAG_TAKE };
}

/** A local-brand call (G9): brands only, so filter.location is never sent (§5.1). */
export function brandParams(location: QlooParams): QlooParams {
  return { ...location, "filter.popularity.max": BRAND_POPULARITY_MAX, take: BRAND_TAKE };
}

/** The calls one side (area or city) makes, as the cache probe sees them (with filter.type). */
export function sideRequests(location: QlooParams, brands: boolean): QlooParams[] {
  return [
    { "filter.type": TAG, ...tagParams(location, false) },
    { "filter.type": TAG, ...tagParams(location, true) },
    ...(brands ? [{ "filter.type": BRAND, ...brandParams(location) }] : []),
  ];
}

/** Calls one side makes: the two tag lists, and the brand list when asked. */
export const sideCalls = (brands: boolean): number => 2 + (brands ? 1 : 0);

// Calls --------------------------------------------------------------------------------------------------

export type TagAttempt = Attempt<QlooResult<QlooTagInsightsResponse>>;
export type BrandAttempt = Attempt<QlooResult<QlooEntityInsightsResponse>>;
export type FormedRung = Extract<LadderRung, { params: QlooParams }>;

export interface Ladder {
  /** The rung that returned ranked family tags, with its answer; null when none did. */
  chosen: { rung: FormedRung; answer: QlooResult<QlooTagInsightsResponse> } | null;
  /** Rungs that answered with no ranked family tags: the receipts of the fallback. */
  empty: QlooCallMeta[];
  /** An empty rung held family tags, all tied at the floor (G1): its receipts are NOT_SCORED. */
  emptyUnscored: boolean;
  steps: LadderStep[];
  truncated: boolean;
  failures: { method: string; code: string; error: unknown }[];
}

/**
 * Walks the ladder one rung at a time: a rung that cannot be formed, fails in the Qloo client or
 * answers with no ranked family tags steps down (tags all tied at the floor bear no relation to the
 * location, G1). Unformed rungs fold into the next step's reason, so one step down is one CODE
 * FALLBACK. The budget, the key and the rate limit stop the walk: another rung would fail the same
 * way, so they are not fallbacks.
 */
export async function climbDown(ctx: SkillCtx, area: Pick<BlockArea, "rungs">): Promise<Ladder> {
  const out: Ladder = { chosen: null, empty: [], emptyUnscored: false, steps: [], truncated: false, failures: [] };
  let from: LadderRung["method"] | null = null;
  let reasons: string[] = [];
  for (const rung of area.rungs) {
    if (rung.params === null) {
      from ??= rung.method;
      reasons.push(rung.missing);
      continue;
    }
    if (from !== null) out.steps.push({ from, to: rung.method, reason: reasons.join("; ") });
    from = rung.method;
    reasons = [];
    const params = rung.params;
    const [attempt] = await attemptAllKeepingFailures([() => ctx.qloo.insights(TAG, tagParams(params, false))], ctx.signal);
    if (attempt === undefined || attempt.kind === "skipped") continue;
    if (attempt.kind === "truncated") {
      out.truncated = true;
      return out;
    }
    if (attempt.kind === "failed") {
      out.failures.push({ method: rung.method, code: attempt.code, error: attempt.error });
      if (LADDER_STOPPERS.has(attempt.code)) return out;
      reasons = [`the ${rung.method} call failed (${attempt.code})`];
      continue;
    }
    const list = rankTagRows(attempt.value.data.results.tags, LIST_FAMILIES);
    if (list.ranks.size > 0) {
      out.chosen = { rung: { ...rung, params }, answer: attempt.value };
      return out;
    }
    out.empty.push(attempt.value.meta);
    const tied = list.unscored.size > 0;
    if (tied) out.emptyUnscored = true;
    reasons = [tied ? `${rung.method} returned no ranked taste tags (all tied at the floor)` : `${rung.method} returned no taste tags`];
  }
  return out;
}

export const okValue = <T>(a: Attempt<T> | undefined): T | null => (a?.kind === "ok" ? a.value : null);

/** Why a list is missing: refused by the budget, lost to a failed call, or answered with nothing to rank. */
export function gapOf(attempt: Attempt<unknown> | undefined, list: RankedList | null): NoValueReason | null {
  if (attempt?.kind === "truncated") return "budget_truncated";
  if (attempt?.kind === "failed") return "error";
  return list === null || list.ranks.size === 0 ? "not_measured" : null;
}

export function metasOf(attempts: readonly (Attempt<{ meta: QlooCallMeta }> | undefined)[]): QlooCallMeta[] {
  return attempts.flatMap((a) => (a?.kind === "ok" ? [a.value.meta] : []));
}

export const rowsOf = (a: TagAttempt | undefined): number | null => (a?.kind === "ok" ? a.value.data.results.tags.length : null);
export const brandRowsOf = (a: BrandAttempt | undefined): number | null => (a?.kind === "ok" ? a.value.data.results.entities.length : null);

// Evidence -----------------------------------------------------------------------------------------------

export interface Bundle {
  purpose: string;
  calls: QlooCallMeta[];
  status: SkillStatus;
  summary: string;
  flags: Flag[];
  qualityGateDrops?: number;
}

/** What a bundle is recorded into: a run's flags and evidence ids. */
export interface EvidenceSink {
  ctx: SkillCtx;
  flags: Set<Flag>;
  evidenceIds: EvidenceId[];
}

export function addBundle(run: EvidenceSink, skill: SkillId, bundle: Bundle): EvidenceId | null {
  for (const f of bundle.flags) run.flags.add(f);
  const evidence = addSkillEvidence(run.ctx.ledger, { skill, ...bundle });
  if (evidence === null) return null;
  run.evidenceIds.push(evidence.id);
  return evidence.id;
}

/** THIN_RESULT, NOT_SCORED, STALE_CACHE and BUDGET_TRUNCATED for one bundle's calls. */
export function callFlags(rows: readonly (number | null)[], lists: readonly (RankedList | null)[], calls: readonly QlooCallMeta[], truncated: boolean): Flag[] {
  const flags: Flag[] = [];
  if (rows.some((n) => n !== null && n < THIN_ROWS)) flags.push("THIN_RESULT");
  if (lists.some((l) => l !== null && l.unscored.size > 0)) flags.push("NOT_SCORED");
  if (calls.some((c) => c.stale)) flags.push("STALE_CACHE");
  if (truncated) flags.push("BUDGET_TRUNCATED");
  return flags;
}

/** "1 music tag", "5 music tags": counts in evidence summaries a reader sees. */
export function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

export function tagSummary(list: RankedList | null, gap: NoValueReason | null, noun: string): string {
  if (list === null || gap === "budget_truncated" || gap === "error") return `${noun}s not measured (${gap ?? "not_measured"})`;
  const unscored = list.unscored.size > 0 ? `, ${list.unscored.size} tied at the floor and not ranked` : "";
  return `${count(list.ranks.size, noun)}${unscored}`;
}

export function familyCounts(list: RankedList): string {
  const counts = LIST_FAMILIES.map((f) => `${f} ${[...list.items.values()].filter((i) => i.family === f).length}`);
  return counts.join(", ");
}
