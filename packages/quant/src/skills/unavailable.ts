import { ANALYST_TOOLS, TOOL_MNEMONIC, type SkillFor, type SkillId, type ToolInput } from "@ct/contracts";
import type { z } from "zod";
import { skillErrorResult } from "./digest";

/**
 * A placeholder for a skill this build does not ship yet: it validates input like the real tool,
 * costs nothing, touches no ledger and answers with an error digest, so the tool set stays constant
 * (and prompt-cacheable) while the skills land one by one.
 */
export function unavailableSkill<Id extends SkillId>(id: Id): SkillFor<Id> {
  const spec = ANALYST_TOOLS[id];
  return {
    id,
    mnemonic: TOOL_MNEMONIC[id],
    kitWorkflows: spec.kitWorkflows,
    input: spec.input as unknown as z.ZodType<ToolInput<Id>>,
    estimateCalls: async () => 0,
    run: async () => skillErrorResult({ tool: id, step: null }, `${id} is not available in this build; use another tool.`),
    limitations: () => [],
  };
}
