/**
 * Pages that exist in this build. A link to a page that is not built yet is never rendered, so no
 * reader lands on a 404: Method ships in Part 7, Following in Part 6. Flip a flag when its page lands.
 */
export const ROUTE_LIVE = { method: false, following: false } as const;
