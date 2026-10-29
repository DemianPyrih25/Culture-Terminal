import type { ReactNode } from "react";
import { Card } from "./card";
import { cx } from "./cx";
import { Icon } from "./icons";
import { Monogram, type MonogramPalette } from "./monogram";
import { Tag } from "./tag";

/** One side of a split key number ("Cities where it ranks first": A 4, B 0). */
export interface KeyNumberSide {
  name: string;
  value: string;
  /** subject: accent bar, accent-ink value. second: orange bar, second-ink value. */
  tone: "subject" | "second";
}

interface KeyNumberBase {
  /** "Closest audience" (15/600). On the split variant it sits on top. */
  label: string;
  /** A Tag after the label (e.g. Hidden gem). */
  tag?: ReactNode;
  /** The context line, 13/500 ink-2: "Pinecone Soap Co. · 1.00 = identical". */
  context?: ReactNode;
  /** While the run is live: the Draft tag replaces Source and nothing opens. */
  draft?: boolean;
  /** A 2 px accent stroke while the drawer shows this number. */
  selected?: boolean;
  /** Opens the drawer on this number's footnote. Without it (and not draft) no Source shows. */
  onSource?: () => void;
  className?: string;
}

export type KeyNumberProps = KeyNumberBase &
  (
    | { variant?: "number" | "word"; value: string }
    | { variant: "name"; value: string; palette?: MonogramPalette }
    | { variant: "split"; sides: readonly [KeyNumberSide, KeyNumberSide] }
  );

function SourceButton({ label, onSource, compact }: { label: string; onSource: () => void; compact?: boolean }) {
  return (
    <button
      type="button"
      onClick={onSource}
      aria-label={`Source of ${label}`}
      className={cx(
        "inline-flex items-center gap-1.5 rounded-sm text-[13px] leading-[18px] font-medium text-ink-2 transition-colors hover:text-accent",
        compact ? "size-11 justify-center md:hidden" : "max-md:hidden",
      )}
    >
      <Icon name="receipt" size={compact ? 16 : 14} />
      {compact ? null : <span>Source</span>}
    </button>
  );
}

function Split({ sides }: { sides: readonly [KeyNumberSide, KeyNumberSide] }) {
  return (
    <div className="flex gap-8">
      {sides.map((side, i) => (
        <div key={i} className="flex items-stretch gap-3">
          <span
            aria-hidden="true"
            className={cx("w-1 shrink-0 rounded-[2px]", side.tone === "subject" ? "bg-accent" : "bg-second")}
          />
          <div className="flex flex-col justify-end">
            <span className="type-label text-ink-2">{side.name}</span>
            <span
              className={cx(
                "type-number-l max-md:type-number-l-sm",
                side.tone === "subject" ? "text-accent-ink" : "text-second-ink",
              )}
            >
              {side.value}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * C/KeyNumber: 148 tall, padding 20, gap 8. The main column stacks from the top: a 44 px value slot (number,
 * word, name with a monogram, or a split of two sides), then 8 below it the label and the context, so a
 * wrapped context grows downward and labels line up across a row. "Source" sits bottom right in its own
 * column and opens the drawer. On phones Source is an icon-only receipt at the top right.
 */
export function KeyNumber(props: KeyNumberProps) {
  const { label, tag, context, draft, selected, onSource, className } = props;
  const variant = props.variant ?? "number";
  const source = draft ? (
    <Tag preset="draft" />
  ) : onSource ? (
    <SourceButton label={label} onSource={onSource} />
  ) : null;

  let value: ReactNode = null;
  if (props.variant === "split") value = <Split sides={props.sides} />;
  else if (props.variant === "name") {
    value = (
      <span className="flex min-w-0 items-center gap-3">
        <Monogram name={props.value} size={32} palette={props.palette} />
        <span className="min-w-0 type-name-value text-ink [overflow-wrap:anywhere] max-md:type-name-value-sm">{props.value}</span>
      </span>
    );
  } else if (variant === "word") {
    value = <span className="pb-1 type-name-value text-ink max-md:type-name-value-sm">{props.value}</span>;
  } else {
    value = <span className="type-number-l text-ink max-md:type-number-l-sm">{props.value}</span>;
  }

  const labelLine = (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className="text-[15px] leading-6 font-semibold text-ink">{label}</span>
      {tag}
    </p>
  );

  return (
    <Card
      as="div"
      role="group"
      aria-label={label}
      padding="none"
      selected={selected}
      data-variant={variant}
      data-draft={draft ? "true" : undefined}
      className={cx("relative flex gap-2 px-5 py-5 max-md:py-4 md:min-h-[148px]", className)}
    >
      <div className={cx("flex min-w-0 flex-1 flex-col", variant === "split" ? "gap-3" : "gap-2")}>
        {variant === "split" ? labelLine : null}
        <div className="flex min-h-8 min-w-0 items-end md:min-h-11">{value}</div>
        {variant === "split" ? null : (
          <div className="flex min-w-0 flex-col gap-0.5">
            {labelLine}
            {context ? <p className="type-label text-ink-2">{context}</p> : null}
          </div>
        )}
      </div>
      {source ? <div className="flex shrink-0 flex-col items-end justify-end max-md:hidden">{source}</div> : null}
      {!draft && onSource ? (
        <div className="absolute top-1 right-1 md:hidden">
          <SourceButton label={label} onSource={onSource} compact />
        </div>
      ) : null}
      {draft ? <div className="absolute top-4 right-5 md:hidden">{source}</div> : null}
    </Card>
  );
}
