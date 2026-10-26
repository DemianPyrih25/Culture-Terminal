import { isRunId } from "@/lib/run-id";
import { loadPermalink } from "./load";
import { PendingProvider } from "./pending";
import { RunPending } from "./run-pending";

/**
 * Around the permalink: when the run has no finished brief, the page answers 404, and its not-found
 * file shows the run's own page with the way to /run/[id] (see ./pending). The run is read once per
 * request, shared with the page and its metadata.
 */
export default async function PermalinkLayout({ children, params }: LayoutProps<"/r/[id]">) {
  const { id } = await params;
  const found = isRunId(id) ? await loadPermalink(id) : null;
  const pending = found?.kind === "pending" ? <RunPending runId={found.runId} ended={found.ended} /> : null;
  return <PendingProvider view={pending}>{children}</PendingProvider>;
}
