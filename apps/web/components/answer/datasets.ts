"use client";

import { useEffect, useState } from "react";
import { DatasetEnvelope } from "@ct/contracts";
import type { AnswerDatasets } from "../../lib/answer";
import type { BriefFigure } from "../../lib/brief";

/**
 * Datasets too large to stream inline (a big lift map or matrix) are fetched from
 * /api/runs/[id]/datasets/[did] once the run is stored. One fetch per URL for the page's lifetime once it
 * succeeds: an envelope never changes once stored. A failure is never kept, so the next mount asks again.
 */

const loads = new Map<string, Promise<DatasetEnvelope | null>>();

export function loadDataset(url: string, doFetch: typeof fetch = fetch): Promise<DatasetEnvelope | null> {
  const known = loads.get(url);
  if (known) return known;
  const load = doFetch(url)
    .then((res) => (res.ok ? res.json() : null))
    .then((json: unknown) => {
      const parsed = DatasetEnvelope.safeParse(json);
      return parsed.success ? parsed.data : null;
    })
    .catch(() => null)
    .then((data) => {
      if (data === null) loads.delete(url);
      return data;
    });
  loads.set(url, load);
  return load;
}

/**
 * The fetched datasets by dataset id (undefined while loading, null when the fetch failed). `initial`
 * holds the ones the server already read (a permalink's lift map), so the first paint has them and the
 * page does not move when they would have arrived; only the rest are fetched.
 */
export function useFetchedDatasets(figures: readonly BriefFigure[], initial: Readonly<Record<string, DatasetEnvelope>> = {}): AnswerDatasets {
  const wanted = figures
    .filter((f) => f.needsFetch && f.dataset === null && initial[f.datasetId] === undefined)
    .map((f) => `${f.datasetId}=${f.datasetUrl}`)
    .join(" ");
  const [fetched, setFetched] = useState<Readonly<Record<string, DatasetEnvelope | null>>>(initial);
  useEffect(() => {
    if (wanted === "") return;
    let current = true;
    for (const pair of wanted.split(" ")) {
      const at = pair.indexOf("=");
      const id = pair.slice(0, at);
      void loadDataset(pair.slice(at + 1)).then((data) => {
        if (current) setFetched((prev) => ({ ...prev, [id]: data }));
      });
    }
    return () => {
      current = false;
    };
  }, [wanted]);
  return fetched;
}
