import { Pillar } from "@ct/contracts";
import { z } from "zod";
import config from "../../../../config/showcases.json";
import { STARTER_DESKS } from "../home/starters";

/**
 * The curated showcases of the Launchpad (PLAN §9, SPEC §9), read from config/showcases.json: the code,
 * the desk and the exact question each tile shows. Names only (D29): the config holds no Qloo values,
 * and which run a showcase opens is read from the database (the run pinned under its slug), never from here.
 * Server code only: the client bundle never needs the config.
 */

const ShowcaseConfig = z.object({
  showcases: z
    .array(z.object({ code: z.string().regex(/^S[1-9]\d*$/), slug: z.string().min(1), desk: Pillar, question: z.string().min(1) }))
    .min(1),
  trust: z.object({ slug: z.string().min(1), question: z.string().min(1) }),
});

export interface Showcase {
  /** "S1". */
  code: string;
  slug: string;
  desk: Pillar;
  /** The exact question, word for word: the tile's text, and what [Run live] asks. */
  question: string;
  /** Its starter's short label (components/home/starters.ts), for links that name it; the question when there is none. */
  label: string;
}

const parsed = ShowcaseConfig.parse(config);

const starterLabel = new Map(
  STARTER_DESKS.flatMap((desk) => desk.starters).flatMap((s) => (s.showcase ? [[s.showcase, s.label] as const] : [])),
);

/** S1 to S7 in config order: the pitch opener first. */
export const SHOWCASES: readonly Showcase[] = parsed.showcases.map((s) => ({
  code: s.code,
  slug: s.slug,
  desk: s.desk,
  question: s.question,
  label: starterLabel.get(s.code) ?? s.question,
}));

/** The trust example: a question refused before any request, with a group-level reframe (SPEC §9 trust tile). */
export const TRUST_QUESTION: string = parsed.trust.question;

/** The slug its pinned refusal run is stored under. */
export const TRUST_SLUG: string = parsed.trust.slug;
