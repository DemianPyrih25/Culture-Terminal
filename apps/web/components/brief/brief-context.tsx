"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { Evidence, ProvenanceRequest, RunState } from "@ct/contracts";
import type { BriefModel, BriefSource, Footnote } from "../../lib/brief";

/** A Qloo call's full canonical query, from the provenance of the evidence bundle that used it (D30). */
export type CallQuery = Pick<ProvenanceRequest, "path" | "query">;

/**
 * What every number on the page needs to open its request inspector: the footnotes by number, the
 * run's requests, the evidence bundles they belong to with each call's full query (for "Copy as curl"),
 * and which requests just landed (their stamps flash once).
 */
export interface BriefContextValue {
  runId: string;
  footnotes: ReadonlyMap<number, Footnote>;
  sources: readonly BriefSource[];
  evidence: Readonly<Record<string, Pick<Evidence, "id" | "skill" | "purpose" | "summary" | "status">>>;
  /** Qloo call id → its full query; calls in no bundle (name searches) have only their redacted parameters. */
  queries: ReadonlyMap<string, CallQuery>;
  /** True for a Qloo call that is landing now: its stamp flashes. */
  isFresh: (qlooCallId: string) => boolean;
  /** The brief is being written (live or replayed): arriving notes and figures settle in. */
  animate: boolean;
}

const never = () => false;

const BriefContext = createContext<BriefContextValue>({
  runId: "",
  footnotes: new Map(),
  sources: [],
  evidence: {},
  queries: new Map(),
  isFresh: never,
  animate: false,
});

export function useBrief(): BriefContextValue {
  return useContext(BriefContext);
}

/** Each call's full query: `qlooCallIds` and `provenance.requests` run parallel in every bundle. */
function callQueries(evidence: RunState["evidence"]): Map<string, CallQuery> {
  const out = new Map<string, CallQuery>();
  for (const e of Object.values(evidence)) {
    e.qlooCallIds.forEach((id, i) => {
      const request = e.provenance.requests[i];
      if (request && !out.has(id)) out.set(id, { path: request.path, query: request.query });
    });
  }
  return out;
}

/** The context value for one model and the state it was built from. */
export function briefContextValue(
  model: BriefModel,
  state: Pick<RunState, "evidence">,
  isFresh: (qlooCallId: string) => boolean = never,
  animate = false,
): BriefContextValue {
  const evidence = Object.fromEntries(
    Object.values(state.evidence).map((e) => [e.id, { id: e.id, skill: e.skill, purpose: e.purpose, summary: e.summary, status: e.status }]),
  );
  return {
    runId: model.runId,
    footnotes: new Map(model.footnotes.map((f) => [f.n, f])),
    sources: model.sources.items,
    evidence,
    queries: callQueries(state.evidence),
    isFresh,
    animate,
  };
}

export function BriefProvider({ value, children }: { value: BriefContextValue; children: ReactNode }) {
  return <BriefContext value={value}>{children}</BriefContext>;
}
