import type { ReactNode } from "react";
import type { StatusLevel } from "../../server/status";
import { cx } from "../ui/cx";
import { LEVEL_TAG, type Tag, type TagTone } from "./format";

/** The rows of a section: a definition list, one row per item over a line. */
export function StatusRows({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <dl aria-label={label} className="flex flex-col">
      {children}
    </dl>
  );
}

export interface StatusRowProps {
  /** The 200 px label on the left, 13/500 ink-2. */
  label: ReactNode;
  /** The value: text, a meter and its amount, a strip. */
  children: ReactNode;
  /** The note on the right, or a breaker's state pill. */
  note?: ReactNode;
  className?: string;
}

/**
 * A row: label 200 · value · note, 44 px over a line. Below 640 px the label takes its own line and the
 * note goes under the value.
 */
export function StatusRow({ label, children, note, className }: StatusRowProps) {
  return (
    <div
      className={cx(
        "flex min-h-11 flex-wrap items-center gap-x-4 gap-y-1 border-t border-line py-2.5 first:border-t-0 max-sm:flex-col max-sm:items-start",
        className,
      )}
    >
      <dt className="w-[200px] shrink-0 type-label text-ink-2 max-sm:w-full">{label}</dt>
      <dd className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-1 type-body text-ink-2 max-sm:w-full sm:flex-nowrap">{children}</dd>
      {note ? <dd className="shrink-0 text-right type-label text-ink-2 max-sm:text-left">{note}</dd> : null}
    </div>
  );
}

/** "214 of 1,900": the used part in ink (never broken), the rest in ink-2, wrapping on a phone. */
export function Amount({ used, of, wrap = false }: { used: ReactNode; of?: ReactNode; /** A sentence rather than a number: it may wrap. */ wrap?: boolean }) {
  return (
    <span className="min-w-0 tabular-nums [overflow-wrap:anywhere]">
      <span className={cx("font-medium text-ink", !wrap && "whitespace-nowrap")}>{used}</span>
      {of ? <> {of}</> : null}
    </span>
  );
}

const PILL: Readonly<Record<TagTone, { box: string; dot: string }>> = {
  good: { box: "bg-good-soft text-good-ink", dot: "bg-good" },
  caution: { box: "bg-caution-soft text-caution-ink", dot: "bg-caution" },
  danger: { box: "bg-danger-soft text-danger-ink", dot: "bg-danger" },
  muted: { box: "bg-sunken text-ink-2", dot: "bg-ink-3" },
};

/** A state as a soft pill: a dot and the word, in the tone's soft fill. */
export function StateTag({ tag, state }: { tag: Tag; state: string }) {
  const pill = PILL[tag.tone];
  return (
    <span
      className={cx("inline-flex h-6 items-center gap-1.5 rounded-chip px-2.5 text-[13px] leading-[18px] font-medium whitespace-nowrap", pill.box)}
      data-state={state}
      data-tone={tag.tone}
    >
      <span aria-hidden="true" className={cx("size-1.5 shrink-0 rounded-full", pill.dot)} />
      {tag.word}
    </span>
  );
}

/** A breaker's state: Clear, Past 80%, Warning, Economy, Tripped. */
export function LevelTag({ level }: { level: StatusLevel }) {
  return <StateTag tag={LEVEL_TAG[level]} state={level} />;
}
