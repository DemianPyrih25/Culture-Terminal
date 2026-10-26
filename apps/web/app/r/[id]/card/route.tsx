import { ImageResponse } from "next/og";
import { DatasetEnvelope, type DatasetId } from "@ct/contracts";
import { buildOgCard, OG_SIZE, OgCardImage, showsOgCard } from "@/lib/og";
import { ogFonts } from "@/lib/og/fonts";
import { isRunId } from "@/lib/run-id";
import { runDataset } from "@/server/http";
import { loadPermalink, type Permalink } from "../load";

export const runtime = "nodejs";
// Read per request from the run's stored events and its showcase flag, as the permalink is.
export const dynamic = "force-dynamic";

/**
 * How long a card may be cached. A stored brief never changes, but a showcase can be unpinned and its
 * card must then go (D31).
 */
const CACHE_CONTROL = "public, max-age=3600";

type Brief = Extract<Permalink, { kind: "brief" }>;

/**
 * A curated showcase's finished brief with something to show; null for a reader's own run (D31), an
 * unfinished or unknown one, one stored without its report, or a bad id.
 */
async function showcaseBrief(id: string): Promise<Brief | null> {
  if (!isRunId(id)) return null;
  const found = await loadPermalink(id);
  return found.kind === "brief" && showsOgCard(found) ? found : null;
}

/** The lead figure's dataset when the stream did not carry it inline (a large lift map or matrix). */
async function fetchedDatasets(id: string, brief: Brief): Promise<Map<DatasetId, DatasetEnvelope>> {
  const out = new Map<DatasetId, DatasetEnvelope>();
  const lead = brief.model.evidence.figures[0];
  if (!lead?.needsFetch) return out;
  const res = await runDataset(id, lead.datasetId);
  if (!res.ok) return out;
  const parsed = DatasetEnvelope.safeParse(await res.json());
  if (parsed.success) out.set(lead.datasetId, parsed.data);
  return out;
}

/**
 * GET /r/[id]/card: the share card of a curated showcase (P1 #4, SPEC §8.6, 1200 × 630), which the
 * permalink's head names as its og:image (lib/og/meta.ts): the question, the signal line, a mini viz
 * of the lead figure and the receipt strip. Any other run answers 404 (D31), as an unknown one does.
 */
export async function GET(_request: Request, ctx: RouteContext<"/r/[id]/card">): Promise<Response> {
  const { id } = await ctx.params;
  const brief = await showcaseBrief(id);
  if (!brief) return new Response("Not Found", { status: 404 });
  const card = buildOgCard({ model: brief.model, state: brief.state, question: brief.question, datasets: await fetchedDatasets(id, brief) });
  const image = new ImageResponse(<OgCardImage card={card} />, { ...OG_SIZE, fonts: await ogFonts() });
  // ImageResponse draws as it streams: reading it here turns a drawing error into a 500, not a cut-off 200.
  const png = await image.arrayBuffer();
  return new Response(png, { headers: { "Content-Type": "image/png", "Cache-Control": CACHE_CONTROL } });
}
