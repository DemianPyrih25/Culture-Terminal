/**
 * Which request stamps flash (PLAN §8.3): a call flashes once, as it lands while the reader watches. A
 * call already in the run when the page opened never flashes, and one that landed more than a moment ago
 * stays still, so a Sources list that opens at the end of a run or an inspector opened later does not
 * replay the flash. Pure, so the rule is tested without a DOM.
 */

/** How long after it lands a call's stamp may still start its flash (the flash itself lasts 360 ms). */
export const FLASH_WINDOW_MS = 1000;

export class FreshCalls {
  private readonly landed = new Map<string, number>();

  /** `known`: the calls the first paint already showed. */
  constructor(private readonly known: ReadonlySet<string> = new Set()) {}

  /**
   * Records when each call in the run was first seen. A call that has left the run (a replay that
   * restarted) is forgotten, so it flashes again when it lands again.
   */
  observe(qlooCallIds: readonly string[], now: number): void {
    const present = new Set(qlooCallIds);
    for (const id of this.landed.keys()) if (!present.has(id)) this.landed.delete(id);
    for (const id of qlooCallIds) if (!this.landed.has(id)) this.landed.set(id, now);
  }

  /** True while a call that landed after the page opened is new: unseen yet, or seen within the window. */
  isFresh(qlooCallId: string, now: number): boolean {
    if (this.known.has(qlooCallId)) return false;
    const at = this.landed.get(qlooCallId);
    return at === undefined || now - at < FLASH_WINDOW_MS;
  }
}
