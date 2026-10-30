import type { ReactNode } from "react";
import { cx } from "../ui/cx";
import { Hatch } from "../ui/skeleton";
import { TAG_PRESETS, Tag } from "../ui/tag";
import { NO_DATA } from "./format";
import type { PlotTag, PlotTagOne } from "./types";

const isTagList = (tag: PlotTag): tag is readonly PlotTagOne[] => Array.isArray(tag);

/** Several tags, or none: an empty list is no tag. */
export function plotTags(...tags: (PlotTag | null | undefined)[]): PlotTag | null {
  const list = tags.flatMap((t) => (!t ? [] : isTagList(t) ? [...t] : [t]));
  return list.length === 0 ? null : list.length === 1 ? (list[0] as PlotTagOne) : list;
}

function OneTag({ tag, className }: { tag: PlotTagOne; className?: string }) {
  if (typeof tag === "string") return <Tag preset={tag} className={className} />;
  return (
    <Tag tone={tag.tone} className={className}>
      {tag.label}
    </Tag>
  );
}

/** A plot's tag: a preset or free words with a tone, or several of them in a wrapping row. */
export function PlotTagView({ tag, className }: { tag: PlotTag | null | undefined; className?: string }) {
  if (!tag) return null;
  if (!isTagList(tag)) return <OneTag tag={tag} className={className} />;
  if (tag.length === 0) return null;
  return (
    <span className={cx("inline-flex flex-wrap items-center gap-1", className)}>
      {tag.map((t, i) => (
        <OneTag key={i} tag={t} />
      ))}
    </span>
  );
}

const oneText = (tag: PlotTagOne) => (typeof tag === "string" ? TAG_PRESETS[tag].label : tag.label);

/** The words of a tag (several joined with " · "), for tables and accessible names. */
export function tagText(tag: PlotTag | null | undefined): string {
  if (!tag) return "";
  return isTagList(tag) ? tag.map(oneText).join(" · ") : oneText(tag);
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
