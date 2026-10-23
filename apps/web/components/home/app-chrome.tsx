import type { ReactNode } from "react";
import { TopBarAsk } from "../ask/top-bar-ask";
import { StatusLine } from "../chrome/status-line";
import { TopBar, type NavKey } from "../chrome/top-bar";
import { cx } from "../ui/cx";
import { QlooUsage } from "./qloo-usage";

export interface AppChromeProps {
  /** The top bar section the page belongs to. */
  active?: NavKey | null;
  /** The day's fresh Qloo request quota, for the status line. */
  qlooCap: number;
  /** Today's fresh Qloo requests, read on the server (qlooRequestsToday); null leaves the count out. */
  qlooUsed: number | null;
  children: ReactNode;
  className?: string;
}

/**
 * The chrome of Home, Ask and the library: the top bar with its question field (⌘K; the page's own
 * field or search takes /), the page, and the status line with today's Qloo requests.
 */
export function AppChrome({ active = null, qlooCap, qlooUsed, children, className }: AppChromeProps) {
  return (
    <>
      <TopBar active={active} command={<TopBarAsk shortcut={["mod-k"]} />} />
      <main id="main" className={cx("flex w-full flex-1 flex-col bg-paper", className)}>
        {children}
      </main>
      <StatusLine right={<QlooUsage used={qlooUsed} cap={qlooCap} />} />
    </>
  );
}
