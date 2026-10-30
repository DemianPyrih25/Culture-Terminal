import {
  ANALYST_TOOLS,
  METRO_LABEL,
  OSM_ATTRIBUTION,
  OSM_COMPLETENESS,
  OSM_LICENCE,
  OSM_LICENCE_URL,
  PUBLIC_NOT_CONFIGURED_REASON,
  publicDataErrorCode,
  SUPPLY_PLACES_MAX,
  supplySourceLine,
  type CandidateSource,
  type DatasetId,
  type DigestRow,
  type EvidenceId,
  type Finding,
  type Flag,
  type GeoApi,
  type MarketId,
  type Metric,
  type MetroId,
  type OsmCounts,
  type OsmPlace,
  type OsmShape,
  type OsmTypeQuery,
  type PublicCallMeta,
  type PublicDataErrorCode,
  type SkillCtx,
  type SkillFor,
  type SkillResult,
  type SkillStatus,
  type SupplyPayload,
  type SupplyRow,
  type ToolInput,
} from "@ct/contracts";
import { OSM_ACTIVITY_KEY, osmCityQueries, osmMetro, osmPlaceType, osmTags, osmTenantTypes, type OsmPlaceType } from "@ct/publicdata/osm-config";
import { isOversupplied, isUndersupplied, lowStreetActivityFinding, oversuppliedFinding, undersuppliedFinding, type FindingDraft, type SupplyCandidate } from "../findings";
import { isAboutLevelDensityIndex } from "../formulas";
import { SKILL_LIMITATIONS } from "../limitations";
import { addSkillEvidence, addSkillMetric } from "./common";
import { skillErrorResult, skillResult, type DigestTarget } from "./digest";
import { safeFullName, safeName } from "./format";
import { marketLabel, placeSearchArea } from "./metros";

/**
 * S15 local_supply (Part 11, R6, D46): real places of a type (competitors) and overall street activity in
 * up to 8 neighbourhoods of a map city, or within 5 km of a market's centre, counted from OpenStreetMap
 * through the Overpass API. Each area is compared with its city (the map city's counties, an approximate
 * reference), so "what does the block already have too much of" is answered from counts (`mix`). Costs 0
 * Qloo calls: one counts request, the city reference (one, or two when the types span both fixed sets,
 * cached 30 days and pre-warmed) and one names request when places are listed. OpenStreetMap is mapped by
 * volunteers, so every count is a floor, never a census; names stay data for the exhibit and never reach
 * the model.
 */

type SupplyInput = ToolInput<"local_supply">;

/** A market's radius, in metres (DESIGN §3.1). */
export const MARKET_RADIUS_M = 5000;
/** Metrics one call writes at most, so the digest fits; the dataset holds every count. */
export const MAX_SUPPLY_METRICS = 48;
/** Types listed per side of `mix`. */
export const MIX_MAX = 5;
/** Places asked of the names request (the exhibit lists up to SUPPLY_PLACES_MAX named ones). */
const PLACES_LIMIT = 80;
/** The names request takes at most 4 types (OSM_QUERY_LIMITS). */
const PLACES_TYPES_MAX = 4;
/** Types in one counts request (OSM_QUERY_LIMITS.types). */
const COUNT_TYPES_MAX = 24;

const ERROR_TEXT: Readonly<Record<PublicDataErrorCode, string>> = {
  not_configured: PUBLIC_NOT_CONFIGURED_REASON.osm,
  not_found: "OpenStreetMap returned nothing for these areas",
  rate_limited: "the OpenStreetMap service is busy or today's request limit is reached; try again later",
  unavailable: "the OpenStreetMap service could not be reached",
  bad_request: "the OpenStreetMap service refused the request",
  invalid_response: "the OpenStreetMap service returned an answer that could not be read",
};

/** "OpenStreetMap data as of 2026-10-01": the {{PERIOD}} text of an OSM figure (V11). */
export function osmPeriod(osmBase: string | null): string {
  return osmBase === null ? "OpenStreetMap data, date not given" : `OpenStreetMap data as of ${osmBase.slice(0, 10)}`;
}

/** "amenity=cafe", "amenity=restaurant + cuisine=pizza", "shop=*": the tags a type counts, for the exhibit. */
function tagsOf(q: OsmTypeQuery): string[] {
  return q.groups.map((g) => g.map((f) => (f.op === "exists" ? `${f.key}=*` : f.op === "regex" ? `${f.key}~${f.value ?? ""}` : `${f.key}=${f.value ?? ""}`)).join(" + "));
}

/** A lon-first WKT polygon's outer ring as [lat, lon] pairs (the Overpass `poly` order); null when it cannot be read. */
export function ringFromWkt(wkt: string): [number, number][] | null {
  const open = wkt.indexOf("((");
  if (open < 0) return null;
  const close = wkt.indexOf(")", open + 2);
  if (close < 0) return null;
  const ring: [number, number][] = [];
  for (const pair of wkt.slice(open + 2, close).split(",")) {
    const [lon, lat] = pair.trim().split(/\s+/).map(Number);
    if (lon === undefined || lat === undefined || !Number.isFinite(lon) || !Number.isFinite(lat)) return null;
    ring.push([lat, lon]);
  }
  return ring.length >= 3 ? ring : null;
}

async function ensureMetro(geo: GeoApi, metro: MetroId): Promise<void> {
  const ensure = (geo as Partial<{ ensure(metro: MetroId): Promise<void> }>).ensure;
  if (typeof ensure === "function") await ensure.call(geo, metro);
}

interface Subject {
  id: string;
  name: string;
  areaKm2: number;
  shape: OsmShape;
  source?: CandidateSource;
}

const round1 = (x: number): number => Math.round(x * 10) / 10;
const round2 = (x: number): number => Math.round(x * 100) / 100;
const perKm2 = (count: number | null, km2: number): number | null => (count === null || !(km2 > 0) ? null : round2(count / km2));
const ratio = (a: number | null, b: number | null): number | null => (a === null || b === null || !(b > 0) ? null : round2(a / b));

function indexWords(index: number): string {
  if (isAboutLevelDensityIndex(index)) return `about the city's level (${index.toFixed(2)}×)`;
  return index > 1 ? `${round1(index).toFixed(1)}× the city's density` : `${round1(index).toFixed(1)}× the city's density (less than the city)`;
}

/** Errors of a settled public-data call: known codes are kept as the failure; anything else is a bug and is thrown. */
function failureOf(reason: unknown): PublicDataErrorCode {
  const code = publicDataErrorCode(reason);
  if (code === null) throw reason;
  return code;
}

async function runLocalSupply(input: SupplyInput, ctx: SkillCtx): Promise<SkillResult> {
  const out: DigestTarget = { tool: "local_supply", step: input.step_id };
  if (ctx.publicdata === null) return skillErrorResult(out, "Public data (OpenStreetMap) is not available in this run, so no places were counted.");
  const api = ctx.publicdata;

  // Types: the asked keys (an unknown key is an input error naming the valid ones), plus every storefront
  // type with `mix`; street activity always.
  const unknown = input.place_types.filter((k) => k === OSM_ACTIVITY_KEY || osmPlaceType(k) === null);
  if (unknown.length > 0) {
    const valid = osmTags().types.map((t) => t.key);
    return skillErrorResult(out, `INVALID_INPUT: unknown place type ${unknown.map((k) => `'${safeName(k)}'`).join(", ")}; use keys from LOCAL SUPPLY TYPES: ${valid.join(", ")}.`);
  }
  const asked = input.place_types.map((k) => osmPlaceType(k) as OsmPlaceType);
  const activity = osmTags().activity;
  const pool = [...asked, ...(input.mix ? osmTenantTypes() : [])];
  const types: OsmPlaceType[] = [];
  for (const t of pool) if (!types.some((x) => x.key === t.key) && types.length < COUNT_TYPES_MAX - (activity === null ? 0 : 1)) types.push(t);
  const queries: OsmTypeQuery[] = [...types.map((t) => t.query), ...(activity === null ? [] : [activity.query])];
  if (queries.length === 0) return skillErrorResult(out, "No verified OpenStreetMap place type is available in this build, so nothing was counted.");

  // Subjects: the input areas (outline from the gazetteer), or the market's circle.
  const notices: string[] = [];
  const subjects: Subject[] = [];
  const sourceOfArea = (metro: MetroId, id: string): CandidateSource | undefined =>
    ctx.candidates.areas.find((a) => a.metro === metro && a.id === id)?.source;
  let cityLabel: string;
  if (input.metro !== null) {
    const metro = input.metro;
    cityLabel = METRO_LABEL[metro];
    await ensureMetro(ctx.geo, metro);
    for (const id of input.areas) {
      const a = ctx.geo.neighbourhood(metro, id);
      if (a === null) {
        notices.push(`${safeName(id)} is not a ${cityLabel} area in the AREAS list; left out.`);
        continue;
      }
      const wkt = ctx.geo.polygonWkt(metro, id);
      const ring = wkt === null ? null : ringFromWkt(wkt);
      const shape: OsmShape =
        ring === null
          ? { kind: "around", id: a.id, lat: a.centroid.lat, lon: a.centroid.lon, radiusM: Math.max(300, Math.round(Math.sqrt(a.areaKm2 / Math.PI) * 1000)) }
          : { kind: "poly", id: a.id, ring };
      if (ring === null) notices.push(`${safeName(a.name)} has no usable outline, so it was counted in a circle of the same size around its centre.`);
      const source = sourceOfArea(metro, a.id);
      subjects.push({ id: a.id, name: a.name, areaKm2: a.areaKm2, shape, ...(source === undefined ? {} : { source }) });
    }
    if (subjects.length === 0) return skillErrorResult(out, [...notices, `None of the areas is a ${cityLabel} area in the AREAS list.`].join(" "));
  } else {
    const market = input.market as MarketId;
    cityLabel = marketLabel(market);
    const centre = placeSearchArea(market)?.centre ?? null;
    if (centre === null) return skillErrorResult(out, `${safeName(market)} is not a market in MARKETS, so nothing was counted.`);
    const km2 = round2((Math.PI * MARKET_RADIUS_M * MARKET_RADIUS_M) / 1e6);
    const source = ctx.candidates.markets.find((m) => m.id === market)?.source;
    subjects.push({
      id: market,
      name: `${cityLabel} (within ${MARKET_RADIUS_M / 1000} km of the centre)`,
      areaKm2: km2,
      shape: { kind: "around", id: market, lat: centre.lat, lon: centre.lon, radiusM: MARKET_RADIUS_M },
      ...(source === undefined ? {} : { source }),
    });
  }

  // Requests: the counts, the city reference (metro scope only) and the names, in parallel.
  const typeKeys = queries.map((q) => q.key);
  const cityQueries = input.metro === null ? [] : osmCityQueries(input.metro, typeKeys);
  const cityMeta = input.metro === null ? null : osmMetro(input.metro);
  const placesTypes = asked.slice(0, PLACES_TYPES_MAX);
  const countsCall = api.osmCounts({ shapes: subjects.map((s) => s.shape), types: queries });
  const cityCalls = cityQueries.map((q) => api.osmCounts(q));
  const first = subjects[0] as Subject;
  // Names only after the counts answered: OpenStreetMap requests share one slot, the counts are the answer and
  // names without them are never shown, so a slow names query never starves the counts (live, both timed out).
  const namesCall =
    input.list_places && placesTypes.length > 0
      ? countsCall.then(() => api.osmPlaces({ shape: first.shape, types: placesTypes.map((t) => t.query), limit: PLACES_LIMIT }))
      : null;
  const [countsR, namesR, ...cityRs] = await Promise.allSettled([countsCall, namesCall ?? Promise.resolve(null), ...cityCalls]);

  const calls: PublicCallMeta[] = [];
  let failure: PublicDataErrorCode | null = null;
  let counts: OsmCounts | null = null;
  if (countsR.status === "fulfilled") {
    counts = countsR.value.data;
    calls.push(countsR.value.meta);
  } else failure = failureOf(countsR.reason);
  const cityCounts: Record<string, number> = {};
  let cityOk = cityQueries.length > 0;
  for (const r of cityRs) {
    if (r.status === "rejected") {
      failureOf(r.reason);
      cityOk = false;
      continue;
    }
    if (r.value === null) continue;
    calls.push(r.value.meta);
    for (const byType of Object.values(r.value.data.counts)) for (const [k, v] of Object.entries(byType)) cityCounts[k] = v;
  }
  let places: OsmPlace[] = [];
  let namesFailed = false;
  if (namesR.status === "fulfilled" && namesR.value !== null) {
    places = namesR.value.data;
    calls.push(namesR.value.meta);
  } else if (namesR.status === "rejected") {
    failureOf(namesR.reason);
    namesFailed = true;
  }

  const flags = new Set<Flag>(["OSM_SUPPLY_FLOOR"]);
  if (calls.some((c) => c.stale)) flags.add("STALE_CACHE");
  const evidence = addSkillEvidence(ctx.ledger, {
    skill: "local_supply",
    source: "osm",
    purpose: `OpenStreetMap places in ${subjects.length === 1 ? safeName(first.name) : `${subjects.length} ${cityLabel} areas`}`,
    calls,
    status: counts === null ? "error" : cityOk || input.metro === null ? (namesFailed ? "partial" : "ok") : "partial",
    summary:
      counts === null
        ? `No counts came back: ${ERROR_TEXT[failure ?? "unavailable"]}.`
        : `Counts for ${subjects.length} ${subjects.length === 1 ? "area" : "areas"} and ${queries.length} place types over ${calls.length} OpenStreetMap ${calls.length === 1 ? "request" : "requests"}.`,
    flags: [...flags],
  });
  const evidenceIds: EvidenceId[] = evidence === null ? [] : [evidence.id];
  if (counts === null) {
    return skillErrorResult(out, [...notices, `No places counted: ${ERROR_TEXT[failure ?? "unavailable"]}. None are estimated.`].join(" "));
  }
  const period = osmPeriod(counts.osmBase);

  // The city reference (map city only): counts over its counties ÷ their land area.
  const cityKm2 = cityMeta?.landKm2 ?? null;
  const city: SupplyPayload["city"] =
    input.metro !== null && cityOk && cityKm2 !== null && cityKm2 > 0
      ? {
          label: `${cityLabel} (${cityMeta?.counties.length === 1 ? "its county" : "its counties"})`,
          areaKm2: round1(cityKm2),
          approximate: true,
          counts: Object.fromEntries(types.map((t) => [t.key, cityCounts[t.key] ?? null])),
          perKm2: Object.fromEntries(types.map((t) => [t.key, perKm2(cityCounts[t.key] ?? null, cityKm2)])),
          activityPerKm2: activity === null ? null : perKm2(cityCounts[OSM_ACTIVITY_KEY] ?? null, cityKm2),
        }
      : null;
  if (input.metro !== null && city === null) {
    notices.push(
      cityQueries.length === 0
        ? `${cityLabel} has no verified county set, so areas are not compared with the city.`
        : `The ${cityLabel} city reference could not be read now, so areas are not compared with the city (index not measured).`,
    );
  }

  // Rows.
  const rows: SupplyRow[] = subjects.map((s) => {
    const own = counts?.counts[s.id] ?? {};
    const c = Object.fromEntries(types.map((t) => [t.key, own[t.key] ?? null])) as Record<string, number | null>;
    const d = Object.fromEntries(types.map((t) => [t.key, perKm2(c[t.key] ?? null, s.areaKm2)])) as Record<string, number | null>;
    const idx = Object.fromEntries(types.map((t) => [t.key, city === null ? null : ratio(d[t.key] ?? null, city.perKm2[t.key] ?? null)])) as Record<string, number | null>;
    const act = activity === null ? null : (own[OSM_ACTIVITY_KEY] ?? null);
    return {
      id: s.id,
      name: safeFullName(s.name),
      areaKm2: round2(s.areaKm2),
      ...(s.source === undefined ? {} : { source: s.source }),
      counts: c,
      perKm2: d,
      index: idx,
      activity: act,
      activityPerKm2: perKm2(act, s.areaKm2),
    };
  });

  // Mix: what the first area has more and less of than its city, beyond its overall street activity (SUPPLY).
  const activityIndexOf = (r: SupplyRow): number | null => ratio(r.activityPerKm2, city?.activityPerKm2 ?? null);
  const firstRow = rows[0] as SupplyRow;
  const firstActivity = activityIndexOf(firstRow);
  const mixItems = types
    .map((t) => ({ typeKey: t.key, index: firstRow.index[t.key] ?? null, count: firstRow.counts[t.key] ?? null, cityPerKm2: city?.perKm2[t.key] ?? null, activityIndex: firstActivity }))
    .filter((m): m is { typeKey: string; index: number; count: number; cityPerKm2: number | null; activityIndex: number | null } => m.index !== null && m.count !== null);
  const mix: SupplyPayload["mix"] = input.mix
    ? {
        over: mixItems
          .filter((m) => isOversupplied(m))
          .sort((a, b) => b.index - a.index)
          .slice(0, MIX_MAX)
          .map(({ typeKey, index, count }) => ({ typeKey, index, count })),
        under: mixItems
          .filter((m) => isUndersupplied(m))
          .sort((a, b) => a.index - b.index)
          .slice(0, MIX_MAX)
          .map(({ typeKey, index, count }) => ({ typeKey, index, count })),
      }
    : null;

  // Places: named ones only, at most SUPPLY_PLACES_MAX, each tied to the first area.
  const listed = places
    .filter((p) => p.name.trim() !== "")
    .slice(0, SUPPLY_PLACES_MAX)
    .map((p) => ({
      name: safeFullName(p.name),
      brand: p.brand === null ? null : safeFullName(p.brand),
      lat: p.lat,
      lon: p.lon,
      typeKey: p.typeKey,
      area: input.metro === null ? null : first.id,
      osmUrl: `https://www.openstreetmap.org/${p.osmType}/${p.osmId}`,
    }));
  if (input.list_places && placesTypes.length === 0) notices.push("Named places are listed only for asked place types; none were asked, so no names were listed.");
  if (namesFailed) notices.push("The named places could not be read now; the counts stand.");

  // Metrics: per area the asked types (all types without mix), count, density and index; street activity.
  const metricTypes = input.mix && asked.length === 0 ? types.filter((t) => mix?.over.some((m) => m.typeKey === t.key) || mix?.under.some((m) => m.typeKey === t.key)) : asked.length > 0 ? asked : types;
  const metrics: Metric[] = [];
  const byRow = new Map<string, Record<string, string>>();
  const label = (t: OsmPlaceType): string => t.label;
  const room = (): boolean => metrics.length < MAX_SUPPLY_METRICS;
  let trimmed = false;
  for (const [i, r] of rows.entries()) {
    const s = subjects[i] as Subject;
    const refs = [s.id, ...(input.metro === null ? [] : [input.metro])];
    const ids: Record<string, string> = { area: s.id };
    if (activity !== null && room()) {
      const v = r.activityPerKm2;
      const m = addSkillMetric(ctx.ledger, {
        key: "osm.activity_density",
        label: `Shops, food and drink places per km², ${safeName(s.name)}`,
        subjectRefs: refs,
        value: v,
        reason: "not_measured",
        display: v === null ? "" : `${round1(v).toFixed(1)} per km²${city?.activityPerKm2 != null ? ` (city ${round1(city.activityPerKm2).toFixed(1)})` : ""}`,
        unit: "ratio",
        badge: "DERIVED",
        formulaId: "osm.activity_density",
        evidenceIds,
        n: r.activity,
        comparator: city === null ? null : "CITY",
        period,
      });
      metrics.push(m);
      ids.activity = m.id;
    }
    for (const t of metricTypes) {
      if (metrics.length + 3 > MAX_SUPPLY_METRICS) {
        trimmed = true;
        break;
      }
      const count = r.counts[t.key] ?? null;
      const density = r.perKm2[t.key] ?? null;
      const index = r.index[t.key] ?? null;
      const mc = addSkillMetric(ctx.ledger, {
        key: `osm.count.${t.key}`,
        label: `${label(t)} mapped, ${safeName(s.name)}`,
        subjectRefs: refs,
        value: count,
        reason: "not_measured",
        display: count === null ? "" : `${count} ${count === 1 ? "place" : "places"}`,
        unit: "count",
        badge: "MEASURED",
        formulaId: "osm.count",
        evidenceIds,
        n: count,
        comparator: null,
        period,
      });
      const md = addSkillMetric(ctx.ledger, {
        key: `osm.density.${t.key}`,
        label: `${label(t)} per km², ${safeName(s.name)}`,
        subjectRefs: refs,
        value: density,
        reason: "not_measured",
        display: density === null ? "" : `${density.toFixed(2)} per km²`,
        unit: "ratio",
        badge: "DERIVED",
        formulaId: "osm.density",
        evidenceIds,
        n: count,
        comparator: null,
        period,
      });
      const mi = addSkillMetric(ctx.ledger, {
        key: `osm.density_index.${t.key}`,
        label: `${label(t)} against the city, ${safeName(s.name)}`,
        subjectRefs: refs,
        value: index,
        reason: city === null ? "not_measured" : "not_measured",
        display: index === null ? "" : indexWords(index),
        unit: "index",
        badge: "DERIVED",
        formulaId: "osm.density_index",
        evidenceIds,
        n: count,
        comparator: "CITY",
        period,
        aboutLevel: isAboutLevelDensityIndex(index),
      });
      metrics.push(mc, md, mi);
      ids[t.key] = `${mc.id} ${md.id} ${mi.id}`;
    }
    byRow.set(s.id, ids);
  }
  if (trimmed) notices.push(`Metrics cover the first areas and types only; the table holds every count.`);

  // Dataset.
  const dataset = ctx.ledger.addDataset({
    kind: "Supply",
    title: `Places nearby · ${subjects.length === 1 ? safeName(first.name) : `${cityLabel} areas`} (OpenStreetMap)`,
    evidenceIds: [...evidenceIds],
    formulaIds: ["osm.count", "osm.density", "osm.density_index", "osm.activity_density"],
    payload: {
      source: "osm",
      attribution: OSM_ATTRIBUTION,
      licence: OSM_LICENCE,
      licenceUrl: OSM_LICENCE_URL,
      osmBase: counts.osmBase,
      scope: input.metro === null ? "market" : "areas",
      metro: input.metro,
      market: input.market,
      radiusKm: input.metro === null ? MARKET_RADIUS_M / 1000 : null,
      types: types.map((t) => ({ key: t.key, label: t.label, tags: tagsOf(t.query) })),
      rows,
      city,
      mix,
      places: listed,
      completeness: OSM_COMPLETENESS,
      caption: `${supplySourceLine(counts.osmBase)}. ${OSM_COMPLETENESS} Counts are of mapped places, not sales, rents or foot traffic${city === null ? "" : `; "against the city" compares each area's density with ${city.label}, an approximate reference`}.`,
    } satisfies SupplyPayload,
  });
  const datasetIds: DatasetId[] = [dataset.id];

  // Findings.
  const findings: Finding[] = [];
  const addFinding = (draft: FindingDraft | null, metricIds: readonly string[]): void => {
    if (draft === null) return;
    findings.push(ctx.ledger.addFinding({ ...draft, metricIds: metricIds.filter((id) => metrics.some((m) => m.id === id)) as Metric["id"][] }));
  };
  const indexMetric = (areaId: string, key: string): string[] =>
    metrics.filter((m) => m.key === `osm.density_index.${key}` && m.subjectRefs[0] === areaId).map((m) => m.id);
  if (city !== null) {
    const candidates: (SupplyCandidate & { areaId: string; key: string })[] = rows.flatMap((r) =>
      types.map((t) => ({
        area: r.name,
        areaId: r.id,
        key: t.key,
        typeLabel: t.label,
        count: r.counts[t.key] ?? null,
        index: r.index[t.key] ?? null,
        cityPerKm2: city.perKm2[t.key] ?? null,
        activityIndex: activityIndexOf(r),
      })),
    );
    const relevant = candidates.filter((c) => asked.length === 0 || asked.some((t) => t.key === c.key));
    // Each finding cites the index metrics of the types it names, then the street activity it is read against.
    const activityMetric = (areaId: string): string[] => metrics.filter((m) => m.key === "osm.activity_density" && m.subjectRefs[0] === areaId).map((m) => m.id);
    const citeOf = (pick: (c: (typeof relevant)[number]) => boolean): string[] => {
      const hit = relevant.filter(pick);
      return [...hit.flatMap((c) => indexMetric(c.areaId, c.key)).slice(0, 3), ...(hit[0] === undefined ? [] : activityMetric(hit[0].areaId))];
    };
    addFinding(oversuppliedFinding({ cityLabel, candidates: relevant }), citeOf(isOversupplied));
    addFinding(undersuppliedFinding({ cityLabel, candidates: relevant }), citeOf(isUndersupplied));
    addFinding(
      lowStreetActivityFinding({ cityLabel, areas: rows.map((r) => ({ area: r.name, activityPerKm2: r.activityPerKm2 })), cityActivityPerKm2: city.activityPerKm2 }),
      metrics.filter((m) => m.key === "osm.activity_density").map((m) => m.id).slice(0, 3),
    );
  }

  // Digest rows: counts, densities, index and activity per area, and the mix; names only as a count.
  const typeLabel = (key: string): string => types.find((t) => t.key === key)?.label ?? key;
  const digestRows: DigestRow[] = rows.map((r) => ({
    ref: null,
    name: safeName(r.name),
    values: {
      ...(byRow.get(r.id) ?? { area: r.id }),
      ...(r.activityPerKm2 === null ? {} : { activity_per_km2: round1(r.activityPerKm2) }),
      ...Object.fromEntries(
        (metricTypes.length > 0 ? metricTypes : types).slice(0, 6).map((t) => [
          `${t.key}`,
          `${r.counts[t.key] ?? "n/a"} (${r.perKm2[t.key] === null || r.perKm2[t.key] === undefined ? "n/a" : (r.perKm2[t.key] as number).toFixed(2)}/km², ${r.index[t.key] === null || r.index[t.key] === undefined ? "index n/a" : isAboutLevelDensityIndex(r.index[t.key]) ? "about the city's level" : `index ${(r.index[t.key] as number).toFixed(2)}`})`,
        ]),
      ),
    },
  }));
  if (mix !== null) {
    if (mix.over.length > 0) notices.push(`${safeName(first.name)} has more than the city of: ${mix.over.map((m) => `${typeLabel(m.typeKey)} (${m.index.toFixed(2)}×, ${m.count})`).join(", ")}.`);
    if (mix.under.length > 0) notices.push(`${safeName(first.name)} has less than the city of: ${mix.under.map((m) => `${typeLabel(m.typeKey)} (${m.index.toFixed(2)}×, ${m.count})`).join(", ")}.`);
    if (mix.over.length === 0 && mix.under.length === 0 && city !== null) notices.push(`${safeName(first.name)} has no storefront type clearly above or below the city's level.`);
  }
  if (listed.length > 0) notices.push(`${listed.length} named places are listed in the exhibit ${dataset.id} (names stay in the exhibit).`);
  notices.push(`OpenStreetMap counts are a floor, not a census (${period}); cite each with its {{PERIOD:M#}} token and keep them apart from Qloo's venue sample.`);

  const status: SkillStatus = (input.metro !== null && city === null) || namesFailed ? "partial" : "ok";
  return skillResult({ status, evidenceIds, datasetIds, metrics, rows: digestRows, findings, flags, registered: [], notices }, out);
}

export const localSupplySkill: SkillFor<"local_supply"> = {
  id: "local_supply",
  mnemonic: "SUPP",
  kitWorkflows: ANALYST_TOOLS.local_supply.kitWorkflows,
  input: ANALYST_TOOLS.local_supply.input,
  // OpenStreetMap reads cost no Qloo calls; their pace and daily cap are the public-data client's.
  estimateCalls: async () => 0,
  run: runLocalSupply,
  limitations: () => [...SKILL_LIMITATIONS.local_supply],
};
