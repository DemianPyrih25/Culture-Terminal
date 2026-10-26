import type { ReactNode } from "react";
import type { StatusLevel } from "../../server/status";
import { cx } from "../ui/cx";
import { LEVEL_TAG, type Tag } from "./format";

/** The rows of a section (A12 Settings): a definition list, one hairline row per item. */
export function StatusRows({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <dl aria-label={label} className="m-0 flex flex-col">
      {children}
    </dl>
  );
}

export interface StatusRowProps {
  /** The 160 px label on the left, in dim. */
  label: ReactNode;
  /** The value: text, a meter and its amount, a strip. */
  children: ReactNode;
  /** The note on the right, or a breaker's tag. */
  note?: ReactNode;
  className?: string;
}

/**
 * A/Settings row: label 160 · value · note, 32 px over a hairline. Below 640 px the label takes its own
 * line and the note goes under the value. A12 sets its notes in faint; here they carry numbers (the
 * spend by lane, the floor, the slots), so they take dim, which reads at AA on paper.
 */
export function StatusRow({ label, children, note, className }: StatusRowProps) {
  return (
    <div
      className={cx(
        "flex min-h-8 flex-wrap items-center gap-x-4 gap-y-1 border-b border-line py-[7px] max-sm:flex-col max-sm:items-start max-sm:py-2",
        className,
      )}
    >
      <dt className="w-[160px] shrink-0 text-[12px] leading-4 text-dim max-sm:w-full">{label}</dt>
      <dd className="m-0 flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-1 text-[13px] leading-[18px] text-text-2 max-sm:w-full sm:flex-nowrap">
        {children}
      </dd>
      {note ? <dd className="m-0 shrink-0 text-right text-[12px] leading-4 text-dim max-sm:text-left">{note}</dd> : null}
    </div>
  );
}

/** "214 of 1,900": the used part in ink, the rest in text-2 (A12's meter rows). */
export function Amount({ used, of }: { used: ReactNode; of?: ReactNode }) {
  return (
    <span className="whitespace-nowrap tabular-nums">
      <span className="font-medium text-ink">{used}</span>
      {of ? <> {of}</> : null}
    </span>
  );
}

/** A state as A/Prior prints a verdict: the mark, then the word in small caps, in the tag's tone. */
export function StateTag({ tag, state }: { tag: Tag; state: string }) {
  return (
    <span className={cx("inline-flex items-center justify-end gap-1.5 sm:w-[120px]", tag.tone)} data-state={state}>
      <span aria-hidden="true" className={cx("text-[14px] leading-none", tag.mark === "·" ? "font-normal" : "font-semibold")}>
        {tag.mark}
      </span>
      <span className="text-[11px] leading-none font-semibold tracking-[1.3px] uppercase">{tag.word}</span>
    </span>
  );
}

/** A breaker's state: ✓ CLEAR, – PAST 80%, – WARNING, – ECONOMY, × TRIPPED. */
export function LevelTag({ level }: { level: StatusLevel }) {
  return <StateTag tag={LEVEL_TAG[level]} state={level} />;
}

/** A label's note number, as A12 marks "Briefs this month¹". */
export function NoteMark({ n }: { n: number }) {
  return (
    <sup aria-hidden="true" className="ml-px text-[9px] font-semibold text-accent">
      {n}
    </sup>
  );
}

/** A/Sidenote without a ledger behind it: the number, the note and an optional mono trace. */
export function StatusNote({ n, children, trace }: { n: number; children: ReactNode; trace?: ReactNode }) {
  return (
    <div className="flex gap-2" data-status-note={n}>
      <span className="min-w-3 shrink-0 text-[11px] leading-[17px] font-semibold text-accent tabular-nums">{n}</span>
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className="m-0 type-sidenote text-dim">{children}</p>
        {trace ? <p className="m-0 type-trace text-dim">{trace}</p> : null}
      </div>
    </div>
  );
}
