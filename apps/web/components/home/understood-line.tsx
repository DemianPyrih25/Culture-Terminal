import type { PreviewResponse } from "../ask/ask-machine";
import { cx } from "../ui/cx";
import { Icon } from "../ui/icons";

type Understood = NonNullable<PreviewResponse["understood"]>;

/** What the line says: the desk, the names as matched, the cities, and any name read as another. */
export interface UnderstoodParts {
  desk: string;
  names: string[];
  metros: string[];
  /** A typed name read as a different catalogue name ("NWC" as "Northwind Coffee"). */
  swaps: { typed: string; read: string }[];
}

/** The parts of the preview's reading worth showing; names that were not found are left out. */
export function understoodParts(understood: Understood): UnderstoodParts {
  const found = understood.mentions.filter((m) => m.match !== "not_found");
  const names = [...new Set(found.map((m) => m.name ?? m.text))];
  const swaps = found
    .filter((m) => m.name !== null && m.name.trim().toLowerCase() !== m.text.trim().toLowerCase())
    .map((m) => ({ typed: m.text, read: m.name ?? "" }));
  return { desk: understood.jobLabel, names, metros: [...understood.metros], swaps };
}

/**
 * The "Understood as" line under the box once the question is read: the desk, the names it matched and
 * the cities, so the visitor sees how the question was taken while the answer starts. One quiet line,
 * plus one more when a typed name was read as another.
 */
export function UnderstoodLine({ understood, className }: { understood: Understood; className?: string }) {
  const parts = understoodParts(understood);
  const bits = [parts.desk, parts.names.join(", "), parts.metros.join(", ")].filter((bit) => bit !== "");
  return (
    <div data-understood="" className={cx("flex flex-col gap-1.5 border-l-2 border-accent py-1 pl-3", className)}>
      <p className="m-0 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-[11px] leading-4 font-semibold tracking-[0.08em] text-ink-3 uppercase">Understood as</span>
        <span className="type-body text-ink">{bits.join(" · ")}</span>
      </p>
      {parts.swaps.map((swap) => (
        <p key={`${swap.typed}|${swap.read}`} className="m-0 flex items-center gap-1.5 type-caption text-ink-2">
          <Icon name="corner-down-right" size={13} className="shrink-0 text-accent" />
          Read “{swap.typed}” as “{swap.read}”.
        </p>
      ))}
    </div>
  );
}
