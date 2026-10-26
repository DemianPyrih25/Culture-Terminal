import type { ReactNode } from "react";
import { TopBarAsk } from "../ask/top-bar-ask";
import { StatusLine } from "../chrome/status-line";
import { TopBar } from "../chrome/top-bar";

/**
 * The tearsheet's chrome: the top bar with its question field, the page, and the status line with the
 * honesty line and, once a tearsheet is drawn, its Qloo requests (QLOO 8 REQ · 3 CACHED).
 */
export function DesChrome({ requests = null, children }: { requests?: { total: number; cached: number } | null; children: ReactNode }) {
  return (
    <>
      <TopBar command={<TopBarAsk />} />
      <main id="main" className="flex w-full flex-1 flex-col bg-paper">
        {children}
      </main>
      <StatusLine requests={requests ?? undefined} />
    </>
  );
}
