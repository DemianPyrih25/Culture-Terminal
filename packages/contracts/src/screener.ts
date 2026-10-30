import { z } from "zod";
import { TasteMapPayload } from "./datasets";
import { Badge, CacheStatus, IsoDateTime, MarketId, Mode, MetricUnit, NoValueReason } from "./enums";
import { PickerCandidate } from "./events";
import { QlooProvenanceRequest } from "./ledger";
import { SCREENER_MARKETS_MAX, SCREENER_QUERY_MAX, SCREENER_ROWS_DEFAULT, SCREENER_ROWS_MAX } from "./values/screener";

export * from "./values/screener";

/**
 * The brand screener (PLAN §5.5, §8.1 `/screener`): a code-only page, not an ANALYST tool, so it makes
 * no LLM call. A category (a Qloo tag) or a seed brand → discovery (1–2 calls) → one-scale scoring (1)
 * → age contexts (3) → markets (≤ 4). Every cell traces to the request it came from. It draws from the
 * same daily Qloo cap as runs (§10.4) and sits behind Turnstile (§10.3), so the route extends
 * ScreenerRequest with its `turnstileToken`.
 */

/** The six columns, in display order (§5.5). No composite score (D14). */
export const ScreenerColumn = z.enum([
  "fit",
  "distinctiveness",
  "next_gen_tilt",
  "metro_breadth",
  "popularity",
  "under_the_radar",
]);
export type ScreenerColumn = z.infer<typeof ScreenerColumn>;

export const SCREENER_COLUMN_LABEL: Readonly<Record<ScreenerColumn, string>> = {
  fit: "FIT",
  distinctiveness: "Distinctiveness",
  next_gen_tilt: "Next-gen tilt",
  metro_breadth: "Metro breadth",
  popularity: "Popularity",
  under_the_radar: "UNDER-THE-RADAR",
};

/**
 * The FORMULAS id (packages/quant/src/formulas.ts) behind each column, for its ⓘ link to /method.
 * Distinctiveness is S1's 1 − max similarity over the screened set, so it needs the screener's taste
 * map calls (≤ 13); without them the column is UNAVAILABLE with reason not_measured, never estimated.
 */
export const SCREENER_COLUMN_FORMULA = {
  fit: "pct.within_call",
  distinctiveness: "subs.distinctiveness",
  next_gen_tilt: "share.youth_tilt",
  metro_breadth: "share.metros_won",
  popularity: "popularity",
  under_the_radar: "screen.under_the_radar",
} as const satisfies Record<ScreenerColumn, string>;


/** What to screen: brands of a category (a tag the server finds by name) or brands near a seed brand. */
export const ScreenerSeed = z.discriminatedUnion("by", [
  z.object({ by: z.literal("tag"), query: z.string().trim().min(1).max(SCREENER_QUERY_MAX) }),
  z.object({ by: z.literal("brand"), name: z.string().trim().min(1).max(SCREENER_QUERY_MAX) }),
]);
export type ScreenerSeed = z.infer<typeof ScreenerSeed>;

/** POST /api/screener. */
export const ScreenerRequest = z.object({
  seed: ScreenerSeed,
  /**
   * Market ids for metro breadth (config/metros.json); empty leaves metro breadth UNAVAILABLE with
   * reason not_measured. Unknown ids are refused with 400, never dropped silently.
   */
  markets: z.array(MarketId).max(SCREENER_MARKETS_MAX).default([]),
  rows: z.int().min(5).max(SCREENER_ROWS_MAX).default(SCREENER_ROWS_DEFAULT),
  /** Also run the taste map calls (≤ 13): fills distinctiveness and returns the map. */
  map: z.boolean().default(false),
  /** The opaque key of a candidate from a `pick` answer; never a Qloo id. Offered, never applied unasked. */
  pick: z.string().min(1).max(200).nullish(),
});
export type ScreenerRequest = z.infer<typeof ScreenerRequest>;

/** Q#: one Qloo request of a screen, which cells cite. */
export const ScreenerRequestId = z.string().regex(/^Q[1-9]\d*$/, { message: "expected a screener request id like Q1" });
export type ScreenerRequestId = z.infer<typeof ScreenerRequestId>;

export const ScreenerRequestPurpose = z.enum(["resolve", "discovery", "scoring", "age", "market", "taste_map"]);
export type ScreenerRequestPurpose = z.infer<typeof ScreenerRequestPurpose>;

export const ScreenerRequestEntry = z.object({
  id: ScreenerRequestId,
  purpose: ScreenerRequestPurpose,
  /** The context a call reads, e.g. "age 25–29" or a market label; null for the national calls. */
  context: z.string().nullable(),
  request: QlooProvenanceRequest,
  /** x-qloo-request-id of the response; a cached call keeps its original one. */
  requestId: z.string().min(1),
  cache: CacheStatus,
  fetchedAt: IsoDateTime,
  /** Results the call returned; null when it failed. */
  rows: z.int().nonnegative().nullable(),
  /** Why the call gave nothing usable; null when it did. */
  error: z.string().nullable(),
});
export type ScreenerRequestEntry = z.infer<typeof ScreenerRequestEntry>;

/**
 * One cell: a value with its source requests, or an explained absence. UNAVAILABLE is never drawn
 * as 0 (§8.3). A cell that was asked for and not scored still names the request that did not score it.
 */
export const ScreenerCell = z
  .object({
    status: z.enum(["ok", "unavailable"]),
    value: z.number().nullable(),
    reason: NoValueReason.nullable(),
    /** As printed, e.g. "0.82", "top half in 3 of 4", "2 of 14"; null when unavailable. */
    display: z.string().nullable(),
    requestIds: z.array(ScreenerRequestId),
  })
  .refine((c) => (c.status === "ok") === (c.value !== null), { message: "a cell has a value exactly when it is ok" })
  .refine((c) => (c.value === null) === (c.reason !== null), { message: "value is null exactly when a reason is given" })
  .refine((c) => c.status !== "ok" || c.requestIds.length > 0, { message: "an ok cell names its requests" });
export type ScreenerCell = z.infer<typeof ScreenerCell>;

export const ScreenerRowFlag = z.enum(["SEED", "UTR"]);
export type ScreenerRowFlag = z.infer<typeof ScreenerRowFlag>;

export const ScreenerRow = z.object({
  /** Opaque and unique within the screen; never a Qloo id. */
  key: z.string().min(1),
  /** Default order: FIT, best first. */
  rank: z.int().positive(),
  label: z.string(),
  disambiguation: z.string().nullable(),
  flags: z.array(ScreenerRowFlag),
  cells: z.record(ScreenerColumn, ScreenerCell),
});
export type ScreenerRow = z.infer<typeof ScreenerRow>;

export const ScreenerColumnMeta = z.object({
  key: ScreenerColumn,
  label: z.string(),
  formulaId: z.string().min(1),
  unit: MetricUnit,
  badge: Badge,
});
export type ScreenerColumnMeta = z.infer<typeof ScreenerColumnMeta>;

/** A finished screen. */
export const ScreenerResult = z
  .object({
    seed: z.object({ by: z.enum(["tag", "brand"]), label: z.string() }),
    markets: z.array(z.object({ id: MarketId, label: z.string() })),
    columns: z.array(ScreenerColumnMeta).length(ScreenerColumn.options.length),
    rows: z.array(ScreenerRow).max(SCREENER_ROWS_MAX),
    requests: z.array(ScreenerRequestEntry),
    /** The taste map of the top rows when asked for and drawable; null otherwise. */
    map: TasteMapPayload.nullable(),
    /** Plain limits shown above the table, e.g. "Taste fit within this set, not sales or share." */
    limitations: z.array(z.string()),
    mode: Mode,
    /** Fresh and cached Qloo calls this screen made; a repeat within the cache window costs none. */
    qloo: z.object({ network: z.int().nonnegative(), cached: z.int().nonnegative() }),
    createdAt: IsoDateTime,
  })
  .refine((r) => r.columns.every((c, i) => c.key === ScreenerColumn.options[i]), {
    message: "columns must be the six ScreenerColumn values in order",
  })
  .refine(
    (r) => {
      const ids = new Set(r.requests.map((q) => q.id));
      return r.rows.every((row) => Object.values(row.cells).every((c) => c.requestIds.every((id) => ids.has(id))));
    },
    { message: "every cell must cite requests of this screen" },
  )
  .refine((r) => new Set(r.rows.map((row) => row.key)).size === r.rows.length, { message: "row keys must be unique" });
export type ScreenerResult = z.infer<typeof ScreenerResult>;

/** POST /api/screener answer. Only `ok` carries numbers; every other kind is a plain message. */
export const ScreenerAnswer = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ok"), screen: ScreenerResult }),
  /** The seed matches more than one Qloo entity or tag exactly: the reader picks, nothing is applied. */
  z.object({ kind: z.literal("pick"), message: z.string(), candidates: z.array(PickerCandidate) }),
  /** No exact match: the closest candidates are offered, never applied (D20). */
  z.object({ kind: z.literal("not_found"), message: z.string(), candidates: z.array(PickerCandidate) }),
  /** Off, over budget, throttled or failed: why, and when to try again when known. */
  z.object({ kind: z.literal("unavailable"), message: z.string(), retryAfterS: z.int().nonnegative().nullable() }),
]);
export type ScreenerAnswer = z.infer<typeof ScreenerAnswer>;
