"use client";

import { useId, useRef, type KeyboardEvent } from "react";
import { cx } from "./cx";

export interface SortOption<T extends string> {
  value: T;
  label: string;
}

export interface SortToggleProps<T extends string> {
  options: readonly SortOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** The word before the options (default "Sort"); also the group's accessible name. */
  label?: string;
  className?: string;
}

/**
 * A/Sort toggle: "Sort [Date | Conviction]". A radio group: one tab stop, arrow keys move the choice,
 * the selected option sits on accent-soft.
 */
export function SortToggle<T extends string>({ options, value, onChange, label = "Sort", className }: SortToggleProps<T>) {
  const labelId = useId();
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const selected = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const step =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    let next = selected;
    if (step !== 0) next = (selected + step + options.length) % options.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = options.length - 1;
    else return;
    event.preventDefault();
    const option = options[next];
    if (!option) return;
    onChange(option.value);
    refs.current[next]?.focus();
  }

  return (
    <div className={cx("inline-flex items-center gap-[10px]", className)}>
      <span id={labelId} className="text-[12px] text-dim">
        {label}
      </span>
      <div
        role="radiogroup"
        aria-labelledby={labelId}
        onKeyDown={onKeyDown}
        className="inline-flex overflow-hidden rounded-brief border border-line-strong"
      >
        {options.map((option, index) => {
          const checked = index === selected;
          return (
            <button
              key={option.value}
              ref={(el) => {
                refs.current[index] = el;
              }}
              type="button"
              role="radio"
              aria-checked={checked}
              tabIndex={checked ? 0 : -1}
              onClick={() => onChange(option.value)}
              className={cx(
                "flex h-[25px] items-center px-[10px] text-[12px] transition-colors focus-visible:-outline-offset-2",
                index > 0 && "border-l border-line-strong",
                checked ? "bg-accent-soft font-medium text-accent" : "text-dim hover:bg-canvas hover:text-ink",
              )}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
