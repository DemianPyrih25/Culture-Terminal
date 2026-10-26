// The italic serif: /method sets its formulas in it and /trust its example questions. The root layout
// loads only the upright face.
import "@fontsource-variable/source-serif-4/wght-italic.css";
import type { ReactNode } from "react";
import { TopBarAsk } from "../ask/top-bar-ask";
import { StatusLine } from "../chrome/status-line";
import { TopBar, type NavKey } from "../chrome/top-bar";
import { GRID_COLUMNS_MD, GRID_COLUMNS_XL } from "../layout/grid";
import { CheckIcon } from "../ui/icons";
import { cx } from "../ui/cx";
import { MetaLine } from "../ui/meta-line";

/**
 * The reference pages, /method and /trust (A11 · Method & sources): the brief grid without a running
 * head. An outline on the left, the reading column, and numbered sidenotes level with what they
 * annotate. Server components only; the outline is the one client part.
 */

/** Only the 56 px top bar sticks (from 768 px up), so an anchor clears that and a little air. */
export const REFERENCE_ANCHOR = "scroll-mt-20 max-md:scroll-mt-4";

/** Where the outline rests and where the scrollspy's activation line sits: under the top bar. */
export const REFERENCE_STICKY_TOP = 56;

export interface ReferenceChromeProps {
  /** The top bar section the page belongs to. */
  active?: NavKey | null;
  /** The trending window for the status line, e.g. "Apr–Sep 2025". */
  trendWindow?: string | null;
  /** The status line's right side, replacing the trend window. */
  statusRight?: ReactNode;
  children: ReactNode;
}

/** The top bar with its question field, the page, and the status line with the honesty line. */
export function ReferenceChrome({ active = null, trendWindow = null, statusRight, children }: ReferenceChromeProps) {
  return (
    <>
      <TopBar active={active} command={<TopBarAsk />} />
      <main id="main" className="flex w-full flex-1 flex-col bg-paper">
        {children}
      </main>
      <StatusLine trendWindow={trendWindow} right={statusRight} />
    </>
  );
}

export interface ReferenceGridProps {
  /** The outline column, usually an <Outline>: sticky from 768 px up, hidden below. */
  outline: ReactNode;
  /** BriefRow elements. */
  children: ReactNode;
}

/**
 * The brief grid of A00 · 02: margin · outline 200 · gutter · reading 680 · gutter · sidenotes 300 ·
 * margin. Below 1280 px the sidenotes fold under their rows; below 768 px the outline is hidden.
 */
export function ReferenceGrid({ outline, children }: ReferenceGridProps) {
  return (
    <div className={cx("w-full px-4 pt-7 pb-16 md:grid md:px-0", GRID_COLUMNS_MD, "xl:grid", GRID_COLUMNS_XL)}>
      <div className="hidden md:col-start-2 md:row-start-1 md:block">
        <div className="sticky pt-[2px]" style={{ top: REFERENCE_STICKY_TOP + 28 }}>
          {outline}
        </div>
      </div>
      <div className="flex min-w-0 flex-col gap-[22px] md:col-start-4 md:row-start-1 xl:col-[4/span_3] xl:grid xl:grid-cols-subgrid xl:content-start">
        {children}
      </div>
    </div>
  );
}

export interface ReferenceHeadProps {
  /** "Appendix": accent small caps. */
  kicker: string;
  /** "Method & sources": dim small caps. */
  section: string;
  /** Plain parts after them, e.g. "Applies to every brief". */
  extra?: readonly ReactNode[];
  title: string;
  lede: string;
}

/** The meta line, the 40 px serif title and the serif lede. */
export function ReferenceHead({ kicker, section, extra, title, lede }: ReferenceHeadProps) {
  return (
    <header className="flex flex-col gap-[22px]">
      <MetaLine desk={kicker} job={section} extra={extra} />
      <div className="flex flex-col gap-2">
        <h1 className="m-0 font-serif text-[32px] leading-[38px] font-medium tracking-[-0.4px] text-ink md:text-[40px] md:leading-[48px]">
          {title}
        </h1>
        <p className="m-0 font-serif text-[18px] leading-[27px] text-text-2">{lede}</p>
      </div>
    </header>
  );
}

/** A section's anchor and the hairline gap below the one before it. */
export const SECTION_CLASS = cx("flex flex-col gap-3 pt-3", REFERENCE_ANCHOR);

/** The note's id on the page, so its number in the text can link to it. */
export const noteId = (n: number) => `note-${n}`;

/** A/Note ref: the accent superscript that points to a sidenote. */
export function NoteRef({ n }: { n: number }) {
  return (
    <sup className="ml-px align-super text-[9px] leading-none font-semibold">
      <a href={`#${noteId(n)}`} className="text-accent hover:underline" aria-label={`Note ${n}`}>
        {n}
      </a>
    </sup>
  );
}

export interface SideNoteProps {
  n: number;
  text: ReactNode;
  /** The mono trace line under the note, e.g. where the rule lives in the code. */
  trace?: string;
}

/** A/Sidenote: the number, the note and its mono trace line. */
export function SideNote({ n, text, trace }: SideNoteProps) {
  return (
    <div id={noteId(n)} className={cx("flex gap-2", REFERENCE_ANCHOR)} data-sidenote={n}>
      <span className="w-3 shrink-0 text-[11px] leading-[17px] font-semibold text-accent tabular-nums">{n}</span>
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className="m-0 type-sidenote text-dim">{text}</p>
        {trace ? <p className="m-0 type-trace text-faint [overflow-wrap:anywhere]">{trace}</p> : null}
      </div>
    </div>
  );
}

/** Notes in a column, 16 px apart. */
export function SideNotes({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-4">{children}</div>;
}

export interface TraceNoteProps {
  head: string;
  detail: string;
}

/** A/Trace note: the check, a count in ink and a dim detail line, over a hairline. */
export function TraceNote({ head, detail }: TraceNoteProps) {
  return (
    <div className="flex flex-col gap-1 border-b border-line pb-3" data-trace-note="true">
      <p className="m-0 flex items-center gap-2 text-[13px] leading-[18px] font-semibold text-ink">
        <CheckIcon className="shrink-0 text-accent" />
        {head}
      </p>
      <p className="m-0 pl-[22px] text-[11px] leading-[15px] text-dim">{detail}</p>
    </div>
  );
}

export interface ColophonRow {
  key: string;
  value: ReactNode;
}

/** A/Colophon: SOURCES, then key · value rows. */
export function Colophon({ heading, rows }: { heading: string; rows: readonly ColophonRow[] }) {
  return (
    <div className="flex flex-col gap-2.5">
      <p className="m-0 text-[10px] leading-none font-semibold tracking-[1.2px] text-dim uppercase">{heading}</p>
      <dl className="m-0 flex flex-col gap-1.5">
        {rows.map((row) => (
          <div key={row.key} className="flex gap-3 text-[12px] leading-[17px]">
            <dt className="w-[76px] shrink-0 text-dim">{row.key}</dt>
            <dd className="m-0 min-w-0 text-ink">{row.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** Small caps for a row's label: a step's agent, a rule's action. */
export const SMALL_CAPS = "text-[10px] leading-[14px] font-semibold tracking-[0.9px] uppercase";
