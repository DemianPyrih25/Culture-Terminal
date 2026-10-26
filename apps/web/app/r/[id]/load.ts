import "server-only";
import { cache } from "react";
import type { RunState } from "@ct/contracts";
import { buildBriefModel, inlineText, type BriefModel } from "@/lib/brief";
import { runSnapshot } from "@/server/http";

/**
 * A finished brief for its permalink, /r/[id] (PLAN Part 6, SPEC §8.1): the snapshot GET /api/runs/[id]
 * serves (the run row and the state rebuilt from its stored events) and the brief model built from it,
 * read once per request for the layout, the page and its metadata.
 */

/** How a run ended with something to show for good: a note, an evidence digest, or a refusal card. */
export const PERMALINK_STATUSES: readonly string[] = ["completed", "incomplete", "refused"];

export type Permalink =
  /** `showcase`: the run row's is_showcase, a curated showcase and indexed; every other run is a reader's own and unlisted (D31). */
  | { kind: "brief"; question: string | null; state: RunState; model: BriefModel; showcase: boolean }
  /**
   * The run exists but has no finished brief: still being written (`ended` false), or it ended without
   * one (failed, cancelled, waiting for a pick). Its /run/[id] page shows it.
   */
  | { kind: "pending"; runId: string; ended: boolean }
  | { kind: "not_found" }
  | { kind: "unavailable" };

export const loadPermalink = cache(async (runId: string): Promise<Permalink> => {
  const res = await runSnapshot(runId);
  if (res.status === 404) return { kind: "not_found" };
  if (!res.ok) return { kind: "unavailable" };
  const body = (await res.json()) as { run: { question: string | null; isShowcase?: boolean }; state: RunState };
  const { state } = body;
  if (state.ended === null || !PERMALINK_STATUSES.includes(state.ended.status)) return { kind: "pending", runId, ended: state.ended !== null };
  // The clock drives only the live meters, which a finished run's model leaves out.
  const model = buildBriefModel(state, Date.now());
  return { kind: "brief", question: body.run.question, state, model, showcase: body.run.isShowcase === true };
});

/** One plain line for a showcase's description: its answer's headline, else the refusal's message. */
export function permalinkSummary(model: BriefModel): string | null {
  const headline = inlineText(model.answer.headline).replace(/\s+/g, " ").trim();
  if (headline !== "") return headline;
  return model.terminal?.message ?? null;
}
