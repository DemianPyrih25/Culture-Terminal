import type { ReactNode } from "react";
import { abbreviateRequestId } from "./format";
import { ROUTE_LIVE } from "@/lib/routes";
import { FigureViews } from "./figure-views";

/**
 * A/Figure frame (Concept A, D36): FIGURE n in the accent, the serif title (the finding), the
 * caption, an optional legend, the plot, then the source line with its short request id, the ⧉
 * table toggle and the ⓘ link to /method#<formula id>. Every family renders inside one.
 */

/** Where a figure's numbers came from, as its source line shows it. */
export interface FigureSource {
  /** The source line, e.g. "Source: Qloo /v2/insights · 8 requests · computed in code". */
  text: string;
  /** The request behind the figure, shown shortened ("req 0001…f001"); null for code-only figures. */
  requestId: string | null;
  /** Where the request id links to, e.g. the request in the Sources section. */
  href?: string | null;
  /** Printed right after the text, e.g. a CODE FALLBACK superscript (A06 note 5). */
  after?: ReactNode;
}

/** What every figure takes besides its data. */
export interface FigureMeta {
  /** "FIGURE n"; null or omitted hides the label. */
  number?: number | null;
  /** The serif title: the finding, not the chart type. May carry footnote markers. */
  title: ReactNode;
  /** Plain-text name for the plot's accessible title; defaults to the title when it is a string. */
  label?: string;
  caption?: ReactNode;
  source?: FigureSource | null;
  /** A FORMULAS id for the ⓘ link to /method#<id>; null hides the link. */
  formulaId?: string | null;
  /** full: the 680 reading column (or a half of it). margin: the 300 sidenote column (A08 figure 3). */
  size?: "full" | "margin";
  /** Right side of the label row in the margin size, e.g. "INDEX VS US 1.00". */
  aside?: ReactNode;
  headingLevel?: 2 | 3 | 4;
  /** DOM id of the figure, for links to it. */
  id?: string;
  className?: string;
}

/** The method page anchor for a formula id. */
export function methodHref(formulaId: string): string {
  return `/method#${encodeURIComponent(formulaId)}`;
}

/** The plain-text accessible name of a figure. */
export function figureLabel(meta: Pick<FigureMeta, "label" | "title" | "number">): string {
  if (meta.label) return meta.label;
  if (typeof meta.title === "string") return meta.title;
  return meta.number ? `Figure ${meta.number}` : "Figure";
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
  /** The ⧉ table view; null hides the toggle. */
  table: ReactNode | null;
  /**
   * The payload's fixed, code-written caption (e.g. SLATE's "taste fit only; no fee, availability or
   * ROI data"), printed under the plot in both views; null or empty prints nothing.
   */
  fixedCaption?: string | null;
  /** The plot is already an accessible HTML table, so the table view stays out of the reading order until toggled. */
  htmlPlot?: boolean;
}) {
  const margin = meta.size === "margin";
  const Heading = `h${meta.headingLevel ?? 3}` as "h2" | "h3" | "h4";
  const number = meta.number ? `FIGURE ${meta.number}` : null;
  return (
    <figure
      id={meta.id}
      className={`m-0 flex h-full min-w-0 flex-col border-t border-ink ${margin ? "pt-2.5" : "pt-3"} ${meta.className ?? ""}`}
    >
      <figcaption className={`flex flex-col ${margin ? "gap-0.5" : "gap-1"}`}>
        {margin ? (
          <span className="flex items-center justify-between gap-3">
            {number ? (
              <span className="font-ui text-[10.5px] font-semibold tracking-[1.3px] text-accent">{number}</span>
            ) : null}
            {meta.aside ? (
              <span className="font-ui text-[10px] font-medium tracking-[0.8px] text-dim uppercase">{meta.aside}</span>
            ) : null}
          </span>
        ) : number ? (
          <span className="type-label text-accent">{number}</span>
        ) : null}
        <Heading
          className={
            margin
              ? "m-0 font-serif text-[14px] leading-[19px] font-semibold text-ink"
              : "type-figure-title m-0 text-ink"
          }
        >
          {meta.title}
        </Heading>
        {meta.caption ? (
          <span className={`font-ui text-dim ${margin ? "text-[11.5px] leading-[16px]" : "text-[13px] leading-[19px]"}`}>
            {meta.caption}
          </span>
        ) : null}
      </figcaption>
      {legend ? <div className={margin ? "pt-1.5" : "pt-3"}>{legend}</div> : null}
      <div className={`flex flex-1 flex-col ${margin ? "pt-1.5" : "pt-1"}`}>
        <FigureViews
          plot={plot}
          table={table}
          label={figureLabel(meta)}
          note={fixedCaption?.trim() ? fixedCaption.trim() : null}
          htmlPlot={htmlPlot}
          source={<SourceLine source={meta.source ?? null} />}
          methodHref={meta.formulaId && ROUTE_LIVE.method ? methodHref(meta.formulaId) : null}
          compact={margin}
        />
      </div>
    </figure>
  );
}

function SourceLine({ source }: { source: FigureSource | null }) {
  if (!source) return null;
  const rid = source.requestId ? `req ${abbreviateRequestId(source.requestId)}` : null;
  return (
    <span className="flex min-w-0 flex-wrap items-baseline gap-x-2.5">
      <span className="font-ui text-[11px] text-dim">
        {source.text}
        {source.after}
      </span>
      {rid ? (
        source.href ? (
          <a
            href={source.href}
            title={`Request ${source.requestId}`}
            className="type-trace text-dim underline-offset-2 hover:text-accent hover:underline"
          >
            {rid}
          </a>
        ) : (
          <span className="type-trace text-dim" title={`Request ${source.requestId}`}>
            {rid}
          </span>
        )
      ) : null}
    </span>
  );
}

/** A legend entry: a swatch (square for bars and cells, dot for points) and its label. */
export interface LegendItem {
  label: string;
  swatch: "data" | "data-2" | "accent-soft" | "hatch";
  shape?: "square" | "dot";
}

/** The A/Figure frame legend row: swatches with labels, 18 px apart. */
export function Legend({ items }: { items: readonly LegendItem[] }) {
  return (
    <ul className="m-0 flex list-none flex-wrap items-center gap-x-[18px] gap-y-1 p-0">
      {items.map((item) => (
        <li key={item.label} className="flex items-center gap-1.5 font-ui text-[12px] text-text-2">
          <Swatch swatch={item.swatch} shape={item.shape ?? "square"} />
          {item.label}
        </li>
      ))}
    </ul>
  );
}

function Swatch({ swatch, shape }: { swatch: LegendItem["swatch"]; shape: "square" | "dot" }) {
  if (swatch === "hatch") {
    return (
      <svg viewBox="0 0 14 10" width="14" height="10" aria-hidden="true">
        <rect x="0.5" y="0.5" width="13" height="9" className="fill-paper stroke-line-strong" />
        <path d="M0 10L10 0M5 10L14 1M-5 10L5 0M10 10L14 6" className="stroke-faint" strokeWidth="1" />
      </svg>
    );
  }
  const fill =
    swatch === "data" ? "fill-data" : swatch === "data-2" ? "fill-data-2" : "fill-accent-soft stroke-line-strong";
  return (
    <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
      {shape === "dot" ? <circle cx="5" cy="5" r="4" className={fill} /> : <rect width="10" height="10" className={fill} />}
    </svg>
  );
}
