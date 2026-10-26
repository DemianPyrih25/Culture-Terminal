/** Formatting shared by source lines, disclaimers and summaries. Times are shown in UTC. */

/** Items as a phrase: "a", "a and b", "a, b and c". */
export function wordList(items: readonly string[]): string {
  return items.length < 2 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]!}`;
}

/** "2026-10-21 14:05 UTC". */
export function formatUtc(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** "2026-10-21". */
export function formatUtcDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().slice(0, 10);
}

/** A cache age for chips and source lines: "<1m", "15m", "3h", "2d". */
export function formatAge(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** The earliest and latest of ISO timestamps that may carry different offsets; originals are kept. */
export function timeRange(timestamps: readonly string[]): { from: string; to: string } | null {
  if (timestamps.length === 0) return null;
  let from = timestamps[0] as string;
  let to = from;
  for (const t of timestamps) {
    if (Date.parse(t) < Date.parse(from)) from = t;
    if (Date.parse(t) > Date.parse(to)) to = t;
  }
  return { from, to };
}
