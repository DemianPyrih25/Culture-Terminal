import type { AreaStanding, GeoLiftNeighbourhood, GeoLiftPayload, SupplyPayload } from "@ct/contracts";
import { AREA_STANDING_LABEL, CANDIDATE_SOURCE_LABEL, HIDDEN_AREAS_LABEL, POPULAR_AREAS_LABEL } from "@ct/contracts/values";
import { cx } from "../ui/cx";
import { FigureTable, type TableCell, type TableSpec } from "./figure-table";
import { formatLift } from "./lift-scale";

/**
 * Popular next to hidden areas (R7, D50). A lift map ranks areas by extra interest for their size, which
 * can crown a small pocket where few people are. This view puts beside it where the crowd already is: the
 * areas ranked by raw interest ("Where it's already popular") and the high-lift, low-raw ones ("Hidden
 * pockets (stands out for its size)"), then one table with both ranks, the standing chip and, when an
 * OpenStreetMap supply read covers the same areas, the similar places already there and street activity.
 * A map stored before Part 11 carries no raw ranks: the view is not drawn. Pure apart from the card.
 */

export interface StandingArea {
  id: string;
  name: string;
  /** [rank, of] by raw interest among the areas that have a raw value. */
  rawRank: [number, number] | null;
  lift: number | null;
  standing: AreaStanding | null;
  /** "You named" / "Expected" (R3), or null. */
  chip: string | null;
  /** Similar places counted in OpenStreetMap (the supply read's types summed), or null without a read. */
  osmPlaces: number | null;
  osmActivityPerKm2: number | null;
}

export interface StandingModel {
  popular: StandingArea[];
  hidden: StandingArea[];
  rows: StandingArea[];
  /** The supply read covers these areas (the OSM columns are shown). */
  withOsm: boolean;
}

const rawOf = (n: GeoLiftNeighbourhood) => (typeof n.raw === "number" ? n.raw : null);

/** Whether the map carries R7 popularity at all (raw values or the two lists). */
export function hasStanding(data: Pick<GeoLiftPayload, "neighbourhoods" | "popular" | "hidden">): boolean {
  return (data.popular?.length ?? 0) > 0 || (data.hidden?.length ?? 0) > 0 || data.neighbourhoods.some((n) => rawOf(n) !== null);
}

/** The supply read that counts this map's areas: same metro, area scope. */
export function supplyForMap(data: Pick<GeoLiftPayload, "metro">, supplies: readonly SupplyPayload[]): SupplyPayload | null {
  return supplies.find((s) => s.scope === "areas" && s.metro === data.metro) ?? null;
}

export function standingModel(data: GeoLiftPayload, supply: SupplyPayload | null = null): StandingModel | null {
  if (data.coarse || !hasStanding(data)) return null;
  const byRaw = data.neighbourhoods.filter((n) => rawOf(n) !== null).sort((a, b) => (rawOf(b) ?? 0) - (rawOf(a) ?? 0) || (a.id < b.id ? -1 : 1));
  const supplyRows = new Map((supply?.rows ?? []).map((r) => [r.id, r]));
  const area = (n: GeoLiftNeighbourhood): StandingArea => {
    const at = byRaw.indexOf(n);
    const row = supplyRows.get(n.id);
    const counts = row ? Object.values(row.counts).filter((c): c is number => typeof c === "number") : [];
    return {
      id: n.id,
      name: n.name,
      rawRank: at >= 0 ? [at + 1, byRaw.length] : null,
      lift: n.lift,
      standing: n.standing ?? null,
      chip: n.source ? CANDIDATE_SOURCE_LABEL[n.source] : null,
      osmPlaces: row && supply && supply.types.length > 0 && counts.length > 0 ? counts.reduce((a, b) => a + b, 0) : null,
      osmActivityPerKm2: row?.activityPerKm2 ?? null,
    };
  };
  const find = (id: string) => data.neighbourhoods.find((n) => n.id === id);
  const listed = (ids: readonly string[] | undefined) => (ids ?? []).map(find).filter((n): n is GeoLiftNeighbourhood => n !== undefined);
  const popularFrom = listed(data.popular);
  const popular = (popularFrom.length > 0 ? popularFrom : byRaw.filter((n) => n.standing === "popular" || n.standing === "popular_distinct").slice(0, 3)).map(area);
  const hiddenFrom = listed(data.hidden);
  const hidden = (
    hiddenFrom.length > 0
      ? hiddenFrom
      : data.neighbourhoods
          .filter((n) => n.standing === "hidden")
          .sort((a, b) => (b.demandPct ?? 0) - (a.demandPct ?? 0))
          .slice(0, 3)
  ).map(area);
  const named = data.neighbourhoods.filter((n) => n.source === "user_named");
  const rest = data.neighbourhoods
    .filter((n) => n.source !== "user_named" && (rawOf(n) !== null || n.lift !== null))
    .sort((a, b) => {
      const ra = byRaw.indexOf(a);
      const rb = byRaw.indexOf(b);
      return (ra < 0 ? Infinity : ra) - (rb < 0 ? Infinity : rb) || (b.lift ?? 0) - (a.lift ?? 0);
    });
  return { popular, hidden, rows: [...named, ...rest].map(area), withOsm: supply !== null && data.neighbourhoods.some((n) => supplyRows.has(n.id)) };
}

const rankText = (r: [number, number] | null) => (r === null ? null : `#${r[0]} of ${r[1]}`);

/** The table: area, raw rank, lift, standing, and the OpenStreetMap columns when a read covers the areas. */
export function standingTableSpec(model: StandingModel, caption: string): TableSpec {
  const missing = (reason: string): TableCell => ({ kind: "missing", reason });
  return {
    caption,
    columns: [
      { label: "Area" },
      { label: "Rank by all interest", numeric: true },
      { label: "Extra interest (lift)", numeric: true },
      { label: "Standing" },
      ...(model.withOsm ? [{ label: "Similar places (OpenStreetMap)", numeric: true }, { label: "Street activity per km²", numeric: true }] : []),
    ],
    rows: model.rows.map((a) => ({
      key: a.id,
      cells: [
        a.chip ? `${a.name} · ${a.chip}` : a.name,
        rankText(a.rawRank) ?? missing("no reading"),
        a.lift === null ? missing("too few cells") : { kind: "value", text: formatLift(a.lift) },
        a.standing ? AREA_STANDING_LABEL[a.standing] : "",
        ...(model.withOsm
          ? [
              a.osmPlaces === null ? missing("not counted") : String(a.osmPlaces),
              a.osmActivityPerKm2 === null ? missing("not counted") : { kind: "value" as const, text: a.osmActivityPerKm2.toFixed(1) },
            ]
          : []),
      ],
    })),
  };
}

function AreaList({ title, areas, kind }: { title: string; areas: readonly StandingArea[]; kind: "popular" | "hidden" }) {
  return (
    <div className="flex min-w-0 flex-col gap-2" data-standing-list={kind}>
      <h3 className="m-0 text-[13px] leading-[18px] font-semibold text-ink-2">{title}</h3>
      {areas.length === 0 ? (
        <p className="m-0 type-body text-ink-2">{kind === "popular" ? "No area leads on all interest." : "No area stands out for its size alone."}</p>
      ) : (
        <ol className="m-0 flex list-none flex-col gap-2 p-0">
          {areas.map((a, i) => (
            <li key={a.id} className="grid grid-cols-[20px_minmax(0,1fr)] items-baseline gap-x-2">
              <span className="type-label text-ink-2 tabular-nums">{i + 1}</span>
              <span className="flex min-w-0 flex-col">
                <span className="text-[15px] leading-6 font-semibold text-ink [overflow-wrap:anywhere]">{a.name}</span>
                <span className="type-label text-ink-2 tabular-nums">
                  {[
                    rankText(a.rawRank) ? `${rankText(a.rawRank)} by all interest` : null,
                    a.lift !== null ? `${formatLift(a.lift)} extra interest` : null,
                    a.osmPlaces !== null ? `${a.osmPlaces} similar ${a.osmPlaces === 1 ? "place" : "places"} (OpenStreetMap)` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

const cellText = (cell: TableCell) => (typeof cell === "string" ? cell : cell.kind === "value" ? cell.text : cell.reason);

/**
 * The same table on a phone: one card per area, each column a labelled line, so six columns never squeeze
 * into 390 px or scroll sideways. Hidden from md up, where the table shows instead (display none, so a
 * screen reader meets the rows once).
 */
function StandingRows({ spec }: { spec: TableSpec }) {
  const [, ...columns] = spec.columns;
  return (
    <ul className="m-0 flex list-none flex-col gap-3 p-0 md:hidden" aria-label={spec.caption} data-standing-rows="true">
      {spec.rows.map((row) =>
        "section" in row ? null : (
          <li key={row.key} className="flex min-w-0 flex-col gap-1.5 rounded-tile border border-line p-3">
            <p className="m-0 text-[15px] leading-6 font-semibold text-ink [overflow-wrap:anywhere]">{cellText(row.cells[0] ?? "")}</p>
            <dl className="m-0 grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-4 gap-y-1">
              {columns.map((c, i) => {
                const cell = row.cells[i + 1];
                const value = cell === undefined ? "" : cellText(cell);
                if (value === "") return null;
                const missing = typeof cell === "object" && cell.kind === "missing";
                return (
                  <div key={c.label} className="contents">
                    <dt className="type-label text-ink-2">{c.label}</dt>
                    <dd className={cx("m-0 text-right type-body tabular-nums", missing ? "text-ink-2" : "text-ink")}>{value}</dd>
                  </div>
                );
              })}
            </dl>
          </li>
        ),
      )}
    </ul>
  );
}

/** The explanation under the two lists: what each list measures. */
export const STANDING_NOTE =
  "Popular areas have the most interest overall: the crowd is already there. Hidden pockets have high extra interest for their size but little interest overall, so they are small or early, not the biggest market.";

/** The card on the answer page (site_selection and taste_twins maps): the two lists, then the table. */
export function AreaStandingCard({
  data,
  supply = null,
  title = "Popular and hidden areas",
  headingLevel = 2,
  className,
}: {
  data: GeoLiftPayload;
  supply?: SupplyPayload | null;
  title?: string;
  headingLevel?: 2 | 3;
  className?: string;
}) {
  const model = standingModel(data, supply);
  if (!model) return null;
  const Heading = `h${headingLevel}` as "h2" | "h3";
  return (
    <section aria-label={title} data-standing={data.metro} className={cx("flex min-w-0 flex-col gap-5 rounded-card border border-line bg-surface p-6 shadow-xs max-md:p-5", className)}>
      <div className="flex flex-col gap-1.5">
        <p className="m-0 type-label text-ink-2">Where the crowd is, and where it stands out</p>
        <Heading className="m-0 type-title text-ink max-md:type-title-sm">{title}</Heading>
      </div>
      <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
        <AreaList title={POPULAR_AREAS_LABEL} areas={model.popular} kind="popular" />
        <AreaList title={HIDDEN_AREAS_LABEL} areas={model.hidden} kind="hidden" />
      </div>
      <p className="m-0 type-caption text-ink-2">{STANDING_NOTE}</p>
      {model.rows.length > 0 ? (
        <>
          <div className="min-w-0 overflow-x-auto max-md:hidden" data-standing-table="true">
            <FigureTable spec={standingTableSpec(model, title)} />
          </div>
          <StandingRows spec={standingTableSpec(model, title)} />
        </>
      ) : null}
      {model.withOsm && supply ? (
        <p className="m-0 type-caption text-ink-2">
          Similar places and street activity: OpenStreetMap via the Overpass API, © OpenStreetMap contributors (ODbL). {supply.completeness}
        </p>
      ) : null}
    </section>
  );
}
