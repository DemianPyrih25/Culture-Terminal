import { isVerdictTag, type DatasetKind, type NumbersTraced, type Pillar, type RunState } from "@ct/contracts";
import { DESK_ORDER, headlineText } from "../library/format";
import type { Showcase } from "./showcases";

/**
 * The Launchpad's showcase tiles (PLAN §8.1): each showcase of config/showcases.json, with what its
 * pinned run says when there is one. Pure, so the page and its tests build the same tiles; the server
 * read is ./load.ts. Nothing here is invented: a tile without a stored brief shows its question only.
 */

/** The one-line finding: the brief's verdict tag ("Taste island") when it has one, else its headline. */
export interface ShowcaseFinding {
  kind: "tag" | "headline";
  text: string;
}

/** What a pinned showcase's tile reads from its stored brief. */
export interface ShowcaseCard {
  runId: string;
  /** Null when the brief could not be read: the tile still opens it. */
  finding: ShowcaseFinding | null;
  /** The dataset kind of the brief's first exhibit, drawn as the tile's thumbnail; null without one. */
  exhibit: DatasetKind | null;
  /** CHECKER's count from the brief's receipt. */
  numbersTraced: NumbersTraced | null;
}

export interface ShowcaseTile {
  showcase: Showcase;
  /** The stored brief the tile opens; null while the showcase is not pinned yet (the tile offers [Run live] only). */
  card: ShowcaseCard | null;
}

export type PinnedTile = ShowcaseTile & { card: ShowcaseCard };

export interface DeskTiles {
  desk: Pillar;
  tiles: ShowcaseTile[];
}

/**
 * The brief's verdict tag when it keeps its rule (CHECKER V9: 2 to 5 words, at most 32 characters, no
 * digits or tokens), as the brief page and the library print it; else null, and the tile reads the
 * headline. A note stored before the tag existed has none.
 */
function verdictTag(tag: unknown): string | null {
  return isVerdictTag(tag) ? tag.replace(/\s+/g, " ").trim() : null;
}

/** The headline with its numbers printed from the run's metrics (an UNAVAILABLE one reads "not measured", never 0). */
function headlineFinding(headline: string, metrics: RunState["metrics"]): ShowcaseFinding | null {
  const displays = Object.fromEntries(
    Object.values(metrics).map((m) => [m.id, { label: m.label, display: m.value === null ? null : m.display, badge: m.badge }]),
  );
  const text = headlineText(headline, displays).replace(/\s+/g, " ").trim();
  return text === "" ? null : { kind: "headline", text };
}

/** A pinned showcase's card from its stored run, as the brief page rebuilds it from the run's events. */
export function showcaseCard(state: RunState): ShowcaseCard {
  const report = state.report;
  if (report === null) {
    return { runId: state.runId, finding: null, exhibit: null, numbersTraced: state.validation?.numbersTraced ?? null };
  }
  const tag = verdictTag(report.verdict.tag);
  return {
    runId: state.runId,
    finding: tag !== null ? { kind: "tag", text: tag } : headlineFinding(report.verdict.headline, state.metrics),
    exhibit: report.exhibits[0]?.kind ?? null,
    numbersTraced: report.receipt.numbersTraced,
  };
}

/** A card for a pinned run whose brief could not be read: the tile still opens it, without a finding. */
export function unreadCard(runId: string): ShowcaseCard {
  return { runId, finding: null, exhibit: null, numbersTraced: null };
}

/** Every showcase as a tile, in config order, with its pinned brief's card by showcase code. */
export function launchpadTiles(showcases: readonly Showcase[], cards: ReadonlyMap<string, ShowcaseCard>): ShowcaseTile[] {
  return showcases.map((showcase) => ({ showcase, card: cards.get(showcase.code) ?? null }));
}

/** The tiles by desk, INVESTMENT · LOCATION · MARKETING · AUDIENCE; a desk without a showcase is left out. */
export function tilesByDesk(tiles: readonly ShowcaseTile[]): DeskTiles[] {
  return DESK_ORDER.map((desk) => ({ desk, tiles: tiles.filter((t) => t.showcase.desk === desk) })).filter((d) => d.tiles.length > 0);
}

export function isPinned(tile: ShowcaseTile): tile is PinnedTile {
  return tile.card !== null;
}

/** The showcase "Judge in 60 seconds" opens: the first pinned one in config order (S1, the pitch opener, once pinned). */
export function judgeTile(tiles: readonly ShowcaseTile[]): PinnedTile | null {
  return tiles.find(isPinned) ?? null;
}

/** Numbers traced across the pinned showcase briefs that report it; null when none does. */
export function showcasesTraced(tiles: readonly ShowcaseTile[]): { traced: number; total: number; briefs: number } | null {
  const counts = tiles.flatMap((t) => (t.card?.numbersTraced ? [t.card.numbersTraced] : []));
  if (counts.length === 0) return null;
  return {
    traced: counts.reduce((sum, c) => sum + c.traced, 0),
    total: counts.reduce((sum, c) => sum + c.total, 0),
    briefs: counts.length,
  };
}
