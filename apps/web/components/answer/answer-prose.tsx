"use client";

import { Fragment, type ReactNode } from "react";
import { isKnownAbsence, type Inline } from "../../lib/brief";
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
  // Punctuation that touches a metric ("(" before it, ")" or "," after it) stays on the metric's line: a
  // number button never wraps inside, so without this a lone "(" ends one line on a phone.
  const glued = gluedPunctuation(inlines);
  inlines.forEach((piece, i) => {
    switch (piece.kind) {
      case "text": {
        const { lead, tail } = glued.get(i) ?? { lead: 0, tail: 0 };
        const body = piece.text.slice(lead, piece.text.length - tail);
        if (body !== "") out.push(<Fragment key={i}>{body}</Fragment>);
        return;
      }
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
        // A public value's known absence prints its reason ("not reported in filings"); any other gap reads "No data".
        const text = metric.unavailable ? (isKnownAbsence(metric.reason) ? metric.text : "No data") : metric.text;
        const before = glued.get(i - 1);
        const after = glued.get(i + 1);
        const open = before && before.tail > 0 ? (inlines[i - 1] as { text: string }).text.slice(-before.tail) : "";
        const close = after && after.lead > 0 ? (inlines[i + 1] as { text: string }).text.slice(0, after.lead) : "";
        const wrap = (node: ReactNode) =>
          open || close ? (
            <span key={i} className="whitespace-nowrap">
              {open}
              {node}
              {close}
            </span>
          ) : (
            node
          );
        if (!how.available) {
          out.push(
            wrap(
              <span key={i} data-metric={metric.id} className="tabular-nums">
                {text}
              </span>,
            ),
          );
          return;
        }
        out.push(
          wrap(
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
          ),
        );
        return;
      }
    }
  });
  return out;
}

const OPENING = /[(\[\u201c"\u2018]+$/;
const CLOSING = /^[)\]\u201d"\u2019,.;:!?]+/;

/** For each text piece next to a metric: how many characters at its start (lead) and end (tail) glue to it. */
function gluedPunctuation(inlines: readonly Inline[]): Map<number, { lead: number; tail: number }> {
  const out = new Map<number, { lead: number; tail: number }>();
  inlines.forEach((piece, i) => {
    if (piece.kind !== "text") return;
    const tail = inlines[i + 1]?.kind === "metric" ? (OPENING.exec(piece.text)?.[0].length ?? 0) : 0;
    const lead = inlines[i - 1]?.kind === "metric" ? (CLOSING.exec(piece.text)?.[0].length ?? 0) : 0;
    // A text piece shorter than its glue on both sides (")(") keeps its characters once.
    if (lead + tail > piece.text.length) out.set(i, { lead, tail: Math.max(0, piece.text.length - lead) });
    else if (lead > 0 || tail > 0) out.set(i, { lead, tail });
  });
  return out;
}
