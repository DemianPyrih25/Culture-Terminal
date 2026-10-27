import { AudienceKey, DENIED_AUDIENCE_FAMILIES, DENIED_AUDIENCES as DENIED_AUDIENCE_KEYS, type Pillar } from "@ct/contracts";

/** The audience families D21 allows on every desk, in the order the catalogue lists them. */
const SIX_FAMILIES = [
  "hobbies_and_interests",
  "leisure",
  "spending_habits",
  "professional_area",
  "life_stage",
  "investing_interests",
] as const;

/**
 * The desk audience allowlist (D21, SPEC §0.1 D21). This module is the source of truth; the file
 * config/audiences.allow.json mirrors it for readers outside the code, and a test keeps the two equal.
 * The client checks every `urn:audience:…` value it sends, so even a buggy skill cannot send a
 * denied segment.
 */
export const AUDIENCE_ALLOWLIST = {
  description:
    "Audience families each desk may send to Qloo (D21). Denied families and audiences are refused on every desk. Mirror of packages/qloo/src/audiences.ts.",
  // The denied set lives in contracts so skills can tell a sensitive segment from an off-desk family.
  denied: { families: DENIED_AUDIENCE_FAMILIES, audiences: DENIED_AUDIENCE_KEYS },
  // D21: the six families are allowed on every desk; the desk table stays so a desk can be narrowed.
  desks: {
    investment: SIX_FAMILIES,
    location: SIX_FAMILIES,
    marketing: SIX_FAMILIES,
    audience: SIX_FAMILIES,
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
