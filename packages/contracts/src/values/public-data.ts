import type { PUBLIC_SOURCE_VALUES } from "./enums";

/** Zod-free public-data values (PLAN §5.2); ../public-data.ts documents them and builds the schemas. */

type PublicSourceV = (typeof PUBLIC_SOURCE_VALUES)[number];

/**
 * Endpoint templates, as receipts, events and the sources tab name them. The concrete path of a call
 * (e.g. `/api/xbrl/companyfacts/CIK0000000001.json` or `/data/2023/acs/acs5`) is in its provenance. The
 * Overpass endpoint is the same template whatever OSM_OVERPASS_URL points at; the concrete host is recorded
 * in each call's provenance.
 */
export const PUBLIC_ENDPOINT_VALUES = [
  "/files/company_tickers.json",
  "/api/xbrl/companyfacts",
  "/data/acs/acs5",
  "/api/interpreter",
] as const;
type PublicEndpointV = (typeof PUBLIC_ENDPOINT_VALUES)[number];

export const PUBLIC_ENDPOINTS: Readonly<Record<PublicEndpointV, { source: PublicSourceV; host: string; label: string }>> = {
  "/files/company_tickers.json": { source: "sec", host: "www.sec.gov", label: "SEC EDGAR company tickers" },
  "/api/xbrl/companyfacts": { source: "sec", host: "data.sec.gov", label: "SEC EDGAR XBRL company facts" },
  "/data/acs/acs5": { source: "census", host: "api.census.gov", label: "US Census ACS 5-year" },
  "/api/interpreter": { source: "osm", host: "overpass-api.de", label: "OpenStreetMap (Overpass API)" },
};

export const PUBLIC_SOURCE_LABEL: Readonly<Record<PublicSourceV, string>> = {
  sec: "SEC EDGAR",
  census: "US Census Bureau",
  osm: "OpenStreetMap",
};

/**
 * The exact reason a public source cannot be read on this server (D7 of the Part 9 close-out). When a
 * source is not configured, code does not plan or run its tool in the opening scan, adds the
 * SEC_NOT_CONFIGURED / CENSUS_NOT_CONFIGURED / OSM_NOT_CONFIGURED limitation with this text, and refuses an
 * ANALYST call to the tool with this text. Nothing paraphrases it.
 */
export const PUBLIC_NOT_CONFIGURED_REASON: Readonly<Record<PublicSourceV, string>> = {
  sec: "SEC EDGAR is not configured on this server",
  census: "Census ACS is not configured on this server",
  osm: "OpenStreetMap is not configured on this server",
};

/** Why a public-data call failed; ../public-data.ts documents each code. */
export const PUBLIC_DATA_ERROR_CODE_VALUES = [
  "not_configured",
  "not_found",
  "rate_limited",
  "unavailable",
  "bad_request",
  "invalid_response",
] as const;
type PublicDataErrorCodeV = (typeof PUBLIC_DATA_ERROR_CODE_VALUES)[number];

/** The code of a public-data client error, or null for any other value. */
export function publicDataErrorCode(err: unknown): PublicDataErrorCodeV | null {
  if (typeof err !== "object" || err === null) return null;
  const e = err as { name?: unknown; code?: unknown };
  if (e.name !== "PublicDataError") return null;
  return (PUBLIC_DATA_ERROR_CODE_VALUES as readonly unknown[]).includes(e.code) ? (e.code as PublicDataErrorCodeV) : null;
}

/** The OpenStreetMap attribution and licence every OSM figure carries (ODbL 1.0, D46). */
export const OSM_ATTRIBUTION = "© OpenStreetMap contributors" as const;
export const OSM_LICENCE = "ODbL-1.0" as const;
export const OSM_LICENCE_URL = "https://www.openstreetmap.org/copyright" as const;
/** The caveat on every OpenStreetMap count (OSM_SUPPLY_FLOOR). */
export const OSM_COMPLETENESS = "OpenStreetMap is mapped by volunteers: counts are a floor, not a census.";
