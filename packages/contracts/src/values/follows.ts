/** Zod-free Following values (PLAN Part 10, §2.4); ../follows.ts holds the API schemas. */

export const FOLLOW_KIND_VALUES = ["brand", "place", "question"] as const;
type FollowKindV = (typeof FOLLOW_KIND_VALUES)[number];

export const FOLLOW_KIND_LABEL: Readonly<Record<FollowKindV, string>> = {
  brand: "Brand",
  place: "Place",
  question: "Question",
};

/** Follows one visitor may hold; a new one beyond this is refused with a plain message. */
export const FOLLOWS_PER_VISITOR_MAX = 50;
export const FOLLOW_LABEL_MAX = 120;
export const FOLLOW_SUBJECT_KEY_MAX = 200;

/**
 * The stable subject key of a follow, the same however it was followed: `brand:<name>` (a brand by its
 * resolved Qloo name, never its Qloo id), `place:<metro>` or `place:<metro>:<area>`, and
 * `question:<question hash>` (the answer-cache hash, so the same question asked twice is one follow).
 * Parts are folded to NFKC lower case with single spaces.
 */
export function followSubjectKey(kind: FollowKindV, ...parts: readonly string[]): string {
  const fold = (p: string) => p.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
  const folded = parts.map(fold).filter((p) => p !== "");
  if (folded.length === 0) throw new RangeError(`followSubjectKey: a ${kind} follow needs a subject`);
  return `${kind}:${folded.join(":")}`.slice(0, FOLLOW_SUBJECT_KEY_MAX);
}

/**
 * The question a brand followed from its profile (/d/[entity]) re-runs: a brand-health note, the job a
 * profile's brand reads as. A brand followed from a note re-runs that note's own question instead.
 */
export function brandFollowQuestion(name: string): string {
  return `How healthy is ${name.trim()}'s audience taste, and who are its nearest substitutes?`;
}

/** The row label of a follow whose re-run stopped at the picker and waits for the visitor's pick. */
export const FOLLOW_PENDING_LABEL = "Needs your pick";
