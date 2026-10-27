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

/** Body text, 15 ink-2. */
export const BODY = "type-body text-ink-2";
/** A heading inside a section: 13/600 ink-2. */
export const SUBHEAD = "text-[13px] leading-[18px] font-semibold text-ink-2";
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
    <ol className="flex flex-col">
      {items.map((item) => (
        <li key={item.id}>
          <a href={`#${item.id}`} className="block rounded-sm py-1.5 type-label text-ink-2 transition-colors hover:text-ink">
            {item.label}
          </a>
        </li>
      ))}
    </ol>
  );
}

/** The sticky index (desktop) and its <details> (phones), with the sections beside or under it. */
export function ReferenceLayout({ items, head, children }: { items: readonly IndexItem[]; head: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-6 pt-12 pb-12 max-md:gap-4 max-md:pt-6 max-md:pb-8">
      {head}
      <details className="rounded-card border border-line bg-surface px-5 py-3 shadow-xs md:hidden" data-index="phone">
        <summary className="flex cursor-pointer list-none items-center justify-between type-label font-semibold text-ink">
          On this page
          <Icon name="chevron-down" size={16} className="text-ink-3" />
        </summary>
        <nav aria-label="On this page" className="pt-2">
          <IndexLinks items={items} />
        </nav>
      </details>
      <div className="md:grid md:grid-cols-[200px_minmax(0,1fr)] md:gap-12">
        <aside className="max-md:hidden">
          <nav aria-label="On this page" className="sticky top-6 flex flex-col gap-2" data-index="desktop">
            <p className="text-[13px] leading-[18px] font-semibold text-ink">On this page</p>
            <IndexLinks items={items} />
          </nav>
        </aside>
        <div className="flex min-w-0 flex-col gap-6 max-md:gap-4">{children}</div>
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
    <div className="flex gap-2 border-t border-line pt-4" data-note="true">
      <Icon name="lightbulb" size={16} className="mt-0.5 shrink-0 text-ink-2" />
      <p className={LABEL}>
        {children}
        {trace ? <span className="block pt-0.5 font-mono text-[12px] leading-[18px] text-ink-2 [overflow-wrap:anywhere]">{trace}</span> : null}
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
    <Card id={id} aria-labelledby={`${id}-title`} data-section={id} className={cx("flex flex-col gap-4", REFERENCE_ANCHOR, className)}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id={`${id}-title`} className="type-title text-ink max-md:type-title-sm">
          {title}
        </h2>
        {aside ? <p className={LABEL}>{aside}</p> : null}
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
