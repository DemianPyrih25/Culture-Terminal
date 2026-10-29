import { AgeBucket, findMalformedTokens, stripTokens } from "@ct/contracts";

/**
 * CHECKER V3 (D6): numbers typed outside tokens. Decimals and percentages always count; integers
 * count above 10 unless they are a year (1900–2099) or an ISO date, a ZIP named as one ("ZIP 37206",
 * "ZIP code 37206", "the 37206 ZIP"), a Qloo age-bucket label, or part of a registered entity or tag
 * name or of an area name in the run's metro ("MLK-183", or a bare "37206" in a Nashville run). Digits
 * glued to letters ("Q3", a bare "M12") are words, not numbers. An age range that merges buckets
 * ("30–44", "35+") counts once, as written: no metric carries it (mergedAgeBuckets). A number above
 * ten spelled out ("twelve", "eleventh", "twenty-one", "a dozen") counts like its digits.
 */

const RANGE = String.raw`\s?(?:–|—|-|to)\s?`;
const AGE_PAIRS = [
  ["25", "29"],
  ["30", "34"],
  ["35", "44"],
  ["45", "54"],
] as const;

/** Qloo's six age buckets as prose labels them, with the ages each covers (prose gives "≤24" a floor of 18). */
const BUCKETS: readonly { label: string; from: number; to: number }[] = [
  { label: "≤24", from: 18, to: 24 },
  ...AGE_PAIRS.map(([a, b]) => ({ label: `${a}–${b}`, from: Number(a), to: Number(b) })),
  { label: "55+", from: 55, to: Infinity },
];

/**
 * An age range whose ends fall on bucket edges ("30–44", "18 to 34", "35+"). Bucket labels are removed
 * before it is matched, so what it finds merges buckets or renames one ("18–24" for "≤24").
 */
const BUCKET_EDGE_RANGE = String.raw`\b(18|25|30|35|45)(?:${RANGE}(24|29|34|44|54)\b(?!\.\d|\s?%)|\s?\+)`;

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
/** A five-digit ZIP named with the word ZIP, as Nashville's area names write it (D37). */
const ZIP_RE = /\bZIP(?:[\s-]*code)?\s+\d{5}\b|\b\d{5}\s+ZIP(?:[\s-]*code)?\b/giu;

/** A numeral not glued to a preceding letter, digit or dot, with an optional percentage suffix. */
const NUMERAL_RE =
  /(?<![\p{L}\p{N}_.])(?:\.\d+|(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)(?:\s?(?:%|percent\b|per\scent\b|pct\b|pp\b|bps\b|percentage\spoints?\b))?/giu;

/** Units, cardinal and ordinal, as the second word of a spelled-out number ("twenty-one", "thirty-second"). */
const UNIT_WORDS: Readonly<Record<string, number>> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9,
};
const TENS_WORDS: Readonly<Record<string, number>> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
/** The other number words above ten, cardinal and ordinal. A plural ("hundreds", "dozens") names no number. */
const LONE_NUMBER_WORDS: Readonly<Record<string, number>> = {
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17, eighteenth: 18, nineteenth: 19,
  twentieth: 20, thirtieth: 30, fortieth: 40, fiftieth: 50, sixtieth: 60, seventieth: 70, eightieth: 80, ninetieth: 90,
  hundred: 100, hundredth: 100, thousand: 1000, thousandth: 1000, million: 1e6, millionth: 1e6, billion: 1e9, billionth: 1e9,
  dozen: 12,
};

const wordsOf = (table: Readonly<Record<string, number>>): string => Object.keys(table).join("|");
/** A number above ten spelled out, with no capture group; "half a dozen" is six, so it is left alone. */
const NUMBER_WORD =
  String.raw`\b(?:(?:${wordsOf(TENS_WORDS)})(?:[\s-](?:${wordsOf(UNIT_WORDS)}))?|(?<!\bhalf[\s-]a[\s-])(?:${wordsOf(LONE_NUMBER_WORDS)}))\b`;
const NUMBER_WORD_RE = new RegExp(NUMBER_WORD, "giu");

/** The value of a spelled-out number NUMBER_WORD matched: "twenty-one" is 21, "dozen" 12. */
function numberWordValue(written: string): number {
  const [head = "", unit = ""] = written.toLowerCase().split(/[\s-]+/u);
  return (TENS_WORDS[head] ?? LONE_NUMBER_WORDS[head] ?? 0) + (UNIT_WORDS[unit] ?? 0);
}

/** The numbers above ten a text spells out, as written ("twelve", "Eleventh", "twenty-one"). */
export function numberWords(text: string): string[] {
  return [...text.matchAll(NUMBER_WORD_RE)].map((m) => m[0]);
}

/**
 * One left-to-right scan for V3: a bucket-edge age range (group 1 set), a spelled-out number (group 3)
 * or a single numeral.
 */
const SCAN_RE = new RegExp(`${BUCKET_EDGE_RANGE}|(${NUMBER_WORD})|${NUMERAL_RE.source}`, "giu");

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

/**
 * A name as prose may write it: any run of spaces or dashes matches any other ("MLK 183", "MLK–183"),
 * and never inside a longer word or number (a bare "37206" leaves "372061" alone).
 */
function namePattern(name: string): RegExp {
  const parts = name.split(/[\s\-–—]+/u).filter((part) => part !== "");
  const body = parts.map(escapeRegExp).join(String.raw`[\s\-–—]+`);
  return new RegExp(String.raw`(?<![\p{L}\p{N}])${body}(?![\p{L}\p{N}])`, "giu");
}

/**
 * Names whose numbers are allowed in prose: the registered entity and tag names that contain a digit
 * or a number V3 counts spelled out ("Studio 54", "Fifteen Elms").
 */
export function numeralNames(names: Iterable<string>): string[] {
  const out = new Set<string>();
  for (const name of names) if ((/\d/.test(name) || numberWords(name).length > 0) && name.trim() !== "") out.add(name.trim());
  // Longest first, so "Blink-182 Live" is removed before "Blink-182".
  return [...out].sort((a, b) => b.length - a.length);
}

/**
 * The ways prose names the run metro's areas, for numeralNames: each name, the name without its
 * parenthetical ("ZIP 37206" of "ZIP 37206 (East Nashville)"), and the bare ZIP of a ZIP area (D37).
 */
export function areaAliases(names: Iterable<string>): string[] {
  const out: string[] = [];
  for (const name of names) {
    const short = name.replace(/\s*\([^)]*\)\s*$/u, "").trim();
    out.push(name, short);
    const zip = /^ZIP\s+(\d{5})$/iu.exec(short);
    if (zip !== null) out.push(zip[1]!);
  }
  return out;
}

/**
 * The Qloo buckets an age range written in prose spans when it is no bucket itself: "30–44" spans
 * ["30–34", "35–44"], "35+" spans ["35–44", "45–54", "55+"], "18–24" is ["≤24"]. Null for anything
 * else, a bucket label included.
 */
export function mergedAgeBuckets(numeral: string): string[] | null {
  const written = numeral.trim();
  const m = new RegExp(`^${BUCKET_EDGE_RANGE}$`, "u").exec(written);
  if (m === null || new RegExp(`^(?:${AGE_LABEL_RE.source})$`, "iu").test(written)) return null;
  const from = Number(m[1]);
  const to = m[2] === undefined ? Infinity : Number(m[2]);
  return from < to ? BUCKETS.filter((b) => b.from >= from && b.to <= to).map((b) => b.label) : null;
}

/** The integers that end a Qloo age bucket ("30" of "30–34", "44" of "35–44"). */
const BUCKET_EDGES = new Set(["18", "24", "25", "29", "30", "34", "35", "44", "45", "54", "55"]);
const EDGE = [...BUCKET_EDGES].join("|");

/** Words that put a bare number in an age context: "aged 30", "the 30s", "up to 44", "under 35", "older". */
const AGE_CONTEXT_RE = new RegExp(
  String.raw`\b(?:age[ds]?|years?\sold|older|younger|buckets?|(?:${EDGE})s)\b|\b(?:up\sto|under|over|early|mid|late)[\s-]+(?:${EDGE})\b`,
  "iu",
);

/** Qloo's six age buckets as prose labels them, in order: "≤24", "25–29", …, "55+". */
export const AGE_BUCKET_LABELS: readonly string[] = BUCKETS.map((b) => b.label);

/**
 * The bare numbers V3 flagged that read as loose ages: a bucket edge ("30", "44") in a text that speaks
 * of ages ("the early 30s", "up to 44", "aged 35"). The repair is told to name Qloo's bucket labels.
 */
export function looseAgeNumbers(text: string, bare: readonly string[]): string[] {
  if (!AGE_CONTEXT_RE.test(stripTokens(text))) return [];
  return bare.filter((b) => BUCKET_EDGES.has(b.trim()));
}

/**
 * The numerals in `text` that V3 counts as violations, as written (e.g. "0.82", "45%", "1,200",
 * "twelve"), and each age range that merges Qloo buckets as one ("30–44").
 */
export function numeralViolations(text: string, allowedNames: readonly string[]): string[] {
  let s = stripTokens(text);
  for (const malformed of findMalformedTokens(s)) s = s.replaceAll(malformed, " ");
  for (const name of allowedNames) s = s.replace(namePattern(name), " ");
  s = s.replace(ISO_DATE_RE, " ").replace(ZIP_RE, " ").replace(AGE_LABEL_RE, " ");
  return [...s.matchAll(SCAN_RE)].flatMap((m) => {
    const written = m[0].trim();
    if (m[3] !== undefined) return [written];
    if (m[1] === undefined) return violates(written) ? [written] : [];
    if (mergedAgeBuckets(written) !== null) return [written];
    // Bucket edges that make no range ("45-24"): its numbers count one by one.
    return [...written.matchAll(NUMERAL_RE)].map((n) => n[0].trim()).filter(violates);
  });
}

/**
 * The numbers a text shows, digits only ("+26" and "26" are one number, "twelve" is "12"), for matching
 * typed copies.
 */
export function numeralValues(text: string): string[] {
  const digits = [...text.matchAll(NUMERAL_RE)].map((m) => m[0].replace(/[^\d.]/g, ""));
  return [...digits, ...numberWords(text).map((w) => String(numberWordValue(w)))];
}
