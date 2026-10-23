import { QUESTION_MAX_CHARS } from "@ct/contracts";

/** The Ask page for a question (A02): /ask?q=…, with the parent brief of a follow-up. */
export function askHref(question: string, parentRunId?: string | null): string {
  const params = new URLSearchParams({ q: question });
  if (parentRunId) params.set("parent", parentRunId);
  return `/ask?${params.toString()}`;
}

/** The question an Ask URL's ?q= carries, as the page reads it: trimmed and cut to the longest question. */
export function askQuestionOf(value: string | null | undefined): string {
  return (value ?? "").trim().slice(0, QUESTION_MAX_CHARS);
}
