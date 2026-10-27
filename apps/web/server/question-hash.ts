import "server-only";
import { createHash } from "node:crypto";
import { sanitizeQuestion, type AnalystMode } from "@ct/agent";

/**
 * Every agent run's question_hash starts with this. It keeps agent runs countable apart from fake
 * runs ("fake:"), and a later change to the key format can take a new prefix without colliding.
 */
export const QUESTION_HASH_PREFIX = "q1:";

/**
 * The version of what an answer is made of: the agent, the skills, the CHECKER and the answer page's
 * reading of a run. Raise it with any change that makes a stored answer wrong or incomplete for the same
 * question (2: competitor counts unknown, never 0, and the question's own area ranked; 3: the supply-label
 * rule, so no area reads crowded or open from a capped sample's 0 or a venue or two), so the answer
 * cache never serves a brief built before the change. Older rows stay valid permalinks; they only stop
 * answering new questions.
 */
export const ANSWER_VERSION = 3;

/**
 * The answer-cache key (D26): sha256 of the normalised question, the pins and the mode, and of the
 * parent for a follow-up. The question is sanitized as the models see it, then case-folded; pins are
 * sorted by mention. A follow-up's brief answers its parent's case, not the bare question, so its key
 * never matches a question asked on its own; top-level keys leave the parent out. From ANSWER_VERSION 2
 * the key carries the version, so a version change is a new key.
 */
export function questionHash(
  question: string,
  pins: Readonly<Record<string, string>> | undefined,
  mode: AnalystMode,
  parentRunId: string | null = null,
): string {
  const normalised = sanitizeQuestion(question).normalize("NFKC").toLowerCase();
  const sortedPins = Object.entries(pins ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const base: unknown[] = parentRunId ? [normalised, sortedPins, mode, parentRunId] : [normalised, sortedPins, mode];
  const parts: unknown[] = [...base, { answerVersion: ANSWER_VERSION }];
  const digest = createHash("sha256").update(JSON.stringify(parts)).digest("hex");
  return `${QUESTION_HASH_PREFIX}${digest}`;
}
