import type { Footnote } from "../../lib/brief";

/**
 * A footnote as the margin prints it (A/Sidenote): the short note with every sentence opening on a
 * capital, and the short trace ("req ab12…cd34 · cached 2h", "computed in code · QUANT"), which fits one
 * line of the column at 1440. The long note and trace (purpose, formula id, every request) stay in the
 * inspector, the note's hover titles and the printed endnotes. Pure.
 */

/** "15 rows. taste-island test …" → "15 rows. Taste-island test …": each sentence opens on a capital. */
export function sentenceCase(text: string): string {
  return text.replace(/(^|[.!?]\s+)([a-z])/g, (_, lead: string, letter: string) => lead + letter.toUpperCase());
}

/** The margin's trace line: the short trace, never the formula id. */
export function noteTrace(note: Pick<Footnote, "short">): string {
  return note.short.trace;
}

/** The margin's text for a note: its short text (or a figure's codes worked out from fetched data). */
export function noteText(note: Pick<Footnote, "short">, override?: string): string {
  return sentenceCase(override ?? note.short.text);
}

/** The hover titles: the long note and trace, so the margin's short lines never hide anything. */
export function noteTitles(note: Pick<Footnote, "text" | "trace">, override?: string): { text: string; trace: string } {
  return { text: sentenceCase(override ?? note.text), trace: note.trace };
}
