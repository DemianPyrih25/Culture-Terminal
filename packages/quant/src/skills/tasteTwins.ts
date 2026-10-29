import {
  ANALYST_TOOLS,
  METRO_LABEL,
  type CacheProbe,
  type EntityRegistry,
  type EstimateEnv,
  type EvidenceId,
  type GeoApi,
  type MarketLocality,
  type MetroId,
  type Neighbourhood,
  type NoValueReason,
  type QlooHeatmapResponse,
  type QlooParams,
  type QlooResult,
  type SkillCtx,
  type SkillFor,
  type SkillResult,
  type ToolInput,
} from "@ct/contracts";
import { SKILL_LIMITATIONS } from "../limitations";
import { attemptAllKeepingFailures, countUncached, type Attempt } from "./common";
import { skillErrorResult, type DigestTarget } from "./digest";
import { safeName } from "./format";
import {
  addBundle,
  callFlags,
  climbDown,
  count,
  LIST_FAMILIES,
  metasOf,
  okValue,
  rowsOf,
  TAG,
  tagParams,
  type TagAttempt,
} from "./blockDna/calls";
import { compareLists, NEW_AREA_TOP, rankTagRows, TAG_TAKE, type RankedList } from "./blockDna/fingerprint";
import { cityLocation, pointWkt, resolveArea } from "./blockDna/location";
import { finishBlockRun, methodNotice, recordFallbacks, type BlockRun } from "./blockDna/outputs";
import { geoConcept, geoLiftRequests } from "./geoLift";
import { heatCells, liftGrid, rollUp } from "./geoLift/lift";
import {
  addTwinBars,
  addTwinFinding,
  addTwinMetrics,
  addTwinTable,
  byResemblance,
  pickNotice,
  twinDigestRows,
  type TwinArea,
  type TwinFrame,
  type TwinPick,
} from "./tasteTwins/outputs";
import { largestAreas, MAX_TARGET_AREAS, MIN_LIFTED_AREAS, topLiftAreas, twinScore } from "./tasteTwins/twins";

/**
 * S11 taste_twins, Taste Twins (PLAN §2.2, §4.3, SPEC S11): the areas of another map city whose
 * taste pattern most resembles a source neighbourhood. Each area is read against its own city, as
 * Block DNA reads it (the source down the location ladder, each target area by its boundary, both
 * city sides from their pinned localities, byte-identical to the warmed requests), and two areas
 * are compared by Spearman ρ of their rank gains over the union of their tags. The areas checked are
 * the ones named, else the top concept-lift areas (one concept heatmap; the baseline is pinned),
 * else the largest. SOUND is not compared: music would cost a second call per area.
 */

type TwinsInput = ToolInput<"taste_twins">;

const HEATMAP = "urn:heatmap";

/** Loads a metro's polygons when the GeoApi can (createGeo's ensure); a test double is used as it is. */
async function ensureMetros(geo: GeoApi, metros: readonly MetroId[]): Promise<void> {
  const ensure = (geo as Partial<{ ensure(metro: MetroId): Promise<void> }>).ensure;
  if (typeof ensure !== "function") return;
  await Promise.all(metros.map((m) => ensure.call(geo, m)));
}

/** A polygon, or null when the gazetteer holds none or has not loaded the metro (estimates only). */
function polygonOf(geo: GeoApi, metro: MetroId, id: string): string | null {
  try {
    return geo.polygonWkt(metro, id);
  } catch {
    return null;
  }
}

const tagRequest = (location: QlooParams): QlooParams => ({ "filter.type": TAG, ...tagParams(location, false) });

/** The concept argument geo_lift's builders take, for the concept tags of a twins call. */
function conceptOf(input: TwinsInput, registry: EntityRegistry) {
  return geoConcept(
    { metro: input.target_metro, concept_tags: input.concept_tags, concept_entities: [], supply: false, trigger_finding_id: null, step_id: null },
    registry,
  );
}

/**
 * Network calls a taste_twins input would cost now, cached ones free. Requests the estimate cannot
 * key (no gazetteer, no pins, or target areas the concept map would pick) count as network calls.
 */
export async function estimateTasteTwinsCalls(input: TwinsInput, probe: CacheProbe, registry: EntityRegistry, env?: EstimateEnv): Promise<number> {
  const geo = env?.geo ?? null;
  const localities = env?.localities ?? null;
  const requests: QlooParams[] = [];
  let unknown = 0;

  // Source area: its first rung.
  const known = geo === null ? null : geo.neighbourhood(input.source.metro, input.source.ref);
  if (geo === null || known === null) unknown += 1;
  else {
    const polygon = polygonOf(geo, input.source.metro, known.id);
    requests.push(tagRequest({ "signal.location": polygon ?? pointWkt(known.centroid) }));
  }

  // City sides (pinned).
  for (const metro of [input.source.metro, input.target_metro]) {
    const loc = localities === null ? undefined : await localities.market(metro);
    if (loc === undefined) unknown += 1;
    else if (loc !== null) requests.push(tagRequest(cityLocation(loc)));
  }

  // Target areas.
  if (input.target_areas.length > 0) {
    for (const id of input.target_areas) {
      const polygon = geo === null ? null : polygonOf(geo, input.target_metro, id);
      if (polygon === null) unknown += 1;
      else requests.push(tagRequest({ "signal.location": polygon }));
    }
  } else if (input.concept_tags.length > 0 && conceptOf(input, registry).heatmapTags.length > 0) {
    const loc = localities === null ? null : await localities.market(input.target_metro);
    const maps = loc === null ? null : geoLiftRequests(loc.entityId, conceptOf(input, registry), false);
    if (maps === null) unknown += 2;
    else requests.push({ "filter.type": HEATMAP, ...maps.concept }, { "filter.type": HEATMAP, ...maps.baseline });
    unknown += MAX_TARGET_AREAS;
  } else if (geo === null) {
    unknown += MAX_TARGET_AREAS;
  } else {
    for (const a of largestAreas(geo.neighbourhoods(input.target_metro))) {
      const polygon = polygonOf(geo, input.target_metro, a.id);
      if (polygon === null) unknown += 1;
      else requests.push(tagRequest({ "signal.location": polygon }));
    }
  }
  return (await countUncached(probe, "/v2/insights", requests)) + unknown;
}

// Target areas -------------------------------------------------------------------------------------------

interface Picked {
  pick: TwinPick;
  areas: { area: Neighbourhood; lift: number | null }[];
  conceptLabel: string | null;
}

type HeatAttempt = Attempt<QlooResult<QlooHeatmapResponse>>;

/**
 * The areas to check: the named ones, else the top concept-lift areas (fewer than MIN_LIFTED_AREAS
 * with a lift falls back to size), else the largest. The concept maps are recorded as evidence.
 */
async function pickTargets(input: TwinsInput, ctx: SkillCtx, run: BlockRun, targetLoc: MarketLocality): Promise<Picked | { error: string }> {
  const metro = input.target_metro;
  const city = METRO_LABEL[metro];
  const all = ctx.geo.neighbourhoods(metro);
  if (input.target_areas.length > 0) {
    const areas: Neighbourhood[] = [];
    for (const id of input.target_areas) {
      const a = ctx.geo.neighbourhood(metro, id);
      if (a === null) run.notices.push(`${id} is not a ${city} area in the AREAS list; left out.`);
      else areas.push(a);
    }
    if (areas.length === 0) return { error: `None of the target areas is a ${city} area in the AREAS list; use their ids, or leave target_areas empty.` };
    return { pick: "named", areas: areas.map((area) => ({ area, lift: null })), conceptLabel: null };
  }
  const largest = (): Picked => ({ pick: "largest", areas: largestAreas(all).map((area) => ({ area, lift: null })), conceptLabel: null });
  if (input.concept_tags.length === 0) return largest();

  const concept = conceptOf(input, ctx.registry);
  run.notices.push(...concept.notices);
  const requests = concept.heatmapTags.length === 0 ? null : geoLiftRequests(targetLoc.entityId, concept, false);
  if (requests === null) {
    run.notices.push("No concept tag shapes a heatmap (only genre:place tags do), so the areas checked are the largest, not the best fit.");
    return largest();
  }
  const [heatA, baseA] = (await attemptAllKeepingFailures(
    [() => ctx.qloo.insights(HEATMAP, requests.concept), () => ctx.qloo.insights(HEATMAP, requests.baseline)],
    ctx.signal,
  )) as [HeatAttempt | undefined, HeatAttempt | undefined];
  const calls = metasOf([heatA, baseA]);
  const truncated = heatA?.kind === "truncated" || baseA?.kind === "truncated";
  addBundle(run, "taste_twins", {
    purpose: `Concept heatmap of ${concept.label} in ${city} and its restaurant baseline, to pick the areas checked`,
    calls,
    status: heatA?.kind === "ok" && baseA?.kind === "ok" ? "ok" : calls.length === 0 ? "empty" : "partial",
    summary: `${count(calls.length, "map")} came back for picking ${city} areas by concept lift.`,
    flags: [...(calls.some((c) => c.stale) ? (["STALE_CACHE"] as const) : []), ...(truncated ? (["BUDGET_TRUNCATED"] as const) : [])],
  });
  const heat = okValue(heatA);
  const base = okValue(baseA);
  if (heat === null || base === null) {
    const why = truncated ? "the call budget ran out" : "a map call failed";
    run.notices.push(`The concept lift could not be measured (${why}), so the areas checked are the largest, not the best fit.`);
    return largest();
  }
  const grid = liftGrid(heatCells(heat.data.results.heatmap).cells, heatCells(base.data.results.heatmap).cells);
  const lifts = grid === null ? [] : rollUp({ grid, areas: all, areaOf: (g) => ctx.geo.locate(metro, ctx.geo.geohashCentroid(g)), gap: null });
  const top = topLiftAreas(lifts);
  if (top.length < MIN_LIFTED_AREAS) {
    run.notices.push(`Only ${top.length} ${city} areas have a concept lift, so the areas checked are the largest, not the best fit.`);
    return largest();
  }
  const byId = new Map(all.map((a) => [a.id, a]));
  return {
    pick: "concept",
    areas: top.flatMap((t) => {
      const area = byId.get(t.id);
      return area === undefined ? [] : [{ area, lift: t.lift }];
    }),
    conceptLabel: concept.label,
  };
}

// Run ----------------------------------------------------------------------------------------------------

async function runTasteTwins(input: TwinsInput, ctx: SkillCtx): Promise<SkillResult> {
  const out: DigestTarget = { tool: "taste_twins", step: input.step_id };
  const srcMetro = input.source.metro;
  const tgtMetro = input.target_metro;
  const srcCity = METRO_LABEL[srcMetro];
  const tgtCity = METRO_LABEL[tgtMetro];
  for (const metro of [srcMetro, tgtMetro]) {
    if (ctx.geo.neighbourhoods(metro).length === 0) {
      return skillErrorResult(out, `Taste twins needs neighbourhood boundaries in both cities, and this build has none for ${METRO_LABEL[metro]}.`);
    }
  }
  await ensureMetros(ctx.geo, [srcMetro, tgtMetro]);
  const resolved = resolveArea(input.source, ctx.geo);
  if (!resolved.ok) return skillErrorResult(out, resolved.message);
  const source = resolved.area;
  if (ctx.localities === null) return skillErrorResult(out, "This run has no Qloo locality pins, so no area can be read against its city.");
  const [srcLoc, tgtLoc] = await Promise.all([ctx.localities.market(srcMetro), ctx.localities.market(tgtMetro)]);
  if (srcLoc === null || tgtLoc === null) {
    return skillErrorResult(out, `No Qloo locality is pinned for ${srcLoc === null ? srcCity : tgtCity}, so its areas cannot be read against the city.`);
  }

  const run: BlockRun = { ctx, flags: new Set(), evidenceIds: [], metrics: [], findings: [], datasetIds: [], registered: [], notices: [...source.notices] };
  const picked = await pickTargets(input, ctx, run, tgtLoc);
  if ("error" in picked) return skillErrorResult(out, picked.error);
  const targets = picked.areas.slice(0, MAX_TARGET_AREAS);
  const polygons = targets.map((t) => ctx.geo.polygonWkt(tgtMetro, t.area.id));

  // The source down the ladder; both city sides and every target boundary alongside.
  const [ladder, cityAttempts, targetAttempts] = await Promise.all([
    climbDown(ctx, source),
    attemptAllKeepingFailures(
      [() => ctx.qloo.insights(TAG, tagParams(cityLocation(srcLoc), false)), () => ctx.qloo.insights(TAG, tagParams(cityLocation(tgtLoc), false))],
      ctx.signal,
    ),
    attemptAllKeepingFailures(
      polygons.map((wkt) => (wkt === null ? null : () => ctx.qloo.insights(TAG, tagParams({ "signal.location": wkt }, false)))),
      ctx.signal,
    ),
  ]);
  const [srcCityA, tgtCityA] = cityAttempts as [TagAttempt | undefined, TagAttempt | undefined];

  // Ladder receipts and fallbacks.
  if (ladder.empty.length > 0) {
    addBundle(run, "taste_twins", {
      purpose: `Location ladder for ${safeName(source.name)}: rungs that returned no ranked taste tags`,
      calls: ladder.empty,
      status: "empty",
      summary: `${count(ladder.empty.length, "location rung")} returned no ranked taste tags, so the ladder stepped down.`,
      flags: [...(ladder.steps.length > 0 ? (["LOCATION_FALLBACK"] as const) : []), ...(ladder.emptyUnscored ? (["NOT_SCORED"] as const) : [])],
    });
  }
  recordFallbacks(run, source, ladder.steps);
  if (ladder.steps.length > 0) run.flags.add("LOCATION_FALLBACK");

  if (ladder.chosen === null) {
    const last = ladder.failures.at(-1);
    if (last !== undefined && ladder.empty.length === 0 && !ladder.truncated && run.evidenceIds.length === 0) throw last.error;
    if (ladder.truncated) run.flags.add("BUDGET_TRUNCATED");
    run.notices.push(
      ladder.truncated
        ? `The call budget ran out before ${safeName(source.name)} could be read; no twin was measured.`
        : `${safeName(source.name)} returned no ranked taste tags at any rung, so there is nothing to find a twin of.`,
    );
    return finishBlockRun(run, out, ladder.truncated || ladder.failures.length > 0 ? "partial" : "empty", []);
  }
  const { rung, answer } = ladder.chosen;
  const srcList = rankTagRows(answer.data.results.tags, LIST_FAMILIES);
  const srcCityList = okValue(srcCityA) === null ? null : rankTagRows(okValue(srcCityA)?.data.results.tags ?? [], LIST_FAMILIES);
  const tgtCityList = okValue(tgtCityA) === null ? null : rankTagRows(okValue(tgtCityA)?.data.results.tags ?? [], LIST_FAMILIES);
  const targetLists = targetAttempts.map((a) => (a?.kind === "ok" ? rankTagRows(a.value.data.results.tags, LIST_FAMILIES) : null));

  // Evidence.
  const srcCalls = [answer.meta];
  const srcE = addBundle(run, "taste_twins", {
    purpose: `Tag fingerprint of ${safeName(source.name)} by ${rung.method}`,
    calls: srcCalls,
    status: "ok",
    summary: `${rung.method}: ${count(srcList.ranks.size, "ranked taste tag")}.`,
    flags: [...callFlags([answer.data.results.tags.length], [srcList], srcCalls, false), ...(ladder.steps.length > 0 ? (["LOCATION_FALLBACK"] as const) : [])],
  });
  const cityCalls = metasOf([srcCityA, tgtCityA]);
  const cityE = addBundle(run, "taste_twins", {
    purpose: `City tag fingerprints of ${srcCity} and ${tgtCity} (Qloo localities)`,
    calls: cityCalls,
    status: srcCityList !== null && tgtCityList !== null ? "ok" : cityCalls.length === 0 ? "empty" : "partial",
    summary: `${srcCity}: ${srcCityList === null ? "not measured" : count(srcCityList.ranks.size, "ranked tag")}; ${tgtCity}: ${tgtCityList === null ? "not measured" : count(tgtCityList.ranks.size, "ranked tag")}.`,
    flags: callFlags([rowsOf(srcCityA), rowsOf(tgtCityA)], [srcCityList, tgtCityList], cityCalls, srcCityA?.kind === "truncated" || tgtCityA?.kind === "truncated"),
  });
  const targetCalls = metasOf(targetAttempts);
  const targetE = addBundle(run, "taste_twins", {
    purpose: `Tag fingerprints of ${count(targetCalls.length, `${tgtCity} area`)} by their boundaries`,
    calls: targetCalls,
    status: targetAttempts.every((a) => a?.kind === "ok") ? "ok" : targetCalls.length === 0 ? "empty" : "partial",
    summary: targets.map((t, i) => `${safeName(t.area.name)} ${targetLists[i] === null ? "not measured" : count(targetLists[i]?.ranks.size ?? 0, "tag")}`).join("; ") + ".",
    flags: callFlags(
      targetAttempts.map((a) => rowsOf(a as TagAttempt | undefined)),
      targetLists,
      targetCalls,
      targetAttempts.some((a) => a?.kind === "truncated"),
    ),
  });
  const evidenceIds = [srcE, cityE, targetE].filter((e): e is EvidenceId => e !== null);

  // Comparisons.
  const cityGap: NoValueReason | null = srcCityList === null || tgtCityList === null ? (cityAttempts.some((a) => a?.kind === "truncated") ? "budget_truncated" : "error") : null;
  const sourceCompared = cityGap === null ? compareLists(srcList, srcCityList, TAG_TAKE + 1, NEW_AREA_TOP) : [];
  const areas: TwinArea[] = targets.map((t, i): TwinArea => {
    const attempt = targetAttempts[i];
    const list: RankedList | null = targetLists[i] ?? null;
    const missing = (gap: NoValueReason, why: string): TwinArea => ({ area: t.area, lift: t.lift, compared: null, score: null, gap, why });
    if (polygons[i] === null) return missing("unavailable", "the gazetteer holds no boundary for it");
    if (attempt?.kind === "truncated") return missing("budget_truncated", "the call budget ran out");
    if (attempt?.kind === "failed") return missing("error", `the call failed (${attempt.code})`);
    if (list === null || list.ranks.size === 0) return missing("not_measured", "Qloo returned no ranked taste tags for it");
    if (cityGap !== null) return missing(cityGap, "a city tag list is missing");
    const compared = compareLists(list, tgtCityList, TAG_TAKE + 1, NEW_AREA_TOP);
    const score = twinScore(sourceCompared, compared);
    return { area: t.area, lift: t.lift, compared, score, gap: score.reason, why: score.reason === null ? null : "too few tags to compare" };
  });

  // Ledger output.
  const frame: TwinFrame = {
    source: { id: source.subject, name: source.name, metro: srcMetro },
    sourceCompared,
    target: tgtMetro,
    targetAreaCount: ctx.geo.neighbourhoods(tgtMetro).length,
    pick: picked.pick,
    conceptLabel: picked.conceptLabel,
    evidenceIds,
  };
  const ordered = byResemblance(areas);
  const metrics = addTwinMetrics(run, frame, ordered);
  addTwinFinding(run, frame, ordered, metrics);
  addTwinTable(run, frame, ordered);
  addTwinBars(run, frame, ordered[0]);

  // Notices.
  run.notices.unshift(pickNotice(frame, targets.length));
  run.notices.push(methodNotice(source, rung.method, true));
  run.notices.push("Music (SOUND) is not compared between areas: it would cost a second call per area.");
  if (cityGap !== null) run.notices.push(`No twin is measured: a city tag list is missing (${cityGap}).`);
  const unmeasured = ordered.filter((a) => a.score?.rho === null || a.score === null);
  if (unmeasured.length > 0 && cityGap === null) {
    run.notices.push(`Not measured: ${unmeasured.map((a) => `${safeName(a.area.name)} (${a.why ?? a.gap})`).join("; ")}.`);
  }
  if (targetAttempts.some((a) => a?.kind === "truncated")) run.flags.add("BUDGET_TRUNCATED");

  const partial = cityGap !== null || unmeasured.some((a) => a.gap !== "not_measured" && a.gap !== "insufficient_n");
  const status = ordered.every((a) => a.score?.rho === null || a.score === null) && !partial ? "empty" : partial ? "partial" : "ok";
  return finishBlockRun(run, out, status, twinDigestRows(ordered, metrics));
}

export const tasteTwinsSkill: SkillFor<"taste_twins"> = {
  id: "taste_twins",
  mnemonic: "TWIN",
  kitWorkflows: ANALYST_TOOLS.taste_twins.kitWorkflows,
  input: ANALYST_TOOLS.taste_twins.input,
  estimateCalls: (input, probe, registry, env) => estimateTasteTwinsCalls(input, probe, registry, env),
  run: runTasteTwins,
  limitations: () => [...SKILL_LIMITATIONS.taste_twins],
};
