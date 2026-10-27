import "server-only";
import { cache } from "react";
import { DatasetEnvelope, type RunState } from "@ct/contracts";
import { buildBriefModel, inlineText, type BriefModel } from "@/lib/brief";
import { runDataset, runSnapshot } from "@/server/http";

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

/** The most dataset JSON a permalink inlines for its first paint; any more is fetched in the browser as before. */
export const FIRST_PAINT_DATASET_BYTES = 2_000_000;

/**
 * The datasets too large to stream inline (a lift map, a big matrix) read on the server for the first
 * paint, lift maps first: the answer's map row and its "Your area" and competition numbers need them,
 * and fetched after hydration they would push the page down. A failed read is left to the browser.
 */
export async function loadFirstPaintDatasets(runId: string, model: BriefModel): Promise<Record<string, DatasetEnvelope>> {
  const wanted = model.evidence.figures
    .filter((f) => f.needsFetch && f.dataset === null)
    .sort((a, b) => Number(b.kind === "GeoLift") - Number(a.kind === "GeoLift"));
  const read = await Promise.all(
    wanted.map(async (f) => {
      try {
        const res = await runDataset(runId, f.datasetId);
        return res.ok ? { id: f.datasetId, text: await res.text() } : null;
      } catch {
        return null;
      }
    }),
  );
  const out: Record<string, DatasetEnvelope> = {};
  let bytes = 0;
  for (const r of read) {
    if (r === null || bytes + r.text.length > FIRST_PAINT_DATASET_BYTES) continue;
    let json: unknown;
    try {
      json = JSON.parse(r.text);
    } catch {
      continue;
    }
    const parsed = DatasetEnvelope.safeParse(json);
    if (!parsed.success) continue;
    out[r.id] = parsed.data;
    bytes += r.text.length;
  }
  return out;
}

/** One plain line for a showcase's description: its answer's headline, else the refusal's message. */
export function permalinkSummary(model: BriefModel): string | null {
  const headline = inlineText(model.answer.headline).replace(/\s+/g, " ").trim();
  if (headline !== "") return headline;
  return model.terminal?.message ?? null;
}
