/**
 * The no-number rule of the context blocks (R4, R5, DESIGN §2.4). The "What AI knows" block states no
 * number at all: model memory gets figures wrong, and a figure beside the measured answer would read as
 * measured. The "From the web" block may state a number only when its cited passage states it too.
 */

/** Spelled numbers, ordinals and quantity words, matched as whole words, case-insensitive. */
const NUMBER_WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
  "twenty",
  "thirty",
  "forty",
  "fifty",
  "sixty",
  "seventy",
  "eighty",
  "ninety",
  "hundreds?",
  "thousands?",
  "millions?",
  "billions?",
  "trillions?",
  "dozens?",
  "percent",
  "per cent",
  "half",
  "quarter",
  "double",
  "triple",
  "twice",
  "first",
  "second",
  "third",
  "fourth",
  "fifth",
  "tenth",
] as const;

const WORD_RE = new RegExp(`\\b(?:${NUMBER_WORDS.join("|")})\\b`, "gi");
/**
 * Phrases that use a number word without stating a number. Hyphens join words here ("second-hand"),
 * while `\b` would split them, so the phrase is blanked before the word scan.
 */
const EXEMPT_RE = /\bone of\b|\bno one\b|\bsecond-hand\b/gi;
/** A run of digits with its separators: "1,200", "4.5", "2025". Any Unicode decimal digit counts. */
const DIGITS_RE = /\p{Nd}(?:[\p{Nd},.]*\p{Nd})?/gu;
const SYMBOL_RE = /[%$€£¥]/gu;

/** The number words `text` uses, lower-cased, exemptions removed, in order of appearance. */
export function numberWords(text: string): string[] {
  const blanked = text.replace(EXEMPT_RE, (m) => " ".repeat(m.length));
  return [...blanked.matchAll(WORD_RE)].map((m) => m[0].toLowerCase().replace(/\s+/g, " "));
}

/** Digit runs in `text`, as written. */
export function digitRuns(text: string): string[] {
  return [...text.matchAll(DIGITS_RE)].map((m) => m[0]);
}

/**
 * Every way `text` states a number: digit runs, the signs % $ € £ ¥, and number words. Empty when it
 * states none. The AI block drops an item whose topic or text has any problem.
 */
export function numberProblems(text: string): string[] {
  return [...digitRuns(text), ...[...text.matchAll(SYMBOL_RE)].map((m) => m[0]), ...numberWords(text)];
}

/** A digit run compared without separators: "1,200" and "1200" are the same; a trailing "." is punctuation. */
function digitKey(run: string): string {
  return run.replace(/[.,]+$/u, "").replace(/,/g, "");
}

/** The digit runs of `text`, normalised, for whole-run lookups. */
function digitKeys(text: string): Set<string> {
  return new Set(digitRuns(text).map(digitKey));
}

/**
 * The numbers in a web claim that its cited passage does not state (DESIGN §2.3 step 4): each digit run
 * must appear in the passage as a whole run (compared without separators, so "20" never matches inside
 * "2025"), each % $ € £ ¥ sign must appear in it, and each number word must appear in it as a word.
 * Empty when every number in the claim is backed by the passage.
 */
export function unbackedNumbers(claim: string, citedText: string): string[] {
  const keys = digitKeys(citedText);
  const words = new Set(numberWords(citedText));
  const missing: string[] = [];
  for (const run of digitRuns(claim)) if (!keys.has(digitKey(run))) missing.push(run);
  for (const m of claim.matchAll(SYMBOL_RE)) if (!citedText.includes(m[0])) missing.push(m[0]);
  for (const word of numberWords(claim)) if (!words.has(word)) missing.push(word);
  return missing;
}
