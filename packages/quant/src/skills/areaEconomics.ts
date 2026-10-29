import {
  PUBLIC_NOT_CONFIGURED_REASON,
  ANALYST_TOOLS,
  METRO_LABEL,
  publicDataErrorCode,
  type CensusAcsData,
  type CensusField,
  type CensusRow,
  type DatasetId,
  type DigestRow,
  type EvidenceId,
  type Flag,
  type Metric,
  type MetricUnit,
  type Neighbourhood,
  type PublicCallMeta,
  type PublicDataErrorCode,
  type RankedRow,
  type SkillCtx,
  type SkillFor,
  type SkillResult,
  type SkillStatus,
  type ToolInput,
  type ValueCell,
} from "@ct/contracts";
import type { FormulaId } from "../formulas";
import { SKILL_LIMITATIONS } from "../limitations";
import { addSkillEvidence, addSkillMetric } from "./common";
import { skillErrorResult, skillResult, type DigestTarget } from "./digest";
import { safeFullName, safeName } from "./format";
import {
  censusCrosswalkOf,
  censusGeosOf,
  COMMUTE_FIELDS,
  rollUpUnits,
  unitIdsOf,
  type AreaCensusUnits,
  type CommuteField,
  type Rollup,
} from "./areaEconomics/rollup";

/**
 * S14 area_economics (PLAN §5.2, D40, SPEC S14): who lives in up to 12 neighbourhoods of a map city,
 * from US Census ACS 5-year estimates: population, median age, households, median household income
 * and commute mode, with a whole-city row to compare with. Each area is its Census units (ZIP code
 * tabulation areas, or 2020 tracts in New York and Austin) from @ct/geo's crosswalk; one ACS request
 * covers the city's ZCTAs, or one per county for tracts, pinned per vintage. Costs 0 Qloo calls.
 * Only the fixed field set is ever requested (no race, religion or other sensitive fields).
 */

type EconInput = ToolInput<"area_economics">;

/** The fields that get a metric, most decision-relevant first; the dataset holds every field. */
type MetricField = "population" | "median_household_income" | "median_age" | "households" | CommuteField;
const METRIC_FIELDS: readonly MetricField[] = [
  "population",
  "median_household_income",
  "median_age",
  "households",
  "commute_drove_alone",
  "commute_public_transit",
  "commute_worked_from_home",
  "commute_walked",
  "commute_bicycle",
];
/** Metrics a run writes at most, so the digest fits whatever the number of areas: fields per subject shrink with more areas. */
export const MAX_ECON_METRICS = 30;
/** Every subject keeps at least population and median household income. */
const MIN_FIELDS = 2;

export function fieldsPerSubject(subjects: number): number {
  return Math.max(MIN_FIELDS, Math.min(METRIC_FIELDS.length, Math.floor(MAX_ECON_METRICS / Math.max(1, subjects))));
}

const FIELD_LABEL: Readonly<Record<MetricField, string>> = {
  population: "Residents",
  households: "Households",
  median_age: "Median age",
  median_household_income: "Median household income",
  commute_drove_alone: "Workers who drive to work alone",
  commute_public_transit: "Workers who take public transit",
  commute_walked: "Workers who walk to work",
  commute_bicycle: "Workers who cycle to work",
  commute_worked_from_home: "Workers who work from home",
};

const FIELD_UNIT: Readonly<Record<MetricField, MetricUnit>> = {
  population: "people",
  households: "count",
  median_age: "years",
  median_household_income: "usd",
  commute_drove_alone: "pct",
  commute_public_transit: "pct",
  commute_walked: "pct",
  commute_bicycle: "pct",
  commute_worked_from_home: "pct",
};

const FIELD_KEY: Readonly<Record<MetricField, string>> = {
  population: "econ.population",
  households: "econ.households",
  median_age: "econ.median_age",
  median_household_income: "econ.median_hh_income",
  commute_drove_alone: "econ.commute_drove_alone",
  commute_public_transit: "econ.commute_public_transit",
  commute_walked: "econ.commute_walked",
  commute_bicycle: "econ.commute_bicycle",
  commute_worked_from_home: "econ.commute_worked_from_home",
};

const isCommute = (f: MetricField): f is CommuteField => (COMMUTE_FIELDS as readonly string[]).includes(f);
const isMedian = (f: MetricField): boolean => f === "median_age" || f === "median_household_income";
const formulaOf = (f: MetricField): FormulaId => (isCommute(f) ? "econ.share" : isMedian(f) ? "econ.median" : "econ.count");

function valueOf(r: Rollup, f: MetricField): number | null {
  if (isCommute(f)) return r.shares[f];
  if (f === "median_age" || f === "median_household_income") return r.medians[f];
  return r.counts[f];
}

/**
 * A value as a reader sees it: "41,200 residents", "$71,200 (approx.)", "12% of workers". `scope` marks
 * figures that cover more than the row's area ("whole ZIP"), so every citation of one carries it.
 */
function display(f: MetricField, v: number, approx: boolean, scope: string | null = null): string {
  const notes = [isMedian(f) && approx ? "approx." : null, scope].filter((x): x is string => x !== null);
  const a = notes.length > 0 ? ` (${notes.join(", ")})` : "";
  switch (f) {
    case "population":
      return `${Math.round(v).toLocaleString("en-US")} residents${a}`;
    case "households":
      return `${Math.round(v).toLocaleString("en-US")} households${a}`;
    case "median_age":
      return `${v.toFixed(1)} years${a}`;
    case "median_household_income":
      return `$${Math.round(v).toLocaleString("en-US")}${a}`;
    default:
      return `${Math.round(v * 100)}% of resident workers${a}`;
  }
}

/** "ACS 2019-2023 5-year": the {{PERIOD}} text of a Census figure. */
export function vintageText(vintage: number): string {
  return `ACS ${vintage - 4}-${vintage} 5-year`;
}

const ERROR_TEXT: Readonly<Record<PublicDataErrorCode, string>> = {
  not_configured: PUBLIC_NOT_CONFIGURED_REASON.census,
  not_found: "Census returned no rows for these areas",
  rate_limited: "the Census API asked us to slow down; try again shortly",
  unavailable: "the Census API could not be reached",
  bad_request: "the Census API refused the request",
  invalid_response: "the Census API returned an answer that could not be read",
};

interface Subject {
  key: string;
  name: string;
  /** The area id, or the metro id for the whole-city row. */
  ref: string;
  units: AreaCensusUnits[];
  isCity: boolean;
}

/** True when some of the subject's units are whole ZIP areas that reach beyond it. */
const hasClippedZip = (s: Subject): boolean => s.units.some((u) => u.kind === "zcta" && u.clipped);

/** The display note of figures that cover more than the row: whole ZIPs for part of one (one ZIP, or the city's border ZIPs). */
function scopeOf(s: Subject): string | null {
  if (!hasClippedZip(s)) return null;
  return s.isCity ? "whole ZIPs" : "whole ZIP";
}

/** Why a subject's figures are approximate beyond the rollup: whole ZIPs for part of one, a nearest tract. */
function caveatOf(s: Subject): string | null {
  if (s.isCity) return hasClippedZip(s) ? "border ZIP areas count in full, so the figures cover more than the city itself" : null;
  const u = s.units[0];
  if (u === undefined) return null;
  if (u.kind === "zcta" && u.clipped) return "the area is part of its ZIP area, so whole-ZIP figures are used";
  if (u.kind === "tract" && u.nearestOnly) return "no census tract centre lies in the area, so the nearest tract is used and it reaches beyond the area";
  return null;
}

async function runAreaEconomics(input: EconInput, ctx: SkillCtx): Promise<SkillResult> {
  const out: DigestTarget = { tool: "area_economics", step: input.step_id };
  const metro = input.metro;
  const city = METRO_LABEL[metro];
  if (ctx.publicdata === null) return skillErrorResult(out, "Public data (US Census) is not available in this run, so no area figures were read.");
  const crosswalk = censusCrosswalkOf(ctx.geo);
  if (crosswalk === null) return skillErrorResult(out, "This build has no Census crosswalk for neighbourhoods, so no area figures can be read.");

  const notices: string[] = [];
  const named: Neighbourhood[] = [];
  for (const id of input.areas) {
    const a = ctx.geo.neighbourhood(metro, id);
    if (a === null) notices.push(`${id} is not a ${city} area in the AREAS list; left out.`);
    else named.push(a);
  }
  if (named.length === 0) return skillErrorResult(out, [...notices, `None of the areas is a ${city} area in the AREAS list.`].join(" "));

  const [areaUnits, cityUnits] = await Promise.all([Promise.all(named.map((a) => crosswalk.censusUnits(metro, a.id))), crosswalk.censusUnitsOfMetro(metro)]);
  const subjects: Subject[] = named.flatMap((a, i): Subject[] => {
    const u = areaUnits[i];
    if (u === null || u === undefined || unitIdsOf(u).length === 0) {
      notices.push(`${safeName(a.name)} has no Census units in the crosswalk; left out.`);
      return [];
    }
    return [{ key: a.id, name: a.name, ref: a.id, units: [u], isCity: false }];
  });
  if (subjects.length === 0) return skillErrorResult(out, [...notices, "No area maps to Census units."].join(" "));
  // A city clipped from border ZIPs is read as those whole ZIPs: its row says so instead of "All of".
  const cityRowName = cityUnits.some((u) => u.kind === "zcta" && u.clipped) ? `${city} ZIP areas (whole ZIPs)` : `All of ${city}`;
  subjects.push({ key: metro, name: cityRowName, ref: metro, units: cityUnits, isCity: true });

  // One request per geography the city's units need; the areas' units are a subset.
  const geos = censusGeosOf(cityUnits.length > 0 ? cityUnits : subjects.flatMap((s) => s.units));
  const calls: PublicCallMeta[] = [];
  const rows = new Map<string, CensusRow>();
  let vintage: number | null = null;
  const vintages = new Set<number>();
  let failure: PublicDataErrorCode | null = null;
  const results = await Promise.allSettled(geos.map((g) => (ctx.publicdata as NonNullable<SkillCtx["publicdata"]>).censusAcs(g)));
  for (const r of results) {
    if (r.status === "rejected") {
      const code = publicDataErrorCode(r.reason);
      if (code === null) throw r.reason;
      failure ??= code;
      continue;
    }
    calls.push(r.value.meta);
    const data: CensusAcsData = r.value.data;
    vintages.add(data.vintage);
    vintage = Math.max(vintage ?? 0, data.vintage);
    for (const row of data.rows) rows.set(row.geoId, row);
  }

  const flags = new Set<Flag>(["CENSUS_RESIDENTS_ONLY"]);
  if (calls.some((c) => c.stale)) flags.add("STALE_CACHE");
  const evidence =
    calls.length === 0
      ? null
      : addSkillEvidence(ctx.ledger, {
          skill: "area_economics",
          source: "census",
          purpose: `US Census ACS 5-year estimates for ${city} areas${vintage === null ? "" : ` (${vintageText(vintage)})`}`,
          calls,
          status: failure === null ? "ok" : "partial",
          summary: `${rows.size} Census units returned over ${calls.length} of ${geos.length} requests${failure === null ? "" : `; ${ERROR_TEXT[failure]}`}.`,
          flags: [...flags],
        });
  const evidenceIds: EvidenceId[] = evidence === null ? [] : [evidence.id];
  if (vintage === null) {
    const why = failure === null ? "the Census API returned nothing" : ERROR_TEXT[failure];
    return skillErrorResult(out, [...notices, `No area figures for ${city}: ${why}. None are estimated.`].join(" "));
  }
  if (vintages.size > 1) notices.push(`The Census answers came from different releases (${[...vintages].sort().join(", ")}); the latest is named.`);
  const period = vintageText(vintage);

  // Rollups and metrics.
  const rolled = subjects.map((s) => ({ s, r: rollUpUnits(s.units.flatMap(unitIdsOf), rows) }));
  const perSubject = fieldsPerSubject(subjects.length);
  const fields = METRIC_FIELDS.slice(0, perSubject);
  const metrics: Metric[] = [];
  const bySubject = new Map<string, Map<MetricField, Metric>>();
  for (const { s, r } of rolled) {
    const own = new Map<MetricField, Metric>();
    const caveat = caveatOf(s);
    for (const f of fields) {
      const v = valueOf(r, f);
      const withheld = (r.withheld[f] ?? 0) > 0 || r.found < r.units;
      const approx = (isMedian(f) && r.found > 1) || caveat !== null || withheld;
      const badge = approx ? "ESTIMATED" : r.found === 1 && !isCommute(f) ? "MEASURED" : "DERIVED";
      const m = addSkillMetric(ctx.ledger, {
        key: FIELD_KEY[f],
        label: `${FIELD_LABEL[f]}, ${safeName(s.name)}`,
        subjectRefs: [s.ref, metro],
        value: v,
        reason: r.found === 0 ? (failure === null ? "not_measured" : failure === "not_configured" ? "not_configured" : "unavailable") : "suppressed",
        display: v === null ? "" : display(f, v, approx, scopeOf(s)),
        unit: FIELD_UNIT[f],
        badge,
        formulaId: formulaOf(f),
        evidenceIds,
        n: null,
        comparator: s.isCity ? null : "CITY",
        period,
      });
      metrics.push(m);
      own.set(f, m);
    }
    bySubject.set(s.key, own);
  }

  // Dataset: every field, areas then the whole city.
  const cell = (v: number | null, found: number): ValueCell =>
    v === null ? { value: null, reason: found === 0 ? "not_measured" : "suppressed" } : { value: v, reason: null };
  const allFields: { f: CensusField | CommuteField; label: string; unit: MetricUnit; get: (r: Rollup) => number | null }[] = [
    { f: "population", label: "Residents", unit: "people", get: (r) => r.counts.population },
    { f: "households", label: "Households", unit: "count", get: (r) => r.counts.households },
    { f: "median_age", label: "Median age", unit: "years", get: (r) => r.medians.median_age },
    { f: "median_household_income", label: "Median household income", unit: "usd", get: (r) => r.medians.median_household_income },
    { f: "commute_drove_alone", label: "Drive alone", unit: "pct", get: (r) => r.shares.commute_drove_alone },
    { f: "commute_public_transit", label: "Public transit", unit: "pct", get: (r) => r.shares.commute_public_transit },
    { f: "commute_walked", label: "Walk", unit: "pct", get: (r) => r.shares.commute_walked },
    { f: "commute_bicycle", label: "Cycle", unit: "pct", get: (r) => r.shares.commute_bicycle },
    { f: "commute_worked_from_home", label: "Work from home", unit: "pct", get: (r) => r.shares.commute_worked_from_home },
  ];
  const unitWord = (s: Subject, r: Rollup): string => {
    const kind = s.units[0]?.kind === "tract" ? "census tract" : "ZIP area";
    return `${r.found} of ${r.units} ${kind}${r.units === 1 ? "" : "s"}`;
  };
  const row = ({ s, r }: (typeof rolled)[number]): RankedRow => ({
    key: s.key,
    rank: null,
    label: safeFullName(s.name),
    sublabel: [unitWord(s, r), caveatOf(s)].filter((x): x is string => x !== null).join(" · "),
    ref: null,
    tagRef: null,
    type: null,
    cells: allFields.map((c) => cell(c.get(r), r.found)),
    flags: [],
    explain: [],
  });
  const dataset = ctx.ledger.addDataset({
    kind: "Ranked",
    title: `Who lives there · ${city} areas (${period})`,
    evidenceIds: [...evidenceIds],
    formulaIds: ["econ.count", "econ.median", "econ.share"],
    payload: {
      columns: allFields.map((c) => ({ key: c.f, label: c.label, unit: c.unit, comparator: null })),
      groups: [
        { key: "areas", label: "Areas", rows: rolled.filter((x) => !x.s.isCity).map(row) },
        { key: "city", label: `${cityRowName}, to compare with`, rows: rolled.filter((x) => x.s.isCity).map(row) },
      ],
      caption:
        `US Census ACS 5-year estimates, ${vintage - 4}-${vintage}: people who live in each area, not visitors, customers or spending. ` +
        "Counts add up the Census units in each area; medians are population-weighted averages of the units' medians, so they are approximate. " +
        "Commute shares are of resident workers 16 and over.",
    },
  });
  const datasetIds: DatasetId[] = [dataset.id];

  // Notices.
  for (const { s } of rolled) {
    const caveat = caveatOf(s);
    if (caveat !== null) notices.push(`${safeName(s.name)}: ${caveat}.`);
  }
  const withheld = rolled.filter(({ r }) => r.found < r.units || Object.keys(r.withheld).length > 0).map(({ s }) => safeName(s.name));
  if (withheld.length > 0) notices.push(`Census withheld some unit estimates for ${withheld.join(", ")}; those units are left out of the sums and averages.`);
  if (failure !== null) notices.push(`Part of the Census data is missing: ${ERROR_TEXT[failure]}.`);
  if (perSubject < METRIC_FIELDS.length) {
    notices.push(`With ${subjects.length} rows, metrics cover ${fields.map((f) => FIELD_LABEL[f].toLowerCase()).join(", ")}; the table ${dataset.id} holds every field.`);
  }
  notices.push(`These describe residents (${period}), not customers or foot traffic; cite each figure with its {{PERIOD:M#}} token and keep it apart from taste signals.`);

  const digestRows: DigestRow[] = rolled.map(({ s }) => ({
    ref: null,
    name: safeName(s.name),
    values: Object.fromEntries([["area", s.ref], ...[...(bySubject.get(s.key) ?? new Map<MetricField, Metric>())].map(([f, m]) => [f, m.id])]),
  }));
  const status: SkillStatus = failure !== null || withheld.length > 0 ? "partial" : "ok";
  return skillResult(
    { status, evidenceIds, datasetIds, metrics, rows: digestRows, findings: [], flags, registered: [], notices },
    out,
  );
}

export const areaEconomicsSkill: SkillFor<"area_economics"> = {
  id: "area_economics",
  mnemonic: "ECON",
  kitWorkflows: ANALYST_TOOLS.area_economics.kitWorkflows,
  input: ANALYST_TOOLS.area_economics.input,
  // Census calls cost no Qloo calls; their pace is the public-data client's.
  estimateCalls: async () => 0,
  run: runAreaEconomics,
  limitations: () => [...SKILL_LIMITATIONS.area_economics],
};
