import { SkillId, TOOL_MNEMONIC } from "@ct/contracts";

/**
 * The skills this build answers with "not available in this build" (the @ct/quant SKILLS
 * placeholders). The run context lists them as UNAVAILABLE TOOLS and the opening scan skips them;
 * a test keeps this list equal to what SKILLS actually does, so a skill that lands fails it until
 * it is removed here.
 */
export const UNAVAILABLE_SKILLS: readonly SkillId[] = [
  "find_tags",
  "rank_candidates",
  "share_of_taste",
  "audience_dna",
  "momentum",
  "destination_affinity",
  "geo_lift",
  "block_dna",
  "cross_domain",
  "sponsor_slate",
];

const UNAVAILABLE: ReadonlySet<SkillId> = new Set(UNAVAILABLE_SKILLS);

export function isSkillAvailable(id: SkillId): boolean {
  return !UNAVAILABLE.has(id);
}

/** "peer_landscape (SUBS)": how the run context names a tool. */
export function toolLabel(id: SkillId): string {
  return `${id} (${TOOL_MNEMONIC[id]})`;
}

/** Every skill id in contracts order. */
export const ALL_SKILLS: readonly SkillId[] = SkillId.options;
