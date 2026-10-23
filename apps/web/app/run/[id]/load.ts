import "server-only";
import { cache } from "react";
import type { RunState } from "@ct/contracts";
import { runSnapshot } from "@/server/http";

/**
 * The run as stored, for the brief page's first paint: the same snapshot GET /api/runs/[id] serves (the
 * run row and the state rebuilt from its events), read once per request for the page and its metadata.
 */
export type LoadedRun =
  /**
   * `at`: when it was read, the clock the first paint of a live run counts from. `showcase`: the run row's
   * is_showcase, a curated showcase and indexed; every other run is a reader's own and unlisted (D31).
   */
  | { kind: "ok"; question: string | null; state: RunState; at: number; showcase: boolean }
  | { kind: "not_found" }
  | { kind: "unavailable" };

export const loadRun = cache(async (runId: string): Promise<LoadedRun> => {
  const at = Date.now();
  const res = await runSnapshot(runId);
  if (res.status === 404) return { kind: "not_found" };
  if (!res.ok) return { kind: "unavailable" };
  const body = (await res.json()) as { run: { question: string | null; isShowcase?: boolean }; state: RunState };
  return { kind: "ok", question: body.run.question, state: body.state, at, showcase: body.run.isShowcase === true };
});
