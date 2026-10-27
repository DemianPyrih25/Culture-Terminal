"use client";

import type { GeoLiftPayload } from "@ct/contracts";
import { useId, useState } from "react";
import { Button } from "../ui/button";
import { cardClassName } from "../ui/card";
import { cx } from "../ui/cx";
import { Icon } from "../ui/icons";
import { Tag } from "../ui/tag";
import { FigureTable } from "./figure-table";
import { liftCaption, liftTableSpec } from "./lift-map";
import { outlinesUrl as defaultOutlinesUrl } from "./lift-outlines";
import { MAP_CARD_KIND, MAP_CARD_TITLE, MODE_TEXT } from "./lift-map-parts";
import { LiftMapView } from "./lift-map-view";
import { flagValue, mapPins, namedAreas, namedPins, type LiftMode } from "./lift-scale";

/**
 * The site_selection map card (N08, row C, span 6, 464 tall): the LiftMap on the left (about 70 %) and a
 * 312 px panel on the right: the kind and title, the "Extra interest" disclosure that switches the layer
 * (extra interest = LIFT, all interest = RAW), the three best areas (pin numeral, name 15/600,
 * "1.42× interest" 13 ink-2, "Few rivals nearby") and the caption. Phones: the map 280 tall, the panel
 * under it. The full table of areas is in the markup for screen readers.
 */

export interface LiftMapCardProps {
  data: GeoLiftPayload;
  /** The kind line (default "Where interest is highest"). */
  kind?: string;
  /** The title (default "Best areas for this concept"). */
  title?: string;
  /** Under the list; defaults to the payload's caption with the boundary source. */
  caption?: string;
  /** Opens the How we know drawer on this figure. */
  onSource?: () => void;
  draft?: boolean;
  initialMode?: LiftMode;
  /** Default /api/geo/<metro>; null draws no outlines. */
  outlinesUrl?: string | null;
  /** false keeps the static schematic (tests, print). */
  interactive?: boolean;
  headingLevel?: 2 | 3;
  id?: string;
  className?: string;
}

export function LiftMapCard({
  data,
  kind = MAP_CARD_KIND,
  title = MAP_CARD_TITLE,
  caption,
  onSource,
  draft = false,
  initialMode,
  outlinesUrl,
  interactive = true,
  headingLevel = 3,
  id,
  className,
}: LiftMapCardProps) {
  const [mode, setMode] = useState<LiftMode>(initialMode ?? (data.coarse ? "RAW" : "LIFT"));
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const pins = mapPins(data, 3);
  // The areas the question names: marked on the map, and listed first with their rank (or why they have none).
  const labels = [...pins, ...namedPins(data, pins)];
  const named = namedAreas(data).filter((a) => !pins.some((p) => p.id === a.id));
  const Heading = `h${headingLevel}` as "h2" | "h3";
  const shown: "LIFT" | "RAW" = mode === "RAW" ? "RAW" : "LIFT";
  return (
    <section id={id} aria-label={title} data-map-card={data.metro} className={cardClassName("none", cx("overflow-hidden", className))}>
      <div className="grid min-[900px]:grid-cols-[minmax(0,1fr)_312px]">
        <div className="h-[280px] md:h-[400px] min-[900px]:h-[464px]">
          <LiftMapView
            data={data}
            labels={labels}
            label={title}
            initialMode={mode}
            mode={mode}
            onModeChange={setMode}
            controls={false}
            fill
            width={816}
            height={464}
            outlinesUrl={outlinesUrl === undefined ? defaultOutlinesUrl(data.metro) : outlinesUrl}
            interactive={interactive}
          />
        </div>
        <div className="flex min-w-0 flex-col gap-4 p-5 md:p-6">
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 flex-col gap-1.5">
              <p className="m-0 type-label text-ink-2">{kind}</p>
              <Heading className="m-0 type-title text-ink max-md:type-title-sm">{title}</Heading>
            </div>
            {draft ? <Tag preset="draft" /> : null}
          </div>
          <div className="flex flex-col gap-1">
            <button
              type="button"
              aria-expanded={open}
              aria-controls={menuId}
              onClick={() => setOpen((v) => !v)}
              className="inline-flex h-9 items-center gap-2 self-start rounded-control px-2 type-label text-ink hover:bg-sunken"
            >
              <Icon name={open ? "chevron-up" : "chevron-down"} size={16} className="text-ink-2" />
              {MODE_TEXT[shown]}
            </button>
            {open ? (
              <div id={menuId} role="radiogroup" aria-label="Map layer" className="flex flex-col gap-1 pl-2">
                {(["LIFT", "RAW"] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    role="radio"
                    aria-checked={shown === m}
                    onClick={() => {
                      setMode(m);
                      setOpen(false);
                    }}
                    className={cx(
                      "flex items-center gap-2 rounded-control px-2 py-1.5 text-left type-label hover:bg-sunken",
                      shown === m ? "text-accent-ink" : "text-ink-2",
                    )}
                  >
                    <Icon name={shown === m ? "check" : "circle"} size={14} />
                    {m === "LIFT" ? "Extra interest: more than a typical area" : "All interest: where fans are most"}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          {named.length > 0 ? (
            <ul className="flex flex-col gap-4" aria-label="The areas your question names">
              {named.map((a) => (
                <li key={a.id} data-named={a.id} className="grid grid-cols-[24px_minmax(0,1fr)] items-start gap-x-3">
                  <span aria-hidden="true" className="mt-0.5 flex size-6 items-center justify-center rounded-full bg-accent text-white">
                    <Icon name="map-pin" size={14} />
                  </span>
                  <span className="flex min-w-0 flex-col">
                    <span className="text-[15px] leading-6 font-semibold break-words text-ink">{a.name}</span>
                    <span className="text-[13px] leading-[18px] text-ink-2 tabular-nums">
                      {a.lift === null || a.rank === null
                        ? "Your area · not enough data for a reading"
                        : `Your area · #${a.rank[0]} of ${a.rank[1]} · ${flagValue(a.lift)}`}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          {pins.length === 0 ? (
            <p className="m-0 type-body text-ink-2">No area stands out: the data is too coarse to compare neighbourhoods.</p>
          ) : (
            <ol className="flex flex-col gap-5" aria-label={`${title}: top areas`}>
              {pins.map((p) => (
                <li key={p.id} data-row={p.id} className="grid grid-cols-[24px_minmax(0,1fr)] items-start gap-x-3">
                  <span aria-hidden="true" className="mt-0.5 flex size-6 items-center justify-center rounded-full bg-ink text-[12px] font-semibold text-white">
                    {p.rank}
                  </span>
                  {/* The full name, never cut; the tag goes under the value when both do not fit on one line. */}
                  <span className="flex min-w-0 flex-col">
                    <span className="text-[15px] leading-6 font-semibold break-words text-ink">{p.name}</span>
                    <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="text-[13px] leading-[18px] text-ink-2 tabular-nums">{p.named ? `Your area · ${flagValue(p.lift)}` : flagValue(p.lift)}</span>
                      {p.fewRivals ? <Tag preset="few-rivals" /> : null}
                    </span>
                  </span>
                </li>
              ))}
            </ol>
          )}
          <div className="mt-auto flex flex-col gap-3">
            <p className="m-0 type-caption text-ink-2">{caption ?? liftCaption(data)}</p>
            {onSource || draft ? (
              <Button variant="quiet" size="sm" icon="receipt" disabled={draft} onClick={onSource} className="self-start" aria-label={`Source: ${title}`}>
                Source
              </Button>
            ) : null}
          </div>
          <div className="sr-only" data-view="table">
            <FigureTable spec={liftTableSpec(data, title)} />
          </div>
        </div>
      </div>
    </section>
  );
}
