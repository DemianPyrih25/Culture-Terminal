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

/**
 * Words that never open or fill a host's name: a "with" clause holding one is part of the title
 * ("sleep with me", "dinner with the stars", "drinks with friends like us"), not a billing.
 */
const NOT_A_HOST: ReadonlySet<string> = new Set([
  "a", "an", "the", "me", "you", "us", "him", "her", "them", "it", "my", "your", "our", "his", "their", "its",
  "friends", "family", "everyone", "everybody", "someone", "somebody", "nobody", "or",
]);

/**
 * True when a "with" clause reads as a host's name: two to five words, none of them NOT_A_HOST.
 * "Dana Lee" and "Dana Lee and Sam Ortiz" bill hosts; "Me", "Tyler" and "The Stars" do not, so a
 * question naming "Sleep" never matches a show titled "Sleep With Me" (D20).
 */
function isHostBilling(clause: string): boolean {
  const words = clause.split(" ");
  const names = words.filter((w) => w !== "and");
  return words.length <= 5 && words[0] !== "and" && names.length >= 2 && names.every((w) => !NOT_A_HOST.has(w));
}

/**
 * A normalised podcast name without its host billing: "show nova with dana lee" is the show "show
 * nova". Qloo lists many podcasts under their billed title, while a question names the show. Only the
 * first " with " counts, a name that opens with "with" keeps it, and so does a name whose "with"
 * clause is part of the title rather than a host's name (isHostBilling).
 */
export function withoutHostBilling(normalised: string): string {
  const at = normalised.indexOf(" with ");
  if (at <= 0) return normalised;
  return isHostBilling(normalised.slice(at + " with ".length)) ? normalised.slice(0, at) : normalised;
}
