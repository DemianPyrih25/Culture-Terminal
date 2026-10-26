import type { Metadata } from "next";
import { AppChrome } from "../../components/home/app-chrome";
import { StatusView } from "../../components/status/status-view";
import { qlooDailyFreshCapFromEnv } from "../../server/config";
import { currentStatus } from "../../server/status";

// Rendered per request: a reading of the running server (reused for a few seconds, server/status.ts).
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Status · Culture Terminal",
  description: "Mode, breakers, budgets and quota of this Culture Terminal server.",
  // An operations page, not content: kept out of search results.
  robots: { index: false, follow: false },
};

/** /status (PLAN Part 7, P1 item 13): the mode and why, budgets, quota, outcomes and system health. */
export default async function StatusPage() {
  const report = await currentStatus();
  const qlooUsed = report.qloo.configured ? report.qloo.today.network : null;
  return (
    <AppChrome qlooCap={qlooDailyFreshCapFromEnv()} qlooUsed={qlooUsed}>
      <StatusView report={report} />
    </AppChrome>
  );
}
