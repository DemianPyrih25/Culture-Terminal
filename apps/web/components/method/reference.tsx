import type { ReactNode } from "react";
import { Card } from "../ui/card";
import { cx } from "../ui/cx";
import { Icon } from "../ui/icons";

/**
 * The reference page's parts (/method): a sticky index of its sections on the left (a <details> on
 * phones), then one card per section, each with its title, an aside and an optional note.
 */

/** Section anchors clear a little air when the index jumps to them. */
export const REFERENCE_ANCHOR = "scroll-mt-6";

/** A section label: 11 px small caps, tracked, ink-3. */
export const EYEBROW = "text-[11px] leading-4 font-semibold tracking-[0.08em] uppercase text-ink-3";
/** Body text, 15 ink-2. */
export const BODY = "type-body text-ink-2";
/** A heading inside a section: 11 px small caps, tracked, ink-3. */
export const SUBHEAD = "text-[11px] leading-4 font-semibold tracking-[0.08em] uppercase text-ink-3";
/** A small label in a row: 13/500 ink-2. */
export const LABEL = "type-label text-ink-2";
export const LIST = "flex flex-col";
/** A table row's rule. */
export const ROW = "border-t border-line align-baseline";

export interface IndexItem {
  id: string;
  label: string;
}

function IndexLinks({ items }: { items: readonly IndexItem[] }) {
  return (
    <ol className="flex flex-col border-l border-line">
      {items.map((item, i) => (
        <li key={item.id}>
          <a
            href={`#${item.id}`}
            className="-ml-px flex items-baseline gap-2.5 border-l border-transparent py-1.5 pl-3 type-label text-ink-2 transition-colors hover:border-accent hover:text-accent"
          >
            <span aria-hidden="true" className="w-4 shrink-0 font-mono text-[10px] leading-4 text-ink-3">
              {String(i + 1).padStart(2, "0")}
            </span>
            <span className="min-w-0">{item.label}</span>
          </a>
        </li>
      ))}
    </ol>
  );
}

/** The sticky index (desktop) and its <details> (phones), with the reading column beside or under it. */
export function ReferenceLayout({ items, head, children }: { items: readonly IndexItem[]; head: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-10 pt-14 pb-12 max-md:gap-6 max-md:pt-8 max-md:pb-8">
      <div className="md:grid md:grid-cols-[216px_minmax(0,1fr)] md:gap-14">
        <div className="max-md:hidden" />
        <div className="min-w-0 max-w-[880px]">{head}</div>
      </div>
      <details className="rounded-card border border-line bg-surface px-5 py-3 md:hidden" data-index="phone">
        <summary className="flex cursor-pointer list-none items-center justify-between type-label font-semibold text-ink">
          On this page
          <Icon name="chevron-down" size={16} className="text-ink-3" />
        </summary>
        <nav aria-label="On this page" className="pt-2">
          <IndexLinks items={items} />
        </nav>
      </details>
      <div className="md:grid md:grid-cols-[216px_minmax(0,1fr)] md:gap-14">
        <aside className="max-md:hidden">
          <nav aria-label="On this page" className="sticky top-6 flex max-h-[calc(100vh-48px)] flex-col gap-3 overflow-y-auto" data-index="desktop">
            <p className={EYEBROW}>On this page</p>
            <IndexLinks items={items} />
            <a href="/how-it-works" className="pt-4 pl-3 type-caption text-accent hover:underline">
              Back to How it works
            </a>
          </nav>
        </aside>
        <div className="flex min-w-0 max-w-[880px] flex-col gap-10 max-md:gap-6">{children}</div>
      </div>
    </div>
  );
}

export interface RefNoteProps {
  children: ReactNode;
  /** Where the rule lives in the code, in mono. */
  trace?: string;
}

/** A note under a section: what to keep in mind, and where it lives in the code. */
export function RefNote({ children, trace }: RefNoteProps) {
  return (
    <div className="-mx-8 -mb-8 mt-2 flex gap-2.5 rounded-b-card border-t border-line bg-sunken/50 px-8 py-4 max-md:-mx-5 max-md:-mb-5 max-md:px-5" data-note="true">
      <Icon name="lightbulb" size={15} className="mt-0.5 shrink-0 text-caution" />
      <p className="type-caption text-ink-2">
        {children}
        {trace ? <span className="block pt-1 font-mono text-[11px] leading-4 text-ink-3 [overflow-wrap:anywhere]">{trace}</span> : null}
      </p>
    </div>
  );
}

export interface RefSectionProps {
  id: string;
  title: string;
  aside?: string;
  note?: ReactNode;
  children: ReactNode;
  className?: string;
}

/** One section: a card with its h2 and aside, the body, then its note. */
export function RefSection({ id, title, aside, note, children, className }: RefSectionProps) {
  return (
    <Card
      id={id}
      aria-labelledby={`${id}-title`}
      data-section={id}
      padding="none"
      className={cx("flex flex-col gap-6 px-8 pt-7 pb-8 max-md:gap-5 max-md:px-5 max-md:pt-5 max-md:pb-5", REFERENCE_ANCHOR, className)}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-line pb-3.5">
        <h2 id={`${id}-title`} className="font-display text-[24px] leading-[30px] text-ink max-md:text-[20px] max-md:leading-[26px]">
          {title}
        </h2>
        {aside ? <p className="type-caption text-ink-3">{aside}</p> : null}
      </div>
      {children}
      {note}
    </Card>
  );
}

/** Term and text rows: the term 15/600 ink, the text 15 ink-2. */
export function TermList({ rows }: { rows: readonly { term: string; text: ReactNode }[] }) {
  return (
    <dl className="grid gap-x-4 gap-y-3 sm:grid-cols-[160px_minmax(0,1fr)]">
      {rows.map((r) => (
        <div key={r.term} className="contents">
          <dt className="type-body-strong text-ink">{r.term}</dt>
          <dd className={cx(BODY, "max-sm:pb-1")}>{r.text}</dd>
        </div>
      ))}
    </dl>
  );
}

export interface ColophonRow {
  key: string;
  value: ReactNode;
}

/** Key and value rows, as the sources card lists them. */
export function Colophon({ rows }: { rows: readonly ColophonRow[] }) {
  return (
    <dl className="grid gap-x-4 gap-y-2 sm:grid-cols-[120px_minmax(0,1fr)]">
      {rows.map((row) => (
        <div key={row.key} className="contents">
          <dt className={LABEL}>{row.key}</dt>
          <dd className="type-body text-ink max-sm:pb-1">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}
