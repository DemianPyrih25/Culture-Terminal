import { nullable, num, object, oneOf, optional, readAs } from "../../lib/read";

/**
 * The browser side of GET /api/access?usage=1 (server/usage/usage.ts): how much of each limit this
 * visitor has used. Parts the server could not read are absent, and their rows are left out.
 */

export interface UsageWindow {
  used: number;
  limit: number;
  nextFreeS: number | null;
}

export interface UsageSlots {
  used: number;
  limit: number;
}

export interface Usage {
  scope: "visitor" | "lane";
  answers?: { hour: UsageWindow; day: UsageWindow; active?: UsageSlots };
  screener?: { hour: UsageWindow; minute: UsageSlots };
}

const windowRead = object({ used: num, limit: num, nextFreeS: nullable(num) });
const slotsRead = object({ used: num, limit: num });
const UsageSchema = object({
  scope: oneOf(["visitor", "lane"] as const),
  answers: optional(object({ hour: windowRead, day: windowRead, active: optional(slotsRead) })),
  screener: optional(object({ hour: windowRead, minute: slotsRead })),
});

/** The `usage` of an /api/access answer, or null when it has none or it is malformed. */
export function readUsage(body: unknown): Usage | null {
  if (typeof body !== "object" || body === null || !("usage" in body)) return null;
  const parsed = readAs(UsageSchema, (body as { usage: unknown }).usage);
  return parsed.success ? parsed.data : null;
}

/** GET /api/access?usage=1; null when it fails or carries no usage. */
export async function fetchUsage(doFetch: typeof fetch = fetch): Promise<Usage | null> {
  try {
    const res = await doFetch("/api/access?usage=1", { cache: "no-store", headers: { accept: "application/json" } });
    return res.ok ? readUsage(await res.json()) : null;
  } catch {
    return null;
  }
}

export type UsageTone = "accent" | "caution" | "danger";

/** One limit as Settings shows it. */
export interface UsageRow {
  key: string;
  name: string;
  used: number;
  limit: number;
  left: number;
  /** 0 to 1, for the bar. */
  share: number;
  tone: UsageTone;
  resets: string;
}

/** Accent below 80% used, caution from 80%, danger when the limit is reached. */
export function toneOf(used: number, limit: number): UsageTone {
  if (limit <= 0 || used >= limit) return "danger";
  return used / limit >= 0.8 ? "caution" : "accent";
}

/** "23 min", "3 h 12 min", "under a minute". */
export function durationWords(s: number): string {
  if (s < 60) return "under a minute";
  const minutes = Math.ceil(s / 60);
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

function row(key: string, name: string, used: number, limit: number, resets: string): UsageRow {
  const left = Math.max(0, limit - used);
  return { key, name, used, limit, left, share: limit > 0 ? Math.min(1, used / limit) : 1, tone: toneOf(used, limit), resets };
}

/** A rolling window's reset line: when the start that frees a place leaves it. */
function windowResets(w: UsageWindow, span: string, elapsedS: number): string {
  if (w.used === 0 || w.nextFreeS === null) return `Rolling ${span}`;
  const s = Math.max(0, w.nextFreeS - elapsedS);
  return s === 0 ? "One frees up now" : `Next one frees up in ${durationWords(s)}`;
}

/**
 * The rows, in order: answers in the last 24 hours, in the last hour, running at once, screens in the
 * last hour, and follows. `elapsedS` is how long ago the usage was read, so the reset times count down.
 */
export function usageRows(usage: Usage | null, follows: { used: number; max: number } | null, elapsedS = 0): UsageRow[] {
  const rows: UsageRow[] = [];
  const a = usage?.answers;
  if (a) {
    rows.push(row("answers-day", "Answers, last 24 hours", a.day.used, a.day.limit, windowResets(a.day, "24 hours", elapsedS)));
    rows.push(row("answers-hour", "Answers, last hour", a.hour.used, a.hour.limit, windowResets(a.hour, "hour", elapsedS)));
    if (a.active) {
      const { used, limit } = a.active;
      rows.push(row("answers-active", "Answers running at once", used, limit, used > 0 ? "Frees up as each answer finishes" : "None running"));
    }
  }
  const sc = usage?.screener;
  if (sc) {
    const base = windowResets(sc.hour, "hour", elapsedS);
    rows.push(row("screener-hour", "Screener checks, last hour", sc.hour.used, sc.hour.limit, `${base} · at most ${sc.minute.limit} a minute`));
  }
  if (follows) rows.push(row("follows", "Followed items", follows.used, follows.max, "Frees up when you unfollow"));
  return rows;
}
