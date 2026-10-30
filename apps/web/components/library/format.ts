import { isVerdictTag } from "@ct/contracts/values";
import { SIGNAL_LABEL } from "../../lib/brief/format";
import type { BriefSummary } from "./briefs-client";

/** What the verdict cell reads. */
export type VerdictSource = Pick<BriefSummary, "signal" | "status" | "tag">;

/**
 * The verdict cell of an answer row: the answer's verdict tag ("Taste island"), else its signal label,
 * "Partial answer" for a run that stopped without one.
 */
export function verdictText(brief: VerdictSource): string {
  const tag = brief.tag?.trim();
  if (isVerdictTag(tag)) return tag;
  if (brief.signal !== null) return SIGNAL_LABEL[brief.signal];
  return brief.status === "incomplete" ? "Partial answer" : "Answer ready";
}
