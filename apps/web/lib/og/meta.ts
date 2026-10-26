import type { Metadata } from "next";
import type { RunState } from "@ct/contracts";
import type { BriefModel } from "../brief";
import { buildOgCard, hasOgCard } from "./card";
import { OG_SIZE } from "./tokens";

/**
 * Where a permalink's share card shows (D31): only a curated showcase names it in its head, and only
 * a showcase's card is drawn (app/r/[id]/card/route.tsx). A reader's own run gets no og:* or twitter:*
 * tag at all, which a metadata image file in the segment would add to every run.
 */

/** A finished brief as the permalink reads it (app/r/[id]/load.ts). */
export interface OgBrief {
  model: BriefModel;
  state: RunState;
  /** The run row's question, for a run whose state has none. */
  question: string | null;
  /** The run row's is_showcase: a curated showcase. */
  showcase: boolean;
}

/** A curated showcase with a report or a refusal to put on its card. */
export function showsOgCard(brief: OgBrief): boolean {
  return brief.showcase && hasOgCard(brief.model, brief.state);
}

/** The card's path, /r/[id]/card. */
export function ogCardPath(runId: string): string {
  return `/r/${encodeURIComponent(runId)}/card`;
}

/**
 * The permalink head's card: og:image with its size, type and alt text, and a large Twitter card that
 * takes the same image. Nothing for a run that shows no card.
 */
export function ogCardMetadata(runId: string, brief: OgBrief): Pick<Metadata, "openGraph" | "twitter"> {
  if (!showsOgCard(brief)) return {};
  const { alt } = buildOgCard({ model: brief.model, state: brief.state, question: brief.question });
  return {
    openGraph: { images: [{ url: ogCardPath(runId), width: OG_SIZE.width, height: OG_SIZE.height, alt, type: "image/png" }] },
    twitter: { card: "summary_large_image" },
  };
}
