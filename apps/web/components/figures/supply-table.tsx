import type { SupplyPayload, SupplyRow } from "@ct/contracts";
import { CANDIDATE_SOURCE_LABEL, METRO_LABEL, supplySourceLine } from "@ct/contracts/values";
import { cx } from "../ui/cx";
import { Tag } from "../ui/tag";
import { FigureFrame, figureLabel, type FigureMeta, type FigureSource } from "./figure-frame";
import { FigureTable, type TableCell, type TableRow, type TableSpec } from "./figure-table";

/**
 * SupplyTable (kind Supply: R6, D46). What is already on the street, from OpenStreetMap via the Overpass
 * API: one row per area (or the market as a whole), one column per place type with its count, its count
 * per km² and how it compares with the city in words ("about the city's level", "more than the city
 * (1.6×)"), then street activity per km² (shops plus food and drink places). With a mix read, the two
 * lists "Has more of than the city" and "Has less of than the city"; then the named places. Volunteers map
 * OpenStreetMap, so every count is a floor: the caption says so, and the footer carries the source line
 * with the © OpenStreetMap contributors (ODbL) credit the licence asks for. Code computes every number.
 */

export interface SupplyTableOptions {
  /** Named places shown before "Show all" (default 12; the rest stay in the table view). */
  placesShown?: number;
}

export type SupplyTableProps = FigureMeta & SupplyTableOptions & { data: SupplyPayload };

/**
 * The about-level band of the density index (ABOUT_LEVEL.densityIndexLow/High in @ct/quant formulas.ts,
 * mirrored for the client bundle; test/figures/supply-table.test.tsx keeps them equal): inside it an area
 * reads "about the city's level", never more or less.
 */
export const DENSITY_ABOUT_LEVEL = { low: 0.8, high: 1.25 } as const;

/** "1.6×". */
export const formatIndex = (index: number) => `${index.toFixed(index >= 10 ? 0 : 1)}×`;

/** "about the city's level", "more than the city (1.6×)", "less than the city (0.4×)", or why there is no comparison. */
export function vsCityText(index: number | null | undefined): string {
  if (index === null || index === undefined) return "no city comparison";
  if (index >= DENSITY_ABOUT_LEVEL.low && index <= DENSITY_ABOUT_LEVEL.high) return "about the city's level";
  return index > DENSITY_ABOUT_LEVEL.high ? `more than the city (${formatIndex(index)})` : `less than the city (${formatIndex(index)})`;
}

/** "3.4 per km²"; under 1 with two decimals. */
export function perKm2Text(value: number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return `${value.toFixed(value < 1 ? 2 : value < 100 ? 1 : 0)} per km²`;
}

/** An area's name with its candidate chip words (R3), for the table view. */
const rowName = (row: SupplyRow) => {
  const chip = row.source ? CANDIDATE_SOURCE_LABEL[row.source] : null;
  return chip ? `${row.name} · ${chip}` : row.name;
};

const typeLabel = (data: SupplyPayload, key: string) => data.types.find((t) => t.key === key)?.label ?? key;

/** "Areas in Austin" or "Within 5 km of the centre of Austin". */
export function supplyScopeLine(data: SupplyPayload): string {
  if (data.scope === "market") {
    const where = data.rows[0]?.name ?? "the market";
    return data.radiusKm !== null ? `Within ${data.radiusKm} km of the centre of ${where}` : `Around ${where}`;
  }
  return data.metro ? `Areas in ${METRO_LABEL[data.metro]}` : "Areas";
}

/** The table view: per area, each type's count, per km² and index, then street activity; the city last. */
export function supplyTableSpec(data: SupplyPayload, caption: string): TableSpec {
  const cell = (v: number | null | undefined, text: (n: number) => string, reason: string): TableCell =>
    v === null || v === undefined ? { kind: "missing", reason } : { kind: "value", text: text(v) };
  const rows: TableRow[] = data.rows.map((r) => ({
    key: r.id,
    cells: [
      rowName(r),
      ...data.types.flatMap((t) => [
        cell(r.counts[t.key], (n) => String(n), "count failed"),
        cell(r.perKm2[t.key], (n) => n.toFixed(2), "not computed"),
        cell(r.index[t.key], (n) => n.toFixed(2), "no city reference"),
      ]),
      cell(r.activity, (n) => String(n), "count failed"),
      cell(r.activityPerKm2, (n) => n.toFixed(1), "not computed"),
    ],
  }));
  if (data.city) {
    const c = data.city;
    rows.push({ key: "section-city", section: "City reference (approximate area)" });
    rows.push({
      key: "city",
      cells: [
        `${c.label} (${c.areaKm2.toFixed(0)} km², approximate)`,
        ...data.types.flatMap((t) => [cell(c.counts[t.key], (n) => String(n), "count failed"), cell(c.perKm2[t.key], (n) => n.toFixed(2), "not computed"), "1.00"]),
        "",
        cell(c.activityPerKm2, (n) => n.toFixed(1), "not computed"),
      ],
    });
  }
  return {
    caption: `${caption} · ${supplyScopeLine(data)} · OpenStreetMap`,
    columns: [
      { label: data.scope === "market" ? "Market" : "Area" },
      ...data.types.flatMap((t) => [
        { label: `${t.label}: places`, numeric: true },
        { label: `${t.label}: per km²`, numeric: true },
        { label: `${t.label}: vs city (1 = city level)`, numeric: true },
      ]),
      { label: "Shops, food and drink places", numeric: true },
      { label: "Street activity per km²", numeric: true },
    ],
    rows,
  };
}

/** The footer: the fixed source line and the licence link. */
export function supplySource(data: SupplyPayload): FigureSource {
  return {
    text: supplySourceLine(data.osmBase),
    requestId: null,
    after: (
      <>
        {" "}
        <a href={data.licenceUrl} target="_blank" rel="noopener noreferrer" className="underline-offset-2 hover:text-accent hover:underline">
          Copyright and licence
        </a>
      </>
    ),
  };
}

function MixList({ title, items, data }: { title: string; items: NonNullable<SupplyPayload["mix"]>["over"]; data: SupplyPayload }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <h4 className="m-0 text-[13px] leading-[18px] font-semibold text-ink-2">{title}</h4>
      {items.length === 0 ? (
        <p className="m-0 type-body text-ink-2">Nothing stands out.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
          {items.map((m) => (
            <li key={m.typeKey} className="flex items-baseline justify-between gap-3 type-body text-ink">
              <span className="min-w-0 [overflow-wrap:anywhere]">{typeLabel(data, m.typeKey)}</span>
              <span className="shrink-0 text-ink-2 tabular-nums">
                {m.count} · {formatIndex(m.index)} the city
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The plot: an HTML table that stacks into one card per area on phones, then the mix lists and places. */
export function SupplyPlot({ data, placesShown = 12 }: { data: SupplyPayload; placesShown?: number }) {
  const shown = data.places.slice(0, placesShown);
  const rest = data.places.slice(placesShown);
  return (
    <div className="flex min-w-0 flex-col gap-5" data-supply-scope={data.scope}>
      <p className="m-0 type-label text-ink-2">{supplyScopeLine(data)}</p>
      {data.rows.length === 0 ? (
        <p className="m-0 type-body text-ink-2">No area could be counted.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0" aria-label="Places by area">
          {data.rows.map((r) => {
            const chip = r.source ? CANDIDATE_SOURCE_LABEL[r.source] : null;
            return (
              <li key={r.id} className="flex min-w-0 flex-col gap-2 rounded-tile border border-line p-3" data-supply-row={r.id}>
                <p className="m-0 flex flex-wrap items-center gap-2">
                  <span className="text-[15px] leading-6 font-semibold text-ink [overflow-wrap:anywhere]">{r.name}</span>
                  {chip ? <Tag tone="muted">{chip}</Tag> : null}
                </p>
                {data.types.length > 0 ? (
                  <dl className="m-0 grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-2">
                    {data.types.map((t) => {
                      const count = r.counts[t.key];
                      const per = perKm2Text(r.perKm2[t.key]);
                      return (
                        <div key={t.key} className="flex min-w-0 flex-col" data-supply-type={t.key}>
                          <dt className="type-label text-ink-2">{t.label}</dt>
                          <dd className="m-0 type-body text-ink tabular-nums">
                            {count === null || count === undefined ? (
                              <span className="text-ink-2">count failed</span>
                            ) : (
                              <>
                                {count} {count === 1 ? "place" : "places"}
                                {per ? <span className="text-ink-2"> · {per}</span> : null}
                                <span className="text-ink-2"> · {vsCityText(r.index[t.key])}</span>
                              </>
                            )}
                          </dd>
                        </div>
                      );
                    })}
                  </dl>
                ) : null}
                <p className="m-0 type-label text-ink-2 tabular-nums">
                  Street activity: {perKm2Text(r.activityPerKm2) ?? "not counted"}
                  {r.activity !== null ? ` (${r.activity} shops, food and drink places)` : ""}
                </p>
              </li>
            );
          })}
        </ul>
      )}
      {data.city ? (
        <p className="m-0 type-caption text-ink-2" data-supply-city="true">
          City reference: {data.city.label}, street activity {perKm2Text(data.city.activityPerKm2) ?? "not counted"} over about {data.city.areaKm2.toFixed(0)} km² (an
          approximate area).
        </p>
      ) : null}
      {data.mix ? (
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2" data-supply-mix="true">
          <MixList title="Has more of than the city" items={data.mix.over} data={data} />
          <MixList title="Has less of than the city" items={data.mix.under} data={data} />
        </div>
      ) : null}
      {data.places.length > 0 ? (
        <div className="flex flex-col gap-2" data-supply-places={data.places.length}>
          <h4 className="m-0 text-[13px] leading-[18px] font-semibold text-ink-2">
            Named places ({data.places.length}
            {data.places.length >= 60 ? ", the first 60" : ""})
          </h4>
          <PlaceList places={shown} data={data} />
          {rest.length > 0 ? (
            <details>
              <summary className="cursor-pointer type-label text-accent">Show all {data.places.length}</summary>
              <PlaceList places={rest} data={data} className="mt-2" />
            </details>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function PlaceList({ places, data, className }: { places: SupplyPayload["places"]; data: SupplyPayload; className?: string }) {
  return (
    <ul className={cx("m-0 grid list-none grid-cols-1 gap-x-6 gap-y-1 p-0 sm:grid-cols-2", className)}>
      {places.map((p) => (
        <li key={p.osmUrl} className="flex min-w-0 items-baseline justify-between gap-3 type-body">
          <a href={p.osmUrl} target="_blank" rel="noopener noreferrer" className="min-w-0 text-ink [overflow-wrap:anywhere] hover:text-accent hover:underline">
            {p.name}
          </a>
          <span className="shrink-0 type-label text-ink-2">{typeLabel(data, p.typeKey)}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The fixed caption: the completeness line first (counts are a floor), then the payload's caption. The
 * skill's caption opens with its own source line and repeats the completeness line; the frame already
 * prints the source under the figure, so both are taken out here and nothing is said twice.
 */
export function supplyCaption(data: SupplyPayload): string {
  const completeness = data.completeness.trim();
  let caption = data.caption.trim().replace(/^Source: OpenStreetMap via Overpass API[^.]*?Culture Terminal analysis\.\s*/, "");
  if (completeness !== "") caption = caption.split(completeness).join(" ").replace(/\s{2,}/g, " ").trim();
  return [completeness, caption].filter((t) => t !== "").join(" ");
}

export function SupplyTable(props: SupplyTableProps) {
  const { data } = props;
  const label = figureLabel(props);
  return (
    <FigureFrame
      meta={{ ...props, source: props.source ?? supplySource(data) }}
      plot={<SupplyPlot data={data} placesShown={props.placesShown} />}
      table={<FigureTable spec={supplyTableSpec(data, label)} />}
      fixedCaption={supplyCaption(data)}
      htmlPlot
    />
  );
}
