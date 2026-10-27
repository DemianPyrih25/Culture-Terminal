import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BriefView } from "@/components/brief/brief-view";
import { AnswerMissing } from "@/components/working/missing";
import { isRunId } from "@/lib/run-id";
import { loadRun } from "./load";

// Rendered per request from the run's stored events; the client view carries on from there.
export const dynamic = "force-dynamic";

export async function generateMetadata(props: PageProps<"/run/[id]">): Promise<Metadata> {
  const { id } = await props.params;
  const run = isRunId(id) ? await loadRun(id) : null;
  const question = run?.kind === "ok" ? (run.state.question ?? run.question) : null;
  const showcase = run?.kind === "ok" && run.showcase;
  return {
    title: question ? `${question} · Culture Terminal` : "Answer · Culture Terminal",
    // A reader's own run is unlisted (D31); only a curated showcase is indexed.
    ...(showcase ? {} : { robots: { index: false, follow: false } }),
  };
}

/**
 * /run/[id]: an answer being made streams live (the working view, N03 and N04) and becomes the answer in
 * place; a finished run renders as stored, or plays back with ?replay=1; a run that ended early shows its
 * end state (N16).
 */
export default async function RunPage(props: PageProps<"/run/[id]">) {
  const { id } = await props.params;
  if (!isRunId(id)) notFound();
  const run = await loadRun(id);
  if (run.kind === "not_found") notFound();
  if (run.kind === "unavailable") return <AnswerMissing kind="unavailable" runId={id} />;

  const query = await props.searchParams;
  const ended = run.state.ended !== null;
  const replay = ended && query.replay === "1";
  const path = `/run/${encodeURIComponent(id)}`;
  return (
    <BriefView
      key={`${id}:${replay ? "replay" : "brief"}`}
      runId={id}
      initialState={run.state}
      serverNow={run.at}
      mode={replay ? "replay" : ended ? "static" : "live"}
      fallbackQuestion={run.question}
      links={{ permalink: path, replay: `${path}?replay=1`, exitReplay: path }}
      // D31: a reader's own run is noindex (above).
      unlisted={!run.showcase}
    />
  );
}
