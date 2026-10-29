import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PermalinkAnswer, RefusedAnswerPage } from "@/components/answer";
import { AnswerMissing } from "@/components/working/missing";
import { ogCardMetadata } from "@/lib/og";
import { isRunId } from "@/lib/run-id";
import { loadFirstPaintDatasets, loadPermalink, permalinkSummary } from "./load";

// Rendered per request from the run's stored events, on the server: a finished answer never changes, and
// whether it is a showcase is read from the run row each time.
export const dynamic = "force-dynamic";

const NOINDEX = { index: false, follow: false } as const;
const SITE = "Culture Terminal";

export async function generateMetadata(props: PageProps<"/r/[id]">): Promise<Metadata> {
  const { id } = await props.params;
  const found = isRunId(id) ? await loadPermalink(id) : null;
  if (found?.kind !== "brief") return { title: `Answer · ${SITE}`, robots: NOINDEX };
  const question = found.state.question ?? found.question;
  const title = question ? `${question} · ${SITE}` : `Answer · ${SITE}`;
  // D31: a reader's own run is unlisted and gets no description or card; a curated showcase is indexed,
  // its share card (/r/[id]/card) its og:image and a large Twitter card.
  if (!found.showcase) return { title, robots: NOINDEX };
  const summary = permalinkSummary(found.model);
  return { title, ...(summary ? { description: summary } : {}), ...ogCardMetadata(id, found) };
}

/**
 * /r/[id]: the read-only permalink of a finished answer (design/redesign.pen N05, N07–N12). A server
 * render of the answer as stored, with nothing streaming. Only a run that ended with an answer, an
 * evidence digest or a refusal has one; any other run answers 404 with the way to /run/[id] (see
 * ./layout), and so does an unknown id.
 */
export default async function PermalinkPage(props: PageProps<"/r/[id]">) {
  const { id } = await props.params;
  if (!isRunId(id)) notFound();
  const found = await loadPermalink(id);
  if (found.kind === "unavailable") return <AnswerMissing kind="unavailable" runId={id} />;
  if (found.kind !== "brief") notFound();

  const { state, model } = found;
  const permalink = `/r/${encodeURIComponent(id)}`;
  if (model.terminal?.kind === "refused") return <RefusedAnswerPage model={model} fallbackQuestion={found.question} permalink={permalink} />;
  const run = `/run/${encodeURIComponent(id)}`;
  const datasets = await loadFirstPaintDatasets(id, model);
  return (
    <PermalinkAnswer
      model={model}
      // Only what the answer reads from the run: the rest stays on the server.
      state={{ resolves: state.resolves, metrics: state.metrics, evidence: state.evidence, ghost: state.ghost ?? state.report?.ghost ?? null, intent: state.intent }}
      runId={id}
      mode="static"
      links={{ permalink, replay: `${run}?replay=1` }}
      fallbackQuestion={found.question}
      datasets={datasets}
    />
  );
}
