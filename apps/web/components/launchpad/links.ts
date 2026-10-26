/**
 * Where the Launchpad's actions go. A pinned showcase opens as its read-only note (/r/[id], indexable:
 * showcases are curated, D31), replays from its stored events at no cost (D26), or runs live from the
 * Ask page, where the question is read and estimated before anything runs.
 */

/** The read-only note of a stored run. */
export function noteHref(runId: string): string {
  return `/r/${encodeURIComponent(runId)}`;
}

/** The stored run played back: 0 Qloo requests, $0. */
export function replayHref(runId: string): string {
  return `/run/${encodeURIComponent(runId)}?replay=1`;
}

/** Trust and safety: the SAFE_USE mapping and the refusal examples (Part 7). */
export const TRUST_HREF = "/trust";

/** The id of Home's question field section, the target of "Ask live". */
export const ASK_ANCHOR = "ask";

/** The quiet accent link of the Launchpad's actions. */
export const ACTION_LINK = "text-[12px] leading-4 font-medium text-accent hover:underline hover:underline-offset-4";
