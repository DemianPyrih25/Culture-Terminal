import { METRO_LABEL, type BlockFamily, type MetroId, type ValueCell } from "@ct/contracts";
import { FigureFrame, figureLabel, type FigureMeta } from "./figure-frame";
import { FigureTable, type TableCell, type TableColumn, type TableRow } from "./figure-table";
import { cellText, formatNumber, reasonLabel, type NumberStyle } from "./format";

/**
 * TwinCards (S11 taste_twins, P1; SPEC §5.3 S11): a source neighbourhood and its taste twin in
 * another metro, as two cards with mirrored DNA bars between them. Each row is a tag; each side
 * shows d(t), the tag's rank gain in that area over its own city (clipped to ±clip), growing outward
 * when the area over-indexes and inward when it under-indexes. The twin score between the cards is
 * Spearman ρ between the two d vectors; shared traits (d ≥ sharedMin in both) and the key difference
 * (the largest opposite deltas) are called out, then the other candidates with their ρ. The plot is
 * an HTML table, so it reflows on a phone and reads as a table; the table view lists every tag for
 * every candidate. Figures print what the payload holds: ρ, the traits and the difference come from
 * QUANT, never from here. A candidate that was never measured (no tags, e.g. the budget ran out
 * before its BLOCK call) is never drawn as a result: no bars, no callouts, only its reason; it is
 * never the default and never called the twin.
 */

/** A neighbourhood and the metro it is measured against. */
export interface TwinArea {
  key: string;
  label: string;
  metro: MetroId;
}

/** One tag of the union, with d(t) on each side. */
export interface TwinTag {
  key: string;
  label: string;
  tagRef: string | null;
  family: BlockFamily | null;
  /** d(t) = clip(rank_city − rank_area, −clip, clip) in the source and in the candidate; null with a reason. */
  source: ValueCell;
  target: ValueCell;
}

/** A candidate neighbourhood in the target metro. */
export interface TwinCandidate {
  area: TwinArea;
  /** Twin score: Spearman ρ between the two d vectors over the union of tags; null with a reason. */
  rho: ValueCell;
  /** Tags in the union ρ was computed over. */
  n: number;
  tags: TwinTag[];
  /** Shared traits: tag keys with d ≥ sharedMin in both areas. */
  shared: string[];
  /** The key difference: the tag keys with the largest opposite deltas (at most two). */
  difference: string[];
}

/** The Taste Twins payload (the Twin dataset kind of SPEC §10.1, proposed). */
export interface TwinPayload {
  source: TwinArea;
  /** Candidates by ρ, the twin first. */
  candidates: TwinCandidate[];
  /** |d| is clipped here (25). */
  clip: number;
  /** A shared trait needs d at or above this in both areas (10). */
  sharedMin: number;
  /** Fixed: "similarity of taste signals, not rent, footfall or census". */
  caption: string;
}

export interface TwinCardsOptions {
  /** The candidate drawn against the source. Default the twin: the first with a twin score. */
  candidateKey?: string;
  /** Tag rows drawn: shared traits and the key difference first, then the largest deltas. Default 10. */
  maxRows?: number;
  numberStyle?: NumberStyle;
}

export type TwinCardsProps = FigureMeta & TwinCardsOptions & { data: TwinPayload };

type Trait = "shared" | "difference" | null;

/** A candidate with a twin score: it can be the twin, and it takes a rank among the candidates. */
const scored = (c: TwinCandidate) => c.rho.value !== null && c.tags.length > 0;

export function TwinCards(props: TwinCardsProps) {
  const label = figureLabel(props);
  const style: NumberStyle = { ...props.numberStyle };
  const { data } = props;
  const asked = props.candidateKey ? data.candidates.findIndex((c) => c.area.key === props.candidateKey) : -1;
  const index = asked >= 0 ? asked : data.candidates.findIndex(scored);
  const candidate = data.candidates[index];
  return (
    <FigureFrame
      meta={props}
      htmlPlot
      plot={
        candidate ? (
          <TwinPlot data={data} candidate={candidate} index={index} label={label} style={style} maxRows={props.maxRows ?? 10} />
        ) : (
          <div className="flex flex-col gap-1 bg-canvas px-3 py-6 text-center font-ui text-[12px] text-dim" data-twin="none">
            <p className="m-0">No candidate neighbourhood was measured.</p>
            {data.candidates.length > 0 ? (
              <p className="m-0 text-[11.5px]">
                {data.candidates.map((c, i) => (
                  <span key={c.area.key}>
                    {i > 0 ? " · " : ""}
                    {c.area.label}: <span className="italic">{reasonLabel(c.rho.reason)}</span>
                  </span>
                ))}
              </p>
            ) : null}
          </div>
        )
      }
      table={<FigureTable spec={twinTableSpec(data, label, style)} />}
      fixedCaption={data.caption}
    />
  );
}

const delta = (value: number, style: NumberStyle) => formatNumber(value, "delta", { digits: 0, ...style });

/**
 * Rows in reading order: shared traits (strongest in both first), the key difference (in the
 * payload's order, largest gap first), then the largest deltas; capped at maxRows (callouts always shown).
 */
export function twinRows(candidate: TwinCandidate, maxRows: number): { tag: TwinTag; trait: Trait }[] {
  const shared = new Set(candidate.shared);
  const difference = new Set(candidate.difference);
  const tagOf = new Map(candidate.tags.map((t) => [t.key, t]));
  const weight = (t: TwinTag) => Math.abs(t.source.value ?? 0) + Math.abs(t.target.value ?? 0);
  const minBoth = (t: TwinTag) => Math.min(t.source.value ?? -Infinity, t.target.value ?? -Infinity);
  const byKey = (a: TwinTag, b: TwinTag) => a.key.localeCompare(b.key);
  const traitRows = candidate.tags.filter((t) => shared.has(t.key)).sort((a, b) => minBoth(b) - minBoth(a) || byKey(a, b));
  const diffRows = candidate.difference.filter((k) => !shared.has(k)).flatMap((k) => tagOf.get(k) ?? []);
  const rest = candidate.tags.filter((t) => !shared.has(t.key) && !difference.has(t.key)).sort((a, b) => weight(b) - weight(a) || byKey(a, b));
  const fixed = [...traitRows.map((tag) => ({ tag, trait: "shared" as const })), ...diffRows.map((tag) => ({ tag, trait: "difference" as const }))];
  return [...fixed, ...rest.slice(0, Math.max(0, maxRows - fixed.length)).map((tag) => ({ tag, trait: null }))];
}

function TwinPlot({
  data,
  candidate,
  index,
  label,
  style,
  maxRows,
}: {
  data: TwinPayload;
  candidate: TwinCandidate;
  index: number;
  label: string;
  style: NumberStyle;
  maxRows: number;
}) {
  const source = data.source;
  const twin = candidate.area;
  const measured = candidate.tags.length > 0;
  const rows = twinRows(candidate, maxRows);
  const hidden = candidate.tags.length - rows.length;
  const sourceCity = METRO_LABEL[source.metro];
  const twinCity = METRO_LABEL[twin.metro];
  const others = data.candidates.filter((_, i) => i !== index);
  // Ranks count only the candidates with a twin score; the twin is the first of them.
  const ranked = data.candidates.filter(scored);
  const rank = ranked.indexOf(candidate);
  const role = !measured ? "Not measured" : rank < 0 ? "No twin score" : rank === 0 ? "Twin" : `#${rank + 1} of ${ranked.length}`;
  const sharedRows = rows.filter((r) => r.trait === "shared").map((r) => r.tag.label);
  const differenceRows = rows.filter((r) => r.trait === "difference").map((r) => r.tag);
  return (
    <div className="flex flex-col gap-3 pt-2" data-twin={twin.key}>
      <div className="grid grid-cols-[minmax(0,1fr)_112px_minmax(0,1fr)] items-stretch gap-2 sm:grid-cols-[minmax(0,1fr)_132px_minmax(0,1fr)]">
        <AreaCard area={source} role="Source" city={sourceCity} align="left" />
        <div className="flex flex-col items-center justify-center text-center" data-rho={candidate.rho.value ?? "none"}>
          <span className="font-ui text-[10px] font-semibold tracking-[1px] text-dim uppercase">Twin score</span>
          {candidate.rho.value === null ? (
            <span className="font-ui text-[12px] text-dim italic">{reasonLabel(candidate.rho.reason)}</span>
          ) : (
            <span className="font-serif text-[24px] leading-[30px] font-medium text-ink tabular-nums sm:text-[30px] sm:leading-[36px]">
              <span className="text-[0.7em] text-dim italic">ρ </span>
              {formatNumber(candidate.rho.value, "stat", { digits: 2, ...style })}
            </span>
          )}
          {candidate.rho.value !== null ? <span className="font-ui text-[11px] text-dim">{`over ${candidate.n} tags`}</span> : null}
        </div>
        <AreaCard area={twin} role={role} city={twinCity} align="right" muted={!measured} />
      </div>

      {measured ? (
        <TwinBars
          rows={rows}
          hidden={hidden}
          clip={data.clip}
          caption={`${label}: each tag's rank gain over its city, ${source.label} against ${twin.label}`}
          sourceHead={{ visible: `← over ${sourceCity}`, spoken: `${source.label}, rank gain vs ${sourceCity}` }}
          twinHead={{ visible: `over ${twinCity} →`, spoken: `${twin.label}, rank gain vs ${twinCity}` }}
          style={style}
        />
      ) : (
        <p className="m-0 border-y border-line py-3 text-center font-ui text-[12.5px] text-text-2" data-unmeasured="true">
          {`${twin.label} was not compared with ${source.label}: `}
          <span className="text-dim italic">{reasonLabel(candidate.rho.reason)}</span>
        </p>
      )}

      <dl className="m-0 grid grid-cols-[minmax(0,1fr)] gap-x-4 gap-y-1.5 font-ui text-[12.5px] leading-[18px] text-text-2 sm:grid-cols-[120px_minmax(0,1fr)]">
        {measured ? (
          <>
            <dt className="pt-px text-[10px] font-semibold tracking-[1px] text-accent uppercase">Shared traits</dt>
            <dd className="m-0" data-callout="shared">
              {sharedRows.length > 0 ? sharedRows.join(" · ") : `None: no tag gains ${data.sharedMin} or more ranks in both areas.`}
            </dd>
            <dt className="pt-px text-[10px] font-semibold tracking-[1px] text-negative uppercase">Key difference</dt>
            <dd className="m-0" data-callout="difference">
              {differenceRows.length > 0
                ? differenceRows
                    .map((t) => `${t.label}: ${sideText(t.source, style)} in ${source.label}, ${sideText(t.target, style)} in ${twin.label}`)
                    .join("; ")
                : "None: no tag pulls the two areas in opposite directions."}
            </dd>
          </>
        ) : null}
        {others.length > 0 ? (
          <>
            <dt className="pt-px text-[10px] font-semibold tracking-[1px] text-dim uppercase">{rank === 0 ? "Runners-up" : "Other candidates"}</dt>
            <dd className="m-0" data-callout="others">
              {others.map((c, i) => (
                <span key={c.area.key}>
                  {i > 0 ? " · " : ""}
                  <span className="whitespace-nowrap">
                    {c.area.label}{" "}
                    {c.rho.value === null ? (
                      <span className="text-dim italic">{reasonLabel(c.rho.reason)}</span>
                    ) : (
                      <span className="text-dim tabular-nums">{`ρ ${formatNumber(c.rho.value, "stat", { digits: 2, ...style })}`}</span>
                    )}
                  </span>
                </span>
              ))}
            </dd>
          </>
        ) : null}
      </dl>
    </div>
  );
}

/** The mirrored bars as a real table: the tag heads each row, each area heads its column. */
function TwinBars({
  rows,
  hidden,
  clip,
  caption,
  sourceHead,
  twinHead,
  style,
}: {
  rows: { tag: TwinTag; trait: Trait }[];
  hidden: number;
  clip: number;
  caption: string;
  sourceHead: { visible: string; spoken: string };
  twinHead: { visible: string; spoken: string };
  style: NumberStyle;
}) {
  return (
    <>
      <table className="w-full table-fixed border-collapse font-ui">
        <caption className="sr-only">{caption}</caption>
        <colgroup>
          <col />
          <col className="w-[112px] sm:w-[132px]" />
          <col />
        </colgroup>
        <thead>
          <tr className="border-b border-line-strong">
            <th scope="col" className="pb-1.5 text-left text-[10px] font-medium tracking-[0.8px] text-dim uppercase">
              <span aria-hidden="true">{sourceHead.visible}</span>
              <span className="sr-only">{sourceHead.spoken}</span>
            </th>
            <th scope="col" className="pb-1.5 text-center text-[10px] font-medium tracking-[0.8px] text-dim uppercase">
              Tag
            </th>
            <th scope="col" className="pb-1.5 text-right text-[10px] font-medium tracking-[0.8px] text-dim uppercase">
              <span aria-hidden="true">{twinHead.visible}</span>
              <span className="sr-only">{twinHead.spoken}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ tag, trait }) => (
            <tr
              key={tag.key}
              data-row={tag.key}
              data-trait={trait ?? undefined}
              className={`h-[24px] border-b border-line ${trait === "shared" ? "bg-accent-soft" : trait === "difference" ? "bg-negative-soft" : ""}`}
            >
              <td className="py-1 pr-1.5 pl-1">
                <MirroredBar cell={tag.source} clip={clip} side="left" style={style} />
              </td>
              <th
                scope="row"
                className={`px-1 py-1 text-center text-[12px] leading-[15px] break-words ${
                  trait === "shared" ? "font-semibold text-accent" : trait === "difference" ? "font-semibold text-negative" : "font-normal text-text-2"
                }`}
              >
                {tag.label}
                {trait ? <span className="sr-only">{trait === "shared" ? " (shared trait)" : " (key difference)"}</span> : null}
              </th>
              <td className="py-1 pr-1 pl-1.5">
                <MirroredBar cell={tag.target} clip={clip} side="right" style={style} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {hidden > 0 ? <p className="m-0 -mt-1.5 font-ui text-[11px] text-dim">{`${hidden} more tags in the table view.`}</p> : null}
    </>
  );
}

function sideText(cell: ValueCell, style: NumberStyle): string {
  return cell.value === null ? reasonLabel(cell.reason) : `${delta(cell.value, style)} ranks`;
}

function AreaCard({ area, role, city, align, muted = false }: { area: TwinArea; role: string; city: string; align: "left" | "right"; muted?: boolean }) {
  return (
    <div
      className={`flex min-w-0 flex-col gap-0.5 rounded-brief border px-3 py-2.5 ${muted ? "border-dashed border-line-strong bg-canvas" : "border-line bg-paper"} ${
        align === "right" ? "items-end text-right" : "items-start text-left"
      }`}
      data-card={area.key}
    >
      <span className={`font-ui text-[10px] font-semibold tracking-[1px] uppercase ${muted ? "text-dim" : "text-accent"}`}>{role}</span>
      <span className="font-serif text-[15px] leading-[20px] font-semibold text-ink sm:text-[17px] sm:leading-[22px]">{area.label}</span>
      <span className="font-ui text-[11.5px] text-dim">{city}</span>
    </div>
  );
}

/**
 * One side of a mirrored row: the value at the outer edge and a bar from the track's centre line,
 * outward for a gain over the city and inward for a loss; a missing value prints its reason.
 */
function MirroredBar({ cell, clip, side, style }: { cell: ValueCell; clip: number; side: "left" | "right"; style: NumberStyle }) {
  if (cell.value === null) {
    return (
      <span className={`block text-[11px] text-dim italic ${side === "left" ? "text-left" : "text-right"}`} data-missing="true">
        {reasonLabel(cell.reason)}
      </span>
    );
  }
  const v = Math.max(-clip, Math.min(clip, cell.value));
  const share = clip > 0 ? (Math.abs(v) / clip) * 50 : 0;
  // Outward is left on the source side and right on the twin side.
  const outward = v >= 0;
  const fromCentre = side === "left" ? (outward ? "right" : "left") : outward ? "left" : "right";
  const value = (
    <span
      className={`w-8 shrink-0 text-[12px] font-medium tabular-nums ${v < 0 ? "text-negative" : "text-ink"} ${side === "left" ? "text-left" : "text-right"}`}
    >
      {delta(cell.value, style)}
    </span>
  );
  return (
    <span className="flex items-center gap-1.5" data-value={cell.value}>
      {side === "left" ? value : null}
      <span className="relative block h-[9px] min-w-0 flex-1" aria-hidden="true">
        <span className="absolute -top-2 -bottom-2 left-1/2 w-px bg-line-strong" />
        <span
          className={`absolute inset-y-0 ${v < 0 ? "bg-negative" : "bg-data"}`}
          style={{ [fromCentre]: "50%", width: `${share.toFixed(2)}%` }}
          data-bar={outward ? "out" : "in"}
        />
      </span>
      {side === "right" ? value : null}
    </span>
  );
}

// Table ------------------------------------------------------------------------------------------------

/**
 * The table view: the twin score and tag count of every candidate, then every tag of the union with
 * d(t) in the source and in each candidate; a tag a measured candidate's comparison lacks says so,
 * and an unmeasured candidate gives its reason in every row.
 */
export function twinTableSpec(data: TwinPayload, caption: string, style: NumberStyle) {
  const columns: TableColumn[] = [
    { label: "Tag" },
    { label: `${data.source.label} (source)`, numeric: true },
    ...data.candidates.map((c) => ({ label: c.area.label, numeric: true })),
  ];
  // Section heads are set in capitals, which would turn ρ into Ρ: the heading spells it out.
  const rows: TableRow[] = [{ key: "section-score", section: "Twin score (Spearman rank correlation over the union of tags)" }];
  rows.push({
    key: "rho",
    cells: ["ρ", "—", ...data.candidates.map((c) => cellText(c.rho, "stat", { digits: 2, ...style }))],
  });
  rows.push({ key: "n", cells: ["Tags compared", "—", ...data.candidates.map((c) => String(c.n))] });
  rows.push({
    key: "shared",
    cells: ["Shared traits", "—", ...data.candidates.map((c) => String(c.shared.length))],
  });

  // Every tag of every comparison, the source's strongest gains first.
  const tags = new Map<string, TwinTag>();
  for (const c of data.candidates) for (const t of c.tags) if (!tags.has(t.key)) tags.set(t.key, t);
  const ordered = [...tags.values()].sort(
    (a, b) => (b.source.value ?? -Infinity) - (a.source.value ?? -Infinity) || a.label.localeCompare(b.label),
  );
  rows.push({ key: "section-tags", section: `Rank gain over the city, clipped at ±${data.clip}` });
  for (const tag of ordered) {
    const cells: TableCell[] = [
      tag.label,
      cellText(tag.source, "delta", { digits: 0, ...style }),
      ...data.candidates.map((c): TableCell => {
        const own = c.tags.find((t) => t.key === tag.key);
        if (!own) return { kind: "missing", reason: c.tags.length === 0 ? reasonLabel(c.rho.reason) : "not in this comparison" };
        const text = cellText(own.target, "delta", { digits: 0, ...style });
        const mark = c.shared.includes(tag.key) ? " · shared" : c.difference.includes(tag.key) ? " · key difference" : "";
        return text.kind === "value" ? { kind: "value", text: `${text.text}${mark}` } : text;
      }),
    ];
    rows.push({ key: `tag-${tag.key}`, cells });
  }
  return { caption, columns, rows };
}
