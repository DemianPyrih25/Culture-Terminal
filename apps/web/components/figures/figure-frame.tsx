import type { ReactNode } from "react";
import { ROUTE_LIVE } from "@/lib/routes";
import { cardClassName } from "../ui/card";
import { cx } from "../ui/cx";
import { FigureViews } from "./figure-views";
import { abbreviateRequestId } from "./format";

/**
 * The frame every figure family draws in: the Ledger chart card (design/redesign-v3.pen). The kind line
 * (11/600 small caps ink-3) and the serif title (20/600) on the left; Draft, the "Chart | Table" switch and Source on the
 * right; then the legend, the plot (or its table), the captions, and a quiet footer with the source line
 * and the link to how the number is calculated. `chrome="plain"` drops the card for figures shown inside
 * another surface (the chart sheet).
 */

/** Where a figure's numbers came from, as its footer prints it. */
export interface FigureSource {
  /** The source line, e.g. "Source: Qloo /v2/insights · 8 requests · computed in code". */
  text: string;
  /** The request behind the figure, shown shortened ("req 0001…f001"); null for code-only figures. */
  requestId: string | null;
  /** Where the request id links to. */
  href?: string | null;
  /** Printed right after the text. */
  after?: ReactNode;
}

/** What every figure takes besides its data. */
export interface FigureMeta {
  /** The fixed kind line over the title ("Closest audiences"); omitted: none. */
  kind?: string | null;
  /** The title: the finding, not the chart type. */
  title: ReactNode;
  /** Plain-text name for the plot's accessible title; defaults to the title when it is a string. */
  label?: string;
  /** A caption under the plot (12 ink-2). */
  caption?: ReactNode;
  source?: FigureSource | null;
  /** A FORMULAS id for the "How it's calculated" link to /method#<id>; null hides the link. */
  formulaId?: string | null;
  /** Opens the How we know drawer on this figure: the Source button. Client parents only. */
  onSource?: () => void;
  /** A live run's figure: the Draft tag, Source disabled. */
  draft?: boolean;
  headingLevel?: 2 | 3 | 4;
  /** DOM id of the figure, for links to it. */
  id?: string;
  /** DOM id of the title heading, e.g. for a dialog that the title names (aria-labelledby). */
  titleId?: string;
  className?: string;
  /** card (default): a ChartCard. plain: no card, for a figure inside another surface. */
  chrome?: "card" | "plain";
}

/** The method page anchor for a formula id. */
export function methodHref(formulaId: string): string {
  return `/method#${encodeURIComponent(formulaId)}`;
}

/** The plain-text accessible name of a figure. */
export function figureLabel(meta: Pick<FigureMeta, "label" | "title" | "kind">): string {
  if (meta.label) return meta.label;
  if (typeof meta.title === "string") return meta.title;
  return meta.kind ?? "Chart";
}

export function FigureFrame({
  meta,
  legend,
  plot,
  table,
  fixedCaption,
  htmlPlot = false,
}: {
  meta: FigureMeta;
  legend?: ReactNode;
  plot: ReactNode;
  /** The Table view; null hides the switch. */
  table: ReactNode | null;
  /** The payload's fixed, code-written caption, printed under the plot in both views. */
  fixedCaption?: string | null;
  /** The plot is already an accessible HTML table, so the table view stays out of the reading order until switched to. */
  htmlPlot?: boolean;
}) {
  const Heading = `h${meta.headingLevel ?? 3}` as "h2" | "h3" | "h4";
  const label = figureLabel(meta);
  const plain = meta.chrome === "plain";
  const heading = (
    <div className="flex min-w-0 flex-col gap-1.5">
      {meta.kind ? <p className="m-0 type-overline text-ink-3">{meta.kind}</p> : null}
      <Heading id={meta.titleId} className="m-0 type-title text-ink max-md:type-title-sm">
        {meta.title}
      </Heading>
    </div>
  );
  const captions = [fixedCaption?.trim() ? fixedCaption.trim() : null, meta.caption ?? null].filter((c) => c !== null && c !== "");
  return (
    <figure
      id={meta.id}
      data-figure="true"
      className={cx("m-0 flex h-full min-w-0 flex-col gap-4", plain ? null : cardClassName("default"), meta.className)}
    >
      <FigureViews
        heading={heading}
        legend={legend ?? null}
        plot={plot}
        table={table}
        label={label}
        htmlPlot={htmlPlot}
        draft={meta.draft === true}
        onSource={meta.onSource}
        captions={captions.map((c, i) => (
          <p key={i} className="m-0 type-caption text-ink-2" data-fixed-caption={i === 0 && fixedCaption?.trim() ? "true" : undefined}>
            {c}
          </p>
        ))}
        footer={<FigureFooter source={meta.source ?? null} formulaId={meta.formulaId ?? null} label={label} />}
      />
    </figure>
  );
}

/** The quiet footer: the source line with its short request id, and "How it's calculated". */
function FigureFooter({ source, formulaId, label }: { source: FigureSource | null; formulaId: string | null; label: string }) {
  const method = formulaId && ROUTE_LIVE.method ? methodHref(formulaId) : null;
  if (!source && !method) return null;
  const rid = source?.requestId ? `req ${abbreviateRequestId(source.requestId)}` : null;
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-t border-line pt-3 type-caption text-ink-3">
      {source ? (
        <span>
          {source.text}
          {source.after}
        </span>
      ) : null}
      {rid ? (
        source?.href ? (
          <a href={source.href} title={`Request ${source.requestId}`} className="font-mono underline-offset-2 hover:text-accent hover:underline">
            {rid}
          </a>
        ) : (
          <span className="font-mono" title={`Request ${source?.requestId}`}>
            {rid}
          </span>
        )
      ) : null}
      {method ? (
        <a href={method} aria-label={`How it's calculated: ${label}`} className="ml-auto text-accent hover:text-accent-hover hover:underline">
          How it&apos;s calculated
        </a>
      ) : null}
    </div>
  );
}

/** A legend entry: an 8 px square swatch (bars, points) or a hatch swatch (no data) and its label. */
export interface LegendItem {
  label: string;
  swatch: "data" | "data-2" | "accent-soft" | "hatch" | "second";
}

const SWATCH: Readonly<Record<LegendItem["swatch"], string>> = {
  data: "bg-accent",
  "data-2": "bg-chart-muted",
  "accent-soft": "bg-accent-soft ring-1 ring-line-strong ring-inset",
  second: "bg-second",
  hatch: "bg-hatch ring-1 ring-line-strong ring-inset",
};

/** The calm legend row: 8 px squares and caption ink-2 labels, gap 20. */
export function Legend({ items }: { items: readonly LegendItem[] }) {
  return (
    <ul className="m-0 flex list-none flex-wrap items-center gap-x-5 gap-y-1 p-0">
      {items.map((item) => (
        <li key={item.label} className="flex items-center gap-1.5 type-caption text-ink-2">
          <span aria-hidden="true" className={cx("inline-block size-2 shrink-0 rounded-[2px]", SWATCH[item.swatch])} />
          {item.label}
        </li>
      ))}
    </ul>
  );
}
