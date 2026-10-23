"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { DatasetEnvelope } from "@ct/contracts";
import { figureLegend, figureNoteText, type BriefFigure } from "../../lib/brief";
import { Exhibit, FigurePending, type ExhibitDisplay, type FigureSource } from "../figures";
import { BriefRow, SCROLL_ANCHOR_CLASS } from "../layout";
import { cx } from "../ui";
import { useBrief } from "./brief-context";
import styles from "./brief.module.css";
import { Sidenotes } from "./margin";
import { NoteRef } from "./note-ref";
import { isCompactFigure } from "./plan";
import { Prose } from "./prose";

/**
 * FIGURE n blocks: each figure family drawn from its dataset with the brief's title, caption, codes
 * and comparison keys, its source line linked to the request in Sources, the ⧉ table and the ⓘ method
 * link. A dataset too large to stream inline is fetched from /api/runs/[id]/datasets/[did]; its codes
 * and sidenote are then worked out from the fetched data.
 */

const loads = new Map<string, Promise<DatasetEnvelope | null>>();

/**
 * One fetch per dataset URL for the page's lifetime once it succeeds: an envelope never changes once
 * stored. A failure (404 before the run's ledger is written, a 503, a bad body) is never kept, so the
 * next mount asks again.
 */
export function loadDataset(url: string, doFetch: typeof fetch = fetch): Promise<DatasetEnvelope | null> {
  const known = loads.get(url);
  if (known) return known;
  const load = doFetch(url)
    .then((res) => (res.ok ? res.json() : null))
    .then((json: unknown) => {
      const parsed = DatasetEnvelope.safeParse(json);
      return parsed.success ? parsed.data : null;
    })
    .catch(() => null)
    .then((data) => {
      if (data === null) loads.delete(url);
      return data;
    });
  loads.set(url, load);
  return load;
}

/**
 * The figures' datasets: streamed inline, fetched (undefined while loading or while the run is still
 * being written), or null when the fetch failed. `ready`: the run's datasets are stored (it has ended),
 * so a dataset not streamed inline can be fetched.
 */
function useDatasets(figures: readonly BriefFigure[], ready: boolean): (DatasetEnvelope | null | undefined)[] {
  const urls = figures
    .filter((f) => f.needsFetch)
    .map((f) => f.datasetUrl)
    .join(" ");
  const [fetched, setFetched] = useState<Readonly<Record<string, DatasetEnvelope | null>>>({});
  useEffect(() => {
    if (urls === "" || !ready) return;
    let current = true;
    for (const url of urls.split(" ")) {
      void loadDataset(url).then((data) => {
        if (current) setFetched((prev) => ({ ...prev, [url]: data }));
      });
    }
    return () => {
      current = false;
    };
  }, [urls, ready]);
  return figures.map((f) => f.dataset ?? (f.needsFetch ? fetched[f.datasetUrl] : null));
}

/** Display options the brief passes each family: matrix codes, the expected rivals in grey, the bars layout. */
export function figureDisplay(dataset: DatasetEnvelope, rivals: readonly string[], width: number): ExhibitDisplay {
  switch (dataset.kind) {
    case "Matrix": {
      const codes = Object.fromEntries(figureLegend(dataset).codes.map((c) => [c.key, c.code]));
      // The codes are spelled out in the figure's sidenote, beside it.
      return { Matrix: { codes, showKey: false, ...(dataset.payload.cols.length > 7 ? { width } : {}) } };
    }
    case "Ranked": {
      const keys = dataset.payload.groups.flatMap((g) => g.rows.filter((r) => r.ref !== null && rivals.includes(r.ref)).map((r) => r.key));
      return { Ranked: { width, ...(keys.length > 0 ? { comparisonKeys: keys } : {}) } };
    }
    case "Bars": {
      const two = dataset.payload.series.length === 2;
      return { Bars: { width, ...(two ? { display: dataset.payload.unit === "pct" ? "split" : "dumbbell" } : {}) } };
    }
    case "Quadrant":
      return { Quadrant: { width } };
    default:
      return {};
  }
}

const FULL_WIDTH = 680;
const HALF_WIDTH = 328;
/** Below this the plot scrolls sideways instead of shrinking its labels. */
const MIN_FULL_PLOT = 520;

/** What a figure without its data yet says: loading, waiting for the run to be stored, or failed. */
export function pendingNote(viz: string, dataset: null | undefined, ready: boolean): string {
  if (dataset === null) return `${viz} · its data could not be loaded`;
  return ready ? `${viz} · loading its data` : `${viz} · drawn once the run is stored`;
}

function FigureView({
  figure,
  dataset,
  rivals,
  compact,
  ready,
}: {
  figure: BriefFigure;
  dataset: DatasetEnvelope | null | undefined;
  rivals: readonly string[];
  compact: boolean;
  ready: boolean;
}) {
  const { sources, animate } = useBrief();
  const sourceN = figure.source.requestId ? sources.find((s) => s.requestId === figure.source.requestId)?.n ?? null : null;
  const source: FigureSource = {
    text: figure.source.text,
    requestId: figure.source.requestId,
    href: sourceN !== null ? `#source-${sourceN}` : null,
  };
  // The figure's own note closes its caption (A05), or its title while it has no caption yet.
  const captioned = figure.caption.length > 0;
  const note = <NoteRef n={figure.footnote} />;
  const meta = {
    number: figure.number,
    title: captioned ? (
      figure.title
    ) : (
      <>
        {figure.title}
        {note}
      </>
    ),
    label: figure.title,
    caption: captioned ? (
      <>
        <Prose inlines={figure.caption} />
        {note}
      </>
    ) : undefined,
    source,
    id: `figure-${figure.number}`,
    formulaId: figure.formulaIds[0] ?? null,
    // The frame fills its cell, so a pair's frames end level (see FigureRow).
    className: "flex-1",
  };
  const width = compact ? HALF_WIDTH : FULL_WIDTH;
  const style = { "--plot-min": `${compact ? 0 : MIN_FULL_PLOT}px` } as CSSProperties;
  return (
    <div className={cx("flex h-full min-w-0 flex-col", styles.figure, animate && styles.settle)} style={style} data-figure={figure.number} data-kind={figure.kind}>
      {dataset ? (
        <Exhibit {...meta} dataset={dataset} display={figureDisplay(dataset, rivals, width)} />
      ) : (
        <FigurePending {...meta} note={pendingNote(figure.viz, dataset, ready)} />
      )}
    </div>
  );
}

/**
 * One display row of figures (one, or two compact ones side by side) with their sidenotes. `ready`: the
 * run's datasets are stored, so one not streamed inline can be fetched.
 */
export function FigureRow({
  figures,
  notes,
  rivals,
  first,
  ready,
}: {
  figures: readonly BriefFigure[];
  notes: readonly number[];
  rivals: readonly string[];
  first: boolean;
  ready: boolean;
}) {
  const datasets = useDatasets(figures, ready);
  // A fetched dataset brings its codes: the figure's sidenote names them.
  const texts: Record<number, string> = {};
  figures.forEach((f, i) => {
    const data = datasets[i];
    if (!f.needsFetch || !data) return;
    const legend = figureLegend(data);
    if (legend.codes.length > 0) texts[f.footnote] = figureNoteText(legend, "");
  });
  // A lone compact matrix keeps its natural width, and its title and caption the whole column.
  const pair = figures.length > 1;
  return (
    // 12 px under the section head when the figures open it (A05), 24 px after key figures or a figure (A07, A08).
    <BriefRow
      className={cx(first ? "pt-3" : "pt-6", SCROLL_ANCHOR_CLASS)}
      notes={notes.length > 0 ? <Sidenotes numbers={notes} texts={texts} /> : null}
    >
      {/* A pair stretches to the taller figure and each frame fills its cell; with the frame's source line at its foot, both sit level (A05). */}
      <div className={cx("grid w-full gap-x-6 gap-y-8", styles.figures, pair ? "grid-cols-1 items-stretch sm:grid-cols-2" : "grid-cols-1 items-start")}>
        {figures.map((f, i) => (
          <FigureView key={f.datasetId} figure={f} dataset={datasets[i]} rivals={rivals} compact={pair || isCompactFigure(f)} ready={ready} />
        ))}
      </div>
    </BriefRow>
  );
}
