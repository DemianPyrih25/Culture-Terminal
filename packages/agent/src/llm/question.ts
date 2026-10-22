import { QUESTION_MAX_CHARS } from "@ct/contracts";

/** Line and tab breaks become spaces so words never run together (\s below also folds U+2028 and U+2029). */
const BREAKS = /[\t\n\v\f\r\u0085]/g;
/** Every other control or format character: C0/C1 controls, zero-width and bidi overrides. */
const INVISIBLE = /[\p{Cc}\p{Cf}]/gu;

/**
 * The question as the models may see it (PLAN §4.6): control and format characters stripped,
 * whitespace collapsed, and capped at QUESTION_MAX_CHARS code points.
 */
export function sanitizeQuestion(raw: string): string {
  const flat = raw.replace(BREAKS, " ").replace(INVISIBLE, "").replace(/\s+/g, " ").trim();
  return Array.from(flat).slice(0, QUESTION_MAX_CHARS).join("").trimEnd();
}

/**
 * The sanitized question wrapped in <user_question>. Angle brackets are escaped, so the text can
 * never close the wrapper or open a tag of its own.
 */
export function wrapQuestion(raw: string): string {
  const text = sanitizeQuestion(raw).replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<user_question>${text}</user_question>`;
}
