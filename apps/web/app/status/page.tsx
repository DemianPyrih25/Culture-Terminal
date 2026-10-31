import type { Metadata } from "next";
import { SiteShell } from "../../components/chrome/site-shell";
import { StatusView } from "../../components/status/status-view";
import { currentStatus } from "../../server/status";

// Rendered per request: a reading of the running server (reused for a few seconds, server/status.ts).
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Status · Culture Terminal",
  description: "Service health, runs, Qloo and system readings of this Culture Terminal server.",
  // An operations page, not content: kept out of search results.
  robots: { index: false, follow: false },
};

/** /status (PLAN Part 7, P1 item 13): the service state and why, runs, Qloo and system health. */
export default async function StatusPage() {
  const report = await currentStatus();
  return (
    <SiteShell header="inner">
      <StatusView report={report} />
    </SiteShell>
  );
}
