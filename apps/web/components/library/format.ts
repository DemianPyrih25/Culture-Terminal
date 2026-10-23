import type { Pillar } from "@ct/contracts";
import { briefIdOf } from "../../lib/brief/model";
import { DESK_LABEL, NOT_MEASURED, SIGNAL_LABEL } from "../../lib/brief/format";
import type { BriefSummary } from "./briefs-client";

/**
 * What a brief row prints (A/Brief on Home and in the library). Pure, so Home, Ask, the library and
 * their tests print the same text. Dates are UTC.
 */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** "14 Oct", with the year when it is not `year` (the current UTC year): "14 Oct 2025". */
export function shortDate(iso: string, year: number): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const day = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()] ?? ""}`;
  return d.getUTCFullYear() === year ? day : `${day} ${d.getUTCFullYear()}`;
}

/** "Brief 3F2A": the short id the brief page prints. */
export function briefLabel(runId: string): string {
  return `Brief ${briefIdOf(runId)}`;
}

/** The verdict column: the signal of the note, "Incomplete" for a run that stopped without one. */
export function verdictText(brief: Pick<BriefSummary, "signal" | "status">): string {
  if (brief.signal !== null) return SIGNAL_LABEL[brief.signal];
  return brief.status === "incomplete" ? "Incomplete" : "No verdict";
}

/** "Investment · Compare two brands" (Home), or the job and brief id (the library, inside its desk). */
export function deskJobText(brief: Pick<BriefSummary, "pillar" | "jobLabel" | "runId">, withDesk = true): string {
  const parts = [withDesk && brief.pillar ? DESK_LABEL[brief.pillar] : null, brief.jobLabel];
  if (!withDesk) parts.push(briefLabel(brief.runId));
  const text = parts.filter((p): p is string => Boolean(p)).join(" · ");
  return text === "" ? briefLabel(brief.runId) : text;
}

/** The desks in the order Home and the library show them. */
export const DESK_ORDER: readonly Pillar[] = ["investment", "location", "marketing", "audience"];

/** One piece of a verdict headline: text, or a cited number with its note. */
export type HeadlinePiece = { kind: "text"; text: string } | { kind: "metric"; text: string; note: number; unavailable: boolean };

/** A note on a cited number, for the library's margin. */
export interface HeadlineNote {
  note: number;
  label: string;
  /** The display, or "not measured" for an UNAVAILABLE metric: never 0. */
  value: string;
  badge: string;
  unavailable: boolean;
}

/**
 * The verdict headline as pieces: {{M#}} tokens print the metric's display with a note number (in
 * order of first citation), [E#] evidence tokens are dropped. A metric the list did not send, or one
 * that is UNAVAILABLE, prints "not measured".
 */
export function headlinePieces(headline: string, metrics: BriefSummary["metrics"]): { pieces: HeadlinePiece[]; notes: HeadlineNote[] } {
  const pieces: HeadlinePiece[] = [];
  const notes: HeadlineNote[] = [];
  const noteOf = new Map<string, number>();
  const pattern = /\{\{(M[1-9]\d*)\}\}|\s*\[E[1-9]\d*\]/g;
  let last = 0;
  for (const match of headline.matchAll(pattern)) {
    const at = match.index ?? 0;
    if (at > last) pieces.push({ kind: "text", text: headline.slice(last, at) });
    last = at + match[0].length;
    const id = match[1];
    if (id === undefined) continue;
    const metric = metrics[id];
    const unavailable = metric === undefined || metric.display === null || metric.badge === "UNAVAILABLE";
    const text = unavailable ? NOT_MEASURED : (metric.display ?? NOT_MEASURED);
    let note = noteOf.get(id);
    if (note === undefined) {
      note = notes.length + 1;
      noteOf.set(id, note);
      notes.push({ note, label: metric?.label ?? id, value: text, badge: metric?.badge ?? "UNAVAILABLE", unavailable });
    }
    pieces.push({ kind: "metric", text, note, unavailable });
  }
  if (last < headline.length) pieces.push({ kind: "text", text: headline.slice(last) });
  return { pieces, notes };
}

/** The headline as plain text, numbers printed: for labels and tests. */
export function headlineText(headline: string, metrics: BriefSummary["metrics"]): string {
  return headlinePieces(headline, metrics)
    .pieces.map((p) => p.text)
    .join("");
}
