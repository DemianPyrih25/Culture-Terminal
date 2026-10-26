/**
 * Pages that exist in this build. A link to a page that is not built yet is never rendered, so no
 * reader lands on a 404: Following ships in Part 6. Flip a flag when its page lands. Method shipped in
 * Part 7, with /trust beside it.
 */
export const ROUTE_LIVE = { method: true, following: false } as const;
