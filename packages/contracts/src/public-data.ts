import { z } from "zod";
import { CacheStatus, IsoDateTime, PublicSource } from "./enums";

/**
 * Public data (PLAN §5.2, Part 9): SEC EDGAR filings and US Census ACS estimates, read through
 * @ct/publicdata with the Qloo client's shape (canonical key, cache, single-flight, retries, a call row
 * and a `public` event per call). These calls cost no Qloo calls. Skills see them only through
 * `SkillCtx.publicdata` and get parsed values, never raw responses.
 */

// Endpoints ---------------------------------------------------------------------------------------------

/**
 * Endpoint templates, as receipts, events and the sources tab name them. The concrete path of a call
 * (e.g. `/api/xbrl/companyfacts/CIK0000000001.json` or `/data/2023/acs/acs5`) is in its provenance.
 */
export const PublicEndpoint = z.enum(["/files/company_tickers.json", "/api/xbrl/companyfacts", "/data/acs/acs5"]);
export type PublicEndpoint = z.infer<typeof PublicEndpoint>;

export const PUBLIC_ENDPOINTS: Readonly<Record<PublicEndpoint, { source: PublicSource; host: string; label: string }>> = {
  "/files/company_tickers.json": { source: "sec", host: "www.sec.gov", label: "SEC EDGAR company tickers" },
  "/api/xbrl/companyfacts": { source: "sec", host: "data.sec.gov", label: "SEC EDGAR XBRL company facts" },
  "/data/acs/acs5": { source: "census", host: "api.census.gov", label: "US Census ACS 5-year" },
};

export const PUBLIC_SOURCE_LABEL: Readonly<Record<PublicSource, string>> = {
  sec: "SEC EDGAR",
  census: "US Census Bureau",
};

/**
 * The exact reason a public source cannot be read on this server (D7 of the Part 9 close-out). When a
 * source is not configured, code does not plan or run its tool in the opening scan, adds the
 * SEC_NOT_CONFIGURED / CENSUS_NOT_CONFIGURED limitation with this text, and refuses an ANALYST call to
 * the tool with this text. Nothing paraphrases it.
 */
export const PUBLIC_NOT_CONFIGURED_REASON: Readonly<Record<PublicSource, string>> = {
  sec: "SEC EDGAR is not configured on this server",
  census: "Census ACS is not configured on this server",
};

// Call metadata ---------------------------------------------------------------------------------------------

/**
 * Metadata the public-data client returns with every call, the counterpart of QlooCallMeta. A cached
 * call keeps its original reference and fetch time.
 */
export const PublicCallMeta = z.object({
  publicCallId: z.string().min(1),
  source: PublicSource,
  endpoint: PublicEndpoint,
  /**
   * What a reader can trace the response to, in place of Qloo's request id: for SEC company facts
   * `CIK##########`, for the SEC ticker map `company_tickers.json`, for Census the dataset, vintage and
   * geography (e.g. `acs5 2023 zcta 37206,37207`), and `mock-<hash>` under the mock transport. Filing
   * accession numbers travel on each fact point and in metric labels. Never contains an API key.
   */
  reference: z.string().min(1),
  cache: CacheStatus,
  fetchedAt: IsoDateTime,
  ms: z.number().nonnegative(),
  /** Served from an expired entry after a network failure (STALE_CACHE). */
  stale: z.boolean(),
  /** The run that first fetched a cached response; drives REUSED chips. Null for this run's own network calls. */
  originRunId: z.string().nullable(),
});
export type PublicCallMeta = z.infer<typeof PublicCallMeta>;

export interface PublicResult<T> {
  data: T;
  meta: PublicCallMeta;
}

/**
 * Why a public-data call failed. The client throws an error whose `name` is "PublicDataError" and whose
 * `code` is one of these, so skills can map it to UNAVAILABLE with a plain reason without importing the
 * client (see publicDataErrorCode).
 * - not_configured: live SEC needs SEC_USER_AGENT, live Census needs CENSUS_API_KEY, and it is not set
 * - not_found: unknown ticker or CIK, or no Census row for the geography
 * - rate_limited: 429 after retries; unavailable: network, 5xx or a 403 block after retries
 * - bad_request: other 4xx (e.g. an unknown Census variable); invalid_response: the body failed to parse
 */
export const PublicDataErrorCode = z.enum([
  "not_configured",
  "not_found",
  "rate_limited",
  "unavailable",
  "bad_request",
  "invalid_response",
]);
export type PublicDataErrorCode = z.infer<typeof PublicDataErrorCode>;

/** The code of a public-data client error, or null for any other value. */
export function publicDataErrorCode(err: unknown): PublicDataErrorCode | null {
  if (typeof err !== "object" || err === null) return null;
  const e = err as { name?: unknown; code?: unknown };
  if (e.name !== "PublicDataError") return null;
  const code = PublicDataErrorCode.safeParse(e.code);
  return code.success ? code.data : null;
}

// SEC EDGAR ------------------------------------------------------------------------------------------------

/** A listed company from the SEC ticker map. `cik` is zero-padded to 10 digits. */
export interface SecCompany {
  cik: string;
  ticker: string;
  /** The registrant name as the SEC lists it. */
  title: string;
}

/**
 * The us-gaap concepts read from company facts (PLAN §5.2). Revenue is the first of the four revenue
 * concepts the company reports for a period, in this order; then gross profit and operating income.
 */
export const SecConcept = z.enum([
  "RevenueFromContractWithCustomerExcludingAssessedTax",
  "Revenues",
  "SalesRevenueNet",
  "RevenueFromContractWithCustomerIncludingAssessedTax",
  "GrossProfit",
  "OperatingIncomeLoss",
]);
export type SecConcept = z.infer<typeof SecConcept>;

export const SEC_REVENUE_CONCEPTS = [
  "RevenueFromContractWithCustomerExcludingAssessedTax",
  "Revenues",
  "SalesRevenueNet",
  "RevenueFromContractWithCustomerIncludingAssessedTax",
] as const satisfies readonly SecConcept[];

/**
 * One reported value, USD only. For one concept and period (start, end) only the latest-filed value is
 * kept, so a restatement replaces the original. `span` is annual for a 10-K fiscal year of about one
 * year, quarterly for a 10-Q value of about three months, other otherwise (e.g. year-to-date).
 */
export interface SecFactPoint {
  concept: SecConcept;
  unit: "USD";
  value: number;
  /** Period start (ISO date); null for instant values. */
  start: string | null;
  /** Period end (ISO date). */
  end: string;
  /** Fiscal year and period of the filing that reported it, as filed (e.g. 2024, "FY" or "Q2"). */
  fy: number | null;
  fp: string | null;
  /** Form type, e.g. 10-K or 10-Q. */
  form: string;
  /** Filing date (ISO date). */
  filed: string;
  /** The filing's accession number, e.g. 0000000000-24-000001. */
  accession: string;
  span: "annual" | "quarterly" | "other";
}

export interface SecCompanyFacts {
  cik: string;
  /** The registrant name in the facts file. */
  entityName: string;
  points: SecFactPoint[];
}

// US Census ACS ---------------------------------------------------------------------------------------------

/**
 * The fixed ACS 5-year field set (PLAN §5.2). Nothing else is ever requested: no race, ethnicity,
 * religion or other sensitive variables. The client maps each field to its ACS variable id.
 */
export const CensusField = z.enum([
  "population",
  "median_age",
  "households",
  "median_household_income",
  "workers",
  "commute_drove_alone",
  "commute_public_transit",
  "commute_walked",
  "commute_bicycle",
  "commute_worked_from_home",
]);
export type CensusField = z.infer<typeof CensusField>;

/** Census fields that are medians: a rollup over units weights them, it never sums them. */
export const CENSUS_MEDIAN_FIELDS = ["median_age", "median_household_income"] as const satisfies readonly CensusField[];

/**
 * The geography of one ACS request: a list of ZIP Code Tabulation Areas (5-digit ZCTAs), or every tract
 * of one county (2-digit state and 3-digit county FIPS codes).
 */
export type CensusGeo =
  | { kind: "zcta"; zctas: readonly string[] }
  | { kind: "tract"; state: string; county: string };

export interface CensusRow {
  /** The ZCTA (`37206`) or the full tract GEOID (state + county + tract, 11 digits). */
  geoId: string;
  /** Null when Census withheld or could not compute the estimate (null or a negative sentinel). */
  values: Record<CensusField, number | null>;
}

export interface CensusAcsData {
  /** The ACS 5-year release year, e.g. 2023 for the 2019-2023 estimates. */
  vintage: number;
  dataset: "acs/acs5";
  rows: CensusRow[];
}

// The API skills see ----------------------------------------------------------------------------------------

/**
 * Public data as skills see it (SkillCtx.publicdata): GET-only, cached, rate-limited, and attributed to
 * the current tool call. Every method returns parsed data with its call metadata, for the ledger.
 * Failures throw a PublicDataError (publicDataErrorCode).
 */
export interface PublicDataApi {
  /** Looks a ticker up in the SEC ticker map (cached 7 days); data is null when the ticker is not listed. */
  secTicker(ticker: string): Promise<PublicResult<SecCompany | null>>;
  /** Company facts for a CIK (cached 7 days): the SecConcept points, USD only, restatements resolved. */
  secCompanyFacts(cik: string): Promise<PublicResult<SecCompanyFacts>>;
  /** The fixed ACS 5-year field set for a geography, from the latest vintage that answers (pinned per vintage). */
  censusAcs(geo: CensusGeo): Promise<PublicResult<CensusAcsData>>;
}
