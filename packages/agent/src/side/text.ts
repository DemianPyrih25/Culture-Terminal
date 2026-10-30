/**
 * Text cleaning for the context blocks (DESIGN §2.2, §2.3). Model output and page text are untrusted:
 * they are shown as plain text only, so markdown, links, our own token syntax ({{M3}}, [E2]) and
 * invisible characters are removed before anything is stored or rendered.
 */

/** C0/C1 controls and format characters (zero-width, bidi overrides); line breaks become spaces first. */
const INVISIBLE = /[\p{Cc}\p{Cf}]/gu;
const BREAKS = /[\t\n\v\f\r\u0085\u2028\u2029]/g;
/** Markdown links keep their words: "[the report](https://…)" reads "the report". */
const MD_LINK = /\[([^\]]*)\]\([^)]*\)/g;
const URL_RE = /\b(?:https?:\/\/|www\.)\S+/gi;
/** Markdown emphasis, code, headings and quote markers, and the brackets and braces of our tokens. */
const MARKERS = /[*`#~<>[\]{}|]/g;

/** `raw` as one line of plain text: no links, markdown, token syntax or invisible characters. */
export function cleanText(raw: string): string {
  return raw
    .replace(BREAKS, " ")
    .replace(INVISIBLE, "")
    .replace(MD_LINK, "$1")
    .replace(URL_RE, "")
    .replace(MARKERS, "")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** `text` cut to `max` code points at a word break, with an ellipsis; unchanged when it fits. Titles only, never claims. */
export function cutTitle(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  const head = chars.slice(0, max - 1).join("");
  const space = head.lastIndexOf(" ");
  return `${(space > max / 2 ? head.slice(0, space) : head).trimEnd()}…`;
}

/** Angle brackets escaped, so text can never open or close a tag in a prompt. */
export function escapeTags(text: string): string {
  return text.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
