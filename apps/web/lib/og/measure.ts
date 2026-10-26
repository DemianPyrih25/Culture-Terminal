import metrics from "./fonts/metrics.json";
import { CARD_CODE_POINTS, ellipsis } from "./text";

/**
 * Text widths on the card, from the card fonts' advance widths (fonts/metrics.json), so a label is
 * fitted to its slot before next/og draws it instead of being cut mid-word by a CSS ellipsis.
 * Kerning is left out: it moves a label by a pixel or so, inside the slack fitWidth keeps.
 */

export type CardFace = keyof typeof metrics.faces;

/** How a line is set: its face, size and letter spacing in px, and whether it prints in capitals. */
export interface CardType {
  face: CardFace;
  size: number;
  tracking?: number;
  upper?: boolean;
}

const INDEX = new Map(CARD_CODE_POINTS.map((cp, i) => [cp, i]));

/** Room kept for kerning and rounding, in px. */
const SLACK = 2;

/** The width of a line in px. A character outside the card's set counts a full em, so it errs wide. */
export function textWidth(text: string, type: CardType): number {
  const face = metrics.faces[type.face];
  let units = 0;
  let count = 0;
  for (const ch of type.upper ? text.toUpperCase() : text) {
    const at = INDEX.get(ch.codePointAt(0) ?? 0);
    units += at === undefined ? face.unitsPerEm : (face.advances[at] ?? face.unitsPerEm);
    count++;
  }
  return (units * type.size) / face.unitsPerEm + (type.tracking ?? 0) * count;
}

/**
 * The line as it fits `width` px: whole when it fits. Otherwise, with `segments`, its trailing
 * " · " parts are dropped first ("top half in 4 of 8 · vs peers" reads "top half in 4 of 8"); what
 * still does not fit is cut at a word and closed with an ellipsis, inside a word only when the first
 * one alone is too wide.
 */
export function fitWidth(text: string, type: CardType, width: number, { segments = false }: { segments?: boolean } = {}): string {
  const fits = (t: string) => textWidth(t, type) <= width - SLACK;
  if (fits(text)) return text;
  let head = text;
  if (segments) {
    const parts = text.split(" · ");
    while (parts.length > 1) {
      parts.pop();
      if (fits(parts.join(" · "))) return parts.join(" · ");
    }
    head = parts[0] ?? "";
  }
  const words = head.split(" ");
  while (words.length > 1) {
    words.pop();
    const cut = ellipsis(words.join(" "));
    if (cut !== "…" && fits(cut)) return cut;
  }
  const chars = [...head];
  while (chars.length > 1) {
    chars.pop();
    if (fits(ellipsis(chars.join("")))) return ellipsis(chars.join(""));
  }
  return ellipsis(chars.join(""));
}
