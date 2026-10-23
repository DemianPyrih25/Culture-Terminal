import type { ReactNode } from "react";
import { cx } from "./cx";

export interface KeycapProps {
  /** The key as printed, e.g. "⌘K", "/", "↵", "Esc". */
  children: ReactNode;
  className?: string;
}

/** A/Keycap: an 18 px key hint in mono, hairline border, 2 px radius. */
export function Keycap({ children, className }: KeycapProps) {
  return (
    <kbd
      className={cx(
        "inline-flex h-[18px] shrink-0 items-center justify-center rounded-brief border border-line-strong bg-paper px-[5px] font-mono text-[10px] leading-none font-medium text-dim",
        className,
      )}
    >
      {children}
    </kbd>
  );
}
