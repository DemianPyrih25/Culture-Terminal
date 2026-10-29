import {
  ANALYST_TOOLS,
  METRO_LABEL,
  type CacheProbe,
  type EvidenceId,
  type LocalityApi,
  type NoValueReason,
  type QlooEntity,
  type SkillCtx,
  type SkillFor,
  type SkillResult,
  type ToolInput,
} from "@ct/contracts";
import { SKILL_LIMITATIONS } from "../limitations";
import { attemptAllKeepingFailures, countUncached } from "./common";
import { skillErrorResult, type DigestTarget } from "./digest";
import { safeName } from "./format";
import {
  addBundle,
  BRAND,
  brandParams,
  brandRowsOf,
  callFlags,
  climbDown,
  count,
  familyCounts,
  gapOf,
  LIST_FAMILIES,
  metasOf,
  okValue,
  rowsOf,
  sideCalls,
  sideRequests,
  SOUND,
  TAG,
  tagParams,
  tagSummary,
  type Bundle,
  type Ladder,
} from "./blockDna/calls";
import { estimateCityCalls, runCityFingerprint } from "./blockDna/city";
import { BRAND_POPULARITY_MAX, BRAND_TAKE, compareLists, NEW_AREA_TOP, rankBrandRows, rankTagRows, TAG_TAKE } from "./blockDna/fingerprint";
import { cityLocation, distanceKm, MAX_POINT_KM, parsePoint, pointAreaLocation, resolveArea, type BlockArea } from "./blockDna/location";
import {
  addAreaConceptMetrics,
  addBlockDnaBars,
  addBrandMetrics,
  addEmptyAreaFinding,
  addEmptyBrandsFinding,
  addFamilyMetrics,
  addLocalBrandsTable,
  addNewTagsFinding,
  blockDigestRows,
  cityBase,
  conceptTagsOf,
  finishBlockRun,
  localBrands,
  methodNotice,
  recordFallbacks,
  tenantNotice,
  type BlockFrame,
  type BlockRun,
  type BrandResult,
  type FamilyResult,
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
type NbhdOrPoint = Exclude<BlockInput["area"], { kind: "city" }>;

// The request builders live in blockDna/calls.ts with the ladder; warm-metros and the tests import them from here.
export { brandParams, tagParams } from "./blockDna/calls";

/**
 * Network calls a block_dna input would cost now. The city side is probed on the metro's pinned
 * locality (pinned in the cache, so usually free); without the locality pins (`localities` null) it
 * counts as uncached, and for a metro with no pin the run makes no city calls and no area brand call.
 * A point area's first rung is probed too. A neighbourhood's rungs come from the gazetteer, which
 * estimateCalls does not get, so its area calls count as network calls: an upper bound when they are
 * cached, and fallbacks down the ladder are not foreseen. A whole city reads its own lists and the
 * map-city panel's (estimateCityCalls).
 */
export async function estimateBlockDnaCalls(input: BlockInput, probe: CacheProbe, localities: LocalityApi | null): Promise<number> {
  const { area } = input;
  if (area.kind === "city") return estimateCityCalls(area.market, input.include_brands, probe, localities);
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

const addBlockBundle = (run: BlockRun, bundle: Bundle): EvidenceId | null => addBundle(run, "block_dna", bundle);

// Run ----------------------------------------------------------------------------------------------------

const finish = finishBlockRun;

/** The ladder's answered-but-empty rungs: receipts for the fallback, kept apart so they are not charged as thin results. */
function recordLadder(run: BlockRun, area: Pick<BlockArea, "name">, ladder: Ladder): void {
  if (ladder.empty.length === 0) return;
  addBlockBundle(run, {
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
  if (input.area.kind === "city") return runCityFingerprint({ ...input, area: input.area }, ctx);
  return runAreaFingerprint({ ...input, area: input.area }, ctx);
}

async function runAreaFingerprint(input: BlockInput & { area: NbhdOrPoint }, ctx: SkillCtx): Promise<SkillResult> {
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
    return finishWithoutArea(run, out, { area, method: ladder.steps.at(-1)?.to ?? firstRung, base: cityBase(area.metro) }, ladder);
  }
  const { rung, answer } = ladder.chosen;
  const frame: BlockFrame = { area, method: rung.method, base: cityBase(area.metro) };
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
  const areaE = addBlockBundle(run, {
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
      : addBlockBundle(run, {
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
  let brandInstitutions = 0;
  if (input.include_brands && noCity !== null) {
    brands = { items: null, gap: noCity, raw: new Map(), areaSize: 0, evidenceIds: [] };
  } else if (input.include_brands) {
    const areaData = okValue(areaBrandsA);
    const cityData = okValue(cityBrandsA);
    const areaList = areaData === null ? null : rankBrandRows(areaData.data.results.entities);
    const cityList = cityData === null ? null : rankBrandRows(cityData.data.results.entities);
    const brandCalls = metasOf([areaBrandsA, cityBrandsA]);
    const gateDropped = (areaList?.gateDropped ?? 0) + (cityList?.gateDropped ?? 0);
    brandInstitutions = areaList?.institutions ?? 0;
    const areaGap = gapOf(areaBrandsA, areaList);
    const cityBrandGap = gapOf(cityBrandsA, cityList);
    const flags = callFlags(
      [brandRowsOf(areaBrandsA), brandRowsOf(cityBrandsA)],
      [areaList, cityList],
      brandCalls,
      areaBrandsA?.kind === "truncated" || cityBrandsA?.kind === "truncated",
    );
    if (gateDropped > 0) flags.push("QUALITY_GATE_DROPPED");
    const brandE = addBlockBundle(run, {
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
  addAreaConceptMetrics(run, frame, conceptTagsOf(run, input.concept_tags), families);
  const brandMetrics = brands === null ? [] : addBrandMetrics(run, frame, brands);
  addNewTagsFinding(run, frame, families, familyMetrics);
  if (noLocalBrands) addEmptyBrandsFinding(run, frame);
  addBlockDnaBars(run, frame, families, familyMetrics, tagEvidence);
  if (brands !== null) addLocalBrandsTable(run, frame, brands, brandMetrics);

  // Notices.
  run.notices.push(methodNotice(area, rung.method, city !== null));
  if (city === null) run.notices.push(`No Qloo locality is pinned for ${cityName} yet; the city side is not measured.`);
  else if (cityGap !== null) run.notices.push(`Venue-goer, ambience and venue tags are not compared: the ${cityName} tag list is missing (${cityGap}).`);
  if (areaMusicA?.kind === "ok" && areaMusicGap !== null) run.notices.push("No music tags came back for this area, so music is not measured.");
  else if (areaMusicGap !== null) run.notices.push(`Music is not measured: the area's music list is missing (${areaMusicGap}).`);
  else if (city !== null && cityMusicGap !== null) run.notices.push(`Music is not measured at city scale (${cityMusicGap}).`);
  if (brands !== null && brands.items !== null && localBrands(brands).length === 0) {
    run.notices.push(`No brand ranks higher here than across ${cityName}.`);
  }
  const institutions = brandInstitutions;
  if (institutions > 0) {
    run.notices.push(
      `${institutions === 1 ? "1 university or college" : `${institutions} universities or colleges`} that Qloo lists as brands ${institutions === 1 ? "was" : "were"} left out: an institution is not a tenant brand.`,
    );
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
