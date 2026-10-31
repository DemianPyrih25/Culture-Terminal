"use client";

import { useRef, type KeyboardEvent } from "react";
import { cx } from "./cx";

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

export interface SegmentedProps<T extends string> {
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** The group's accessible name ("View", "Speed", "How we know"). */
  label: string;
  /**
   * radiogroup: a view switch ("Chart | Table", "1× | 4×"). tablist: tabs over panels (the drawer); each
   * tab controls the element with id `segmentedPanelId(idPrefix, value)`.
   */
  kind?: "radiogroup" | "tablist";
  /** Needed for a tablist: the prefix of tab and panel ids. */
  idPrefix?: string;
  /** fit: each segment as wide as its label (32 tall). full: segments share the width (36 tall). */
  width?: "fit" | "full";
  className?: string;
}

/** The id of a tab. */
export function segmentedTabId(idPrefix: string, value: string): string {
  return `${idPrefix}-tab-${value}`;
}

/** The id of the panel a tab controls. */
export function segmentedPanelId(idPrefix: string, value: string): string {
  return `${idPrefix}-panel-${value}`;
}

/** The index a key moves to, or null when the key is not a move. Arrows wrap; Home and End jump. */
export function segmentedKeyMove(key: string, index: number, count: number): number | null {
  if (count === 0) return null;
  if (key === "ArrowRight" || key === "ArrowDown") return (index + 1) % count;
  if (key === "ArrowLeft" || key === "ArrowUp") return (index - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}

/**
 * C/Segmented: a sunken track (padding 2, r4) with the active segment on surface (r3, a hairline, 13/600
 * ink); the others 13/500 ink-2. One tab stop; arrow keys move the choice.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  kind = "radiogroup",
  idPrefix,
  width = "fit",
  className,
}: SegmentedProps<T>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const selected = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );
  const tabs = kind === "tablist";

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const next = segmentedKeyMove(event.key, selected, options.length);
    if (next === null) return;
    event.preventDefault();
    const option = options[next];
    if (!option) return;
    onChange(option.value);
    refs.current[next]?.focus();
  }

  return (
    <div
      role={kind}
      aria-label={label}
      onKeyDown={onKeyDown}
      className={cx(
        "rounded-sm bg-sunken p-[2px]",
        width === "full" ? "flex h-9 w-full" : "inline-flex h-8",
        className,
      )}
    >
      {options.map((option, index) => {
        const on = index === selected;
        return (
          <button
            key={option.value}
            ref={(el) => {
              refs.current[index] = el;
            }}
            type="button"
            role={tabs ? "tab" : "radio"}
            id={tabs && idPrefix ? segmentedTabId(idPrefix, option.value) : undefined}
            aria-controls={tabs && idPrefix ? segmentedPanelId(idPrefix, option.value) : undefined}
            aria-selected={tabs ? on : undefined}
            aria-checked={tabs ? undefined : on}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(option.value)}
            className={cx(
              "flex items-center justify-center rounded-[3px] px-3 text-[13px] leading-[18px] whitespace-nowrap transition-colors focus-visible:outline-offset-0",
              width === "full" && "min-w-0 flex-1",
              on
                ? "bg-surface font-semibold text-ink shadow-[0_0_0_1px_var(--color-line),var(--shadow-xs)]"
                : "font-medium text-ink-2 hover:text-ink",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
