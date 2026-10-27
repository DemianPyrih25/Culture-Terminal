"use client";

import { Fragment, type ReactNode } from "react";
import type { Inline } from "../../lib/brief";
import { useHowWeKnow } from "../drawer";

/**
 * Report prose on the answer page: text as text, never markup. A metric is a quiet button (a dotted
 * underline on hover or focus) that opens How we know on its footnote; a bare citation is for screen
 * readers only; an unmeasured value reads as its words, never 0.
 */
export function AnswerProse({ inlines }: { inlines: readonly Inline[] | null }) {
  const how = useHowWeKnow();
  if (!inlines) return null;
  const out: ReactNode[] = [];
  inlines.forEach((piece, i) => {
    switch (piece.kind) {
      case "text":
        out.push(<Fragment key={i}>{piece.text}</Fragment>);
        return;
      case "window":
        out.push(
          <span key={i} data-window="true">
            {piece.text}
          </span>,
        );
        return;
      case "missing":
        out.push(
          <span key={i} data-missing={piece.id}>
            {piece.text}
          </span>,
        );
        return;
      case "cite":
        out.push(
          <span key={i} className="sr-only">
            {` (source ${piece.footnote})`}
          </span>,
        );
        return;
      case "metric": {
        const { metric, footnote } = piece;
        const text = metric.unavailable ? "No data" : metric.text;
        if (!how.available) {
          out.push(
            <span key={i} data-metric={metric.id} className="tabular-nums">
              {text}
            </span>,
          );
          return;
        }
        out.push(
          <button
            key={i}
            type="button"
            data-metric={metric.id}
            onClick={() => how.open({ tab: "numbers", footnote })}
            aria-label={`${text}: how we know this number`}
            className="inline cursor-pointer rounded-sm p-0 text-left tabular-nums decoration-dotted underline-offset-4 hover:underline focus-visible:underline"
          >
            {text}
          </button>,
        );
        return;
      }
    }
  });
  return out;
}
