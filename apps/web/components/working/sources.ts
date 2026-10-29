import type { RunState } from "@ct/contracts";

/**
 * The working view's lookup chips (PLAN §8.5): how many lookups have arrived from each source while an
 * answer is made. Qloo always shows once a lookup is in; SEC EDGAR and US Census show when the run used
 * them (company financials, area economics). Public lookups cost no Qloo calls, so they are counted apart.
 * Pure, so the server's first paint and the live stream print the same chips.
 */

export interface LookupChip {
  source: "qloo" | "sec" | "census";
  /** "Qloo 12", "SEC EDGAR 2", "US Census 1". */
  label: string;
  count: number;
}

const SOURCE_LABEL = { qloo: "Qloo", sec: "SEC EDGAR", census: "US Census" } as const;

/** The chips in a fixed order; empty before the first lookup arrives. */
export function lookupChips(state: RunState): LookupChip[] {
  const publicChips = state.publicCalls?.chips ?? [];
  const counts = {
    qloo: state.qloo.chips.length,
    sec: publicChips.filter((c) => c.source === "sec").length,
    census: publicChips.filter((c) => c.source === "census").length,
  };
  return (["qloo", "sec", "census"] as const).filter((k) => counts[k] > 0).map((k) => ({ source: k, label: `${SOURCE_LABEL[k]} ${counts[k]}`, count: counts[k] }));
}
