/**
 * Area-name matching (D28): how CLERK's area text, a gazetteer name and an alias compare. Shared by
 * createGeo and the gazetteer builds (tools/geo), which check new aliases against it.
 */

/** Words that only say "this is a neighbourhood": "East Side district" matches "East Side". */
const GENERIC_SUFFIXES: ReadonlySet<string> = new Set(["neighborhood", "neighbourhood", "district", "area"]);
/** A ZIP area named as one, normalised: "ZIP code 37206", "zipcode 37206" and "37206 ZIP" match "ZIP 37206". */
const ZIP_FORMS = /^(?:zip(?: ?code)? (\d{5})|(\d{5}) zip(?: ?code)?)$/;

/**
 * Case, accents, punctuation, a leading "the", a trailing generic word and the way a ZIP area is
 * written do not change a match. "The" before a single word stays: "The Hermitage" names a place of
 * its own, not the community of Hermitage. Before a bare ZIP it goes ("the 37206").
 */
export function normaliseAreaName(text: string): string {
  const words = text
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/['’‘`´.]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter((w) => w.length > 0);
  if (words[0] === "the" && (words.length > 2 || /^\d{5}$/.test(words[1] ?? ""))) words.shift();
  if (words.length > 1 && GENERIC_SUFFIXES.has(words[words.length - 1] ?? "")) words.pop();
  const name = words.join(" ");
  const zip = ZIP_FORMS.exec(name);
  return zip === null ? name : `zip ${zip[1] ?? zip[2] ?? ""}`;
}
