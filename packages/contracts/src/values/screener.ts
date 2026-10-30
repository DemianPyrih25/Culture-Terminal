/** Zod-free screener values (PLAN §5.5); ../screener.ts holds the request and response schemas. */

/** Brands one screen ranks; the taste map places the top TASTE_MAP_MAX_K of them. */
export const SCREENER_ROWS_MAX = 25;
export const SCREENER_ROWS_DEFAULT = 20;
/** Market contexts one screen reads (§5.5: markets ≤ 4). */
export const SCREENER_MARKETS_MAX = 4;
export const SCREENER_QUERY_MAX = 120;

/**
 * kv key prefix of the screens-per-UTC-day counter (`screener.count.YYYY-MM-DD`), which /status reads.
 * The screener increments it once per screen it serves.
 */
export const SCREENER_DAILY_KV_PREFIX = "screener.count.";
