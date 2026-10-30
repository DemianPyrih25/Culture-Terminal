/**
 * Pages that exist in this build. A link to a page that is not built yet is never rendered, so no
 * reader lands on a 404. Flip a flag when its page lands. Method shipped in Part 7, with /trust beside
 * it; Following and the screener ship in Part 10.
 */
export const ROUTE_LIVE = { method: true, following: true, screener: true } as const;
