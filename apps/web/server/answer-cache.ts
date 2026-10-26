import "server-only";
import type { AnalystMode } from "@ct/agent";
import { ConfidenceBand, Signal } from "@ct/contracts";
import { findAnswerCache, type Queryable } from "@ct/db";
import { z } from "zod";
import { questionHash } from "./question-hash";

/**
 * The answer cache (D26): a completed brief for the same question within 72 hours answers it again
 * at $0 and no Qloo call. The key is the question hash (normalised question, pins, mode); the
 * 72-hour window stands for "the same snapshot", since a run keeps no snapshot id of its own.
 * Follow-ups never answer from it, and never answer it: a child run's brief is about its parent's
 * case (and links to that unlisted run, D31), so its key carries the parent (question-hash.ts).
 */

/** A recent completed brief for the same question. */
export interface AlreadyHave {
  runId: string;
  question: string;
  createdAt: string;
  signal: Signal | null;
  confidence: { score: number; band: ConfidenceBand } | null;
}

const ANALYST_MODES: readonly AnalystMode[] = ["live", "economy"];

const StoredVerdict = z.object({
  verdict: z.object({ signal: Signal, confidence: z.object({ score: z.int().min(0).max(100), band: ConfidenceBand }) }),
});

/**
 * The answer-cache hit for a question under either ANALYST mode, the newest (no pins: the browser
 * never sends any). A follow-up stored under a top-level key (before keys carried the parent) is a miss.
 */
export async function findAlreadyHave(db: Queryable, question: string): Promise<AlreadyHave | null> {
  const hits = await Promise.all(ANALYST_MODES.map((mode) => findAnswerCache(db, questionHash(question, undefined, mode))));
  const newest = hits
    .flatMap((r) => (r === undefined || r.parentRunId !== null ? [] : [r]))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  if (newest === undefined) return null;
  const stored = StoredVerdict.safeParse(newest.report);
  return {
    runId: newest.id,
    question: newest.question,
    createdAt: newest.createdAt.toISOString(),
    signal: stored.success ? stored.data.verdict.signal : null,
    confidence: stored.success ? { score: stored.data.verdict.confidence.score, band: stored.data.verdict.confidence.band } : null,
  };
}

/** The answer cache as the runs route reads it; the route tests stand one in. */
export interface AnswerCache {
  find(question: string): Promise<AlreadyHave | null>;
}
