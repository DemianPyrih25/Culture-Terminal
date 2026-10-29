/**
 * Escape sequences the model typed as text. A tool input is JSON, and now and then the model escapes
 * a character twice, so the parsed string holds the six characters of a JSON escape instead of the
 * character (a backslash, "u" and "2013" for the en dash of an age range). Shown as written that is
 * a display bug (ANSWER_QUALITY §11), and V3 reads the digits glued to it as numbers typed outside
 * tokens. No
 * reader means the escape itself, so every string of a submit_plan or submit_report input is read
 * with each such escape turned into its character before the plan or the CHECKER sees it.
 *
 * Only printable characters come back. A control, a line or paragraph separator, a zero-width, BOM or
 * bidi character, or a lone surrogate becomes a space: prose never needs one, and they hide text
 * (pnpm guard keeps them out of source for the same reason).
 */

/** A surrogate pair written as two escapes, then any single escape. */
const ESCAPE_RE = /\\u(d[89ab][0-9a-f]{2})\\u(d[c-f][0-9a-f]{2})|\\u([0-9a-f]{4})/giu;

/** Code points an escape may not bring back: controls, separators, invisible and bidi formatting, surrogates. */
function hidden(code: number): boolean {
  return (
    code < 0x20 ||
    (code >= 0x7f && code <= 0x9f) ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x2028 && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x206f) ||
    code === 0xfeff ||
    (code >= 0xd800 && code <= 0xdfff)
  );
}

/** `text` with every typed \uXXXX escape replaced by its character (a space for a hidden one). */
export function decodeTypedEscapes(text: string): string {
  if (!text.includes("\\u") && !text.includes("\\U")) return text;
  return text.replace(ESCAPE_RE, (_all, high?: string, low?: string, single?: string) => {
    if (high !== undefined && low !== undefined) return String.fromCharCode(parseInt(high, 16), parseInt(low, 16));
    const code = parseInt(single ?? "", 16);
    return Number.isFinite(code) && !hidden(code) ? String.fromCharCode(code) : " ";
  });
}

/** A copy of a parsed tool input with decodeTypedEscapes applied to every string in it, keys left alone. */
export function decodeInputEscapes(value: unknown): unknown {
  if (typeof value === "string") return decodeTypedEscapes(value);
  if (Array.isArray(value)) return value.map(decodeInputEscapes);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, decodeInputEscapes(inner)]));
  }
  return value;
}
