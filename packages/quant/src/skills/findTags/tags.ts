import { isTaxonomyTag } from "@ct/contracts";

/**
 * Tag vocabulary shared by find_tags and geo_lift (PROBE "Part 5 consequences" 1 and 2): what a tag
 * can do follows from its namespace, and concept names are compared word by word.
 */

const GENRE_PLACE = "urn:tag:genre:place:";
const CATEGORY_PLACE = "urn:tag:category:place:";

/**
 * What a tag can do.
 * - heatmap_signal: a urn:tag:genre:place:* tag, the only kind that shapes a heatmap (P5).
 * - place_filter: a urn:tag:category:place:* tag; it returned an empty heatmap (P5) and filters the
 *   places sample instead (G10).
 * - taste_signal: any other taxonomy tag (genre:brand, genre:music, genre:media), a rank signal.
 * - label_only: a descriptive *:qloo:* tag, which gave flat rows and empty maps (G1, G6).
 */
export type TagUse = "heatmap_signal" | "place_filter" | "taste_signal" | "label_only";

export function tagUse(tagId: string): TagUse {
  if (!isTaxonomyTag(tagId)) return "label_only";
  if (tagId.startsWith(GENRE_PLACE)) return "heatmap_signal";
  if (tagId.startsWith(CATEGORY_PLACE)) return "place_filter";
  return "taste_signal";
}

/** The namespace of a tag URN, e.g. urn:tag:genre:place for urn:tag:genre:place:restaurant:bar. */
export function tagTypeOf(tagId: string): string {
  const parts = tagId.split(":");
  if (isTaxonomyTag(tagId)) return parts.slice(0, 4).join(":");
  const qloo = parts.indexOf("qloo");
  return qloo > 0 ? parts.slice(0, qloo + 1).join(":") : parts.slice(0, -1).join(":");
}

/** A readable name from a URN leaf: urn:tag:genre:place:restaurant:coffee_shop → "Coffee shop". */
export function tagNameFromUrn(tagId: string): string {
  const leaf = (tagId.split(":").pop() ?? tagId).replace(/_/g, " ").trim();
  return leaf.charAt(0).toUpperCase() + leaf.slice(1);
}

/** Lower case, accents folded, punctuation and hyphens as spaces, whitespace collapsed. */
export function normaliseConcept(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/['’‘`´]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Words that do not tell two concept names apart. */
const FILLER: ReadonlySet<string> = new Set(["a", "an", "and", "the", "of", "for", "with", "to", "in", "on", "at", "or"]);

/** A plural's singular, enough to match "Coffee Shops" with "coffee shop"; "glass" and "bus" stay. */
function singular(word: string): string {
  return word.length > 3 && word.endsWith("s") && !word.endsWith("ss") && !word.endsWith("us") ? word.slice(0, -1) : word;
}

/**
 * A place noun in "-ery" folded onto its maker in "-er", so the place and the trade read as one word:
 * "roastery" and "Roasters", "brewery" and "Brewer", "cidery" and "Cider", "grocery" and "Grocer".
 * Short words ("very", "every") stay.
 */
function trade(word: string): string {
  return word.length >= 6 && word.endsWith("ery") ? word.slice(0, -1) : word;
}

export function conceptWords(text: string): Set<string> {
  return new Set(
    normaliseConcept(text)
      .split(" ")
      .filter((w) => w !== "" && !FILLER.has(w))
      .map((w) => trade(singular(w))),
  );
}

/**
 * The all-words name filter (SPEC §4.3 find_tags): a tag name matches a query when every word of
 * one appears in the other, so "Wine Bar" matches "natural wine bar" and "Ramen Restaurant" matches
 * "ramen", while a semantic neighbour that shares no complete name ("Lounge" for "wine bar") does not.
 */
export function nameMatches(query: ReadonlySet<string>, name: ReadonlySet<string>): boolean {
  if (query.size === 0 || name.size === 0) return false;
  const [small, large] = query.size <= name.size ? [query, name] : [name, query];
  if ([...small].every((w) => large.has(w))) return true;
  // A tag that only adds a generic product word ("Non-Alcoholic Drink" for "non-alcoholic craft beer").
  const specific = new Set([...name].filter((w) => !GENERIC_NAME_WORDS.has(w)));
  return specific.size > 0 && specific.size < name.size && [...specific].every((w) => query.has(w));
}

/** Generic product words a tag name may add without changing what it names (nameMatches). */
export const GENERIC_NAME_WORDS: ReadonlySet<string> = new Set(["drink", "beverage", "product", "good"]);

/**
 * Words that qualify a concept without defining it ("premium hot sauce" is still hot sauce): a part whose kept
 * tags leave only these uncovered is read exactly, with KEEP and VETO on the tested part (definingWordsLeft).
 */
export const NON_DEFINING_WORDS: ReadonlySet<string> = new Set([
  "premium", "luxury", "small", "batch", "artisanal", "artisan", "boutique", "independent", "indie", "local", "new", "modern",
  "upscale", "high", "end", "budget", "affordable", "specialty", "speciality", "gourmet", "quality", "little", "style", "look",
  "inspired", "themed", "brand", "company", "concept", "line",
]);

/**
 * The defining words of a concept part that none of its kept tags covers: "non" and "alcoholic" when only
 * "Beer" and "Craft" were kept for "non-alcoholic craft beer". Empty: the tags read the part itself.
 */
export function definingWordsLeft(part: string, tagNames: readonly string[]): string[] {
  const covered = new Set(tagNames.flatMap((n) => [...conceptWords(n)]));
  return [...conceptWords(part)].filter((w) => !covered.has(w) && !NON_DEFINING_WORDS.has(w));
}
