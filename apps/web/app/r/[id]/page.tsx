import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BriefDocument, BriefMissing } from "@/components/brief";
import { ogCardMetadata } from "@/lib/og";
import { isRunId } from "@/lib/run-id";
import { loadPermalink, permalinkSummary } from "./load";

// Rendered per request from the run's stored events, on the server: a finished brief never changes, and
// whether it is a showcase is read from the run row each time.
export const dynamic = "force-dynamic";

const NOINDEX = { index: false, follow: false } as const;
const SITE = "Culture Terminal";

export async function generateMetadata(props: PageProps<"/r/[id]">): Promise<Metadata> {
  const { id } = await props.params;
  const found = isRunId(id) ? await loadPermalink(id) : null;
  if (found?.kind !== "brief") return { title: `Brief · ${SITE}`, robots: NOINDEX };
  const question = found.state.question ?? found.question;
  const title = question ? `${question} · ${SITE}` : `Brief · ${SITE}`;
  // D31: a reader's own run is unlisted and gets no description or card; a curated showcase is indexed,
  // its share card (/r/[id]/card) its og:image and a large Twitter card.
  if (!found.showcase) return { title, robots: NOINDEX };
  const summary = permalinkSummary(found.model);
  return { title, ...(summary ? { description: summary } : {}), ...ogCardMetadata(id, found) };
}

/**
 * /r/[id]: the read-only permalink of a finished brief (PLAN Part 6, SPEC §8.1). A server render of the
 * brief as stored, through the brief page's own document in its final view, with nothing streaming.
 * Only a run that ended with a note, a digest or a refusal has one; any other run answers 404 with the
 * way to /run/[id] (see ./layout), and so does an unknown id.
 */
export default async function PermalinkPage(props: PageProps<"/r/[id]">) {
  const { id } = await props.params;
  if (!isRunId(id)) notFound();
  const found = await loadPermalink(id);
  if (found.kind === "unavailable") return <BriefMissing kind="unavailable" runId={id} />;
  if (found.kind !== "brief") notFound();

  const { state, model } = found;
  const run = `/run/${encodeURIComponent(id)}`;
  return (
    <BriefDocument
      model={model}
      // Only what the document reads from the state: the rest stays on the server.
      state={{ evidence: state.evidence, resolves: state.resolves, model: state.model, lastSeq: state.lastSeq, ghost: state.ghost ?? state.report?.ghost ?? null }}
      view="final"
      links={{ permalink: `/r/${encodeURIComponent(id)}`, replay: `${run}?replay=1` }}
      fallbackQuestion={found.question}
      // D31: a reader's own run is noindex (above) and marked unlisted.
      unlisted={!found.showcase}
    />
  );
}
