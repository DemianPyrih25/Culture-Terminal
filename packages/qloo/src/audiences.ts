import { AudienceKey, type Pillar } from "@ct/contracts";

/**
 * The desk audience allowlist (D21, SPEC §0.1 D21). This module is the source of truth; the file
 * config/audiences.allow.json mirrors it for readers outside the code, and a test keeps the two equal.
 * The client checks every `urn:audience:…` value it sends, so even a buggy skill cannot send a
 * denied segment.
 */
export const AUDIENCE_ALLOWLIST = {
  description:
    "Audience families each desk may send to Qloo (D21). Denied families and audiences are refused on every desk. Mirror of packages/qloo/src/audiences.ts.",
  denied: {
    families: ["communities", "political_preferences", "lifestyle_preferences_beliefs", "global_issues"],
    audiences: ["urn:audience:leisure:political_junkie"],
  },
  desks: {
    investment: [
      "hobbies_and_interests",
      "leisure",
      "spending_habits",
      "professional_area",
      "investing_interests",
      "life_stage",
    ],
    location: ["hobbies_and_interests", "leisure"],
    marketing: ["hobbies_and_interests", "leisure", "spending_habits", "professional_area", "life_stage"],
    audience: ["hobbies_and_interests", "leisure", "spending_habits", "professional_area", "life_stage"],
  },
} as const satisfies {
  description: string;
  denied: { families: readonly string[]; audiences: readonly string[] };
  desks: Readonly<Record<Pillar, readonly string[]>>;
};

const DENIED_FAMILIES: ReadonlySet<string> = new Set(AUDIENCE_ALLOWLIST.denied.families);
const DENIED_AUDIENCES: ReadonlySet<string> = new Set(AUDIENCE_ALLOWLIST.denied.audiences);

/** Standalone tools (no desk) may use the union of the desk families; none of them is denied. */
const STANDALONE_FAMILIES: ReadonlySet<string> = new Set(Object.values(AUDIENCE_ALLOWLIST.desks).flat());

/** The audience families a desk may use; `null` (standalone tools) gets the union of all desks. */
export function audienceFamiliesFor(pillar: Pillar | null): ReadonlySet<string> {
  return pillar === null ? STANDALONE_FAMILIES : new Set<string>(AUDIENCE_ALLOWLIST.desks[pillar]);
}

/**
 * Why an audience URN may not be sent on this desk, or null when it may. Accepts a full audience key
 * (`urn:audience:<family>:<leaf>`) or a family URN (`urn:audience:<family>`, e.g. a catalogue filter).
 */
export function audienceDenial(urn: string, pillar: Pillar | null): string | null {
  const family = /^urn:audience:([a-z][a-z0-9_]*)(?::|$)/.exec(urn)?.[1];
  if (family === undefined) return `"${urn}" is not an audience URN`;
  const isFamilyUrn = urn === `urn:audience:${family}`;
  if (!isFamilyUrn && !AudienceKey.safeParse(urn).success) return `"${urn}" is not an audience URN`;
  if (DENIED_FAMILIES.has(family)) return `audience family "${family}" is denied on every desk (D21)`;
  if (DENIED_AUDIENCES.has(urn)) return `audience "${urn}" is denied on every desk (D21)`;
  if (!audienceFamiliesFor(pillar).has(family)) {
    const desk = pillar === null ? "standalone tools" : `the ${pillar} desk`;
    return `audience family "${family}" is not allowed for ${desk} (D21)`;
  }
  return null;
}
