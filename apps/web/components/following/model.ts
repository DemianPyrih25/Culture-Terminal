import type { Follow, RunStatus } from "@ct/contracts";
import { FOLLOW_KIND_LABEL, FOLLOW_PENDING_LABEL, isVerdictTag } from "@ct/contracts/values";
import { JOB_LABEL, SIGNAL_LABEL } from "../../lib/brief/format";
import { relativeDay } from "../library/answers";

/**
 * The Following page (PLAN §8.1, §2.4) as data: one row per follow with its latest note and the state
 * of its re-run. Nothing here says a note changed: a row shows the latest note, its date and [Re-run].
 * Pure, so it is tested without a browser.
 */

/** Where a row's re-run stands. */
export type RerunState =
  | { kind: "idle" }
  | { kind: "starting" }
  /** Started and not ended: the row links to the run while it works (or waits in the queue). */
  | { kind: "running"; runId: string }
  /** Could not start (a limit, the human check, the budget): the server's own words. */
  | { kind: "error"; message: string }
  /** Ended without a note: the follow keeps its last note, and the run stays open to read. */
  | { kind: "ended"; runId: string; message: string };

export const RERUN_IDLE: RerunState = { kind: "idle" };

/** What a re-run that ended without a note says, by its status; the last note always stays. */
export function rerunEndedMessage(status: RunStatus | null): string {
  switch (status) {
    case "needs_input":
      return "The re-run needs you to choose which name it means. Open it to choose; your last note stays.";
    case "refused":
      return "The re-run was declined. Your last note stays.";
    case "cancelled":
      return "The re-run was stopped. Your last note stays.";
    case null:
      return "The re-run is no longer stored. Your last note stays.";
    default:
      return "The re-run did not finish. Your last note stays.";
  }
}

/** done: a note; partial: a note without a full verdict; working: running or queued; stopped: anything else. */
export type NoteStatus = "done" | "partial" | "working" | "stopped";

const STATUS_NOTE: Readonly<Record<RunStatus, { status: NoteStatus; text: string }>> = {
  queued: { status: "working", text: "Working…" },
  running: { status: "working", text: "Working…" },
  completed: { status: "done", text: "Answer ready" },
  incomplete: { status: "partial", text: "Partial answer" },
  cancelled: { status: "stopped", text: "Stopped" },
  failed: { status: "stopped", text: "Not finished" },
  refused: { status: "stopped", text: "Declined" },
  needs_input: { status: "stopped", text: "Needs input" },
};

export interface FollowNote {
  /** /r/[id] for a finished note, /run/[id] otherwise. */
  href: string;
  status: NoteStatus;
  /** The verdict tag ("Taste island"), else the signal label, else the status in words. */
  text: string;
  /** The note's verdict headline, when it has one. */
  headline: string | null;
  /** "Today", "Yesterday", "26 Oct". */
  day: string;
  createdAt: string;
}

export interface FollowRowModel {
  id: string;
  /** "Brand", "Place", "Question". */
  kindLabel: string;
  label: string;
  /** "Real competitors": the job the follow re-runs as; null when it was never read as one. */
  jobLabel: string | null;
  /** The latest note, or null before the first run (a brand followed from its profile) or once retention removed it. */
  note: FollowNote | null;
  /** "Run" before any note, "Re-run" after. */
  rerunLabel: string;
  rerun: RerunState;
  /**
   * A re-run that stopped to ask which name it means (the follow's `pending`): "Needs your pick" with a
   * link to that run. Once the picked run completes the server moves `latest` to it and clears this.
   */
  pending: { href: string; label: string } | null;
}

const runHref = (runId: string, status: RunStatus) =>
  status === "completed" || status === "incomplete" ? `/r/${encodeURIComponent(runId)}` : `/run/${encodeURIComponent(runId)}`;

export function followNote(latest: NonNullable<Follow["latest"]>, now: number, timeZone?: string): FollowNote {
  const row = STATUS_NOTE[latest.status];
  const tag = latest.tag?.trim();
  const finished = latest.status === "completed" || latest.status === "incomplete";
  const text = finished && isVerdictTag(tag) ? tag : finished && latest.signal !== null ? SIGNAL_LABEL[latest.signal] : row.text;
  const headline = latest.headline?.trim() || null;
  return {
    href: runHref(latest.runId, latest.status),
    status: finished && latest.status === "incomplete" && latest.signal === null ? "partial" : row.status,
    text,
    headline,
    day: relativeDay(latest.createdAt, now, timeZone),
    createdAt: latest.createdAt,
  };
}

export function followRowModel(follow: Follow, rerun: RerunState, now: number, timeZone?: string): FollowRowModel {
  return {
    id: follow.id,
    kindLabel: FOLLOW_KIND_LABEL[follow.kind],
    label: follow.label,
    jobLabel: follow.rerun.job ? JOB_LABEL[follow.rerun.job] : null,
    note: follow.latest ? followNote(follow.latest, now, timeZone) : null,
    rerunLabel: follow.latest ? "Re-run" : "Run",
    rerun,
    pending: follow.pending ? { href: `/run/${encodeURIComponent(follow.pending.runId)}`, label: FOLLOW_PENDING_LABEL } : null,
  };
}

export const EMPTY_TEXT =
  "You don't follow anything yet. On an answer or a brand profile, press Follow to keep its brand, place or question here with its latest note.";

/** The page's lead: what a follow is, and what it is not (§2.4: no alerts, nothing compared). */
export const LEAD_TEXT =
  "The brands, places and questions you follow on this browser, each with its latest note. Re-run one to read it again with today's data. Nothing here updates by itself and there are no alerts.";

// The Follow button ------------------------------------------------------------------------------

export interface FollowButtonModel {
  /** "Follow" or "Following". */
  text: string;
  /** The accessible name: "Follow the brand Juniper Cola", "Unfollow the question …". */
  label: string;
  pressed: boolean;
  /** While the follows are read, and while a request is on its way. */
  disabled: boolean;
  loading: boolean;
  /** The follow to remove on a press, when followed. */
  followId: string | null;
}

const KIND_NOUN: Readonly<Record<Follow["kind"], string>> = { brand: "the brand", place: "the place", question: "the question" };

/**
 * The Follow button's look from the shared follows: disabled while they load, "Following" (pressed) when
 * this subject is followed. Follows that could not be read leave it a plain Follow: following again is
 * safe, the server keeps one follow per subject.
 */
export function followButtonModel(follow: Follow | undefined, subject: { kind: Follow["kind"]; label: string }, phase: "loading" | "ready" | "busy"): FollowButtonModel {
  const pressed = follow !== undefined;
  const noun = `${KIND_NOUN[subject.kind]} ${subject.label}`;
  return {
    text: pressed ? "Following" : "Follow",
    label: pressed ? `Unfollow ${noun}` : `Follow ${noun}`,
    pressed,
    disabled: phase !== "ready",
    loading: phase === "busy",
    followId: follow?.id ?? null,
  };
}
