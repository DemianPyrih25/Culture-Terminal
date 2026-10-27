"use client";

import { createContext, useContext, type ReactNode } from "react";

/**
 * A permalink of a run with no finished answer answers 404 (notFound), and the 404 cannot see the run.
 * The layout, which can, hands the page to show instead through this context: the run is still being
 * made, or it ended without an answer; either way /run/[id] shows it. Null for every other 404.
 */
const PendingView = createContext<ReactNode>(null);

export function PendingProvider({ view, children }: { view: ReactNode; children: ReactNode }) {
  return <PendingView.Provider value={view}>{children}</PendingView.Provider>;
}

/** The pending run's page when the layout found one, else `children` (the plain 404). */
export function PendingSwitch({ children }: { children: ReactNode }) {
  const view = useContext(PendingView);
  return <>{view ?? children}</>;
}
