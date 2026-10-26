import { ConfidenceBand, Job, Pillar, Signal } from "@ct/contracts";
import { z } from "zod";
import { readRecentRunIds, recentIdsParam } from "../../lib/recent-briefs";
// Types only: erased from the browser bundle, and they keep the schema below in step with the server.
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

const MetricDisplaySchema = z.object({ label: z.string(), display: z.string().nullable(), badge: z.string() });

const BriefSummarySchema = z.object({
  runId: z.string(),
  question: z.string(),
  pillar: Pillar.nullable(),
  job: Job.nullable(),
  jobLabel: z.string().nullable(),
  status: z.enum(["completed", "incomplete"]),
  signal: Signal.nullable(),
  // A list from before the verdict tag existed sends none: the row prints the signal label.
  tag: z.string().nullable().default(null),
  headline: z.string().nullable(),
  metrics: z.record(z.string(), MetricDisplaySchema),
  confidence: z.object({ score: z.number(), band: ConfidenceBand }).nullable(),
  createdAt: z.string(),
  numbersTraced: z.object({ traced: z.number(), total: z.number() }).nullable(),
  sources: z.number(),
}) satisfies z.ZodType<BriefSummary>;

const TracedSchema = z.object({ traced: z.number(), total: z.number() });

const BriefListSchema = z.object({
  runs: z.array(BriefSummarySchema),
  next: z.string().nullable(),
  total: z.number(),
  pillars: z.object({ investment: z.number(), location: z.number(), marketing: z.number(), audience: z.number() }),
  numbersTraced: TracedSchema,
  pillarsTraced: z.object({ investment: TracedSchema, location: TracedSchema, marketing: TracedSchema, audience: TracedSchema }),
}) satisfies z.ZodType<BriefList>;

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
  const parsed = BriefListSchema.safeParse(body);
  if (!parsed.success) throw new BriefsError("The briefs could not be read.", false);
  return parsed.data;
}
