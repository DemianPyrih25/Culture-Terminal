import {
  ANALYST_TOOLS,
  METRO_LABEL,
  type BlockFamily,
  type CacheProbe,
  type DigestRow,
  type EvidenceId,
  type Flag,
  type LocalityApi,
  type NoValueReason,
  type QlooCallMeta,
  type QlooEntity,
  type QlooEntityInsightsResponse,
  type QlooParams,
  type QlooResult,
  type QlooTagInsightsResponse,
  type SkillCtx,
  type SkillFor,
  type SkillResult,
  type SkillStatus,
  type ToolInput,
} from "@ct/contracts";
import { SKILL_LIMITATIONS } from "../limitations";
import { addSkillEvidence, attemptAllKeepingFailures, countUncached, type Attempt } from "./common";
import { skillErrorResult, skillResult, type DigestTarget } from "./digest";
import { safeName } from "./format";
import {
  BRAND_POPULARITY_MAX,
  BRAND_TAKE,
  compareLists,
  MUSIC_TAG_TYPE,
  NEW_AREA_TOP,
  rankBrandRows,
  rankTagRows,
  TAG_TAKE,
  type RankedList,
} from "./blockDna/fingerprint";
import {
  cityLocation,
  distanceKm,
  MAX_POINT_KM,
  parsePoint,
  pointAreaLocation,
  resolveArea,
  type BlockArea,
  type LadderRung,
} from "./blockDna/location";
import {
  addBlockDnaBars,
  addBrandMetrics,
  addEmptyAreaFinding,
  addEmptyBrandsFinding,
  addFamilyMetrics,
  addLocalBrandsTable,
  addNewTagsFinding,
  blockDigestRows,
  localBrands,
  methodNotice,
  recordFallbacks,
  tenantNotice,
  type BlockFrame,
  type BlockRun,
  type BrandResult,
  type FamilyResult,
  type LadderStep,
} from "./blockDna/outputs";
import { METRO_CENTRES, metroReachKm } from "./metros";

/**
 * S7 block_dna, Block DNA (SPEC §5.3 S7; PROBE consequences 3 and 6): the area's urn:tag fingerprint
 * against the whole city's, by rank. The area is read down the ladder POLYGON → POINT → QUERY (each
 * step a CODE FALLBACK); the city is the metro's pinned Qloo locality. WHO, VIBE and WHAT compare the
 * unfiltered top-50 lists and SOUND compares the two genre:music lists, since the city list holds
 * almost no music. With include_brands the same rank gain on brands under the G9 popularity cap gives
 * the local brands that tenant fit ranks.
 */

type BlockInput = ToolInput<"block_dna">;

const TAG = "urn:tag";
const BRAND = "urn:entity:brand";
/** A call with fewer rows than this is a thin result (§6.4). */
const THIN_ROWS = 5;
/** WHO, VIBE and WHAT share the unfiltered lists; SOUND has its own pair. */
const LIST_FAMILIES: readonly BlockFamily[] = ["WHO", "VIBE", "WHAT"];
const SOUND: readonly BlockFamily[] = ["SOUND"];
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
function sideRequests(location: QlooParams, brands: boolean): QlooParams[] {
  return [
    { "filter.type": TAG, ...tagParams(location, false) },
    { "filter.type": TAG, ...tagParams(location, true) },
    ...(brands ? [{ "filter.type": BRAND, ...brandParams(location) }] : []),
  ];
}

/** Calls one side makes: the two tag lists, and the brand list when asked. */
const sideCalls = (brands: boolean): number => 2 + (brands ? 1 : 0);

/**
 * Network calls a block_dna input would cost now. The city side is probed on the metro's pinned
 * locality (pinned in the cache, so usually free); without the locality pins (`localities` null) it
 * counts as uncached, and for a metro with no pin the run makes no city calls and no area brand call.
 * A point area's first rung is probed too. A neighbourhood's rungs come from the gazetteer, which
 * estimateCalls does not get, so its area calls count as network calls: an upper bound when they are
 * cached, and fallbacks down the ladder are not foreseen.
 */
export async function estimateBlockDnaCalls(input: BlockInput, probe: CacheProbe, localities: LocalityApi | null): Promise<number> {
  const { area } = input;
  // Without the gazetteer a far point may still lie in the map city (resolveArea decides), so only a
  // point beyond the metro's whole reach is known to cost nothing; a refused point is over-counted.
  if (area.kind === "point" && !(distanceKm(parsePoint(area.ref), METRO_CENTRES[area.metro]) <= metroReachKm(area.metro, MAX_POINT_KM))) return 0;
  const locality = localities === null ? undefined : await localities.market(area.metro);
  const brands = input.include_brands && locality !== null;
  const areaLocation = area.kind === "point" ? pointAreaLocation(area) : null;
  const requests = [
    ...(locality === undefined || locality === null ? [] : sideRequests(cityLocation(locality), brands)),
    ...(areaLocation === null ? [] : sideRequests(areaLocation, brands)),
  ];
  const probed = await countUncached(probe, "/v2/insights", requests);
  return probed + (locality === undefined ? sideCalls(brands) : 0) + (areaLocation === null ? sideCalls(brands) : 0);
}

// Calls --------------------------------------------------------------------------------------------------

type TagAttempt = Attempt<QlooResult<QlooTagInsightsResponse>>;
type BrandAttempt = Attempt<QlooResult<QlooEntityInsightsResponse>>;
type FormedRung = Extract<LadderRung, { params: QlooParams }>;

interface Ladder {
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
async function climbDown(ctx: SkillCtx, area: BlockArea): Promise<Ladder> {
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

const okValue = <T>(a: Attempt<T> | undefined): T | null => (a?.kind === "ok" ? a.value : null);

/** Why a list is missing: refused by the budget, lost to a failed call, or answered with nothing to rank. */
function gapOf(attempt: Attempt<unknown> | undefined, list: RankedList | null): NoValueReason | null {
  if (attempt?.kind === "truncated") return "budget_truncated";
  if (attempt?.kind === "failed") return "error";
  return list === null || list.ranks.size === 0 ? "not_measured" : null;
}

function metasOf(attempts: readonly (Attempt<{ meta: QlooCallMeta }> | undefined)[]): QlooCallMeta[] {
  return attempts.flatMap((a) => (a?.kind === "ok" ? [a.value.meta] : []));
}

// Evidence -----------------------------------------------------------------------------------------------

interface Bundle {
  purpose: string;
  calls: QlooCallMeta[];
  status: SkillStatus;
  summary: string;
  flags: Flag[];
  qualityGateDrops?: number;
}

function addBundle(run: BlockRun, bundle: Bundle): EvidenceId | null {
  for (const f of bundle.flags) run.flags.add(f);
  const evidence = addSkillEvidence(run.ctx.ledger, { skill: "block_dna", ...bundle });
  if (evidence === null) return null;
  run.evidenceIds.push(evidence.id);
  return evidence.id;
}

/** THIN_RESULT, NOT_SCORED, STALE_CACHE and BUDGET_TRUNCATED for one bundle's calls. */
function callFlags(rows: readonly (number | null)[], lists: readonly (RankedList | null)[], calls: readonly QlooCallMeta[], truncated: boolean): Flag[] {
  const flags: Flag[] = [];
  if (rows.some((n) => n !== null && n < THIN_ROWS)) flags.push("THIN_RESULT");
  if (lists.some((l) => l !== null && l.unscored.size > 0)) flags.push("NOT_SCORED");
  if (calls.some((c) => c.stale)) flags.push("STALE_CACHE");
  if (truncated) flags.push("BUDGET_TRUNCATED");
  return flags;
}

const rowsOf = (a: TagAttempt | undefined): number | null => (a?.kind === "ok" ? a.value.data.results.tags.length : null);
const brandRowsOf = (a: BrandAttempt | undefined): number | null => (a?.kind === "ok" ? a.value.data.results.entities.length : null);

/** "1 music tag", "5 music tags": counts in evidence summaries a reader sees. */
function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function tagSummary(list: RankedList | null, gap: NoValueReason | null, noun: string): string {
  if (list === null || gap === "budget_truncated" || gap === "error") return `${noun}s not measured (${gap ?? "not_measured"})`;
  const unscored = list.unscored.size > 0 ? `, ${list.unscored.size} tied at the floor and not ranked` : "";
  return `${count(list.ranks.size, noun)}${unscored}`;
}

function familyCounts(list: RankedList): string {
  const counts = LIST_FAMILIES.map((f) => `${f} ${[...list.items.values()].filter((i) => i.family === f).length}`);
  return counts.join(", ");
}

// Run ----------------------------------------------------------------------------------------------------

function finish(run: BlockRun, out: DigestTarget, status: SkillStatus, rows: readonly DigestRow[]): SkillResult {
  return skillResult(
    {
      status,
      evidenceIds: run.evidenceIds,
      datasetIds: run.datasetIds,
      metrics: run.metrics,
      rows,
      findings: run.findings,
      flags: run.flags,
      registered: run.registered,
      notices: run.notices,
    },
    out,
  );
}

/** The ladder's answered-but-empty rungs: receipts for the fallback, kept apart so they are not charged as thin results. */
function recordLadder(run: BlockRun, area: BlockArea, ladder: Ladder): void {
  if (ladder.empty.length === 0) return;
  addBundle(run, {
    purpose: `Location ladder for ${safeName(area.name)}: rungs that returned no ranked taste tags`,
    calls: ladder.empty,
    status: "empty",
    summary: `${count(ladder.empty.length, "location rung")} returned no ranked taste tags, so the ladder stepped down.`,
    flags: [...(ladder.steps.length > 0 ? (["LOCATION_FALLBACK"] as const) : []), ...(ladder.emptyUnscored ? (["NOT_SCORED"] as const) : [])],
  });
}

/**
 * No rung returned ranked tags: a budget-truncated fingerprint, an empty one (every rung that could
 * be formed answered with nothing to rank), or a partial one when a rung failed and might have held
 * the tags, so the area is not called empty.
 */
function finishWithoutArea(run: BlockRun, out: DigestTarget, frame: BlockFrame, ladder: Ladder): SkillResult {
  recordLadder(run, frame.area, ladder);
  recordFallbacks(run, frame.area, ladder.steps);
  if (ladder.steps.length > 0) run.flags.add("LOCATION_FALLBACK");
  if (ladder.truncated) {
    run.flags.add("BUDGET_TRUNCATED");
    run.notices.push(`The call budget ran out before ${safeName(frame.area.name)} could be read; nothing was measured.`);
    return finish(run, out, "partial", []);
  }
  if (ladder.failures.length === 0) {
    addEmptyAreaFinding(run, frame);
    return finish(run, out, "empty", []);
  }
  const codes = [...new Set(ladder.failures.map((f) => f.code))].join(", ");
  run.notices.push(
    `${count(ladder.failures.length, "location call")} failed (${codes}) and the rest returned no ranked taste tags, so nothing was measured; ` +
      `retry block_dna on ${safeName(frame.area.name)} later.`,
  );
  return finish(run, out, "partial", []);
}

async function runBlockDna(input: BlockInput, ctx: SkillCtx): Promise<SkillResult> {
  const out: DigestTarget = { tool: "block_dna", step: input.step_id };
  const resolved = resolveArea(input.area, ctx.geo);
  if (!resolved.ok) return skillErrorResult(out, resolved.message);
  const area = resolved.area;
  const run: BlockRun = {
    ctx,
    flags: new Set(),
    evidenceIds: [],
    metrics: [],
    findings: [],
    datasetIds: [],
    registered: [],
    notices: [...area.notices],
  };

  // The city: the metro's pinned locality, or none, and then no city side is measured.
  const locality = (await ctx.localities?.market(area.metro)) ?? null;
  const city = locality === null ? null : cityLocation(locality);
  const noCity: NoValueReason | null = city === null ? "unavailable" : null;

  // The area, down the ladder.
  const ladder = await climbDown(ctx, area);
  const firstRung = area.rungs.find((r) => r.params !== null)?.method ?? "QUERY";
  if (ladder.chosen === null) {
    const last = ladder.failures.at(-1);
    // With nothing answered there is no evidence to keep: the error goes to the caller.
    if (last !== undefined && ladder.empty.length === 0 && !ladder.truncated) throw last.error;
    return finishWithoutArea(run, out, { area, method: ladder.steps.at(-1)?.to ?? firstRung }, ladder);
  }
  const { rung, answer } = ladder.chosen;
  const frame: BlockFrame = { area, method: rung.method };
  // Each step down reaches the trace before the follow-on calls go out.
  recordFallbacks(run, area, ladder.steps);

  // The rest in parallel: the area's music list, the city's two lists, and the brand pair. Without a
  // city side the area brands are not fetched either: nothing could rank them against the city.
  const [tagAttempts, brandAttempts] = await Promise.all([
    attemptAllKeepingFailures(
      [
        () => ctx.qloo.insights(TAG, tagParams(rung.params, true)),
        ...(city === null ? [] : [() => ctx.qloo.insights(TAG, tagParams(city, false)), () => ctx.qloo.insights(TAG, tagParams(city, true))]),
      ],
      ctx.signal,
    ),
    attemptAllKeepingFailures(
      input.include_brands && city !== null
        ? [() => ctx.qloo.insights(BRAND, brandParams(rung.params)), () => ctx.qloo.insights(BRAND, brandParams(city))]
        : [],
      ctx.signal,
    ),
  ]);
  const [areaMusicA, cityTagsA, cityMusicA] = tagAttempts;
  const [areaBrandsA, cityBrandsA] = brandAttempts;

  // Ranks.
  const areaTags = rankTagRows(answer.data.results.tags, LIST_FAMILIES);
  const areaMusicData = okValue(areaMusicA);
  const areaMusic = areaMusicData === null ? null : rankTagRows(areaMusicData.data.results.tags, SOUND);
  const cityTagsData = okValue(cityTagsA);
  const cityTags = cityTagsData === null ? null : rankTagRows(cityTagsData.data.results.tags, LIST_FAMILIES);
  const cityMusicData = okValue(cityMusicA);
  const cityMusic = cityMusicData === null ? null : rankTagRows(cityMusicData.data.results.tags, SOUND);
  const cityGap = noCity ?? gapOf(cityTagsA, cityTags);
  const cityMusicGap = noCity ?? gapOf(cityMusicA, cityMusic);
  // An area music list with nothing to rank is not measured: compared with it, every city music tag
  // would read as a loss by construction.
  const areaMusicGap = gapOf(areaMusicA, areaMusic);

  // Evidence.
  recordLadder(run, area, ladder);
  const areaCalls = [answer.meta, ...metasOf([areaMusicA])];
  const areaE = addBundle(run, {
    purpose: `Tag fingerprint of ${safeName(area.name)} by ${rung.method}`,
    calls: areaCalls,
    status: areaMusicA?.kind === "ok" ? "ok" : "partial",
    summary:
      `${rung.method}: ${tagSummary(areaTags, null, "taste tag")} (${familyCounts(areaTags)}); ` +
      `${tagSummary(areaMusic, areaMusicGap, "music tag")}.`,
    flags: [
      ...callFlags([answer.data.results.tags.length, rowsOf(areaMusicA)], [areaTags, areaMusic], areaCalls, areaMusicA?.kind === "truncated"),
      ...(ladder.steps.length > 0 ? (["LOCATION_FALLBACK"] as const) : []),
    ],
  });
  const cityCalls = metasOf([cityTagsA, cityMusicA]);
  const cityName = METRO_LABEL[area.metro];
  const cityE =
    city === null
      ? null
      : addBundle(run, {
          purpose: `City tag fingerprint of ${cityName} (Qloo locality)`,
          calls: cityCalls,
          status: cityGap === null && cityMusicGap === null ? "ok" : cityCalls.length === 0 ? "empty" : "partial",
          summary: `${tagSummary(cityTags, cityGap, "taste tag")}; ${tagSummary(cityMusic, cityMusicGap, "music tag")}.`,
          flags: callFlags(
            [rowsOf(cityTagsA), rowsOf(cityMusicA)],
            [cityTags, cityMusic],
            cityCalls,
            cityTagsA?.kind === "truncated" || cityMusicA?.kind === "truncated",
          ),
        });
  const tagEvidence = [areaE, cityE].filter((e): e is EvidenceId => e !== null);

  // Families.
  const listCompared = compareLists(areaTags, cityGap === null ? cityTags : null, TAG_TAKE + 1, NEW_AREA_TOP);
  const families: FamilyResult[] = LIST_FAMILIES.map((family) => ({
    family,
    items: listCompared.filter((c) => c.item.family === family),
    gap: cityGap,
    areaSize: areaTags.ranks.size,
    evidenceIds: tagEvidence,
  }));
  families.push({
    family: "SOUND",
    items: areaMusic === null || areaMusicGap !== null ? [] : compareLists(areaMusic, cityMusicGap === null ? cityMusic : null, TAG_TAKE + 1, NEW_AREA_TOP),
    gap: areaMusicGap ?? cityMusicGap,
    areaSize: areaMusic?.ranks.size ?? 0,
    evidenceIds: tagEvidence,
  });

  // Brands.
  let brands: BrandResult | null = null;
  let noLocalBrands = false;
  if (input.include_brands && noCity !== null) {
    brands = { items: null, gap: noCity, raw: new Map(), areaSize: 0, evidenceIds: [] };
  } else if (input.include_brands) {
    const areaData = okValue(areaBrandsA);
    const cityData = okValue(cityBrandsA);
    const areaList = areaData === null ? null : rankBrandRows(areaData.data.results.entities);
    const cityList = cityData === null ? null : rankBrandRows(cityData.data.results.entities);
    const brandCalls = metasOf([areaBrandsA, cityBrandsA]);
    const gateDropped = (areaList?.gateDropped ?? 0) + (cityList?.gateDropped ?? 0);
    const areaGap = gapOf(areaBrandsA, areaList);
    const cityBrandGap = gapOf(cityBrandsA, cityList);
    const flags = callFlags(
      [brandRowsOf(areaBrandsA), brandRowsOf(cityBrandsA)],
      [areaList, cityList],
      brandCalls,
      areaBrandsA?.kind === "truncated" || cityBrandsA?.kind === "truncated",
    );
    if (gateDropped > 0) flags.push("QUALITY_GATE_DROPPED");
    const brandE = addBundle(run, {
      purpose: `Local brands of ${safeName(area.name)} against ${cityName} (popularity up to ${BRAND_POPULARITY_MAX})`,
      calls: brandCalls,
      status: areaGap === null && cityBrandGap === null ? "ok" : areaBrandsA?.kind === "ok" && areaGap === "not_measured" ? "empty" : "partial",
      summary:
        `${areaList?.ranks.size ?? 0} area and ${cityList?.ranks.size ?? 0} city brands ranked` +
        `${gateDropped > 0 ? `, ${gateDropped} below the popularity quality gate skipped` : ""}.`,
      flags,
      qualityGateDrops: gateDropped,
    });
    noLocalBrands = areaBrandsA?.kind === "ok" && areaGap === "not_measured";
    const raw = new Map<string, QlooEntity>((areaData?.data.results.entities ?? []).map((e) => [e.entity_id, e]));
    brands = {
      items: areaList !== null && areaGap === null && cityList !== null && cityBrandGap === null ? compareLists(areaList, cityList, BRAND_TAKE + 1, null) : null,
      gap: areaGap ?? cityBrandGap,
      raw,
      areaSize: areaList?.ranks.size ?? 0,
      evidenceIds: brandE === null ? [] : [brandE],
    };
  }

  // Ledger output.
  const familyMetrics = families.map((fam) => addFamilyMetrics(run, frame, fam));
  const brandMetrics = brands === null ? [] : addBrandMetrics(run, frame, brands);
  addNewTagsFinding(run, frame, families, familyMetrics);
  if (noLocalBrands) addEmptyBrandsFinding(run, frame);
  addBlockDnaBars(run, frame, families, familyMetrics, tagEvidence);
  if (brands !== null) addLocalBrandsTable(run, frame, brands, brandMetrics);

  // Notices.
  run.notices.push(methodNotice(area, rung.method, city !== null));
  if (city === null) run.notices.push(`No Qloo locality is pinned for ${cityName} yet; the city side is not measured.`);
  else if (cityGap !== null) run.notices.push(`WHO, VIBE and WHAT are not compared: the ${cityName} tag list is missing (${cityGap}).`);
  if (areaMusicA?.kind === "ok" && areaMusicGap !== null) run.notices.push("No music tags came back for this area, so SOUND is not measured.");
  else if (areaMusicGap !== null) run.notices.push(`SOUND is not measured: the area's music list is missing (${areaMusicGap}).`);
  else if (city !== null && cityMusicGap !== null) run.notices.push(`SOUND is not measured at city scale (${cityMusicGap}).`);
  if (brands !== null && brands.items !== null && localBrands(brands).length === 0) {
    run.notices.push(`No brand ranks higher here than across ${cityName}.`);
  }
  const failed = [...tagAttempts, ...brandAttempts].filter((a) => a?.kind === "failed");
  if (failed.length > 0) {
    const codes = [...new Set(failed.map((a) => (a.kind === "failed" ? a.code : "")))].join(", ");
    run.notices.push(`${failed.length} of ${tagAttempts.length + brandAttempts.length} follow-on calls failed (${codes}); what they measure is shown as not measured.`);
  }
  const tenant = tenantNotice(brandMetrics);
  if (tenant !== null) run.notices.push(tenant);

  const partial =
    [...tagAttempts, ...brandAttempts].some((a) => a?.kind !== "ok") || families.some((f) => f.gap !== null) || (brands?.gap ?? null) !== null;
  return finish(run, out, partial ? "partial" : "ok", blockDigestRows(familyMetrics, brandMetrics));
}

export const blockDnaSkill: SkillFor<"block_dna"> = {
  id: "block_dna",
  mnemonic: "BLOCK",
  kitWorkflows: ANALYST_TOOLS.block_dna.kitWorkflows,
  input: ANALYST_TOOLS.block_dna.input,
  // Without the locality pins in `env` the city side counts as uncached: the upper bound.
  estimateCalls: (input, probe, _registry, env) => estimateBlockDnaCalls(input, probe, env?.localities ?? null),
  run: runBlockDna,
  // The method bullets only: buildLimitations writes each raised flag's sentence from FLAG_TEXT.
  limitations: () => [...SKILL_LIMITATIONS.block_dna],
};
