import { createHash } from "node:crypto";
import type { Intent } from "@ct/contracts";
import { sanitizeQuestion } from "../llm/question";
import type { ContextCache } from "./index";

/**
 * The context cache (DESIGN §2.5, D25): AI blocks for 7 days, web blocks for 24 hours, keyed by the
 * block kind, the model, the question as the answer cache normalises it, the job, the subject and the
 * place. Only `ok` and `empty` blocks are stored; a failure or a timeout is tried again next time.
 */

export type ContextKind = "ai" | "web";

export const CONTEXT_TTL_MS: Readonly<Record<ContextKind, number>> = {
  ai: 7 * 24 * 60 * 60 * 1000,
  web: 24 * 60 * 60 * 1000,
};

/** The question as apps/web's questionHash normalises it: sanitized as the models see it, NFKC, case-folded. */
export function normaliseContextQuestion(question: string): string {
  return sanitizeQuestion(question).normalize("NFKC").toLowerCase();
}

export interface ContextKeyInput {
  kind: ContextKind;
  model: string;
  question: string;
  intent: Pick<Intent, "job" | "geo">;
  subjectName: string | null;
}

/** sha256("v1|kind|model|question|job|subject|metro or market"), hex. */
export function contextCacheKey(o: ContextKeyInput): string {
  const place = o.intent.geo.metro ?? o.intent.geo.market ?? "";
  const parts = ["v1", o.kind, o.model, normaliseContextQuestion(o.question), o.intent.job, o.subjectName ?? "", place];
  return createHash("sha256").update(parts.join("|")).digest("hex");
}

/** A cached body, or null on a miss or any cache failure: the cache never fails a run. */
export async function readContext(cache: ContextCache | null, key: string): Promise<{ body: unknown; createdAt: string } | null> {
  if (cache === null) return null;
  try {
    return await cache.get(key);
  } catch {
    return null;
  }
}

/** Stores a settled block; a write failure is ignored (the next run simply calls again). */
export async function writeContext(
  cache: ContextCache | null,
  row: { key: string; kind: ContextKind; model: string; body: unknown; usd: number },
): Promise<void> {
  if (cache === null) return;
  try {
    await cache.put({ ...row, ttlMs: CONTEXT_TTL_MS[row.kind] });
  } catch {
    // A full or unavailable cache costs one more call next time, nothing else.
  }
}
