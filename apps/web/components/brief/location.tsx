import { Fragment } from "react";
import type { BriefLocation } from "../../lib/brief";
import { NoteRef } from "./note-ref";

/**
 * Where a location brief stands, under its question (SPEC §8: the area name and the location method):
 * the area and city, how each area was read (POLYGON, POINT or QUERY, the method in words for screen
 * readers) and the CODE FALLBACK steps code took to get there, each citing the note its figure cites,
 * which gives the reason and the request behind it.
 */
export function LocationLine({ location }: { location: BriefLocation }) {
  if (!location.place) return null;
  const several = location.areas.length > 1;
  return (
    <p className="m-0 flex flex-wrap items-baseline gap-x-2.5 gap-y-1 text-[13px] leading-5 text-text-2" data-location={location.place}>
      <span className="text-[11px] leading-4 font-semibold tracking-[1.3px] text-dim uppercase">{location.areas.length > 0 ? "Area" : "City"}</span>
      <span className="text-ink">{location.place}</span>
      {location.areas.map((area) =>
        area.method ? (
          // Below 640 px the method takes its own line under the place, so no dot opens a line.
          <span key={area.name} className="inline-flex flex-wrap items-baseline gap-x-2 max-sm:basis-full" data-area-method={area.method}>
            <span aria-hidden="true" className="text-faint max-sm:hidden">
              ·
            </span>
            <span className="font-mono text-[11px] text-dim">
              {several ? `${area.name} ` : ""}read by {area.method}
              {area.methodLabel ? <span className="sr-only">, {area.methodLabel}</span> : null}
            </span>
            {area.fallbacks.length > 0 ? (
              <span className="font-mono text-[11px] text-dim" data-code-fallback={area.fallbacks.length}>
                · code {area.fallbacks.length > 1 ? "fallbacks" : "fallback"}{" "}
                {area.fallbacks.map((f, i) => (
                  <Fragment key={i}>
                    {i > 0 ? ", " : ""}
                    {f.from} → {f.to}
                    {/* The figure's note gives the reason; until a figure cites it, the reason is read out here. */}
                    {f.footnote !== null ? <NoteRef n={f.footnote} /> : <span className="sr-only">: {f.reason}</span>}
                  </Fragment>
                ))}
              </span>
            ) : null}
          </span>
        ) : null,
      )}
    </p>
  );
}
