import { Fragment, type ReactNode } from "react";
import type { Inline } from "../../lib/brief";
import { NoteMark, NoteRef, NoteSpan } from "./note-ref";

/**
 * Report prose as the brief prints it (D6): text as text, never markup; each number with its superscript,
 * the number and superscript together a button to its request; an UNAVAILABLE metric as "not measured",
 * never 0; {{WINDOW}} as the trending window. A superscript never starts a line: it stays glued to the
 * word before it.
 */

/** "rank 6 of 6" → ["rank 6 of ", "6"]: the last word is what a superscript holds on to. */
function splitLastWord(text: string): [string, string] {
  const at = text.search(/\S+\s*$/);
  return at <= 0 ? ["", text] : [text.slice(0, at), text.slice(at)];
}

function Glued({ word, children }: { word: string; children: ReactNode }) {
  return (
    <span className="whitespace-nowrap">
      {word}
      {children}
    </span>
  );
}

export function Prose({ inlines }: { inlines: readonly Inline[] | null }) {
  if (!inlines) return null;
  const out: ReactNode[] = [];
  inlines.forEach((piece, i) => {
    const next = inlines[i + 1];
    switch (piece.kind) {
      case "text": {
        if (next?.kind !== "cite") {
          out.push(<Fragment key={i}>{piece.text}</Fragment>);
          return;
        }
        // The citation after this text glues to its last word (and is not drawn again below).
        const [head, word] = splitLastWord(piece.text);
        out.push(
          <Fragment key={i}>
            {head}
            <Glued word={word}>
              <NoteRef n={next.footnote} />
            </Glued>
          </Fragment>,
        );
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
          <span key={i} data-missing={piece.id} className="text-dim">
            {piece.text}
          </span>,
        );
        return;
      case "cite":
        // Drawn with the text before it, unless nothing printable came before.
        if (inlines[i - 1]?.kind !== "text") out.push(<NoteRef key={i} n={piece.footnote} />);
        return;
      case "metric": {
        const { metric } = piece;
        const n = piece.footnote;
        const [head, word] = splitLastWord(metric.text);
        // The whole number opens its request, not only the small superscript after it.
        out.push(
          <span key={i} data-metric={metric.id} data-unavailable={metric.unavailable ? "true" : undefined} className={metric.unavailable ? "text-dim italic" : "tabular-nums"}>
            <NoteSpan n={n} label={`${metric.unavailable ? "Not measured" : metric.text}, note ${n}: open its source`}>
              {head}
              <Glued word={word}>
                <NoteMark n={n} />
              </Glued>
            </NoteSpan>
          </span>,
        );
        return;
      }
    }
  });
  return out;
}
