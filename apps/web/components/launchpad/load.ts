import "server-only";
import { reduceRunEvents } from "@ct/contracts";
import { evalSummaryCandidates, loadEvalSummary } from "../../app/method/load-eval";
import { getDatabase } from "../../server/container";
import { readAllEvents } from "../../server/event-store";
import { log } from "../../server/log";
import type { EvalSummary } from "../method/eval-summary";
import type { Showcase } from "./showcases";
import { showcaseCard, unreadCard, type ShowcaseCard } from "./tiles";

/**
 * The Launchpad's server reads: the stored brief behind each pinned showcase, and the eval's aggregates.
 * Which run a showcase opens is the pin store's (the run holding its slug, written by the showcase tool:
 * curated, never a reader's own run, D31); a tile reads its brief the way the brief page does, from the
 * run's stored events.
 */

/** A pinned showcase as the pin store lists it (@ct/db listPinnedShowcases), newest first within a slug. */
export interface ShowcasePin {
  slug: string;
  runId: string;
}

/** The run each pinned slug opens; a slug listed twice keeps its first (newest) run. */
export function pinsBySlug(pins: readonly ShowcasePin[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const pin of pins) if (!out.has(pin.slug)) out.set(pin.slug, pin.runId);
  return out;
}

/**
 * Cards of finished runs by run id. A finished run never changes, so each is read once per process;
 * a showcase pinned again is a new run id. Bounded, oldest out.
 */
const cards = new Map<string, ShowcaseCard>();
const CARDS_MAX = 64;

/** The card of one stored showcase run; without a finding when its events cannot be read. */
export async function readShowcaseCard(runId: string): Promise<ShowcaseCard> {
  const known = cards.get(runId);
  if (known) return known;
  try {
    const state = reduceRunEvents(runId, await readAllEvents(getDatabase(), runId));
    const card = showcaseCard(state);
    if (state.ended !== null && state.report !== null) {
      if (cards.size >= CARDS_MAX) cards.delete(cards.keys().next().value ?? "");
      cards.set(runId, card);
    }
    return card;
  } catch (err) {
    log.warn({ err, runId }, "launchpad: could not read a showcase brief");
    return unreadCard(runId);
  }
}

/**
 * The cards of the pinned showcases, by showcase code. `pins` is pinsBySlug: the run each slug of
 * config/showcases.json opens. A showcase whose slug has none is not pinned yet.
 */
export async function pinnedShowcases(
  showcases: readonly Showcase[],
  pins: ReadonlyMap<string, string>,
): Promise<Map<string, ShowcaseCard>> {
  const found = await Promise.all(
    showcases.map(async (s) => {
      const runId = pins.get(s.slug);
      return runId === undefined ? null : ([s.code, await readShowcaseCard(runId)] as const);
    }),
  );
  return new Map(found.filter((entry) => entry !== null));
}

/**
 * The eval's aggregates, or null before the eval has run (no file) or when the file is not a summary.
 * Read on each request, so a new eval shows at once; the file, its shape and where it is looked for are
 * the ones /method#eval reads (app/method/load-eval.ts).
 */
export function readEvalSummary(files: readonly string[] = evalSummaryCandidates()): EvalSummary | null {
  const evaluation = loadEvalSummary(files);
  if (evaluation.state === "invalid") log.warn({ reason: evaluation.reason }, "launchpad: the eval summary is not in the expected shape");
  return evaluation.state === "ok" ? evaluation.summary : null;
}
