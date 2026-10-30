import type { Limitation } from "@ct/contracts";

/**
 * A product or concept the question names that has no tag in the data (its own tag search answered
 * and kept no usable tag), with the categories that were tested in its place: the nearest categories
 * a later tag search found and some call then used. No category means the concept was not tested at
 * all. Built by conceptSubstitutes (run/conceptCoverage.ts).
 */
export interface ConceptSubstitute {
  /** The concept as the question names it. */
  concept: string;
  /** Its tag scope: brand reads as a product, place and media as a concept. */
  scope: string;
  /** Names of the category tags tested instead, in the order they were found; empty: not tested. */
  categories: readonly string[];
  /**
   * True when it is the question's only concept part (the product or concept itself); false for one
   * part of several ("surf-culture look" beside "non-alcoholic craft beer"), which is never called the
   * product. Absent: true.
   */
  whole?: boolean;
}

/** At most this many category names per concept in the disclosure. */
const CATEGORIES_MAX = 3;
/** A concept name is cut to this many characters in the disclosure. */
const CONCEPT_CHARS = 60;

/** Plain text for a quoted name: no quotes, control characters or runs of spaces, cut to `max`. */
function quoted(text: string, max: number): string {
  const clean = text
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/["“”]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
    .trim();
  return `"${clean}"`;
}

function wordList(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/**
 * The owner's disclosure (Part 9 o03 decision, worded per R2/D48 in Part 11), per concept: "'X' is not
 * in Qloo's data, so this answer reads its broader category, 'Y'. It gives no winner, keep or veto for 'X'
 * itself." or, with no category found, "The exact product, "X", is not in the data, and no close category
 * was found either, so the product could not be tested at all." One part of several reads "The part 'X'
 * is not in Qloo's data, so this answer reads its broader category, 'Y', for it. …". Null when
 * every concept had a tag of its own. Code opens the thesis with it and puts it first among the limitations,
 * so the reader sees it before any figure.
 */
export function conceptDisclosure(substitutes: readonly ConceptSubstitute[]): string | null {
  const sentences = substitutes.flatMap((s) => {
    const name = quoted(s.concept, CONCEPT_CHARS);
    if (name === '""') return [];
    const whole = s.whole !== false;
    const noun = s.scope === "brand" ? "product" : "concept";
    const subject = whole ? `The exact ${noun}, ${name},` : `The part ${name}`;
    const categories = [...new Set(s.categories.map((c) => quoted(c, CONCEPT_CHARS)).filter((c) => c !== '""'))].slice(0, CATEGORIES_MAX);
    if (categories.length === 0) {
      const what = whole ? `the ${noun}` : "that part";
      return [`${subject} is not in the data, and no close category was found either, so ${what} could not be tested at all.`];
    }
    // R2 (D48): a category-level read, said first, with no verdict on the concept itself.
    const one = categories.length === 1;
    const single = (q: string) => `'${q.slice(1, -1)}'`;
    const named = single(name);
    const what = whole ? named : `The part ${named}`;
    const forIt = whole ? "" : ", for it";
    return [
      `${what} is not in Qloo's data, so this answer reads its broader ${one ? "category" : "categories"}, ${wordList(categories.map(single))}${forIt}. ` +
        `It gives no winner, keep or veto for ${named} itself.`,
    ];
  });
  return sentences.length === 0 ? null : sentences.join(" ");
}

/** The CONCEPT_NOT_IN_DATA limitation with the disclosure's names, or null when there is none. */
export function conceptLimitation(substitutes: readonly ConceptSubstitute[]): Limitation | null {
  const text = conceptDisclosure(substitutes);
  return text === null ? null : { source: "flag", flag: "CONCEPT_NOT_IN_DATA", text };
}

/** The thesis opened by the disclosure (code-built, never left to the model); unchanged without one. */
export function withConceptDisclosure(thesis: string, substitutes: readonly ConceptSubstitute[]): string {
  const text = conceptDisclosure(substitutes);
  return text === null ? thesis : `${text} ${thesis}`.trim();
}
