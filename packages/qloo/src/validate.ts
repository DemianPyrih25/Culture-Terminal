import { AudienceKey, isTaxonomyTag, type Pillar, type QlooParams, type QlooParamValue } from "@ct/contracts";
import { ALLOW, ANY_TYPE, FORBIDDEN, PROBE_FACTS, type QlooPath } from "./allowlist";
import { audienceDenial } from "./audiences";
import { NoSignalError, QlooParamError } from "./errors";
import { latLonProblem, type LonLat, lonLatProblem, looksLikeWkt, parseLatLon, parseWkt } from "./geometry";
import {
  BOOLEAN_PARAMS,
  DATE_PARAMS,
  INTEGER_PARAMS,
  LIST_PARAMS,
  listItems,
  LOCATION_PARAMS,
  MAX_LIST_ITEMS,
  NUMERIC_PARAMS,
} from "./params";

/**
 * Request validation (PLAN §5.1 step 1). Qloo silently ignores parameters it does not know, so every
 * request is checked against the frozen allowlist and the value rules before it can reach the cache
 * or the network, in every environment, mock included.
 */

export interface ValidationContext {
  /** The desk making the call, for the audience allowlist (D21); null for standalone tools. */
  pillar: Pillar | null;
}

/** Largest `take` per path: 50 for insights and trending, 100 for the catalogue endpoints. */
const TAKE_MAX: Readonly<Record<QlooPath, number>> = {
  "/search": 100,
  "/entities": 100,
  "/v2/insights": 50,
  "/v2/trending": 50,
  "/v2/tags": 100,
  "/v2/audiences": 100,
};

const AUDIENCE_PREFIX = "urn:audience:";

/** `filter.type` for /v2/insights and /v2/trending (as sent), else null. Assumes the request is valid. */
export function filterTypeOf(path: QlooPath, params: QlooParams): string | null {
  if (path !== "/v2/insights" && path !== "/v2/trending") return null;
  const value = params["filter.type"];
  return typeof value === "string" ? value.trim() : null;
}

/** Throws QlooParamError (or NoSignalError) when the request may not be sent; returns nothing otherwise. */
export function validateRequest(path: QlooPath, params: QlooParams, ctx: ValidationContext): void {
  if (!Object.hasOwn(ALLOW, path)) throw new QlooParamError(`path "${String(path)}" is not on the Qloo allowlist`);
  const byType = ALLOW[path];
  let filterType: string | null = null;
  let table = byType[ANY_TYPE];
  if (path === "/v2/insights") {
    filterType = insightsFilterType(params);
    table = byType[filterType];
  } else {
    filterType = filterTypeOf(path, params);
  }
  if (table === undefined) throw new QlooParamError(`no allowlist table for ${path}`);
  const where = path === "/v2/insights" ? `${path} ${filterType}` : path;

  for (const [param, value] of Object.entries(params)) {
    const reason = forbiddenReason(path, filterType, param);
    if (reason !== null) throw new QlooParamError(`${param} is forbidden on ${where}: ${reason}`, param);
    if (!Object.hasOwn(table, param)) throw new QlooParamError(`${param} is not allowlisted for ${where}`, param);
    checkValue(path, filterType, param, value, ctx);
  }

  // Probe P5: in a heatmap sent with both, the analog's cells took the top 160 places of the map.
  if (filterType === "urn:heatmap" && params["signal.interests.tags"] !== undefined && params["signal.interests.entities"] !== undefined) {
    throw new QlooParamError(
      "urn:heatmap takes signal.interests.tags or signal.interests.entities, not both: the analog's cells set the top of a combined map (probe P5)",
      "signal.interests.entities",
    );
  }

  if (path === "/v2/insights") requireSignal(filterType ?? "", params);
}

function insightsFilterType(params: QlooParams): string {
  const value = params["filter.type"];
  if (typeof value !== "string" || value.trim() === "") {
    throw new QlooParamError("filter.type is required for /v2/insights", "filter.type");
  }
  const type = value.trim();
  if (!Object.hasOwn(ALLOW["/v2/insights"], type)) {
    throw new QlooParamError(`filter.type "${type}" is not allowlisted for /v2/insights`, "filter.type");
  }
  return type;
}

function forbiddenReason(path: QlooPath, filterType: string | null, param: string): string | null {
  const type = filterType ?? ANY_TYPE;
  const keys = [`${path}|${type}|${param}`, `${path}|*|${param}`, `*|${type}|${param}`, `*|*|${param}`];
  for (const key of keys) {
    const reason = FORBIDDEN[key];
    if (reason !== undefined) return reason;
  }
  return null;
}

const isList = (value: QlooParamValue): value is readonly string[] => Array.isArray(value);

function checkValue(
  path: QlooPath,
  filterType: string | null,
  param: string,
  value: QlooParamValue,
  ctx: ValidationContext,
): void {
  if (LIST_PARAMS.has(param)) return checkList(filterType, param, value, ctx);
  if (isList(value)) throw new QlooParamError(`${param} takes one value, not a list`, param);
  if (NUMERIC_PARAMS.has(param)) return checkNumber(path, param, value);
  if (BOOLEAN_PARAMS.has(param)) {
    if (typeof value === "boolean" || value === "true" || value === "false") return;
    throw new QlooParamError(`${param} must be true or false`, param);
  }
  if (typeof value !== "string") throw new QlooParamError(`${param} must be a string`, param);
  const text = value.trim();
  if (text === "") throw new QlooParamError(`${param} is empty`, param);
  if (LOCATION_PARAMS.has(param)) checkLocation(path, param, text);
  if (DATE_PARAMS.has(param) && !/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new QlooParamError(`${param} must be a YYYY-MM-DD date`, param);
  }
  if (text.startsWith(AUDIENCE_PREFIX)) checkAudience(param, text, ctx);
}

/** The number a numeric parameter carries (a number or a plain decimal string), or null. */
export function numericValue(value: QlooParamValue): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && /^\s*[+-]?\d+(?:\.\d+)?\s*$/.test(value)) return Number(value);
  return null;
}

function checkNumber(path: QlooPath, param: string, value: QlooParamValue): void {
  const n = numericValue(value);
  if (n === null) throw new QlooParamError(`${param} must be a finite number`, param);
  if (INTEGER_PARAMS.has(param) && !(Number.isInteger(n) && n >= 1)) {
    throw new QlooParamError(`${param} must be a positive integer`, param);
  }
  if (param === "take" && n > TAKE_MAX[path]) {
    throw new QlooParamError(`take=${n} exceeds ${TAKE_MAX[path]} for ${path}`, param);
  }
  if (param === "filter.popularity.max" && (n < 0 || n > 1)) {
    throw new QlooParamError(`${param} must be between 0 and 1`, param);
  }
  if (param === "filter.radius" && n <= 0) throw new QlooParamError(`${param} must be positive`, param);
}

function checkList(filterType: string | null, param: string, value: QlooParamValue, ctx: ValidationContext): void {
  if (typeof value !== "string" && !isList(value)) {
    throw new QlooParamError(`${param} must be a list of strings or a comma-joined string`, param);
  }
  if (isList(value) && value.some((item) => typeof item !== "string" || item.includes(","))) {
    throw new QlooParamError(`${param} items must be strings without commas`, param);
  }
  const items = listItems(value);
  if (items.length === 0 || items.some((item) => item === "")) throw new QlooParamError(`${param} has an empty item`, param);
  if (items.length > MAX_LIST_ITEMS) {
    throw new QlooParamError(`${param} holds ${items.length} items; at most ${MAX_LIST_ITEMS} are allowed`, param);
  }
  if (param === "signal.interests.tags") {
    const bad = items.find((tag) => !isTaxonomyTag(tag));
    if (bad !== undefined) {
      throw new QlooParamError(
        `${param} takes taxonomy tags only (urn:tag:genre:… or urn:tag:category:…); "${bad}" gives no signal (probe G1, G6)`,
        param,
      );
    }
    // Probe P5: a urn:tag:category:place:* concept tag returned an empty heatmap; genre tags shape one.
    const flat = filterType === "urn:heatmap" ? items.find((tag) => !tag.startsWith("urn:tag:genre:")) : undefined;
    if (flat !== undefined) {
      throw new QlooParamError(`${param} on urn:heatmap takes urn:tag:genre:… tags only; "${flat}" returned no cells (probe P5)`, param);
    }
  }
  if (
    param === "signal.interests.entities" &&
    filterType === "urn:demographics" &&
    items.length > PROBE_FACTS.demographicsBatchMax
  ) {
    throw new QlooParamError(
      `urn:demographics takes at most ${PROBE_FACTS.demographicsBatchMax} entities per call (probe G12)`,
      param,
    );
  }
  for (const item of items) {
    if (param === "signal.demographics.audiences" && !AudienceKey.safeParse(item).success) {
      throw new QlooParamError(`${param} item "${item}" is not an audience key`, param);
    }
    if (item.startsWith(AUDIENCE_PREFIX)) checkAudience(param, item, ctx);
  }
}

function checkAudience(param: string, urn: string, ctx: ValidationContext): void {
  const denial = audienceDenial(urn, ctx.pillar);
  if (denial !== null) throw new QlooParamError(`${param}: ${denial}`, param);
}

function checkLocation(path: QlooPath, param: string, value: string): void {
  if (path === "/search") {
    const pair = parseLatLon(value);
    if (pair === null) throw new QlooParamError(`${param} on /search takes "lat,lon"`, param);
    const problem = latLonProblem(pair);
    if (problem !== null) throw new QlooParamError(`${param} "${value}" ${problem}`, param);
    return;
  }
  if (looksLikeWkt(value)) {
    let coordinates: readonly LonLat[];
    try {
      coordinates = parseWkt(value).coordinates;
    } catch (err) {
      throw new QlooParamError(`${param} ${(err as Error).message}`, param);
    }
    for (const pair of coordinates) {
      const problem = lonLatProblem(pair);
      if (problem !== null) throw new QlooParamError(`${param} coordinate "${pair[0]} ${pair[1]}" ${problem}`, param);
    }
    return;
  }
  if (/[\s,()]/.test(value)) throw new QlooParamError(`${param} is neither WKT nor a locality id`, param);
}

function requireSignal(filterType: string, params: QlooParams): void {
  if (Object.keys(params).some((key) => key.startsWith("signal."))) return;
  // Probe G10: places filtered by locality and category tag answer without a signal.
  const filterOnlyPlaces =
    filterType === "urn:entity:place" && Object.hasOwn(params, "filter.location") && Object.hasOwn(params, "filter.tags");
  if (filterOnlyPlaces) return;
  throw new NoSignalError(
    `/v2/insights ${filterType} needs an entity, tag, audience, age or location signal (signal.*); without one Qloo returns no affinities`,
  );
}
