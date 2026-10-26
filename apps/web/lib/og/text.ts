import charset from "./fonts/charset.json";

/**
 * Text as the share card prints it. next/og draws only glyphs its fonts carry and fetches any other
 * from a font CDN at render time, so the card keeps to the fonts' character set (fonts/charset.json)
 * and drops the rest. The set holds the capital of each of its letters, as labels print in capitals.
 * Ids never print on a card (D29): UUIDs, URNs and long hex runs are removed.
 */

const RANGES: readonly (readonly [number, number])[] = charset.ranges.map((range) => {
  const [from = "", to = from] = range.split("-");
  return [parseInt(from, 16), parseInt(to, 16)] as const;
});

/** The card's code points in charset.json's order, which fonts/metrics.json follows. */
export const CARD_CODE_POINTS: readonly number[] = RANGES.flatMap(([from, to]) => Array.from({ length: to - from + 1 }, (_, i) => from + i));

/** True when every card font has a glyph for this code point. */
export function inCardCharset(codePoint: number): boolean {
  return RANGES.some(([from, to]) => codePoint >= from && codePoint <= to);
}

/** Signs the card fonts lack, in words they can print: "City → Site" reads "City to Site". */
const SPELLED: Readonly<Record<string, string>> = { "→": " to ", "←": " from ", "≈": "~" };

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const URN = /\burn:\S*/gi;
const HEX_RUN = /\b[0-9a-f]{16,}\b/gi;

/**
 * One line of card text: ids removed, every whitespace run one space, arrows spelled out, characters
 * outside the card's character set dropped (emoji, other scripts, control and zero-width characters),
 * ends trimmed.
 */
export function cardText(text: string | null | undefined): string {
  const scrubbed = (text ?? "").replace(UUID, " ").replace(URN, " ").replace(HEX_RUN, " ");
  let out = "";
  for (const ch of scrubbed) {
    const spelled = SPELLED[ch];
    if (spelled !== undefined) out += spelled;
    else if (/\s/u.test(ch)) out += " ";
    else if (inCardCharset(ch.codePointAt(0) ?? 0)) out += ch;
  }
  return out.replace(/ {2,}/g, " ").trim();
}

/**
 * At most `max` characters: cut at the last word boundary that keeps most of the text, trailing
 * punctuation trimmed, and closed with an ellipsis. Text that fits is returned as is.
 */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const room = text.slice(0, Math.max(1, max - 1));
  const space = room.lastIndexOf(" ");
  return ellipsis(space >= max * 0.6 ? room.slice(0, space) : room);
}

/** The head of a cut text: trailing spaces and punctuation trimmed, closed with an ellipsis. */
export function ellipsis(head: string): string {
  return `${head.replace(/[\s,;:.!?·—–-]+$/u, "")}…`;
}

/** cardText, then truncate: a label that fits its slot. */
export function cardLabel(text: string | null | undefined, max: number): string {
  return truncate(cardText(text), max);
}
