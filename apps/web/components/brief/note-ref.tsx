"use client";

import type { KeyboardEvent, ReactNode, Ref } from "react";
import type { BriefSource } from "../../lib/brief";
import { cx, Popover, type PopoverTriggerProps } from "../ui";
import { useBrief } from "./brief-context";
import { NoteInspector, SourceInspector } from "./request-inspector";

/**
 * Every number is a button (D36): a number in prose with its superscript, a citation's superscript, a
 * key figure, a figure's note or a sidenote number opens the request inspector anchored to it.
 */

const INSPECTOR_WIDTH = 380;

/** The superscript: a small accent number raised after the word it notes. */
const SUPERSCRIPT = "relative -top-[0.1em] ml-px align-super text-[0.62em] leading-none";
const MARK = "font-ui font-semibold text-accent";

/** Opens note `n`'s inspector from any trigger. A number with no footnote renders its content inert. */
export function NoteTrigger({
  n,
  children,
  className,
  label,
}: {
  n: number;
  /** The trigger's content; default the number itself. */
  children?: ReactNode;
  className?: string;
  /** Accessible name; default "Note n: open its source". */
  label?: string;
}) {
  const { footnotes } = useBrief();
  const note = footnotes.get(n);
  if (!note) return <span className={className}>{children ?? n}</span>;
  return (
    <Popover
      label={`Note ${n}: the request behind it`}
      width={INSPECTOR_WIDTH}
      trigger={(props: PopoverTriggerProps) => (
        <button {...props} data-footnote={n} aria-label={label ?? `Note ${n}: open its source`} className={className}>
          {children ?? n}
        </button>
      )}
    >
      {(close) => <NoteInspector note={note} close={close} />}
    </Popover>
  );
}

/**
 * A superscript on its own: an evidence citation in prose, a figure's note. Its invisible 24 px target
 * reaches past the small number without moving the line.
 */
export function NoteRef({ n }: { n: number }) {
  return (
    <sup className={SUPERSCRIPT}>
      <NoteTrigger
        n={n}
        className={cx("relative rounded-brief px-[1px] hover:underline hover:underline-offset-2 after:absolute after:-inset-[7px]", MARK)}
      />
    </sup>
  );
}

/** The superscript drawn inside a trigger that already holds its number. */
export function NoteMark({ n }: { n: number }) {
  return (
    <sup className={SUPERSCRIPT}>
      <span className={cx("px-[1px]", MARK)}>{n}</span>
    </sup>
  );
}

/**
 * A number in prose and its superscript, "0.70⁴", the whole of it opening note `n`. A span with the
 * button role rather than a <button>, which always lays out as one box: a number of several words ("last
 * in 4 of 5 rows") still wraps with the line. Enter and Space press it, as they would a button.
 */
export function NoteSpan({ n, label, children }: { n: number; label: string; children: ReactNode }) {
  const { footnotes } = useBrief();
  const note = footnotes.get(n);
  if (!note) return children;
  return (
    <Popover
      label={`Note ${n}: the request behind it`}
      width={INSPECTOR_WIDTH}
      trigger={(props: PopoverTriggerProps) => (
        <span
          // The popover only measures, focuses and hit-tests its trigger, so a span serves as well.
          ref={props.ref as Ref<HTMLSpanElement>}
          role="button"
          tabIndex={0}
          aria-haspopup={props["aria-haspopup"]}
          aria-expanded={props["aria-expanded"]}
          aria-controls={props["aria-controls"]}
          aria-label={label}
          data-footnote={n}
          onClick={props.onClick}
          onKeyDown={(event: KeyboardEvent<HTMLElement>) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              props.onClick();
              return;
            }
            props.onKeyDown(event);
          }}
          className="cursor-pointer rounded-brief decoration-1 underline-offset-[3px] hover:underline"
        >
          {children}
        </span>
      )}
    >
      {(close) => <NoteInspector note={note} close={close} />}
    </Popover>
  );
}

/** A Sources row's request id, opening that request's inspector. */
export function SourceTrigger({ source, children, className }: { source: BriefSource; children: ReactNode; className?: string }) {
  return (
    <Popover
      label={`Request ${source.n}`}
      width={INSPECTOR_WIDTH}
      placement="bottom-end"
      trigger={(props: PopoverTriggerProps) => (
        <button
          {...props}
          data-source-trigger={source.n}
          aria-label={`Request ${source.n}: inspect`}
          className={cx("rounded-brief hover:text-accent hover:underline hover:underline-offset-2", className)}
        >
          {children}
        </button>
      )}
    >
      {(close) => <SourceInspector source={source} close={close} />}
    </Popover>
  );
}
