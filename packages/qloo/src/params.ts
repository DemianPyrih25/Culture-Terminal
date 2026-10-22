/**
 * How each allowlisted parameter's value is read. Validation and canonicalisation share these sets,
 * so a value that passes validation always has one canonical form.
 */

/** Parameters whose value is a set of ids, tags, types or buckets: order-free, comma-joined on the wire. */
export const LIST_PARAMS: ReadonlySet<string> = new Set([
  "types",
  "entity_ids",
  "signal.interests.entities",
  "signal.interests.tags",
  "signal.demographics.audiences",
  "signal.demographics.age",
  "filter.results.entities",
  "filter.exclude.entities",
  "filter.tags",
  "filter.exclude.tags",
  "filter.tag.types",
  "filter.parents.types",
]);

/** Integer parameters (≥1). */
export const INTEGER_PARAMS: ReadonlySet<string> = new Set(["take", "page"]);

/** Numeric parameters, written without trailing zeros or exponents. */
export const NUMERIC_PARAMS: ReadonlySet<string> = new Set([...INTEGER_PARAMS, "filter.popularity.max", "filter.radius"]);

export const BOOLEAN_PARAMS: ReadonlySet<string> = new Set(["feature.explainability", "feature.semantic_search"]);

/** Location parameters: WKT, a locality id, or (on /search) a `lat,lon` pair. */
export const LOCATION_PARAMS: ReadonlySet<string> = new Set(["signal.location", "filter.location"]);

export const DATE_PARAMS: ReadonlySet<string> = new Set(["filter.start_date", "filter.end_date"]);

/** Largest id list in one parameter (SPEC §5.1 value rules). */
export const MAX_LIST_ITEMS = 50;

/** Splits a list value given as a comma-joined string or an array into trimmed items. */
export function listItems(value: string | readonly string[]): string[] {
  const raw = typeof value === "string" ? value.split(",") : [...value];
  return raw.map((item) => item.trim());
}
