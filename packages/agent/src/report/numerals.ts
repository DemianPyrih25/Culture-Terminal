import { AgeBucket, findMalformedTokens, stripTokens } from "@ct/contracts";

/**
 * CHECKER V3 (D6): numbers typed outside tokens. Decimals and percentages always count; integers
 * count above 10 unless they are a year (1900–2099) or an ISO date, a Qloo age-bucket label, or
 * part of a registered entity or tag name. Digits glued to letters ("Q3", a bare "M12") are words,
 * not numbers.
 */

const RANGE = String.raw`\s?(?:–|—|-|to)\s?`;
const AGE_PAIRS = [
  ["25", "29"],
  ["30", "34"],
  ["35", "44"],
  ["45", "54"],
] as const;

/**
 * Qloo's six age buckets as prose writes them: "≤24", "25–29", "55+", "55 and older", "25_to_29", …
 * V3 allows them as numbers; V10 reads them as age claims. Global: copy it before calling test().
 */
export const AGE_LABEL_RE = new RegExp(
  [
    String.raw`(?:≤|<=)\s?24\b`,
    String.raw`\bunder\s25\b`,
    String.raw`\b24\s(?:and|&)\s(?:younger|under)\b`,
    String.raw`\b55\s?\+`,
    String.raw`\b55\s(?:and|&)\s(?:older|over)\b`,
    ...AGE_PAIRS.map(([a, b]) => String.raw`\b${a}${RANGE}${b}\b`),
    ...AgeBucket.options.map((b) => String.raw`\b${b}\b`),
  ].join("|"),
  "giu",
);

const ISO_DATE_RE = /\b(?:19|20)\d{2}-\d{2}-\d{2}\b/g;

/** A numeral not glued to a preceding letter, digit or dot, with an optional percentage suffix. */
const NUMERAL_RE =
  /(?<![\p{L}\p{N}_.])(?:\.\d+|(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)(?:\s?(?:%|percent\b|per\scent\b|pct\b|pp\b|bps\b|percentage\spoints?\b))?/giu;

const PERCENT_RE = /%|percent|per\scent|pct|pp|bps|percentage/i;

/** True when a matched numeral is a violation. */
function violates(numeral: string): boolean {
  if (PERCENT_RE.test(numeral)) return true;
  const digits = numeral.replace(/[^\d.,]/g, "");
  if (digits.includes(".") || digits.includes(",")) return true;
  const value = Number(digits);
  if (digits.length === 4 && value >= 1900 && value <= 2099) return false;
  return value > 10;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Names whose digits are allowed in prose: the registered entity and tag names that contain a digit. */
export function digitNames(names: Iterable<string>): string[] {
  const out = new Set<string>();
  for (const name of names) if (/\d/.test(name) && name.trim() !== "") out.add(name.trim());
  // Longest first, so "Blink-182 Live" is removed before "Blink-182".
  return [...out].sort((a, b) => b.length - a.length);
}

/** The numerals in `text` that V3 counts as violations, as written (e.g. "0.82", "45%", "1,200"). */
export function numeralViolations(text: string, allowedNames: readonly string[]): string[] {
  let s = stripTokens(text);
  for (const malformed of findMalformedTokens(s)) s = s.replaceAll(malformed, " ");
  for (const name of allowedNames) s = s.replace(new RegExp(escapeRegExp(name), "giu"), " ");
  s = s.replace(ISO_DATE_RE, " ").replace(AGE_LABEL_RE, " ");
  return [...s.matchAll(NUMERAL_RE)].map((m) => m[0].trim()).filter(violates);
}
