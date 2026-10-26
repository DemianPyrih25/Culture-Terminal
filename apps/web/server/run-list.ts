import "server-only";
import {
  ConfidenceBand,
  extractMetricIds,
  IsoDateTime,
  isVerdictTag,
  Job,
  NumbersTraced,
  Pillar,
  Report,
  Signal,
  type MetricId,
} from "@ct/contracts";
import {
  getRun,
  listMetricDisplays,
  listRuns,
  RUN_LIST_MAX,
  RUN_VISIBLE_IDS_MAX,
  summarizeRuns,
  type MetricDisplay,
  type Queryable,
  type RunListCursor,
  type RunListRow,
  type RunListSort,
  type Run,
  type RunStatus,
} from "@ct/db";
import { z } from "zod";
import { JOB_LABEL } from "../lib/brief/format";
import { isRunId } from "../lib/run-id";
import { QUESTION_HASH_PREFIX } from "./question-hash";

/**
 * GET /api/runs: the recent briefs on Home (A01) and in the briefs library (A09). Only agent runs
 * that stored a note, or ended incomplete, are listed; test runs never are (their question_hash has
 * its own prefix). User-run notes are unlisted (D31): a list shows the curated showcases and the runs
 * the browser names in `ids` (its own history, lib/recent-briefs.ts), never another visitor's runs.
 * Pages are keyset cursors over created_at, so a page never repeats or skips a run.
 */

/** Statuses a brief can be listed in: the run finished with a note, or ended incomplete. */
export const BRIEF_STATUSES = ["completed", "incomplete"] as const satisfies readonly RunStatus[];
export type BriefStatus = (typeof BRIEF_STATUSES)[number];

export const RUN_LIST_DEFAULT_LIMIT = 20;
/** Longest question search the list accepts; a question itself is at most 400 characters. */
export const RUN_LIST_SEARCH_MAX = 200;
/** Most run ids one list request may name (`ids`). */
export const RUN_LIST_IDS_MAX = RUN_VISIBLE_IDS_MAX;

export interface RunListQuery {
  /** 1 to RUN_LIST_MAX (larger asks are cut to it). */
  limit: number;
  sort: RunListSort;
  /** Case-insensitive question substring, or null. */
  search: string | null;
  pillar: Pillar | null;
  /** Where the previous page ended, or null for the first page. */
  before: RunListCursor | null;
  /** Runs the browser started (its own history), listed beside the showcases; distinct, at most RUN_LIST_IDS_MAX. */
  ids: string[];
}

/** One brief as Home and the library list it. */
export interface BriefSummary {
  runId: string;
  question: string;
  pillar: Pillar | null;
  job: Job | null;
  /** "Compare two brands"; null when CLERK never read the question. */
  jobLabel: string | null;
  status: BriefStatus;
  /** Null when the run stored no note. */
  signal: Signal | null;
  /** The note's verdict tag ("Taste island") when it keeps its rule; null otherwise, and the row prints the signal. */
  tag: string | null;
  /** The verdict headline with its {{M#}} and [E#] tokens, rendered with `metrics`; null without a note. */
  headline: string | null;
  /** The display of every metric the headline cites, by id. A metric display of null is UNAVAILABLE, never 0. */
  metrics: Record<string, MetricDisplay>;
  /** Conviction: the code-computed confidence (D9); null without a note. */
  confidence: { score: number; band: ConfidenceBand } | null;
  createdAt: string;
  /** CHECKER's "N/N numbers traced", or null when the run never reached it. */
  numbersTraced: NumbersTraced | null;
  /** Qloo requests behind the brief: network calls, calls served from the cache and calls reused from a parent. */
  sources: number;
}

export interface BriefList {
  runs: BriefSummary[];
  /** Pass as `before` for the next page; null on the last page. */
  next: string | null;
  /** Briefs matching the search, all desks. */
  total: number;
  /** Briefs matching the search per desk (the library outline). */
  pillars: Record<Pillar, number>;
  /** Numbers traced across the briefs matching the search ("1,026 / 1,026 numbers traced"). */
  numbersTraced: NumbersTraced;
  /** The same per desk (the library's desk view). */
  pillarsTraced: Record<Pillar, NumbersTraced>;
}

export type ParsedRunListQuery =
  | { ok: true; query: RunListQuery }
  | { ok: false; error: string; issues: { path: string; message: string }[] };

// Cursors -------------------------------------------------------------------------------------------

/** created_at as listRuns writes it into a cursor: UTC, up to microseconds. */
const CURSOR_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
const CURSOR_ID_MAX = 128;

const CursorTuple = z.tuple([
  z.enum(["date", "conviction"]),
  // The shape listRuns writes, and a real calendar time: Postgres cannot read month 13 or hour 25.
  z
    .string()
    .regex(CURSOR_TIME)
    .refine((s) => IsoDateTime.safeParse(s).success),
  z.string().min(1).max(CURSOR_ID_MAX),
  z.number().nullable(),
]);

/** The opaque `next` of a page: the sort it belongs to and where it ended, base64url-encoded. */
export function encodeCursor(sort: RunListSort, cursor: RunListCursor): string {
  const tuple: z.infer<typeof CursorTuple> = [sort, cursor.createdAt, cursor.id ?? "", cursor.score ?? null];
  return Buffer.from(JSON.stringify(tuple), "utf8").toString("base64url");
}

/**
 * A `before` value: a cursor from a previous page of the same sort, or (date sort only) a plain
 * ISO timestamp, which lists the briefs created before it. Null when it is neither.
 */
export function decodeCursor(sort: RunListSort, raw: string): RunListCursor | null {
  if (sort === "date" && IsoDateTime.safeParse(raw).success) return { createdAt: raw, id: null };
  if (!/^[A-Za-z0-9_-]{1,400}$/.test(raw)) return null;
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const parsed = CursorTuple.safeParse(json);
  if (!parsed.success || parsed.data[0] !== sort) return null;
  const [, createdAt, id, score] = parsed.data;
  return { createdAt, id, ...(sort === "conviction" ? { score } : {}) };
}

// The query -----------------------------------------------------------------------------------------

const QueryParams = z.object({
  limit: z.coerce
    .number()
    .int("limit must be a whole number.")
    .min(1, "limit must be at least 1.")
    .transform((n) => Math.min(n, RUN_LIST_MAX))
    .default(RUN_LIST_DEFAULT_LIMIT),
  sort: z.enum(["date", "conviction"]).default("date"),
  q: z.string().trim().max(RUN_LIST_SEARCH_MAX, `q is at most ${RUN_LIST_SEARCH_MAX} characters.`).optional(),
  pillar: Pillar.optional(),
  before: z.string().max(400).optional(),
  // A few bytes over the most ids of the longest kind, so a long list fails on its count, not its length.
  ids: z
    .string()
    .max(RUN_LIST_IDS_MAX * 66, "ids is too long.")
    .transform((s) => [...new Set(s.split(",").map((id) => id.trim()).filter((id) => id !== ""))])
    .refine((ids) => ids.every(isRunId), "ids must be run ids, separated by commas.")
    .refine((ids) => ids.length <= RUN_LIST_IDS_MAX, `ids names at most ${RUN_LIST_IDS_MAX} runs.`)
    .optional(),
});

/**
 * Reads `?limit=&before=&q=&sort=date|conviction&pillar=&ids=`. An empty parameter counts as absent;
 * others are ignored.
 */
export function parseRunListQuery(params: URLSearchParams): ParsedRunListQuery {
  const read = (name: string): string | undefined => {
    const value = params.get(name);
    return value === null || value.trim() === "" ? undefined : value;
  };
  const parsed = QueryParams.safeParse({
    limit: read("limit"),
    sort: read("sort"),
    q: read("q"),
    pillar: read("pillar"),
    before: read("before"),
    ids: read("ids"),
  });
  if (!parsed.success) {
    return {
      ok: false,
      error: "Invalid list request.",
      issues: parsed.error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })),
    };
  }
  const { limit, sort, q, pillar, before: rawBefore, ids = [] } = parsed.data;
  let before: RunListCursor | null = null;
  if (rawBefore !== undefined) {
    before = decodeCursor(sort, rawBefore);
    if (before === null) {
      const message = "before must be the next value of a page with the same sort, or (for the date sort) an ISO timestamp.";
      return { ok: false, error: "Invalid list request.", issues: [{ path: "before", message }] };
    }
  }
  const search = q === "" || q === undefined ? null : q;
  return { ok: true, query: { limit, sort, search, pillar: pillar ?? null, before, ids } };
}

// The list ------------------------------------------------------------------------------------------

const option = <T>(schema: z.ZodType<T>, value: unknown): T | null => {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

function confidenceOf(row: RunListRow): BriefSummary["confidence"] {
  const score = row.confidenceScore;
  const band = option(ConfidenceBand, row.confidenceBand);
  if (score === null || !Number.isInteger(score) || score < 0 || score > 100 || band === null) return null;
  return { score, band };
}

/** A list row as the API shows it; what the stored report says is validated, never trusted. */
export function toBriefSummary(row: RunListRow, metrics: Record<string, MetricDisplay> = {}): BriefSummary {
  const job = option(Job, row.job);
  return {
    runId: row.id,
    question: row.question,
    pillar: option(Pillar, row.pillar),
    job,
    jobLabel: job === null ? null : JOB_LABEL[job],
    status: row.status === "completed" ? "completed" : "incomplete",
    signal: option(Signal, row.signal),
    tag: isVerdictTag(row.tag) ? row.tag.trim() : null,
    headline: row.headline,
    metrics,
    confidence: confidenceOf(row),
    createdAt: row.createdAt.toISOString(),
    numbersTraced: option(NumbersTraced, row.numbersTraced),
    sources: row.qlooNetwork + row.qlooCached + (row.qlooReused ?? 0),
  };
}

function pillarCounts(byPillar: Record<string, number>): Record<Pillar, number> {
  return Object.fromEntries(Pillar.options.map((p) => [p, byPillar[p] ?? 0])) as Record<Pillar, number>;
}

function pillarTraced(byPillar: Record<string, NumbersTraced>): Record<Pillar, NumbersTraced> {
  return Object.fromEntries(Pillar.options.map((p) => [p, byPillar[p] ?? { traced: 0, total: 0 }])) as Record<Pillar, NumbersTraced>;
}

/** One page of the showcases and the named runs, and the counts the library shows, in three queries. */
export async function listBriefs(db: Queryable, query: RunListQuery): Promise<BriefList> {
  const filter = {
    hashPrefix: QUESTION_HASH_PREFIX,
    statuses: BRIEF_STATUSES,
    search: query.search,
    visible: { showcases: true, ids: query.ids },
  };
  const [page, summary] = await Promise.all([
    listRuns(db, { ...filter, limit: query.limit, sort: query.sort, pillar: query.pillar, after: query.before }),
    summarizeRuns(db, filter),
  ]);
  const cited = new Map<string, MetricId[]>(
    page.rows.flatMap((r) => (r.headline === null ? [] : [[r.id, extractMetricIds(r.headline)] as const])),
  );
  const displays = await listMetricDisplays(db, cited);
  return {
    runs: page.rows.map((row) => toBriefSummary(row, displays.get(row.id) ?? {})),
    next: page.next === null ? null : encodeCursor(query.sort, page.next),
    total: summary.total,
    pillars: pillarCounts(summary.byPillar),
    numbersTraced: summary.numbersTraced,
    pillarsTraced: pillarTraced(summary.numbersTracedByPillar),
  };
}

/** A question as the starters and the showcases are matched on: spaces collapsed, any case. */
export function questionKey(question: string): string {
  return question.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * The completed showcase briefs by question (questionKey), the newest of each: a starter on Home whose
 * question has one opens that brief (same snapshot, instant, $0) instead of asking again.
 */
export async function showcaseRunsByQuestion(db: Queryable): Promise<Map<string, string>> {
  const page = await listRuns(db, {
    hashPrefix: QUESTION_HASH_PREFIX,
    statuses: ["completed"],
    visible: { showcases: true, ids: [] },
    limit: RUN_LIST_MAX,
  });
  const byQuestion = new Map<string, string>();
  for (const row of page.rows) {
    const key = questionKey(row.question);
    if (!byQuestion.has(key)) byQuestion.set(key, row.id);
  }
  return byQuestion;
}

/** Why a run cannot be followed up, as POST /api/runs would refuse it as a parent. */
export type FollowUpBlock = "running" | "test_run" | "no_note";

/** Runs still being written: their note is not there yet. */
const WRITING_STATUSES: readonly RunStatus[] = ["queued", "running"];

/**
 * RunManager.parentContext's rule, read from the run row: an agent run (never a test run) that ended
 * completed or incomplete with a stored note. Null when the run can be followed up.
 */
export function followUpBlock(run: Pick<Run, "questionHash" | "status" | "report">): FollowUpBlock | null {
  if (!run.questionHash.startsWith(QUESTION_HASH_PREFIX)) return "test_run";
  if (WRITING_STATUSES.includes(run.status)) return "running";
  const finished = (BRIEF_STATUSES as readonly RunStatus[]).includes(run.status);
  return finished && Report.safeParse(run.report).success ? null : "no_note";
}

/** The parent a follow-up names, as the Ask page shows it. */
export interface FollowUpParent {
  question: string;
  /** Why the run would be refused as the parent; null when it can be followed up. */
  blocked: FollowUpBlock | null;
}

/**
 * The run a follow-up on the Ask page hangs from, by id, or null when there is no such run. Any run the
 * id names, as its own page shows it (the id is the key to an unlisted note); `blocked` says whether
 * POST /api/runs will take it as the parent.
 */
export async function getFollowUpParent(db: Queryable, runId: string): Promise<FollowUpParent | null> {
  if (!isRunId(runId)) return null;
  const run = await getRun(db, runId);
  return run ? { question: run.question, blocked: followUpBlock(run) } : null;
}
