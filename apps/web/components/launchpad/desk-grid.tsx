import Link from "next/link";
import { DESK_LABEL } from "../../lib/brief/format";
import { askHref } from "../ask/ask-href";
import { cx } from "../ui/cx";
import { SectionHead } from "../ui/section-head";
import { ACTION_LINK, noteHref, replayHref } from "./links";
import { ExhibitThumbnail } from "./thumbnail";
import { isPinned, tilesByDesk, type ShowcaseTile } from "./tiles";

/** The words of a tile whose showcase has no stored brief yet. */
export const NOT_PINNED = "Not yet pinned";

/** A dot between the tile's actions. */
function Dot() {
  return (
    <span aria-hidden="true" className="text-faint">
      ·
    </span>
  );
}

/**
 * A showcase tile: the figure glyph, the exact question, the one-line finding of its stored brief, and
 * [Open note] [Replay] [Run live]. A showcase not pinned yet shows its question and [Run live] only.
 */
export function ShowcaseTileView({ tile }: { tile: ShowcaseTile }) {
  const { showcase } = tile;
  const pinned = isPinned(tile) ? tile.card : null;
  const finding = pinned?.finding ?? null;
  const headingId = `showcase-${showcase.code.toLowerCase()}`;
  // Each action names its showcase to a screen reader's link list, where seven "Run live" would read alike.
  const forShowcase = <span className="sr-only">: {showcase.label}</span>;
  return (
    <article
      aria-labelledby={headingId}
      data-showcase={showcase.code}
      data-pinned={pinned ? "true" : "false"}
      className="flex gap-4 border-b border-line py-4 last:border-b-0"
    >
      <ExhibitThumbnail kind={pinned?.exhibit ?? null} className="mt-[3px]" />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <h4 id={headingId} className="m-0 font-serif text-[16px] leading-[22px] font-normal text-ink [overflow-wrap:anywhere]">
          {showcase.question}
        </h4>
        {finding ? (
          <p
            className={cx(
              "m-0 line-clamp-2 text-[13px] leading-[18px]",
              finding.kind === "tag" ? "font-medium text-ink" : "text-text-2",
            )}
            data-finding={finding.kind}
          >
            <span className="sr-only">Finding: </span>
            {finding.text}
          </p>
        ) : null}
        <p className="m-0 flex flex-wrap items-center gap-x-2 gap-y-1">
          {pinned ? (
            <>
              <Link href={noteHref(pinned.runId)} className={ACTION_LINK}>
                Open note
                {forShowcase}
              </Link>
              <Dot />
              <Link href={replayHref(pinned.runId)} className={ACTION_LINK}>
                Replay
                {forShowcase}
              </Link>
              <Dot />
              <Link href={askHref(showcase.question)} className={ACTION_LINK}>
                Run live
                {forShowcase}
              </Link>
            </>
          ) : (
            <>
              <Link href={askHref(showcase.question)} className={ACTION_LINK}>
                Run live
                {forShowcase}
              </Link>
              <Dot />
              <span className="text-[11px] leading-4 text-dim">{NOT_PINNED}</span>
            </>
          )}
        </p>
      </div>
    </article>
  );
}

export interface DeskGridProps {
  tiles: readonly ShowcaseTile[];
  className?: string;
}

const HEADING_ID = "showcases";

/**
 * The desk grid (PLAN §8.1): INVESTMENT · LOCATION · MARKETING · AUDIENCE, each with its showcase tiles,
 * two desks a row from 768 px. A pinned tile opens its stored brief at no cost; every tile can run live.
 */
export function DeskGrid({ tiles, className }: DeskGridProps) {
  const pinned = tiles.filter(isPinned).length;
  const aside = pinned === 0 ? "Run any of them live" : `${pinned} of ${tiles.length} pinned · open and replay at no cost`;
  return (
    <section aria-label="Showcases" className={cx("flex w-full flex-col", className)}>
      <SectionHead title="Showcases" aside={aside} id={HEADING_ID} />
      <div className="grid w-full grid-cols-1 gap-x-10 gap-y-8 pt-6 md:grid-cols-2">
        {tilesByDesk(tiles).map(({ desk, tiles: deskTiles }, i) => {
          const deskId = `showcases-${desk}`;
          return (
            <section key={desk} aria-labelledby={deskId} className="flex min-w-0 flex-col">
              <h3
                id={deskId}
                className="m-0 flex items-center gap-[10px] border-b border-line pb-2 text-[11px] leading-[14px] font-semibold tracking-[1.3px] uppercase"
              >
                <span aria-hidden="true" className="text-faint">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span className="text-ink">{DESK_LABEL[desk]}</span>
              </h3>
              {deskTiles.map((tile) => (
                <ShowcaseTileView key={tile.showcase.code} tile={tile} />
              ))}
            </section>
          );
        })}
      </div>
    </section>
  );
}
