import type { ReactNode } from "react";
import { cx } from "../ui/cx";
import { Hatch } from "../ui/skeleton";
import { TAG_PRESETS, Tag } from "../ui/tag";
import { NO_DATA } from "./format";
import type { PlotTag } from "./types";

/** A plot's tag: a preset or free words with a tone. */
export function PlotTagView({ tag, className }: { tag: PlotTag | null | undefined; className?: string }) {
  if (!tag) return null;
  if (typeof tag === "string") return <Tag preset={tag} className={className} />;
  return (
    <Tag tone={tag.tone} className={className}>
      {tag.label}
    </Tag>
  );
}

/** The words of a tag, for tables and accessible names. */
export function tagText(tag: PlotTag | null | undefined): string {
  if (!tag) return "";
  if (typeof tag === "string") return TAG_PRESETS[tag].label;
  return tag.label;
}

/** An empty plot: the hatch with its pill ("No data"), never an empty box or a zero. */
export function PlotEmpty({ label = NO_DATA, className }: { label?: string; className?: string }) {
  return <Hatch label={label} className={cx("h-32", className)} />;
}

/** The plot box every SVG-free plot shares: role=img named after the chart, so the rows read once, in the table. */
export function PlotFigure({
  label,
  children,
  className,
  plot,
}: {
  label: string;
  children: ReactNode;
  className?: string;
  /** A data attribute naming the primitive, for tests and the gallery. */
  plot: string;
}) {
  return (
    <div role="img" aria-label={label} data-plot={plot} className={cx("min-w-0", className)}>
      {children}
    </div>
  );
}

/** A small "No data" mark inside a row, in ink-2 (never ink-3: it carries meaning). */
export function NoDataMark({ className }: { className?: string }) {
  return (
    <span data-missing="true" className={cx("relative inline-flex items-center bg-surface px-1.5 type-label whitespace-nowrap text-ink-2", className)}>
      {NO_DATA}
    </span>
  );
}
