"use client";

import { useId, useState } from "react";
import { cx } from "../ui/cx";
import { Icon } from "../ui/icons";
import { MAP_CITIES, MAP_COVERAGE } from "./map-coverage";
import { Expand, ExpandItem } from "./motion";

/** Where neighbourhood maps exist: one short line under the box; the city list opens from it. */
export function MapCoverageLine({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  return (
    <div className={cx("flex flex-col px-0.5", className)}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex w-fit items-center gap-1.5 rounded-xs text-[12px] leading-[18px] text-ink-2 transition-colors duration-150 hover:text-ink"
      >
        <Icon name="map-pin" size={13} aria-hidden="true" className="shrink-0 text-ink-3" />
        {MAP_COVERAGE}
        <Icon name="chevron-down" size={12} aria-hidden="true" className={cx("shrink-0 transition-transform duration-150", open && "rotate-180")} />
      </button>
      <div id={listId}>
        <Expand>
          {open ? (
            <ExpandItem key="cities">
              <p className="m-0 pt-1.5 pl-5 text-[12px] leading-[18px] text-ink-2">{MAP_CITIES.join(" · ")}</p>
            </ExpandItem>
          ) : null}
        </Expand>
      </div>
    </div>
  );
}
