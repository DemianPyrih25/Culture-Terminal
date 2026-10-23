import { tokenizeProse } from "@ct/contracts";
import type { ReactNode } from "react";

/**
 * Report prose inside figures (D6): a {{M#}} token prints its metric's display text, an [E#]
 * citation becomes a superscript footnote, {{WINDOW}} the trending window. A metric the caller did
 * not bind prints "n/a", so no unbound number ever appears. Text is never parsed as HTML.
 */

export interface ProseBindings {
  /** Display text per metric id, e.g. { M3: { display: "0.64" } }. */
  metrics?: Readonly<Record<string, { display: string }>>;
  /** Footnote number per metric or evidence id. */
  footnotes?: Readonly<Record<string, number>>;
  /** The trending window as printed, e.g. "Apr–Sep 2025". */
  window?: string;
}

/** Renders one piece of prose; the brief passes its own to make numbers open their requests. */
export type ProseRenderer = (text: string) => ReactNode;

export function renderProse(text: string, bindings: ProseBindings = {}): ReactNode {
  return tokenizeProse(text).map((segment, i) => {
    switch (segment.kind) {
      case "text":
        return segment.text;
      case "window":
        return bindings.window ?? "the trending window";
      case "metric": {
        const note = bindings.footnotes?.[segment.id];
        return (
          <span key={i} data-metric={segment.id}>
            {bindings.metrics?.[segment.id]?.display ?? "n/a"}
            {note !== undefined ? <sup className="ml-px text-[0.7em] text-accent">{note}</sup> : null}
          </span>
        );
      }
      case "evidence": {
        const note = bindings.footnotes?.[segment.id];
        return note !== undefined ? (
          <sup key={i} data-evidence={segment.id} className="ml-px text-[0.7em] text-accent">
            {note}
          </sup>
        ) : null;
      }
    }
  });
}

/** The same prose as plain text for table cells and accessible names: footnotes as "[n]". */
export function plainProse(text: string, bindings: ProseBindings = {}): string {
  return tokenizeProse(text)
    .map((segment) => {
      switch (segment.kind) {
        case "text":
          return segment.text;
        case "window":
          return bindings.window ?? "the trending window";
        case "metric":
          return bindings.metrics?.[segment.id]?.display ?? "n/a";
        case "evidence": {
          const note = bindings.footnotes?.[segment.id];
          return note === undefined ? "" : `[${note}]`;
        }
      }
    })
    .join("")
    .replace(/\s+([.,;:])/g, "$1")
    .trim();
}
