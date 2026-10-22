/**
 * Name normalisation for exact matching (SPEC §5.3 S0, D20). Both the mention and every /search
 * result go through the same function, so "Café Nova, Inc." and "cafe nova" compare equal while
 * "Nova Café" does not: word order and every remaining word still count.
 */

const LEADING_ARTICLE = "the";
const CORPORATE_SUFFIXES: ReadonlySet<string> = new Set(["inc", "co", "company", "llc", "ltd"]);

/**
 * NFKD, diacritics stripped, lowercase, punctuation stripped, whitespace collapsed, a leading "the"
 * and trailing corporate suffix tokens dropped. Apostrophes and periods are deleted outright
 * ("Nova's" → "novas", "A.B.C." → "abc"); every other punctuation mark separates words
 * ("Alpha-Beta" → "alpha beta"). A name is never reduced to nothing: a lone "The" or "Company" stays.
 */
export function normaliseName(s: string): string {
  const words = s
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/['’‘`´.]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter((w) => w.length > 0);

  if (words.length > 1 && words[0] === LEADING_ARTICLE) words.shift();
  while (words.length > 1 && CORPORATE_SUFFIXES.has(words[words.length - 1] ?? "")) words.pop();
  return words.join(" ");
}
