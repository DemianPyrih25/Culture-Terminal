import { and, count, desc, eq, gte, ilike, inArray, isNotNull, isNull, like, lt, notInArray, or, sql, type SQL } from "drizzle-orm";
import type { Queryable } from "../client";
import { metrics, type NewRun, type Run, type RunLane, type RunStatus, runs } from "../schema";

/** D26: a completed run answers the same question hash for 72 hours. */
export const ANSWER_CACHE_WINDOW_MS = 72 * 60 * 60 * 1000;

/** Columns a caller may change after creation. */
export type RunPatch = Partial<Omit<NewRun, "id" | "createdAt" | "updatedAt">>;

export async function createRun(db: Queryable, input: NewRun): Promise<Run> {
  const [row] = await db.insert(runs).values(input).returning();
  if (!row) throw new Error("createRun: insert returned no row");
  return row;
}

export async function getRun(db: Queryable, id: string): Promise<Run | undefined> {
  const [row] = await db.select().from(runs).where(eq(runs.id, id)).limit(1);
  return row;
}

/**
 * Reads a run and locks its row until the surrounding transaction ends, so callers that change a
 * run in several statements take turns. Call it inside `db.transaction`. The lock is FOR NO KEY
 * UPDATE: it does not block run_events inserts (their foreign-key check takes KEY SHARE).
 */
export async function lockRun(tx: Queryable, id: string): Promise<Run | undefined> {
  const [row] = await tx.select().from(runs).where(eq(runs.id, id)).limit(1).for("no key update");
  return row;
}

/** Updates the given columns and bumps updated_at. Returns the updated row, or undefined if none. */
export async function updateRun(db: Queryable, id: string, patch: RunPatch): Promise<Run | undefined> {
  const [row] = await db
    .update(runs)
    .set({ ...patch, updatedAt: sql`now()` })
    .where(eq(runs.id, id))
    .returning();
  return row;
}

export interface SetStatusOptions {
  /** Compare-and-set: only update when the current status is one of these. */
  from?: readonly RunStatus[];
  /** Extra columns written in the same statement (e.g. error, wall_ms). */
  patch?: RunPatch;
}

/** Sets the status. Returns false when the run does not exist or `from` did not match. */
export async function setStatus(
  db: Queryable,
  id: string,
  status: RunStatus,
  options: SetStatusOptions = {},
): Promise<boolean> {
  const { from, patch } = options;
  if (from && from.length === 0) return false;
  const where = from ? and(eq(runs.id, id), inArray(runs.status, [...from])) : eq(runs.id, id);
  const rows = await db
    .update(runs)
    .set({ ...patch, status, updatedAt: sql`now()` })
    .where(where)
    .returning({ id: runs.id });
  return rows.length > 0;
}

/**
 * Stamps when the run left the queue and started; the first stamp wins. Returns false when the run does not
 * exist. Runs that never start keep a null started_at (countRunsSince `startedOnly`).
 */
export async function markStarted(db: Queryable, id: string, ts: Date = new Date()): Promise<boolean> {
  const rows = await db
    .update(runs)
    .set({ startedAt: sql`coalesce(${runs.startedAt}, ${ts.toISOString()}::timestamptz)`, updatedAt: sql`now()` })
    .where(eq(runs.id, id))
    .returning({ id: runs.id });
  return rows.length > 0;
}

/** Raises the cancel flag the run loop polls. Keeps the first request time. False if no such run. */
export async function requestCancel(db: Queryable, id: string): Promise<boolean> {
  const rows = await db
    .update(runs)
    .set({ cancelRequestedAt: sql`coalesce(${runs.cancelRequestedAt}, now())`, updatedAt: sql`now()` })
    .where(eq(runs.id, id))
    .returning({ id: runs.id });
  return rows.length > 0;
}

export async function isCancelRequested(db: Queryable, id: string): Promise<boolean> {
  const [row] = await db
    .select({ at: runs.cancelRequestedAt })
    .from(runs)
    .where(eq(runs.id, id))
    .limit(1);
  return row?.at != null;
}

// Escapes LIKE wildcards so the text matches literally (backslash is Postgres' default escape).
const likeLiteral = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`);
const likePrefix = (prefix: string) => `${likeLiteral(prefix)}%`;

function checkWindow(what: string, ms: number): void {
  if (!Number.isFinite(ms) || ms <= 0) throw new RangeError(`${what}: window must be a positive number of ms, got ${ms}`);
}

export interface CountRunsSinceOptions {
  /** Only runs whose question_hash starts with this, e.g. "fake:". */
  hashPrefix: string;
  /** Window length, measured back from the database clock. */
  sinceMs: number;
  /** Only runs started by this visitor: the salted hash of its address in ip_hash (never the address). */
  ipHash?: string;
  /** Only runs of this lane. */
  lane?: RunLane;
  /**
   * Only runs that started (started_at set): a run that never left the queue (queue timeout, cancel or
   * shutdown while queued) spent nothing and counts toward no visitor or global cap (Part 10 open issue).
   */
  startedOnly?: boolean;
}

/** The conditions of countRunsSince's filter. */
function sinceConditions(what: string, options: CountRunsSinceOptions): SQL[] {
  const { hashPrefix, sinceMs, ipHash, lane, startedOnly } = options;
  checkWindow(what, sinceMs);
  if (ipHash !== undefined && ipHash.trim() === "") throw new RangeError(`${what}: ipHash must not be empty`);
  const conditions = [
    like(runs.questionHash, likePrefix(hashPrefix)),
    gte(runs.createdAt, sql`now() - make_interval(secs => ${sinceMs / 1000})`),
  ];
  if (ipHash !== undefined) conditions.push(eq(runs.ipHash, ipHash));
  if (lane !== undefined) conditions.push(eq(runs.lane, lane));
  if (startedOnly === true) conditions.push(isNotNull(runs.startedAt));
  return conditions;
}

/**
 * How many runs with this question-hash prefix (and, when given, this visitor and lane) were created
 * within the window, whatever their status.
 */
export async function countRunsSince(db: Queryable, options: CountRunsSinceOptions): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(runs)
    .where(and(...sinceConditions("countRunsSince", options)));
  return row?.n ?? 0;
}

/** The most ages one runAgesSince call returns. */
export const RUN_AGES_MAX = 100;

export interface RunAgesSinceOptions extends CountRunsSinceOptions {
  /** At most this many, newest first (1 to RUN_AGES_MAX). */
  limit: number;
}

/**
 * How long ago, in ms on the database clock, the newest runs countRunsSince would count were
 * created, newest first. A rolling limit of k reads the k-th: its leaving the window frees a start.
 */
export async function runAgesSince(db: Queryable, options: RunAgesSinceOptions): Promise<number[]> {
  const { limit } = options;
  if (!Number.isInteger(limit) || limit < 1 || limit > RUN_AGES_MAX) {
    throw new RangeError(`runAgesSince: limit must be an integer from 1 to ${RUN_AGES_MAX}, got ${limit}`);
  }
  const rows = await db
    .select({ ageMs: sql<number>`(extract(epoch from (now() - ${runs.createdAt})) * 1000)::float8`.mapWith(Number) })
    .from(runs)
    .where(and(...sinceConditions("runAgesSince", options)))
    .orderBy(desc(runs.createdAt), desc(runs.id))
    .limit(limit);
  return rows.map((row) => Math.max(0, row.ageMs));
}

export interface ClearIpHashesOptions {
  /** Runs created longer ago than this (database clock) lose their ip_hash. */
  olderThanMs: number;
}

/**
 * Clears ip_hash on runs created before the window: past every per-visitor window, a visitor's hash
 * counts toward nothing, so it is not kept. updated_at is left alone (the run itself did not change).
 * Returns how many runs were cleared.
 */
export async function clearIpHashes(db: Queryable, options: ClearIpHashesOptions): Promise<number> {
  const { olderThanMs } = options;
  checkWindow("clearIpHashes", olderThanMs);
  const rows = await db
    .update(runs)
    .set({ ipHash: null })
    .where(and(isNotNull(runs.ipHash), lt(runs.createdAt, sql`now() - make_interval(secs => ${olderThanMs / 1000})`)))
    .returning({ id: runs.id });
  return rows.length;
}

export interface PurgeRunsOptions {
  /** Only runs whose question_hash starts with this. Required, so a purge can never take every run. */
  hashPrefix: string;
  /** Runs created longer ago than this (database clock) are deleted. */
  olderThanMs: number;
  /** Statuses that are never deleted, e.g. runs still in progress. */
  keepStatuses?: readonly RunStatus[];
}

/**
 * Deletes old runs with this question-hash prefix. Their run_events, evidence, metrics, datasets and
 * findings go with them (on delete cascade); child runs stay, with parent_run_id cleared. Returns
 * how many runs were deleted.
 */
export async function purgeRuns(db: Queryable, options: PurgeRunsOptions): Promise<number> {
  const { hashPrefix, olderThanMs, keepStatuses = [] } = options;
  if (hashPrefix === "") throw new RangeError("purgeRuns: hashPrefix must not be empty");
  checkWindow("purgeRuns", olderThanMs);
  const conditions = [
    like(runs.questionHash, likePrefix(hashPrefix)),
    lt(runs.createdAt, sql`now() - make_interval(secs => ${olderThanMs / 1000})`),
  ];
  if (keepStatuses.length > 0) conditions.push(notInArray(runs.status, [...keepStatuses]));
  const rows = await db
    .delete(runs)
    .where(and(...conditions))
    .returning({ id: runs.id });
  return rows.length;
}

/**
 * The newest completed run for this question hash created within the window (D26), or undefined.
 * The cutoff uses the database clock, the same clock that stamped created_at.
 */
export async function findAnswerCache(
  db: Queryable,
  questionHash: string,
  windowMs: number = ANSWER_CACHE_WINDOW_MS,
): Promise<Run | undefined> {
  const [row] = await db
    .select()
    .from(runs)
    .where(
      and(
        eq(runs.questionHash, questionHash),
        eq(runs.status, "completed"),
        // A follow-up answers its parent's context, never a fresh question (safety net: the hash already differs).
        isNull(runs.parentRunId),
        gte(runs.createdAt, sql`now() - make_interval(secs => ${windowMs / 1000})`),
      ),
    )
    .orderBy(desc(runs.createdAt))
    .limit(1);
  return row;
}

// Listing finished runs (the briefs on Home and in the library) ---------------------------------------

/** The most runs one listRuns page returns. */
export const RUN_LIST_MAX = 50;

/** date: newest first. conviction: highest confidence score first, runs without one last, then newest. */
export type RunListSort = "date" | "conviction";

/**
 * Where a page ended: the next page starts strictly after this row in the sort order. createdAt is
 * the row's created_at in UTC with microseconds (RunListRow.createdAtKey), so rows created within
 * the same millisecond are never skipped; id breaks ties. A date cursor without an id lists the runs
 * created strictly before createdAt. A conviction cursor also carries the row's score.
 */
export interface RunListCursor {
  createdAt: string;
  id: string | null;
  /** The conviction sort key of the row; null for a run without a score. Ignored by the date sort. */
  score?: number | null;
}

/** The most run ids one RunVisibility names. */
export const RUN_VISIBLE_IDS_MAX = 50;

/**
 * Which runs a list may show (D31: user-run notes are unlisted): the curated showcases, and the runs
 * named by id (the ones a visitor started, from their own browser's history). Nothing else, so one
 * visitor's runs never appear in another's list.
 */
export interface RunVisibility {
  /** Include runs with is_showcase set. */
  showcases: boolean;
  /** Include these runs, at most RUN_VISIBLE_IDS_MAX. */
  ids: readonly string[];
}

export interface RunListFilter {
  /** Only runs whose question_hash starts with this (agent runs: "q1:"). Required, so a list never mixes in test runs. */
  hashPrefix: string;
  /** Only runs in these statuses; an empty list matches nothing. */
  statuses: readonly RunStatus[];
  /** Case-insensitive substring of the question. LIKE wildcards in it match literally. */
  search?: string | null;
  /** Required, so a list never shows every visitor's runs; no showcases and no ids match nothing. */
  visible: RunVisibility;
}

export interface ListRunsOptions extends RunListFilter {
  /** Page size, 1 to RUN_LIST_MAX. */
  limit: number;
  /** Defaults to "date". */
  sort?: RunListSort;
  /** Only runs on this desk (the pillar column). */
  pillar?: string | null;
  /** The previous page's `next`. */
  after?: RunListCursor | null;
}

/** One finished run as a list shows it: the row's columns plus what its stored report says. */
export interface RunListRow {
  id: string;
  question: string;
  pillar: string | null;
  job: string | null;
  status: RunStatus;
  createdAt: Date;
  /** created_at in UTC with microseconds, for a cursor. */
  createdAtKey: string;
  /** report.verdict.signal, or null without a report. */
  signal: string | null;
  /** report.verdict.headline, or null. */
  headline: string | null;
  /** report.verdict.tag, or null (absent in reports stored before it existed; callers validate it). */
  tag: string | null;
  /** report.verdict.confidence.score, or null. */
  confidenceScore: number | null;
  /** report.verdict.confidence.band, or null. */
  confidenceBand: string | null;
  /** The receipt's numbersTraced, else the validation column's, as stored (callers validate it). */
  numbersTraced: unknown;
  qlooNetwork: number;
  qlooCached: number;
  /** The receipt's requests reused from a parent run (a follow-up), or null without a report. */
  qlooReused: number | null;
}

export interface RunListPage {
  rows: RunListRow[];
  /** The cursor for the next page, or null when this page is the last. */
  next: RunListCursor | null;
}

export interface RunListSummary {
  /** Matching runs. */
  total: number;
  /** Matching runs per pillar column value; runs without a pillar are counted under "". */
  byPillar: Record<string, number>;
  /** Numbers traced and checked across the matching runs that recorded them. */
  numbersTraced: { traced: number; total: number };
  /** The same per pillar column value, keyed like byPillar. */
  numbersTracedByPillar: Record<string, { traced: number; total: number }>;
}

/** A constant jsonb path literal such as '{verdict,signal}'; only plain keys are accepted. */
function jsonPath(path: string): SQL {
  if (!/^[A-Za-z]+(,[A-Za-z]+)*$/.test(path)) throw new RangeError(`jsonPath: not a plain key path: ${path}`);
  return sql.raw(`'{${path}}'`);
}

const toNumberOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/** A number inside a jsonb value as float8, or null when the path is missing or holds no number. */
function jsonNumber(value: SQL, path: string): SQL<number | null> {
  const at = jsonPath(path);
  return sql<number | null>`(case when jsonb_typeof(${value} #> ${at}) = 'number' then (${value} #>> ${at})::float8 end)`.mapWith(
    toNumberOrNull,
  );
}

/** A string inside a jsonb value, or null when the path is missing or holds no string. */
function jsonText(value: SQL, path: string): SQL<string | null> {
  const at = jsonPath(path);
  return sql<string | null>`(case when jsonb_typeof(${value} #> ${at}) = 'string' then ${value} #>> ${at} end)`;
}

const REPORT = sql`${runs.report}`;
const CONFIDENCE_SCORE = jsonNumber(REPORT, "verdict,confidence,score");
const RECEIPT_TRACED = jsonPath("receipt,numbersTraced");
const VALIDATION_TRACED = jsonPath("numbersTraced");
/** The receipt's numbersTraced, else the validation column's (a run that never assembled a report). */
const NUMBERS_TRACED = sql`coalesce(${runs.report} #> ${RECEIPT_TRACED}, ${runs.validation} #> ${VALIDATION_TRACED})`;
const CREATED_AT_KEY = sql<string>`to_char(${runs.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** The visibility as one condition, or null when it shows no run at all. */
function visibleCondition(visible: RunVisibility): SQL | null {
  const ids = [...new Set(visible.ids)];
  if (ids.length > RUN_VISIBLE_IDS_MAX) {
    throw new RangeError(`listRuns: at most ${RUN_VISIBLE_IDS_MAX} visible run ids, got ${ids.length}`);
  }
  const parts: SQL[] = [];
  if (visible.showcases) parts.push(eq(runs.isShowcase, true));
  if (ids.length > 0) parts.push(inArray(runs.id, ids));
  return parts.length === 0 ? null : (or(...parts) ?? null);
}

/** The filter's conditions, or null when it can match no run (no statuses, nothing visible). */
function filterConditions(filter: RunListFilter): SQL[] | null {
  const { hashPrefix, statuses, search } = filter;
  if (hashPrefix === "") throw new RangeError("listRuns: hashPrefix must not be empty");
  const visible = visibleCondition(filter.visible);
  if (statuses.length === 0 || visible === null) return null;
  const conditions: SQL[] = [like(runs.questionHash, likePrefix(hashPrefix)), inArray(runs.status, [...statuses]), visible];
  const text = search?.trim() ?? "";
  if (text !== "") conditions.push(ilike(runs.question, `%${likeLiteral(text)}%`));
  return conditions;
}

/** Rows strictly after the cursor's (created_at, id) in newest-first order. */
function olderThan(cursor: RunListCursor): SQL {
  const at = sql`${cursor.createdAt}::timestamptz`;
  return cursor.id === null ? sql`${runs.createdAt} < ${at}` : sql`(${runs.createdAt}, ${runs.id}) < (${at}, ${cursor.id}::text)`;
}

/** Rows strictly after the cursor in conviction order: lower scores, the same score but older, then no score. */
function afterInConviction(cursor: RunListCursor): SQL {
  const score = cursor.score ?? null;
  if (score === null) return sql`(${CONFIDENCE_SCORE} is null and ${olderThan(cursor)})`;
  const s = sql`${score}::float8`;
  return sql`(${CONFIDENCE_SCORE} < ${s} or (${CONFIDENCE_SCORE} = ${s} and ${olderThan(cursor)}) or ${CONFIDENCE_SCORE} is null)`;
}

/**
 * A page of the visible runs, newest first or by conviction, keyset-paginated so a page never repeats
 * or skips a run as new ones arrive. Reads only the report fields a list shows, never the whole report.
 */
export async function listRuns(db: Queryable, options: ListRunsOptions): Promise<RunListPage> {
  const { limit, sort = "date", pillar, after } = options;
  if (!Number.isInteger(limit) || limit < 1 || limit > RUN_LIST_MAX) {
    throw new RangeError(`listRuns: limit must be an integer from 1 to ${RUN_LIST_MAX}, got ${limit}`);
  }
  const conditions = filterConditions(options);
  if (conditions === null) return { rows: [], next: null };
  if (pillar) conditions.push(eq(runs.pillar, pillar));
  if (after) conditions.push(sort === "conviction" ? afterInConviction(after) : olderThan(after));
  const order =
    sort === "conviction"
      ? [sql`${CONFIDENCE_SCORE} desc nulls last`, desc(runs.createdAt), desc(runs.id)]
      : [desc(runs.createdAt), desc(runs.id)];
  const found = await db
    .select({
      id: runs.id,
      question: runs.question,
      pillar: runs.pillar,
      job: runs.job,
      status: runs.status,
      createdAt: runs.createdAt,
      createdAtKey: CREATED_AT_KEY,
      signal: jsonText(REPORT, "verdict,signal"),
      headline: jsonText(REPORT, "verdict,headline"),
      tag: jsonText(REPORT, "verdict,tag"),
      confidenceScore: CONFIDENCE_SCORE,
      confidenceBand: jsonText(REPORT, "verdict,confidence,band"),
      numbersTraced: sql<unknown>`${NUMBERS_TRACED}`,
      qlooNetwork: runs.qlooNetwork,
      qlooCached: runs.qlooCached,
      qlooReused: jsonNumber(REPORT, "receipt,qlooReused"),
    })
    .from(runs)
    .where(and(...conditions))
    .orderBy(...order)
    .limit(limit + 1);
  const rows = found.slice(0, limit);
  const last = rows.at(-1);
  const next: RunListCursor | null =
    found.length > limit && last
      ? { createdAt: last.createdAtKey, id: last.id, ...(sort === "conviction" ? { score: last.confidenceScore } : {}) }
      : null;
  return { rows, next };
}

/** How a list shows one metric a run's headline cites. display is null when the metric is UNAVAILABLE. */
export interface MetricDisplay {
  label: string;
  display: string | null;
  badge: string;
}

/**
 * The display of the metrics each run cites, e.g. in its headline: run id → metric id → display.
 * Metrics a run never recorded are simply absent. One query whatever the number of runs.
 */
export async function listMetricDisplays(
  db: Queryable,
  wanted: ReadonlyMap<string, readonly string[]>,
): Promise<Map<string, Record<string, MetricDisplay>>> {
  const out = new Map<string, Record<string, MetricDisplay>>();
  const pairs = [...wanted].filter(([, ids]) => ids.length > 0);
  if (pairs.length === 0) return out;
  const rows = await db
    .select({ runId: metrics.runId, id: metrics.id, label: metrics.label, display: metrics.display, badge: metrics.badge })
    .from(metrics)
    .where(or(...pairs.map(([runId, ids]) => and(eq(metrics.runId, runId), inArray(metrics.id, [...ids])))));
  for (const row of rows) {
    const byId = out.get(row.runId) ?? {};
    byId[row.id] = { label: row.label, display: row.display, badge: row.badge };
    out.set(row.runId, byId);
  }
  return out;
}

/** Counts of the runs a filter matches: in all, per pillar, and the numbers they traced. */
export async function summarizeRuns(db: Queryable, filter: RunListFilter): Promise<RunListSummary> {
  const conditions = filterConditions(filter);
  const summary: RunListSummary = { total: 0, byPillar: {}, numbersTraced: { traced: 0, total: 0 }, numbersTracedByPillar: {} };
  if (conditions === null) return summary;
  const traced = jsonNumber(NUMBERS_TRACED, "traced");
  const total = jsonNumber(NUMBERS_TRACED, "total");
  const groups = await db
    .select({
      pillar: runs.pillar,
      runs: count(),
      traced: sql<number>`coalesce(sum(${traced}), 0)::float8`.mapWith(Number),
      total: sql<number>`coalesce(sum(${total}), 0)::float8`.mapWith(Number),
    })
    .from(runs)
    .where(and(...conditions))
    .groupBy(runs.pillar);
  for (const g of groups) {
    summary.total += g.runs;
    const key = g.pillar ?? "";
    summary.byPillar[key] = (summary.byPillar[key] ?? 0) + g.runs;
    summary.numbersTraced.traced += g.traced;
    summary.numbersTraced.total += g.total;
    const desk = summary.numbersTracedByPillar[key] ?? { traced: 0, total: 0 };
    summary.numbersTracedByPillar[key] = { traced: desk.traced + g.traced, total: desk.total + g.total };
  }
  return summary;
}

export interface RecentRunStatusesOptions {
  /** Only runs whose question_hash starts with this, e.g. "q1:" or "fake:". */
  hashPrefix: string;
  /** At most this many, newest first (1 to RUN_LIST_MAX). */
  limit: number;
}

/** Statuses of the latest runs with this question-hash prefix, newest first (/status). */
export async function recentRunStatuses(db: Queryable, options: RecentRunStatusesOptions): Promise<RunStatus[]> {
  const rows = await db
    .select({ status: runs.status })
    .from(runs)
    .where(like(runs.questionHash, likePrefix(options.hashPrefix)))
    .orderBy(desc(runs.createdAt), desc(runs.id))
    .limit(Math.max(1, Math.min(options.limit, RUN_LIST_MAX)));
  return rows.map((row) => row.status);
}

/** Names listPublicFigureNames returns at most. */
export const PUBLIC_FIGURE_NAMES_MAX = 2_000;

/**
 * The person mentions CLERK marked `public_figure` in briefs that ran (completed or incomplete), each
 * name once as written, newest first. The DES tearsheet vets a person with them before any Qloo request
 * (SPEC §4.6). Names only: no entity id.
 */
export async function listPublicFigureNames(db: Queryable, limit = PUBLIC_FIGURE_NAMES_MAX): Promise<string[]> {
  const capped = Math.max(1, Math.min(Math.trunc(limit), PUBLIC_FIGURE_NAMES_MAX));
  const mentions = sql`(case when jsonb_typeof(${runs.intent} -> 'mentions') = 'array' then ${runs.intent} -> 'mentions' else '[]'::jsonb end)`;
  const rows = await db.execute<{ name: string }>(sql`
    select m.value ->> 'text' as name
    from ${runs} cross join lateral jsonb_array_elements(${mentions}) as m(value)
    where ${runs.status} in ('completed', 'incomplete')
      and m.value ->> 'entity_type' = 'person'
      and m.value -> 'public_figure' = 'true'::jsonb
      and jsonb_typeof(m.value -> 'text') = 'string'
    group by 1
    order by max(${runs.createdAt}) desc
    limit ${capped}`);
  return rows.map((row) => row.name);
}
