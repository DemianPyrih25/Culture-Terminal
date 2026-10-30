import type { Pillar } from "@ct/contracts";
import { CONFIDENCE_BAND_VALUES, JOB_VALUES, PILLAR_VALUES, SIGNAL_VALUES } from "@ct/contracts/values";
import { array, nullable, num, object, oneOf, readAs, record, str, withDefault, type Read } from "../../lib/read";
import { readRecentRunIds, recentIdsParam } from "../../lib/recent-briefs";
// Types only: erased from the browser bundle, and they keep the readers below in step with the server.
import type { BriefList, BriefSummary } from "../../server/run-list";

export type { BriefList, BriefSummary };

/**
 * The browser side of GET /api/runs for Home (A01), Ask (A02) and the library (A09). Every request
 * names this browser's own runs (lib/recent-briefs.ts) beside the showcases the server lists for all:
 * other visitors' runs are never listed (D31). Answers are validated before they are drawn.
 */

export type BriefSort = "date" | "conviction";

export interface BriefsQuery {
  limit?: number;
  sort?: BriefSort;
  /** Question search. */
  q?: string | null;
  pillar?: Pillar | null;
  /** The previous page's `next`. */
  before?: string | null;
}

const MetricDisplaySchema = object({ label: str, display: nullable(str), badge: str });

const BriefSummarySchema: Read<BriefSummary> = object({
  runId: str,
  question: str,
  pillar: nullable(oneOf(PILLAR_VALUES)),
  job: nullable(oneOf(JOB_VALUES)),
  jobLabel: nullable(str),
  status: oneOf(["completed", "incomplete"] as const),
  signal: nullable(oneOf(SIGNAL_VALUES)),
  // A list from before the verdict tag existed sends none: the row prints the signal label.
  tag: withDefault(nullable(str), null),
  headline: nullable(str),
  metrics: record(MetricDisplaySchema),
  confidence: nullable(object({ score: num, band: oneOf(CONFIDENCE_BAND_VALUES) })),
  createdAt: str,
  numbersTraced: nullable(object({ traced: num, total: num })),
  sources: num,
});

const TracedSchema = object({ traced: num, total: num });

const BriefListSchema: Read<BriefList> = object({
  runs: array(BriefSummarySchema),
  next: nullable(str),
  total: num,
  pillars: object({ investment: num, location: num, marketing: num, audience: num }),
  numbersTraced: TracedSchema,
  pillarsTraced: object({ investment: TracedSchema, location: TracedSchema, marketing: TracedSchema, audience: TracedSchema }),
});

/** The list URL for a query and this browser's run ids (newest 50). */
export function briefsUrl(query: BriefsQuery, ids: readonly string[] = []): string {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.sort && query.sort !== "date") params.set("sort", query.sort);
  const q = query.q?.trim() ?? "";
  if (q !== "") params.set("q", q);
  if (query.pillar) params.set("pillar", query.pillar);
  if (query.before) params.set("before", query.before);
  const mine = recentIdsParam(ids);
  if (mine !== null) params.set("ids", mine);
  const text = params.toString();
  return text === "" ? "/api/runs" : `/api/runs?${text}`;
}

/** Thrown when the list cannot be read; `retry` says whether trying again may help. */
export class BriefsError extends Error {
  constructor(
    message: string,
    readonly retry: boolean,
  ) {
    super(message);
    this.name = "BriefsError";
  }
}

export interface FetchBriefsOptions {
  signal?: AbortSignal;
  /** This browser's run ids; read from localStorage by default. */
  ids?: readonly string[];
  fetch?: typeof fetch;
}

/** One page of briefs. Throws BriefsError (or the AbortError of `signal`). */
export async function fetchBriefs(query: BriefsQuery, options: FetchBriefsOptions = {}): Promise<BriefList> {
  const { signal, ids = readRecentRunIds(), fetch: doFetch = fetch } = options;
  let res: Response;
  try {
    res = await doFetch(briefsUrl(query, ids), { signal, headers: { accept: "application/json" } });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new BriefsError("The briefs could not be loaded: the connection failed.", true);
  }
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const message = typeof (body as { error?: unknown } | null)?.error === "string" ? (body as { error: string }).error : null;
    throw new BriefsError(message ?? "The briefs could not be loaded.", res.status >= 500);
  }
  const parsed = readAs(BriefListSchema, body);
  if (!parsed.success) throw new BriefsError("The briefs could not be read.", false);
  return parsed.data;
}
