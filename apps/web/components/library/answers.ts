import { RunStatus } from "@ct/contracts";
import { z } from "zod";
import { isRunId } from "../../lib/run-id";
import { BriefsError, fetchBriefs, type BriefSummary } from "./briefs-client";
import { verdictText } from "./format";

/**
 * "Your answers" (/briefs): the runs this browser started (lib/recent-briefs.ts), never the showcases or
 * another visitor's runs. Finished answers come from GET /api/runs with this browser's ids; the runs
 * that list leaves out (still working, stopped, failed, refused, needing input) are read one by one from
 * GET /api/runs/[id], the newest ANSWERS_SNAPSHOT_MAX of them. Pure but for the requests, so it is tested
 * with a stand-in fetch.
 */

/** done: an answer; partial: ended without a full answer; working: still running; stopped: anything else. */
export type AnswerStatus = "done" | "partial" | "working" | "stopped";

/** One row of Your answers. */
export interface AnswerItem {
  runId: string;
  question: string;
  status: AnswerStatus;
  /** The verdict tag of a done answer, or the status in words ("Working…", "Stopped", "Declined"). */
  note: string;
  createdAt: string;
}

/** Most ids one list request names (GET /api/runs takes up to 50). */
export const ANSWERS_LIST_MAX = 50;
/** Most runs read one by one, for the statuses the list leaves out. */
export const ANSWERS_SNAPSHOT_MAX = 20;

/** The words of a run's status, for the runs the list leaves out. */
const STATUS_ROW: Readonly<Record<RunStatus, { status: AnswerStatus; note: string }>> = {
  queued: { status: "working", note: "Working…" },
  running: { status: "working", note: "Working…" },
  completed: { status: "done", note: "Answer ready" },
  incomplete: { status: "partial", note: "Partial answer" },
  cancelled: { status: "stopped", note: "Stopped" },
  failed: { status: "stopped", note: "Not finished" },
  refused: { status: "stopped", note: "Declined" },
  needs_input: { status: "stopped", note: "Needs input" },
};

/** A finished answer as GET /api/runs lists it. */
export function answerFromSummary(brief: BriefSummary): AnswerItem {
  const partial = brief.status === "incomplete" && brief.signal === null;
  return {
    runId: brief.runId,
    question: brief.question,
    status: partial ? "partial" : "done",
    note: partial ? "Partial answer" : verdictText(brief),
    createdAt: brief.createdAt,
  };
}

/** The part of GET /api/runs/[id] a row reads. */
export const RunRowSchema = z.object({
  run: z.object({ id: z.string(), status: RunStatus, question: z.string(), createdAt: z.string() }),
});
export type RunRow = z.infer<typeof RunRowSchema>["run"];

/** A run read on its own, by its status. */
export function answerFromRun(run: RunRow): AnswerItem {
  const row = STATUS_ROW[run.status];
  return { runId: run.id, question: run.question, status: row.status, note: row.note, createdAt: run.createdAt };
}

/** Newest first; a time that does not parse sorts last. */
export function byNewest(items: readonly AnswerItem[]): AnswerItem[] {
  const at = (item: AnswerItem) => {
    const t = Date.parse(item.createdAt);
    return Number.isNaN(t) ? -Infinity : t;
  };
  return [...items].sort((a, b) => at(b) - at(a));
}

/** One run read on its own; null when it is gone, is not one, or cannot be read. */
async function readRun(id: string, doFetch: typeof fetch, signal?: AbortSignal): Promise<RunRow | null> {
  try {
    const res = await doFetch(`/api/runs/${encodeURIComponent(id)}`, { signal, headers: { accept: "application/json" } });
    if (!res.ok) return null;
    const parsed = RunRowSchema.safeParse(await res.json());
    return parsed.success && parsed.data.run.id === id ? parsed.data.run : null;
  } catch (err) {
    if (signal?.aborted) throw err;
    return null;
  }
}

export interface LoadAnswersOptions {
  signal?: AbortSignal;
  fetch?: typeof fetch;
}

/**
 * The rows for this browser's run ids, newest first. Throws BriefsError when the list cannot be read
 * (a run read on its own that fails is left out instead).
 */
export async function loadYourAnswers(ids: readonly string[], options: LoadAnswersOptions = {}): Promise<AnswerItem[]> {
  const { signal, fetch: doFetch = fetch } = options;
  const mine = [...new Set(ids.filter(isRunId))].slice(0, ANSWERS_LIST_MAX);
  if (mine.length === 0) return [];
  const list = await fetchBriefs({ limit: ANSWERS_LIST_MAX }, { ids: mine, signal, fetch: doFetch });
  const wanted = new Set(mine);
  // The list holds the showcases too: only this browser's own runs are its answers.
  const listed = list.runs.filter((brief) => wanted.has(brief.runId)).map(answerFromSummary);
  const seen = new Set(listed.map((item) => item.runId));
  const rest = mine.filter((id) => !seen.has(id)).slice(0, ANSWERS_SNAPSHOT_MAX);
  const read = await Promise.all(rest.map((id) => readRun(id, doFetch, signal)));
  const others = read.filter((run): run is RunRow => run !== null).map(answerFromRun);
  return byNewest([...listed, ...others]);
}

export { BriefsError };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** The calendar day of a time in `timeZone` (the visitor's by default), as [year, month, day]. */
function dayOf(at: Date, timeZone?: string): [number, number, number] {
  const parts = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "numeric", day: "numeric", timeZone }).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value ?? NaN);
  return [part("year"), part("month"), part("day")];
}

/**
 * "Today", "Yesterday", else "26 Oct", with the year when it is not this year ("26 Oct 2025"); "" when
 * `iso` is not a time.
 */
export function relativeDay(iso: string, now: number, timeZone?: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const [y, m, d] = dayOf(at, timeZone);
  const [ty, tm, td] = dayOf(new Date(now), timeZone);
  const days = Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(y, m - 1, d)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  const day = `${d} ${MONTHS[m - 1] ?? ""}`;
  return y === ty ? day : `${day} ${y}`;
}
