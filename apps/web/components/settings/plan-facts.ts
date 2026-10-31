import type { Lane, Mode } from "@ct/contracts";

/**
 * What the Plan & usage page can say for certain, read on the server from the running config
 * (server/config.ts, server/screener/limits.ts) and passed in as plain numbers. A visitor's own count
 * of answers started today is not readable in the browser yet, so the page shows the limits and how
 * they count, never an invented "used" figure.
 */
export interface PlanFacts {
  /** The public lane, per visitor (VISITOR_MAX_ACTIVE, VISITOR_HOURLY_CAP, VISITOR_DAILY_CAP). */
  visitor: { maxActive: number; perHour: number; perDay: number };
  /** The review lane, shared by everyone holding a review pass (JUDGE_RUN_*). */
  review: { slots: number; perHour: number; perDay: number };
  /** The run queue: answers that may wait for a slot, and the seconds each may wait. */
  queue: { max: number; waitS: number };
  /** The screener, per visitor (screens served from its cache count toward none of these). */
  screener: { perMinute: number; perHour: number };
}

export interface ServiceView {
  tone: "good" | "caution" | "danger" | "muted";
  label: string;
  detail: string | null;
}

const UNTIL = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

/** "1 Nov, 00:00 UTC"; null for a missing or unreadable time. */
export function untilWords(until: string | null): string | null {
  if (!until) return null;
  const at = new Date(until);
  return Number.isNaN(at.getTime()) ? null : `${UNTIL.format(at)} UTC`;
}

/** How live answers run right now for this visitor's lane, from GET /api/access. */
export function serviceView(mode: Mode | null | undefined, message: string | null, until: string | null): ServiceView {
  const back = untilWords(until);
  switch (mode) {
    case "live":
      return { tone: "good", label: "Live", detail: "New questions get a fresh answer." };
    case "economy":
      return {
        tone: "caution",
        label: "Reduced",
        detail: `Answers use a smaller model and web search is off${back ? ` until ${back}` : ""}.`,
      };
    case "replay_only":
      return {
        tone: "danger",
        label: "Paused",
        detail: message ?? `New answers are paused${back ? ` until ${back}` : ""}. Answers you already have still open.`,
      };
    case null:
      return { tone: "muted", label: "Unknown", detail: "The server could not report its state just now." };
    default:
      return { tone: "muted", label: "Checking", detail: null };
  }
}

export function laneName(lane: Lane | undefined): string {
  if (lane === "judge") return "Review access";
  return "Open access";
}

/** "2 minutes", "90 seconds". */
export function secondsWords(s: number): string {
  if (s >= 60 && s % 60 === 0) {
    const m = s / 60;
    return `${m} ${m === 1 ? "minute" : "minutes"}`;
  }
  return `${s} ${s === 1 ? "second" : "seconds"}`;
}
