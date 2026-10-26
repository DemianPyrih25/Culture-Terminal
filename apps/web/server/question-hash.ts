import "server-only";
import { createHash } from "node:crypto";
import { sanitizeQuestion, type AnalystMode } from "@ct/agent";

/**
 * Every agent run's question_hash starts with this. It keeps agent runs countable apart from fake
 * runs ("fake:"), and a later change to the key format can take a new prefix without colliding.
 */
export const QUESTION_HASH_PREFIX = "q1:";

/**
 * The answer-cache key (D26): sha256 of the normalised question, the pins and the mode, and of the
 * parent for a follow-up. The question is sanitized as the models see it, then case-folded; pins are
 * sorted by mention. A follow-up's brief answers its parent's case, not the bare question, so its key
 * never matches a question asked on its own; top-level keys leave the parent out and keep their value.
 */
export function questionHash(
  question: string,
  pins: Readonly<Record<string, string>> | undefined,
  mode: AnalystMode,
  parentRunId: string | null = null,
): string {
  const normalised = sanitizeQuestion(question).normalize("NFKC").toLowerCase();
  const sortedPins = Object.entries(pins ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const parts: unknown[] = parentRunId ? [normalised, sortedPins, mode, parentRunId] : [normalised, sortedPins, mode];
  const digest = createHash("sha256").update(JSON.stringify(parts)).digest("hex");
  return `${QUESTION_HASH_PREFIX}${digest}`;
}
