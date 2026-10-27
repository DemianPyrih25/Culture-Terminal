import type { ReactNode } from "react";
import { austinLiftMap, coarseLiftMap } from "../../../components/figures/fixtures";
import { AreaMap, LiftMapCard } from "../../../components/figures";
import {
  BarList,
  ChartGlyph,
  ClimbLegend,
  ColumnChart,
  DivergingPair,
  DivergingRows,
  MiniBarColumns,
  NeighbourColumns,
  NumberedList,
  RankTrack,
  RankTrackList,
  RankedFitList,
  Scoreboard,
  SlateTable,
  WinnerTable,
  barListTable,
  columnTable,
  divergingPairTable,
  divergingTable,
  miniBarTable,
  neighbourTable,
  numberedListTable,
  rankTrackTable,
  rankedFitTable,
  slateTable,
  winnerTable,
  type PlotTable,
} from "../../../components/plots";
import { ChartCard, ChartTable } from "../../../components/ui";
import {
  SECOND,
  SUBJECT,
  ageGroups,
  alsoLove,
  blockGroups,
  cities,
  closestAudiences,
  interest,
  markets,
  moreLess,
  neighbours,
  slate,
  tenantFit,
  travel,
  whoTheFansAre,
} from "./plot-fixtures";

/**
 * The answer-page plots in their ChartCards, at the spans the answer grid gives them (6 columns of 168 +
 * 24 inside 1128): every primitive, its Table view, an empty state and the two maps. Invented rows.
 */

function table(label: string, t: PlotTable) {
  return <ChartTable label={label} columns={t.columns} rows={t.rows} />;
}

function Row({ children, split }: { children: ReactNode; split?: "4+2" | "3+3" | "6" }) {
  const cls = split === "3+3" ? "lg:grid-cols-2" : split === "4+2" ? "lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]" : "";
  return <div className={`grid grid-cols-1 items-stretch gap-6 max-md:gap-4 ${cls}`}>{children}</div>;
}

const A = { name: SUBJECT };
const B = { name: SECOND };

export function PlotsSection() {
  const t1 = "Its closest audience is a soap brand, not another water brand.";
  const t2 = "Fans lean female and 35–44.";
  const t3 = "The block has plenty of coffee and vintage, and little fine dining.";
  const t4 = `${SUBJECT} ranks first in every city; ${SECOND} takes only 25–29.`;
  const t5 = `${SUBJECT} ranks first in 4 of 6 markets.`;
  const t6 = "Govalle has more vinyl and natural wine than Austin overall.";
  const t7 = "A late-night noodle bar with music fits best.";
  const t8 = "Ridgeline Lager leads beer; two hidden gems beat bigger names.";
  const t9 = "Fans also like rugged, made-in-USA brands.";
  const t10 = "Fans also love The Paper Lanterns, Slow Simmer and Kitchen Detectives.";
  const t11 = "Their taste points to desert and mountain towns.";
  const t12 = "Interest rose from April to September 2025.";
  return (
    <div className="flex flex-col gap-6 max-md:gap-4" data-plots-gallery="true">
      <Row split="4+2">
        <ChartCard
          kind="Closest audiences"
          title={t1}
          legend={[
            { label: "Outside its category", tone: "accent" },
            { label: "Bottled water", tone: "muted" },
          ]}
          caption="1.00 = identical tastes. Shared taste, not shared customers."
          table={table(t1, barListTable(closestAudiences, { label: "Brand", sublabel: "Category", value: "Match" }))}
        >
          <BarList label={t1} rows={closestAudiences} max={1} />
        </ChartCard>
        <ChartCard kind="Empty state" title="A chart with no rows" caption="Missing data reads No data, never zero.">
          <BarList label="A chart with no rows" rows={[]} />
        </ChartCard>
      </Row>
      <Row split="3+3">
        <ChartCard
          kind="Who the fans are"
          title={t2}
          stacked
          caption="How much more or less each group likes it than average. Not shares of shoppers."
          table={table(t2, divergingTable(whoTheFansAre))}
        >
          <DivergingRows label={t2} rows={whoTheFansAre} />
        </ChartCard>
        <ChartCard kind="Interest over time" title={t12} table={table(t12, columnTable(interest))}>
          <ColumnChart label={t12} points={interest} after="No data after Sep 2025" />
        </ChartCard>
      </Row>
      <Row split="4+2">
        <ChartCard
          kind="What this area has more and less of"
          title={t3}
          caption="Compared with Nashville overall. Shared taste, not foot traffic."
          table={table(t3, divergingPairTable(blockGroups))}
        >
          <DivergingPair label={t3} groups={blockGroups} />
        </ChartCard>
        <ChartCard kind="Rank track" title="One market">
          <RankTrack rank={2} of={5} />
        </ChartCard>
      </Row>
      <Row split="4+2">
        <ChartCard
          kind="Who wins where"
          title={t4}
          caption="Rank within the pair: who leads, not by how much. Not sales share."
          table={
            <div className="flex flex-col gap-6">
              {table("Cities", winnerTable("Cities", A, B, cities))}
              {table("Age groups", winnerTable("Age groups", A, B, ageGroups))}
            </div>
          }
        >
          <div className="flex flex-col gap-5">
            <Scoreboard a={{ ...A, score: 4 }} b={{ ...B, score: 0 }} caption="cities where each ranks first" />
            <div className="grid gap-6 md:grid-cols-2 md:gap-10">
              <WinnerTable label={`${t4} Cities`} title="Cities" a={A} b={B} rows={cities} />
              <WinnerTable label={`${t4} Age groups`} title="Age groups" a={A} b={B} rows={ageGroups} />
            </div>
          </div>
        </ChartCard>
        <ChartCard
          kind="Where it out-draws other comedians"
          title={t5}
          caption="Rank among 5 comedians by fan taste in each market. Not ticket sales."
          table={table(t5, rankTrackTable(markets))}
        >
          <RankTrackList label={t5} rows={markets} />
        </ChartCard>
      </Row>
      <LiftMapCard data={austinLiftMap.payload} id="map-card" />
      <Row split="4+2">
        <ChartCard kind="What this area has more and less of" title={t6} table={table(t6, miniBarTable(moreLess))}>
          <MiniBarColumns label={t6} columns={moreLess} />
        </ChartCard>
        <LiftMapCard data={coarseLiftMap.payload} interactive={false} title="A coarse map" />
      </Row>
      <Row split="3+3">
        <AreaMap metro="nashville" area={{ name: "East Nashville" }} venues={[]} />
        <ChartCard
          kind="Best fit for this corner"
          title={t7}
          caption="Fit compares the block's taste with each tenant's fans. Not rent or revenue."
          table={table(t7, rankedFitTable(tenantFit))}
        >
          <div className="flex flex-col gap-3">
            <ClimbLegend />
            <RankedFitList label={t7} rows={tenantFit} />
          </div>
        </ChartCard>
      </Row>
      <ChartCard
        kind="Best fit per category"
        title={t8}
        caption="Taste fit only. No fees, availability or ROI data."
        table={table(t8, slateTable(slate))}
      >
        <SlateTable label={t8} rows={slate} />
      </ChartCard>
      <Row split="4+2">
        <ChartCard kind="What else they love" title={t9} table={table(t9, numberedListTable(alsoLove))}>
          <NumberedList label={t9} items={alsoLove} />
        </ChartCard>
        <ChartCard kind="More charts glyphs" title="Render boxes">
          <div className="grid grid-cols-2 gap-3">
            {(["bars", "diverging", "columns", "dots"] as const).map((g) => (
              <div key={g} className="rounded-sm bg-sunken p-1">
                <ChartGlyph kind={g} />
              </div>
            ))}
          </div>
        </ChartCard>
      </Row>
      <ChartCard
        kind="What else they love"
        title={t10}
        caption="Ranked by how much more these fans like them than average."
        table={table(t10, neighbourTable(neighbours))}
      >
        <NeighbourColumns label={t10} columns={neighbours} />
      </ChartCard>
      <ChartCard
        kind="Places their fans travel to"
        title={t11}
        caption="Places their fans are drawn to, not where they live."
        table={table(t11, barListTable(travel, { label: "Place", value: "Rank" }))}
      >
        <BarList label={t11} rows={travel} max={1} />
      </ChartCard>
    </div>
  );
}
