import { SkillId, TOOL_MNEMONIC } from "@ct/contracts";

/**
 * The skills this build answers with "not available in this build" (@ct/quant unavailableSkill
 * placeholders). The run context lists them as UNAVAILABLE TOOLS and the opening scan skips them;
 * a test keeps this list equal to what SKILLS actually does. Every skill ships, so it is empty; a
 * skill switched off with unavailableSkill is listed here again.
 */
export const UNAVAILABLE_SKILLS: readonly SkillId[] = [];

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
