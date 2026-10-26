import {
  ANALYST_TOOLS,
  METRO_LABEL,
  type CacheProbe,
  type DigestRow,
  type EntityRegistry,
  type EvidenceId,
  type Flag,
  type LocalityApi,
  type MetroId,
  type NoValueReason,
  type QlooEntity,
  type QlooEntityInsightsResponse,
  type QlooHeatmapResponse,
  type QlooParams,
  type QlooResult,
  type RegisteredEntity,
  type RegisteredTag,
  type SkillCtx,
  type SkillFor,
  type SkillResult,
  type SkillStatus,
  type ToolInput,
} from "@ct/contracts";
import { emptyResultFinding } from "../findings";
import { SKILL_LIMITATIONS } from "../limitations";
import { addSkillEvidence, attemptAllKeepingFailures, countUncached, type Attempt } from "./common";
import { skillErrorResult, skillResult, type DigestTarget } from "./digest";
import { HEATMAP_BASELINE } from "./findTags/curated";
import { tagUse } from "./findTags/tags";
import { safeFullName, safeName } from "./format";
import {
  COARSE_PRECISION,
  heatCells,
  liftGrid,
  MIN_AREA_CELLS,
  MIN_RANKED_AREAS,
  NO_CLAIM_PRECISION,
  rollUp,
  supplyRankable,
  whiteSpace,
  type AreaLift,
  type AreaSupply,
  type HeatParse,
  type LiftGrid,
} from "./geoLift/lift";
import {
  addFindingDraft,
  addLatentDemand,
  addLiftMap,
  addLiftMetrics,
  liftDigestRows,
  type LiftEvidence,
  type LiftRun,
  type SupplyPoint,
} from "./geoLift/outputs";

/**
 * S6 geo_lift, the Lift Map and White Space (SPEC §5.3 S6, D18, PROBE "Part 5 consequences" 1–3).
 * A concept heatmap from genre:place tags, or from analog entities in their own call when no genre tag
 * fits, never both and never with an operator; the restaurant baseline (pinned per metro); and, with
 * supply, a places sample filtered by the concept's category:place tags, since heatmap price counts
 * do not depend on the concept (G7). Lift is the concept's percentile over the baseline's at the maps'
 * shared geohash precision, rolled up to gazetteer neighbourhoods by point-in-polygon. The sample is
 * fetched only after the maps, and only when enough neighbourhoods have a lift to rank it against,
 * so it never takes budget from the concept map or spends a call nothing reads.
 */

type LiftInput = ToolInput<"geo_lift">;

const HEATMAP = "urn:heatmap";
const PLACE = "urn:entity:place";
/** The places sample: two pages of fifty (G10), the second only when the first is full. */
export const PLACES_TAKE = 50;
export const SUPPLY_PAGES = 2;
/** A call with fewer rows than this is a thin result (§6.4). */
const THIN_ROWS = 5;

export interface GeoConcept {
  /** urn:tag:genre:place:* tags, the only tags that shape a heatmap (P5). */
  heatmapTags: RegisteredTag[];
  /** urn:tag:category:place:* tags: they gave empty maps (P5) and filter the supply sample (G10). */
  placeFilters: RegisteredTag[];
  /** Analogs sent as their own concept call, only when no genre tag fits (P5). */
  analogs: RegisteredEntity[];
  label: string;
  notices: string[];
}

/**
 * Splits the concept refs by what they can do; refs that cannot shape the map are left out with a
 * notice. The restaurant baseline sent beside a specific genre tag would blend the concept with what
 * it is measured against (several tags combine, P5), so it is left out of such a concept.
 */
export function geoConcept(input: LiftInput, registry: EntityRegistry): GeoConcept {
  const notices: string[] = [];
  let heatmapTags: RegisteredTag[] = [];
  const placeFilters: RegisteredTag[] = [];
  for (const ref of input.concept_tags) {
    const tag = registry.tag(ref);
    if (tag === null) {
      notices.push(`${ref} is not in the registry; left out.`);
      continue;
    }
    const use = tagUse(tag.tagId);
    if (use === "heatmap_signal") heatmapTags.push(tag);
    else if (use === "place_filter") placeFilters.push(tag);
    else {
      const why = use === "label_only" ? "a descriptive tag gives an empty map" : "only genre:place tags shape a heatmap";
      notices.push(`${ref} (${safeName(tag.name)}) is not a place taxonomy tag (${why}); left out.`);
    }
  }
  const specific = heatmapTags.filter((t) => t.tagId !== HEATMAP_BASELINE.tagId);
  const baseline = heatmapTags.find((t) => t.tagId === HEATMAP_BASELINE.tagId);
  if (baseline !== undefined && specific.length > 0) {
    notices.push(`${baseline.ref} (${safeName(baseline.name)}) is the restaurant baseline, left out of the concept: lift is measured against it.`);
    heatmapTags = specific;
  }
  const named: RegisteredEntity[] = [];
  for (const ref of input.concept_entities) {
    const entity = registry.entity(ref);
    if (entity === null) notices.push(`${ref} is not in the registry; left out.`);
    else named.push(entity);
  }
  const analogs = heatmapTags.length === 0 ? named : [];
  if (heatmapTags.length > 0 && named.length > 0) {
    notices.push(
      `The genre tags set the map, so the analogs (${named.map((e) => e.ref).join(", ")}) were not sent: ` +
        "sent together, an analog's own footprint would set the hot spots.",
    );
  }
  const label =
    heatmapTags.length > 0
      ? heatmapTags.map((t) => safeName(t.name)).join(" + ")
      : analogs.length > 0
        ? `Analogs of ${analogs.map((e) => safeName(e.name)).join(", ")}`
        : "";
  return { heatmapTags, placeFilters, analogs, label, notices };
}

export interface LiftRequests {
  concept: QlooParams;
  baseline: QlooParams;
  /** The places sample page by page, or null when supply was not asked for or has no category tag. */
  supply: ((page: number) => QlooParams) | null;
}

/** The S6 requests: no operator, no dimensions, and tags and entities never in one heatmap call (P5). */
export function geoLiftRequests(localityId: string, concept: GeoConcept, supply: boolean): LiftRequests | null {
  const signal: QlooParams | null =
    concept.heatmapTags.length > 0
      ? { "signal.interests.tags": concept.heatmapTags.map((t) => t.tagId) }
      : concept.analogs.length > 0
        ? { "signal.interests.entities": concept.analogs.map((e) => e.entityId) }
        : null;
  if (signal === null) return null;
  const filters = concept.placeFilters.map((t) => t.tagId);
  return {
    concept: { "filter.location": localityId, ...signal },
    baseline: { "filter.location": localityId, "signal.interests.tags": [HEATMAP_BASELINE.tagId] },
    supply:
      supply && filters.length > 0
        ? (page) => ({ "filter.location": localityId, "filter.tags": filters, take: PLACES_TAKE, page })
        : null,
  };
}

/** The probe sees insights requests with their filter.type, since has() takes no separate filter type. */
const withType = (filterType: string, params: QlooParams): QlooParams => ({ "filter.type": filterType, ...params });

/**
 * Network calls a geo_lift input would cost now, cached requests free: the concept and baseline maps
 * and both supply pages. It is an upper bound: the second page counts until it is cached, though a
 * short first page makes it unnecessary, and the sample counts though too few neighbourhoods with a
 * lift skip it. Without the locality pins the requests cannot be keyed, so every call counts.
 */
export async function estimateGeoLiftCalls(
  input: LiftInput,
  probe: CacheProbe,
  registry: EntityRegistry,
  localities: LocalityApi | null,
): Promise<number> {
  const concept = geoConcept(input, registry);
  if (concept.heatmapTags.length === 0 && concept.analogs.length === 0) return 0;
  if (localities === null) return 2 + (input.supply && concept.placeFilters.length > 0 ? SUPPLY_PAGES : 0);
  const locality = await localities.market(input.metro);
  const requests = locality === null ? null : geoLiftRequests(locality.entityId, concept, input.supply);
  if (requests === null) return 0;
  const supply = requests.supply;
  const pages = supply === null ? [] : Array.from({ length: SUPPLY_PAGES }, (_, i) => withType(PLACE, supply(i + 1)));
  return countUncached(probe, "/v2/insights", [withType(HEATMAP, requests.concept), withType(HEATMAP, requests.baseline), ...pages]);
}

type HeatAttempt = Attempt<QlooResult<QlooHeatmapResponse>>;
type PlacesAttempt = Attempt<QlooResult<QlooEntityInsightsResponse>>;

const gapOf = (attempt: HeatAttempt | PlacesAttempt | undefined): NoValueReason =>
  attempt?.kind === "truncated" ? "budget_truncated" : "error";

/** "1 venue", "12 cells": counts in summaries and notices. */
function count(n: number, noun: string): string {
  return `${n} ${n === 1 ? noun : `${noun}s`}`;
}

function recordMap(run: LiftRun, which: "concept" | "baseline", label: string, attempt: HeatAttempt, parse: HeatParse): EvidenceId | null {
  if (attempt.kind !== "ok") return null;
  const rows = attempt.value.data.results.heatmap.length;
  const precision = parse.cells.reduce<number | null>((p, c) => (p === null ? c.geohash.length : Math.min(p, c.geohash.length)), null);
  const flags: Flag[] = [];
  if (rows < THIN_ROWS) flags.push("THIN_RESULT");
  if (precision !== null && precision <= COARSE_PRECISION) flags.push("COARSE_GEOHASH");
  const metro = METRO_LABEL[run.metro];
  const evidence = addSkillEvidence(run.ctx.ledger, {
    skill: "geo_lift",
    purpose: which === "concept" ? `Concept heatmap for ${label} in ${metro}` : `Pinned ${HEATMAP_BASELINE.label.toLowerCase()} baseline heatmap for ${metro}`,
    calls: [attempt.value.meta],
    status: parse.cells.length > 0 ? "ok" : "empty",
    summary:
      `${count(parse.cells.length, "cell")} with affinity${precision === null ? "" : ` at geohash ${precision}`}` +
      (parse.zero > 0 ? `; ${parse.zero} zero-affinity excluded` : "") +
      (parse.invalid > 0 ? `; ${parse.invalid} malformed skipped` : "") +
      ".",
    flags,
  });
  if (evidence === null) return null;
  for (const f of flags) run.flags.add(f);
  run.evidenceIds.push(evidence.id);
  return evidence.id;
}

interface Supply {
  /** Located venues, deduplicated across pages. */
  points: (SupplyPoint & { entityId: string })[];
  returned: number;
  capped: boolean;
  truncated: boolean;
  failed: boolean;
  evidenceId: EvidenceId | null;
}

function venuesOf(attempt: PlacesAttempt | null | undefined): QlooEntity[] {
  return attempt?.kind === "ok" ? attempt.value.data.results.entities : [];
}

function recordSupply(run: LiftRun, concept: GeoConcept, pages: readonly (PlacesAttempt | null | undefined)[]): Supply {
  const seen = new Set<string>();
  const points: Supply["points"] = [];
  let returned = 0;
  for (const venue of pages.flatMap(venuesOf)) {
    returned += 1;
    if (seen.has(venue.entity_id)) continue;
    seen.add(venue.entity_id);
    const at = venue.location;
    if (at === undefined || !Number.isFinite(at.lat) || !Number.isFinite(at.lon)) continue;
    points.push({ entityId: venue.entity_id, lat: at.lat, lon: at.lon, label: safeFullName(venue.name) });
  }
  const ok = pages.filter((p): p is Extract<PlacesAttempt, { kind: "ok" }> => p?.kind === "ok");
  const last = ok[ok.length - 1];
  const supply: Supply = {
    points,
    returned,
    // The last page fetched came back full, so more venues may exist than the sample holds.
    capped: last !== undefined && venuesOf(last).length >= PLACES_TAKE,
    truncated: pages.some((p) => p?.kind === "truncated"),
    failed: pages.some((p) => p?.kind === "failed"),
    evidenceId: null,
  };
  const flags: Flag[] = ["SUPPLY_SAMPLE_ONLY"];
  if (pages[0]?.kind === "ok" && venuesOf(pages[0]).length < THIN_ROWS) flags.push("THIN_RESULT");
  if (supply.truncated) flags.push("BUDGET_TRUNCATED");
  const filters = concept.placeFilters.map((t) => safeName(t.name)).join(", ");
  const evidence = addSkillEvidence(run.ctx.ledger, {
    skill: "geo_lift",
    purpose: `Places sample (${filters}) in ${METRO_LABEL[run.metro]} for supply`,
    calls: ok.map((p) => p.value.meta),
    status: supply.truncated || supply.failed ? "partial" : returned === 0 ? "empty" : "ok",
    summary:
      `${count(returned, "venue")} over ${count(ok.length, "page")}, ${points.length} with a location` +
      `${supply.capped ? "; capped, so more venues may exist" : ""}.`,
    flags,
  });
  if (evidence !== null) {
    supply.evidenceId = evidence.id;
    run.evidenceIds.push(evidence.id);
    for (const f of flags) run.flags.add(f);
  }
  return supply;
}

const NO_SIGNAL =
  "geo_lift needs a genre:place concept tag (find_tags, scope place) or, when none fits, analog venues or brands as " +
  "concept_entities; category:place tags only filter the supply sample.";

function finish(run: LiftRun, target: DigestTarget, status: SkillStatus, rows: readonly DigestRow[]): SkillResult {
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

function precisionNotice(grid: LiftGrid): string | null {
  if (grid.precision <= NO_CLAIM_PRECISION) {
    return `The maps came back at geohash ${grid.precision}, too coarse for any neighbourhood claim; read the cells only.`;
  }
  if (grid.precision <= COARSE_PRECISION) return `The maps came back at geohash ${grid.precision}: neighbourhood lifts carry half confidence.`;
  return null;
}

/**
 * Why no lift can be read off the maps: the baseline was refused or failed, came back empty (a wrong
 * locality pin would show this way) or shares no cell with the concept map. Null when lift is measurable.
 */
function baselineGap(base: HeatAttempt, baseParse: HeatParse | null, grid: LiftGrid): NoValueReason | null {
  if (base.kind !== "ok" || baseParse === null) return gapOf(base);
  if (baseParse.cells.length === 0) return "unavailable";
  return grid.shared === 0 ? "not_measured" : null;
}

const BASELINE_GAP_CAUSE: Partial<Record<NoValueReason, string>> = {
  budget_truncated: "The pinned restaurant baseline was not fetched (budget)",
  error: "The pinned restaurant baseline was lost to a failed call",
  unavailable: "The pinned restaurant baseline came back empty",
  not_measured: "The concept and baseline maps share no cell",
};

function baselineGapNotice(gap: NoValueReason): string {
  const cause = BASELINE_GAP_CAUSE[gap] ?? "The pinned restaurant baseline is missing";
  return `${cause}: the map shows raw heat only, which tracks popularity, so no lift is measured.`;
}

/** The places sample: page 1, then page 2 only after a full first page. */
async function sampleSupply(ctx: SkillCtx, request: (page: number) => QlooParams): Promise<[PlacesAttempt | undefined, PlacesAttempt | null]> {
  const [first] = await attemptAllKeepingFailures([() => ctx.qloo.insights(PLACE, request(1))], ctx.signal);
  if (first?.kind !== "ok" || venuesOf(first).length < PLACES_TAKE) return [first, null];
  const [second] = await attemptAllKeepingFailures([() => ctx.qloo.insights(PLACE, request(2))], ctx.signal);
  return [first, second ?? null];
}

/** Why a supply sample that was due is missing or short, or null when it came back whole. */
function supplyNotice(first: PlacesAttempt | undefined, second: PlacesAttempt | null): string | null {
  if (first?.kind === "truncated") return "The budget stopped the supply sample, so there is no white space.";
  if (first?.kind === "failed") return `The supply sample failed (${first.code}), so there is no white space.`;
  if (second?.kind === "truncated") return "The budget stopped the supply sample after its first page.";
  if (second?.kind === "failed") return `The second supply page failed (${second.code}), so the venue sample is incomplete.`;
  return null;
}

/** Why no supply sample was taken when too few neighbourhoods have a lift to rank it against. */
function unrankedSupplyNotice(lifted: number): string {
  if (lifted === 0) return "No neighbourhood has a lift, so no supply sample was taken and there is no white space.";
  return (
    `Only ${count(lifted, "neighbourhood")} ${lifted === 1 ? "has" : "have"} a lift, too few to rank demand and supply ` +
    `(${MIN_RANKED_AREAS} needed), so no supply sample was taken and there is no white space.`
  );
}

async function runGeoLift(input: LiftInput, ctx: SkillCtx): Promise<SkillResult> {
  const out: DigestTarget = { tool: "geo_lift", step: input.step_id };
  const metro: MetroId = input.metro;
  const metroLabel = METRO_LABEL[metro];
  const concept = geoConcept(input, ctx.registry);
  if (concept.heatmapTags.length === 0 && concept.analogs.length === 0) return skillErrorResult(out, [...concept.notices, NO_SIGNAL].join(" "));
  const locality = (await ctx.localities?.market(metro)) ?? null;
  const requests = locality === null ? null : geoLiftRequests(locality.entityId, concept, input.supply);
  if (requests === null) {
    return skillErrorResult(out, `No Qloo locality is pinned for ${metroLabel} yet, so its heatmaps cannot be requested.`);
  }

  // The two maps together; the supply sample waits for them (see the module comment).
  const [conceptA, baselineA] = await attemptAllKeepingFailures(
    [() => ctx.qloo.insights(HEATMAP, requests.concept), () => ctx.qloo.insights(HEATMAP, requests.baseline)],
    ctx.signal,
  );
  if (conceptA === undefined || baselineA === undefined) throw new Error("geo_lift: missing heatmap attempts");
  // Nothing is in the ledger yet: a concept map Qloo failed leaves nothing to keep, so the error goes to the caller.
  if (conceptA.kind === "failed") throw conceptA.error;
  const heat: HeatAttempt = conceptA;
  const base: HeatAttempt = baselineA;

  const run: LiftRun = {
    ctx,
    metro,
    flags: new Set(),
    evidenceIds: [],
    metrics: [],
    findings: [],
    datasetIds: [],
    notices: [...concept.notices],
  };
  const conceptRefs = [...concept.heatmapTags.map((t) => t.ref), ...concept.analogs.map((e) => e.ref)];
  const conceptParse = heat.kind === "ok" ? heatCells(heat.value.data.results.heatmap) : null;
  const baseParse = base.kind === "ok" ? heatCells(base.value.data.results.heatmap) : null;
  const evidence: LiftEvidence = { maps: [], supply: [] };
  for (const [which, attempt, parse] of [["concept", heat, conceptParse], ["baseline", base, baseParse]] as const) {
    const id = parse === null ? null : recordMap(run, which, concept.label, attempt, parse);
    if (id !== null) evidence.maps.push(id);
  }
  if (heat.kind === "truncated" || base.kind === "truncated") run.flags.add("BUDGET_TRUNCATED");

  const supplyRequest = requests.supply;
  const supplyMissing = input.supply && supplyRequest === null;
  if (supplyMissing) {
    run.notices.push("Supply needs a category:place concept tag (find_tags, scope place); no venue sample was taken, so there is no white space.");
  }

  // No concept map: nothing to measure lift with, and no supply sample.
  const grid = conceptParse === null ? null : liftGrid(conceptParse.cells, baseParse?.cells ?? null);
  if (conceptParse === null || grid === null) {
    const conceptGap: NoValueReason = conceptParse === null ? gapOf(heat) : "not_measured";
    if (conceptParse === null) run.notices.push("The budget stopped the concept heatmap, so no lift was measured.");
    else {
      addFindingDraft(
        run,
        emptyResultFinding({
          what: `the concept heatmap for ${concept.label} in ${metroLabel}`,
          suggestion: { tool: "find_tags", reason: "Look up a genre:place tag for the concept (scope place); category and descriptive tags give an empty map." },
        }),
        [],
      );
    }
    addBaselineEmpty(run, baseParse);
    addLiftMetrics(run, { grid: null, areas: [], supply: new Map(), conceptRefs, evidence, gap: conceptGap });
    return finish(run, out, conceptParse === null || base.kind !== "ok" ? "partial" : "empty", []);
  }

  // Lift and the roll-up.
  const gap = baselineGap(base, baseParse, grid);
  addBaselineEmpty(run, baseParse);
  if (gap !== null) run.notices.push(baselineGapNotice(gap));
  const areas = ctx.geo.neighbourhoods(metro);
  const located = new Map<string, string | null>();
  const areaOf = (geohash: string): string | null => {
    if (!located.has(geohash)) located.set(geohash, ctx.geo.locate(metro, ctx.geo.geohashCentroid(geohash)));
    return located.get(geohash) ?? null;
  };
  const lifts: AreaLift[] = rollUp({ grid, areas, areaOf, gap });
  const lifted = lifts.filter((a) => a.lift !== null).length;

  if (grid.precision <= COARSE_PRECISION) run.flags.add("COARSE_GEOHASH");
  const notes = [
    precisionNotice(grid),
    concept.heatmapTags.length === 1 && concept.heatmapTags[0]?.tagId === HEATMAP_BASELINE.tagId
      ? "The concept tag is the restaurant baseline itself, so every lift is 1 by construction."
      : null,
    concept.heatmapTags.length === 0 && gap === null
      ? "The analog map covers only part of the metro, mostly its most popular cells; cells and neighbourhoods outside it are not measured, not low."
      : null,
    areas.length === 0 ? `No neighbourhood boundaries for ${metroLabel} in this build: the map shows cells only.` : null,
    areas.length > 0 && gap === null && grid.precision > NO_CLAIM_PRECISION && lifted === 0
      ? `No neighbourhood reached the ${MIN_AREA_CELLS} gated cells a lift needs.`
      : null,
  ];
  run.notices.push(...notes.filter((n): n is string => n !== null));

  // Supply and white space: a sample only when enough neighbourhoods have a lift to rank it against.
  let supply: Supply | null = null;
  if (supplyRequest !== null && supplyRankable(lifts).length < MIN_RANKED_AREAS) {
    run.notices.push(unrankedSupplyNotice(lifted));
  } else if (supplyRequest !== null) {
    const [first, second] = await sampleSupply(ctx, supplyRequest);
    // Only a first page that came back is a sample: without one, supply is not measured, never zero venues.
    if (first?.kind === "ok") supply = recordSupply(run, concept, [first, second]);
    if (supply?.evidenceId) evidence.supply.push(supply.evidenceId);
    if (first?.kind === "truncated" || second?.kind === "truncated") run.flags.add("BUDGET_TRUNCATED");
    const notice = supplyNotice(first, second);
    if (notice !== null) run.notices.push(notice);
  }
  const counts =
    supply === null
      ? null
      : supply.points.reduce((m, p) => {
          const id = ctx.geo.locate(metro, { lat: p.lat, lon: p.lon });
          return id === null ? m : m.set(id, (m.get(id) ?? 0) + 1);
        }, new Map<string, number>());
  const space: Map<string, AreaSupply> = whiteSpace(lifts, counts);
  if (supply !== null && supply.returned > 0 && [...space.values()].every((s) => s.supplyPct === null)) {
    run.notices.push("No sampled venue lies in a neighbourhood with a lift, so supply and white space are not measured.");
  }

  const metrics = addLiftMetrics(run, { grid, areas: lifts, supply: space, conceptRefs, evidence, gap });
  addLiftMap(run, {
    grid,
    areas: lifts,
    supply: space,
    points: supply === null ? null : supply.points.map(({ lat, lon, label }) => ({ lat, lon, label })),
    capped: supply?.capped ?? false,
    concept: { label: concept.label, tagRefs: concept.heatmapTags.map((t) => t.ref), entityRefs: concept.analogs.map((e) => e.ref) },
    areaOf,
    evidenceIds: run.evidenceIds,
  });
  if (supply !== null && supply.returned === 0 && !supply.truncated && !supply.failed) {
    addFindingDraft(
      run,
      emptyResultFinding({
        what: `the venue supply sample in ${metroLabel}`,
        suggestion: { tool: "find_tags", reason: "Look up another category:place tag for the concept's venues (scope place)." },
      }),
      [],
    );
  }
  addLatentDemand(run, lifts, space, metrics);

  const supplyShort = supplyRequest !== null && (supply === null || supply.truncated || supply.failed);
  const partial = gap !== null || supplyMissing || supplyShort;
  return finish(run, out, partial ? "partial" : "ok", liftDigestRows(lifts, space, metrics));
}

/** EMPTY_RESULT for a baseline that came back with no cell: no tool can repair a pinned baseline. */
function addBaselineEmpty(run: LiftRun, baseParse: HeatParse | null): void {
  if (baseParse === null || baseParse.cells.length > 0) return;
  addFindingDraft(run, emptyResultFinding({ what: `the pinned restaurant baseline heatmap for ${METRO_LABEL[run.metro]}`, suggestion: null }), []);
}

export const geoLiftSkill: SkillFor<"geo_lift"> = {
  id: "geo_lift",
  mnemonic: "LIFT",
  kitWorkflows: ANALYST_TOOLS.geo_lift.kitWorkflows,
  input: ANALYST_TOOLS.geo_lift.input,
  // Without the locality pins in `env` the requests cannot be keyed: the upper bound.
  estimateCalls: (input, probe, registry, env) => estimateGeoLiftCalls(input, probe, registry, env?.localities ?? null),
  run: runGeoLift,
  // The method bullets only: buildLimitations writes each raised flag's sentence from FLAG_TEXT.
  limitations: () => [...SKILL_LIMITATIONS.geo_lift],
};
