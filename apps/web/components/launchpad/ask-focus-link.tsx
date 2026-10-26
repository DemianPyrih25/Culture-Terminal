"use client";

import type { MouseEvent, ReactNode } from "react";

export interface AskFocusLinkProps {
  /** The id of the section that holds the question field. */
  target: string;
  className?: string;
  children: ReactNode;
}

/**
 * A link to the question field that puts the caret in it: a plain #anchor jump without JavaScript, and
 * with it the field is scrolled into view and focused, ready to type.
 */
export function AskFocusLink({ target, className, children }: AskFocusLinkProps) {
  function focusField(event: MouseEvent<HTMLAnchorElement>) {
    const field = document.getElementById(target)?.querySelector("textarea");
    if (!field) return;
    event.preventDefault();
    field.scrollIntoView({ block: "center", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    field.focus({ preventScroll: true });
  }
  return (
    <a href={`#${target}`} onClick={focusField} className={className}>
      {children}
    </a>
  );
}
