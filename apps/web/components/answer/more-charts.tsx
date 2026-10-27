"use client";

import { useEffect, useRef } from "react";
import type { DatasetEnvelope } from "@ct/contracts";
import type { MoreChart } from "../../lib/answer";
import type { BriefFigure } from "../../lib/brief";
import { useHowWeKnow } from "../drawer";
import { Exhibit } from "../figures";
import { ChartGlyph } from "../plots";
import { cardClassName, cx, Icon, IconButton } from "../ui";
import { GroupLabel } from "./cards";

/**
 * More charts (§2.6 row G): every figure the answer does not draw as a main chart, as a link card (a
 * glyph and the chart's name; list rows on phones). A click opens the chart sheet: a modal around the
 * figure itself, kept in the URL as ?chart=D3. Esc and the close button close it; Source closes it and
 * opens the How we know drawer on that figure.
 */

export function MoreCharts({ charts, onOpen }: { charts: readonly MoreChart[]; onOpen: (chart: MoreChart) => void }) {
  if (charts.length === 0) return null;
  return (
    <section aria-labelledby="more-charts" className="flex flex-col gap-3">
      <div id="more-charts">
        <GroupLabel icon="chart-bar">More charts</GroupLabel>
      </div>
      <ul className="grid gap-6 max-md:gap-3 md:grid-cols-2 lg:grid-cols-4">
        {charts.map((c) => (
          <li key={c.datasetId} className="flex">
            <button
              type="button"
              onClick={() => onOpen(c)}
              aria-haspopup="dialog"
              data-more-chart={c.datasetId}
              className={cardClassName(
                "none",
                "group flex w-full flex-col gap-3 p-4 text-left transition-[border-color,box-shadow] hover:border-line-strong hover:shadow-md active:shadow-xs max-md:flex-row max-md:items-center max-md:px-5 max-md:py-4",
              )}
            >
              <span className="relative flex h-16 items-center rounded-sm bg-sunken px-3 max-md:hidden">
                <ChartGlyph kind={c.glyph} />
                <Icon name="arrow-up-right" size={14} className="absolute top-2 right-2 text-ink-3 transition-colors group-hover:text-accent" />
              </span>
              <Icon name="chart-bar" size={16} className="shrink-0 text-ink md:hidden" />
              <span className="min-w-0 flex-1 text-[15px] leading-6 font-semibold text-ink">{c.name}</span>
              <Icon name="chevron-right" size={18} className="shrink-0 text-ink-3 md:hidden" />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The chart sheet: a modal (max 960, r20) with the figure; a full-screen sheet on phones. */
export function ChartSheet({
  chart,
  figure,
  dataset,
  onClose,
}: {
  chart: MoreChart | null;
  figure: BriefFigure | null;
  dataset: DatasetEnvelope | null;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const how = useHowWeKnow();
  const open = chart !== null;
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    } else if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-labelledby="chart-sheet-title"
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        // A click on the backdrop (the dialog box itself, outside its panel) closes it.
        if (e.target === e.currentTarget) onClose();
      }}
      className={cx(
        "m-auto w-[min(960px,calc(100vw-32px))] max-w-none rounded-box border border-line bg-surface p-0 shadow-lg backdrop:bg-scrim",
        "max-md:h-full max-md:max-h-none max-md:w-full max-md:rounded-none max-md:rounded-t-box",
      )}
    >
      {chart ? (
        <div className="flex max-h-[calc(100vh-64px)] flex-col max-md:max-h-full">
          <div className="flex items-start justify-between gap-4 px-6 pt-5 pb-4 max-md:px-4">
            <h2 id="chart-sheet-title" className="min-w-0 pt-2 type-title text-ink max-md:type-title-sm">
              {chart.name}
            </h2>
            <IconButton label="Close" icon="x" size="lg" onClick={onClose} />
          </div>
          <div className="min-h-0 overflow-auto px-6 pb-6 max-md:px-4">
            {figure && dataset ? (
              <Exhibit
                dataset={dataset}
                title={figure.title}
                label={figure.title}
                headingLevel={3}
                formulaId={figure.formulaIds[0] ?? null}
                // Source closes the sheet first: the drawer cannot open over a modal dialog.
                onSource={
                  how.available
                    ? () => {
                        onClose();
                        how.open({ figure: chart.datasetId });
                      }
                    : undefined
                }
              />
            ) : (
              <p className="type-body text-ink-2">This chart&apos;s data is still loading.</p>
            )}
          </div>
        </div>
      ) : null}
    </dialog>
  );
}
