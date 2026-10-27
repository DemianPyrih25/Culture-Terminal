import type { RunEvent } from "@ct/contracts";

/**
 * Variants of the synthetic job runs for the /dev/brief viewer: "notenough" turns the finished report's
 * signal to insufficient evidence, so the answer page's "Not enough data" verdict can be checked. Only the
 * report changes; every event still passes the RunEvent schema.
 */

export const VARIANTS = ["notenough"] as const;
export type Variant = (typeof VARIANTS)[number];

export function isVariant(value: string | null): value is Variant {
  return value !== null && (VARIANTS as readonly string[]).includes(value);
}

export function variantEvents(events: readonly RunEvent[], variant: Variant): RunEvent[] {
  return events.map((e) => {
    if (variant !== "notenough" || e.type !== "report.final") return e;
    return { ...e, report: { ...e.report, verdict: { ...e.report.verdict, signal: "insufficient_evidence", tag: null } } } as RunEvent;
  });
}
