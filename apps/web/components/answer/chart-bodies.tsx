import type { ChartBody } from "../../lib/answer";
import {
  BarList,
  ClimbLegend,
  DataRows,
  DivergingPair,
  DivergingRows,
  MiniBarColumns,
  NeighbourColumns,
  NumberedList,
  RankedFitList,
  RankTrackList,
  Scoreboard,
  SlateTable,
  VerdictList,
  WinnerTable,
  plotTags,
  type PlotTag,
} from "../plots";

/**
 * The plot inside each of the answer's chart cards: an answer chart body (lib/answer) drawn with the plot
 * primitives (components/plots). The map card draws its own (./map-card).
 */

const gem = (on: boolean): PlotTag | null => (on ? "hidden-gem" : null);

/** A row's chips (R3 "You named" / "Expected", R4 "Already there …") after its own tag. */
const withMarks = (tag: PlotTag | null | undefined, marks: readonly string[] | undefined): PlotTag | null =>
  plotTags(tag, (marks ?? []).map((label) => ({ tone: "muted" as const, label })));

/**
 * Block DNA deltas ("+38", "−24") on the diverging pair's ratio scale: 2^(v / max), so a bar's length (its
 * log2 distance from 1) is proportional to |v| and the longest bar is the largest change. The printed value
 * is the run's own.
 */
const ratioOf = (fraction: number, more: boolean) => 2 ** (more ? fraction : -fraction);

export function ChartBodyView({ body, label }: { body: ChartBody; label: string }) {
  switch (body.type) {
    case "bars":
      return (
        <BarList
          label={label}
          max={1}
          rows={body.rows.map((r) => ({ label: r.label, sublabel: r.sublabel, value: r.fraction, display: r.display, tone: r.tone === "accent" ? "accent" : "muted", tag: withMarks(r.tag, r.marks) }))}
        />
      );
    case "winner":
      return (
        <div className="flex flex-col gap-5">
          {body.score ? <Scoreboard a={{ name: body.a, score: body.score.a }} b={{ name: body.b, score: body.score.b }} caption={body.score.label} /> : null}
          <div className="grid items-start gap-x-10 gap-y-5 min-[900px]:grid-cols-2">
            {body.tables.map((t) => (
              <WinnerTable key={t.title} label={`${label}: ${t.title}`} title={t.title} a={{ name: body.a }} b={{ name: body.b }} rows={t.rows} />
            ))}
          </div>
        </div>
      );
    case "more-less":
      return (
        <MiniBarColumns
          label={label}
          baseline={null}
          columns={[
            { label: body.heads?.[0] ?? "More here", tone: "accent", rows: body.more.map((r) => ({ label: r.label, value: r.fraction, display: r.display, tag: r.tag })) },
            { label: body.heads?.[1] ?? "Less here", tone: "second", rows: body.less.map((r) => ({ label: r.label, value: r.fraction, display: r.display, tag: r.tag })) },
          ]}
        />
      );
    case "pair":
      return (
        <DivergingPair
          label={label}
          groups={body.rows.map((r, i) => ({
            key: `${r.group}-${i}`,
            label: r.group,
            less: r.less ? { label: r.less.label, value: ratioOf(r.less.fraction, false), display: r.less.display } : null,
            more: r.more ? { label: r.more.label, value: ratioOf(r.more.fraction, true), display: r.more.display } : null,
          }))}
        />
      );
    case "fit":
      return (
        <div className="flex flex-col gap-4">
          {body.rows.some((r) => r.climbs) ? <ClimbLegend label={body.climbLabel} /> : null}
          <RankedFitList label={label} max={1} climbLabel={body.climbLabel} rows={body.rows.map((r) => ({ label: r.label, value: r.fraction, display: r.display, climbs: r.climbs }))} />
        </div>
      );
    case "slate":
      return (
        <SlateTable
          label={label}
          rows={body.rows.map((r) => ({ category: r.category, icon: r.icon, name: r.best, href: r.href, fit: r.best ? r.fraction : null, display: r.display, tag: withMarks(gem(r.gem), r.marks) }))}
        />
      );
    case "numbered":
      return <NumberedList label={label} items={body.rows.map((r) => ({ name: r.label, tag: withMarks(gem(r.gem), r.marks) }))} />;
    case "neighbours":
      return (
        <NeighbourColumns
          label={label}
          columns={body.columns.map((c) => ({ key: c.key, label: c.label, icon: c.icon, items: c.items.map((r) => ({ name: r.label, href: r.href, tag: withMarks(gem(r.gem), r.marks) })) }))}
        />
      );
    case "diverging":
      return <DivergingRows label={label} minDomain={body.max} rows={body.rows.map((r) => ({ label: r.label, value: r.value, display: r.display }))} />;
    case "ranks":
      return <RankTrackList label={label} rows={body.rows.map((r) => ({ label: r.label, sublabel: r.sublabel, rank: r.rank, of: r.of, tag: withMarks(gem(r.gem), r.marks) }))} />;
    case "verdicts":
      return (
        <VerdictList
          label={label}
          groups={body.groups.map((g) => ({ verdict: g.verdict, title: g.title, items: g.rows.map((r) => ({ name: r.label, note: r.display, href: r.href })) }))}
        />
      );
    case "rows":
      return <DataRows label={label} columns={body.columns} rows={body.rows} />;
    case "map":
      return null;
  }
}
