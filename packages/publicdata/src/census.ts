import { CensusField, PUBLIC_ENDPOINTS, type CensusAcsData, type CensusGeo, type CensusRow } from "@ct/contracts";
import { z } from "zod";
import { PublicDataError, type PublicRequest } from "./api";

/**
 * US Census ACS 5-year (PLAN §5.2) through the Census Data API: `api.census.gov/data/<vintage>/acs/acs5`.
 * Only the fixed CensusField set is ever requested; nothing touches race, ethnicity, ancestry,
 * religion, language, disability, citizenship or any other sensitive table. Variable ids were checked
 * live against the 2023 and 2024 variable lists (same ids and meaning in both).
 */

export const CENSUS_HOST = PUBLIC_ENDPOINTS["/data/acs/acs5"].host;

/** Each field's ACS 5-year variable (estimate). The only variables this package ever puts in `get`. */
export const CENSUS_VARIABLES: Readonly<Record<CensusField, string>> = {
  population: "B01003_001E", // Total Population: Total
  median_age: "B01002_001E", // Median Age by Sex: Median age, Total
  households: "B11001_001E", // Household Type: Total households
  median_household_income: "B19013_001E", // Median Household Income in the Past 12 Months (inflation-adjusted)
  workers: "B08301_001E", // Means of Transportation to Work: Total (workers 16 and over)
  commute_drove_alone: "B08301_003E", // Car, truck, or van: Drove alone
  commute_public_transit: "B08301_010E", // Public transportation (excluding taxicab)
  commute_bicycle: "B08301_018E", // Bicycle
  commute_walked: "B08301_019E", // Walked
  commute_worked_from_home: "B08301_021E", // Worked from home
};

/** The ACS tables the variables come from: population, age, households, income and commute mode only. */
export const CENSUS_TABLES = ["B01003", "B01002", "B11001", "B19013", "B08301"] as const;

const ALLOWED_VARIABLES: ReadonlySet<string> = new Set(Object.values(CENSUS_VARIABLES));

/** The `get` list, in CensusField order. */
export const CENSUS_GET = CensusField.options.map((field) => CENSUS_VARIABLES[field]).join(",");

/** Throws unless every variable of a `get` list is one of the fixed set. Checked on every request. */
export function assertAllowedVariables(get: string): void {
  for (const variable of get.split(",")) {
    if (!ALLOWED_VARIABLES.has(variable)) {
      throw new PublicDataError("bad_request", `ACS variable ${variable} is outside the fixed field set`, { source: "census" });
    }
  }
}

const ZCTA_COLUMN = "zip code tabulation area";
/** Upper bound of ZCTAs in one request, to keep the URL short. */
export const MAX_ZCTAS_PER_REQUEST = 200;

/** The geography, validated and canonical: ZCTAs de-duplicated and sorted; FIPS codes checked. */
export function canonicalGeo(geo: CensusGeo): CensusGeo {
  if (geo.kind === "zcta") {
    const zctas = [...new Set(geo.zctas.map((z) => z.trim()))].sort();
    if (zctas.length === 0) throw new PublicDataError("bad_request", "no ZCTA to request", { source: "census" });
    if (zctas.length > MAX_ZCTAS_PER_REQUEST) {
      throw new PublicDataError("bad_request", `at most ${MAX_ZCTAS_PER_REQUEST} ZCTAs per request, got ${zctas.length}`, { source: "census" });
    }
    const bad = zctas.find((z) => !/^\d{5}$/.test(z));
    if (bad !== undefined) throw new PublicDataError("bad_request", `"${bad.slice(0, 12)}" is not a 5-digit ZCTA`, { source: "census" });
    return { kind: "zcta", zctas };
  }
  const state = geo.state.trim();
  const county = geo.county.trim();
  if (!/^\d{2}$/.test(state) || !/^\d{3}$/.test(county)) {
    throw new PublicDataError("bad_request", `state ${state.slice(0, 4)} / county ${county.slice(0, 4)} are not FIPS codes`, { source: "census" });
  }
  return { kind: "tract", state, county };
}

/**
 * One ACS 5-year request. The `in` clause of a tract request is written once, space-separated
 * (`state:47 county:037`), so the query stays a flat record; the live transport sends it as the two
 * `in=` parameters the API documents.
 */
export function censusRequest(vintage: number, geo: CensusGeo): PublicRequest {
  const g = canonicalGeo(geo);
  const query: Record<string, string> =
    g.kind === "zcta"
      ? { get: CENSUS_GET, for: `${ZCTA_COLUMN}:${g.zctas.join(",")}` }
      : { get: CENSUS_GET, for: "tract:*", in: `state:${g.state} county:${g.county}` };
  return { source: "census", endpoint: "/data/acs/acs5", host: CENSUS_HOST, path: `/data/${vintage}/acs/acs5`, query };
}

/** The reference of an ACS call: dataset, vintage and geography, e.g. `acs5 2024 zcta 37206,37207`. */
export function censusReference(vintage: number, geo: CensusGeo): string {
  const g = canonicalGeo(geo);
  return g.kind === "zcta" ? `acs5 ${vintage} zcta ${g.zctas.join(",")}` : `acs5 ${vintage} tract state:${g.state} county:${g.county}`;
}

/** The vintage a request path names, or null. */
export function vintageOfPath(path: string): number | null {
  const m = /^\/data\/(\d{4})\/acs\/acs5$/.exec(path);
  return m ? Number(m[1]) : null;
}

/**
 * ACS annotation values written in place of an estimate (-666666666 "could not be computed",
 * -999999999, -888888888, -555555555, -333333333, -222222222). Every field here is a count or a
 * median, so any negative value is read as withheld too.
 */
export const ACS_SENTINELS: ReadonlySet<number> = new Set([-222222222, -333333333, -555555555, -666666666, -888888888, -999999999]);

export function acsValue(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : Number.NaN;
  if (!Number.isFinite(n) || ACS_SENTINELS.has(n) || n < 0) return null;
  return n;
}

const Table = z.array(z.array(z.union([z.string(), z.number(), z.null()])));

/** Checks an ACS answer's shape: a header row naming every requested variable and the geography columns. */
export function validateAcsTable(json: unknown, geo: CensusGeo): void {
  parseAcsRows(json, geo);
}

/**
 * Rows of an ACS answer (`[[header…], [values…], …]`, values as strings). An empty answer (HTTP 204)
 * has no rows. Throws when the header lacks a requested variable or the geography columns.
 */
export function parseAcsRows(json: unknown, geo: CensusGeo): CensusRow[] {
  if (json === null) return [];
  const table = Table.parse(json);
  const header = table[0];
  if (header === undefined) return [];
  const index = new Map(header.map((name, i) => [String(name), i]));
  const column = (name: string): number => {
    const i = index.get(name);
    if (i === undefined) throw new Error(`the ACS answer has no ${name} column`);
    return i;
  };
  const fields = CensusField.options.map((field) => [field, column(CENSUS_VARIABLES[field])] as const);
  const geoColumns = geo.kind === "zcta" ? [column(ZCTA_COLUMN)] : [column("state"), column("county"), column("tract")];
  const rows: CensusRow[] = [];
  for (const line of table.slice(1)) {
    const geoId = geoColumns.map((i) => String(line[i] ?? "")).join("");
    if (geoId === "") continue;
    const values = {} as Record<CensusField, number | null>;
    for (const [field, i] of fields) values[field] = acsValue(line[i]);
    rows.push({ geoId, values });
  }
  rows.sort((a, b) => a.geoId.localeCompare(b.geoId));
  return rows;
}

export function acsData(vintage: number, rows: CensusRow[]): CensusAcsData {
  return { vintage, dataset: "acs/acs5", rows };
}
