import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { SiteShell } from "../../../components/chrome/site-shell";
import { PlotsSection } from "./plots-section";
import {
  DivergingBars,
  Exhibit,
  FigurePending,
  LiftMap,
  MatrixGrid,
  MomentumStrip,
  PositionCard,
  QuadrantScatter,
  RankedTable,
  ScorecardList,
  ScorecardTable,
  SlopeChart,
  geoLiftBars,
  slateToRanked,
} from "../../../components/figures";
import {
  EXPECTED_RIVALS,
  FIXTURE_SOURCES as SRC,
  SCORECARD_BINDINGS,
  ageDumbbellSelfDescribed,
  ageIndexPair,
  agePeers,
  annotatedSimilarityMap,
  areaBrandShifts,
  austinLiftMap,
  blockDna,
  coarseLiftMap,
  codedSimilarityMap,
  domainLists,
  marginBrands,
  marketSlope,
  metroSplit,
  metroSplitSelfDescribed,
  momentumStrip,
  nearestAudiences,
  nearestWithRivals,
  priorsScorecard,
  shareGrid,
  similarityMap,
  sponsorQuadrant,
  sponsorSlate,
  tasteMap,
  tasteMapThree,
  tastePosition,
  tastePositionNoSignal,
  tenantSlope,
} from "../../../components/figures/fixtures";

// Development gallery: the answer-page plots and maps in their ChartCards, then every legacy figure family
// in every mode (the chart sheet and Table views use them), drawn from invented fixtures (D29).

export const metadata: Metadata = {
  title: "Figures · dev gallery",
  robots: { index: false, follow: false },
};

export default function FiguresGallery() {
  if (process.env.NODE_ENV === "production") notFound();
  return (
    <SiteShell mainClassName="pt-10 pb-24">
      <header className="flex flex-col gap-3 pb-8">
        <span className="type-label text-ink-2">Culture Terminal · dev</span>
        <h1 className="m-0 type-display-m text-ink">Charts and maps</h1>
        <p className="m-0 max-w-[744px] type-lead text-ink-2">
          The answer-page plots, the map card and the area map, then every figure family the chart sheet and the
          Table views use, all from invented rows. Nothing here is Qloo data.
        </p>
      </header>

      <Section id="plots" title="Answer charts" note="Every plot primitive in its ChartCard, at the answer grid spans">
        <PlotsSection />
      </Section>

      <Section id="a05" title="A05 · Brief, brand health" note="Lollipop at 384 px beside the pairwise matrix at 272 px">
        <div className="flex max-w-page flex-wrap items-start gap-6">
          <div className="w-[552px] max-w-full">
            <RankedTable
              data={nearestAudiences.payload}
              variant="lollipop"
              width={384}
              id="fig-1"
              title={
                <>
                  Its nearest audience is a tonic, not a rival<sup className="text-[0.6em] text-accent">7</sup>
                </>
              }
              label="Its nearest audience is a tonic, not a rival"
              caption="Audience similarity, 0–1. Grey: rivals we expected."
              comparisonKeys={EXPECTED_RIVALS}
              cut={{ after: 5, label: "Top five above" }}
              source={SRC.insights}
              formulaId="subs.similarity"
            />
          </div>
          <div className="w-[360px] max-w-full">
            <MatrixGrid
              data={similarityMap.payload}
              id="fig-2"
              title="Its two nearest peers are not its rivals"
              caption="Pairwise audience similarity."
              showMargin={false}
              source={SRC.pairs}
              formulaId="subs.similarity"
            />
          </div>
        </div>
      </Section>

      <Section id="matrix" title="MatrixGrid" note="Rank-in-row glyphs, hub margin, a cell and a row annotation; a share grid with sections">
        <Column>
          <MatrixGrid
            data={annotatedSimilarityMap.payload}
            width={680}
            glyph="rank"
            id="fig-3"
            title="Brand Alpha and Brand Beta share an audience"
            caption="Pairwise audience similarity, 0–1, with each cell's rank in its row and the hub score per column."
            source={SRC.pairs}
            formulaId="subs.rank_in_row"
          />
          <MatrixGrid
            data={shareGrid.payload}
            width={680}
            id="fig-4"
            title="Juniper Cola leads in two metros and under 30"
            caption="Share of taste within each call; rows sum to 1 across the three brands."
            source={SRC.insights}
            formulaId="share.pct"
          />
        </Column>
      </Section>

      <Section id="ranked" title="RankedTable" note="Lollipop at full width; the A07 table variant from a Slate payload; the quadrant">
        <Column>
          <RankedTable
            data={nearestAudiences.payload}
            id="fig-5"
            title="Brand Alpha ranks fourth and Brand Beta sixth"
            caption="Audience similarity, 0–1. Grey: rivals we expected."
            comparisonKeys={EXPECTED_RIVALS}
            cut={{ after: 5, label: "Top five above" }}
            source={SRC.insights}
            formulaId="subs.similarity"
          />
          <RankedTable
            data={slateToRanked(sponsorSlate.payload)}
            variant="table"
            labelHeader="Best fit"
            sublabelHeader="Category"
            tick={0.7}
            flagNotes={{ UTR: 5 }}
            id="fig-6"
            title="Beer leads, and its best fit is an ale most sponsors would miss"
            caption="Best fit per category. Fit = taste overlap with The Velvet Lanterns listeners, 0–1; tick at 0.70."
            source={SRC.slate}
            formulaId="slate.best_fit"
          />
          <QuadrantScatter
            data={sponsorQuadrant.payload}
            id="fig-7"
            title="Only one category winner sits in the under-the-radar corner"
            caption="Fit (0–1) against popularity percentile within category. Grey: other candidates."
            source={SRC.scatter}
            formulaId="slate.under_the_radar"
          />
        </Column>
      </Section>

      <Section id="a04" title="A04 · Brief, compare two brands" note="Split around an even share; dumbbell around the 0 baseline of the DNA index">
        <Column>
          <DivergingBars
            data={metroSplit.payload}
            display="split"
            labelHeader="Metro"
            id="fig-8"
            title="Juniper Cola leads in Portland and Seattle; Brand Alpha holds Austin and Atlanta"
            caption="Share of taste by metro, within call. Bar = Juniper Cola's lead within the pair; the shaded band (±.02) reads as even."
            source={SRC.computed}
            formulaId="share.metros_won"
          />
          <DivergingBars
            data={ageIndexPair.payload}
            display="dumbbell"
            labelHeader="Age"
            baselineLabel="0 = avg"
            id="fig-9"
            title="Juniper Cola peaks at 25–29; Brand Alpha from 35 to 54"
            caption="Age index, −1 to 1 (0 = average audience). The line is the gap between the two brands."
            source={SRC.demographics}
            formulaId="dna.age_index"
          />
        </Column>
      </Section>

      <Section id="a08" title="A08 · Brief, audience" note="Dumbbell with a delta column; ranked lists; margin figures at 300 px">
        <div className="flex flex-wrap items-start gap-[60px]">
          <Column>
            <DivergingBars
              data={agePeers.payload}
              display="dumbbell"
              deltaColumn
              deltaHeader="VS PEERS"
              labelWidth={72}
              baselineLabel="0 = avg"
              id="fig-10"
              title="The audience peaks at 25–29 and thins after 45"
              caption="Affinity index, −1 to 1 (0 = average). Grey: average of 6 beverage peers, within call."
              source={SRC.demographics}
              formulaId="dna.age_index"
            />
            <RankedTable
              data={domainLists.payload}
              variant="lists"
              id="fig-11"
              title="Its neighbourhood: slow radio and quiet drama"
              caption="Percentile within each domain's call, top items per domain."
              source={SRC.insights}
              formulaId="xdom.under_the_radar"
            />
          </Column>
          <div className="flex w-[300px] max-w-full flex-col gap-7">
            <RankedTable
              data={marginBrands.payload}
              variant="bars"
              id="fig-12"
              title="Outdoor goods and clean beauty"
              source={SRC.brands}
              formulaId="xdom.under_the_radar"
            />
            <RankedTable
              data={areaBrandShifts.payload}
              variant="bars"
              numberStyle={{ digits: 0 }}
              id="fig-13"
              title="Cafés gain on the block; chains lose"
              source={SRC.insights}
              formulaId="block.rank_delta"
            />
          </div>
        </div>
      </Section>

      <Section id="bars" title="DivergingBars" note="Diverging deltas vs the city with NEW notches; signed butterfly for two series">
        <Column>
          <DivergingBars
            data={blockDna.payload}
            labelHeader="Tag"
            id="fig-14"
            title="Natural wine and live music are new on the block"
            caption="Rank gain of each tag in the area over its rank city-wide. NEW: absent from the city top 50."
            source={SRC.insights}
            formulaId="block.rank_delta"
          />
          <DivergingBars
            data={ageIndexPair.payload}
            display="butterfly"
            labelHeader="Age"
            id="fig-15"
            title="Two age profiles, mirrored"
            caption="Age index, −1 to 1. Each panel reads outward from its zero line (the average audience); bars below zero point to the centre."
            source={SRC.demographics}
            formulaId="dna.age_index"
          />
        </Column>
      </Section>

      <Section id="scorecard" title="ScorecardTable" note="Priors framed as a figure; the bare list with live waiting states">
        <Column>
          <ScorecardTable
            data={priorsScorecard.payload}
            bindings={SCORECARD_BINDINGS}
            id="fig-16"
            title="Four priors, written before any data"
            caption="Each prior is judged against the metrics it cites."
            source={SRC.priors}
          />
          <div className="border-t border-ink">
            <ScorecardList
              data={priorsScorecard.payload}
              bindings={SCORECARD_BINDINGS}
              pending={{ H3: "AWAITING_DATA", H4: "AWAITING_CHECK" }}
              waitingNote="Written before data · 09:12:04"
            />
          </div>
        </Column>
      </Section>

      <Section id="a06" title="A06 · Brief, location" note="The lift map with its Extra interest / All interest switch, the lift per neighbourhood as dots, the tenant slope">
        <Column>
          <LiftMap
            data={austinLiftMap.payload}
            id="fig-19"
            title="The fit sits east of the interstate, strongest in Govalle"
            caption="Lift vs the restaurant baseline (1.00×) for a natural-wine and vinyl audience. Circle size = lift; confidence is the cells' opacity."
            source={SRC.heatmap}
            formulaId="lift.area"
          />
          <DivergingBars
            data={geoLiftBars(austinLiftMap.payload)}
            display="dumbbell"
            labelHeader="Neighbourhood"
            directionLabels={["← UNDER", "OVER →"]}
            baselineLabel="1.00"
            id="fig-20"
            title="Downtown sits just under the baseline; the east side over-indexes"
            caption="Lift vs the restaurant baseline; dots right of the 1.00 line over-index. Two neighbourhoods have too few cells to claim a lift."
            source={SRC.heatmap}
            formulaId="lift.area"
          />
          <SlopeChart
            data={tenantSlope.payload}
            id="fig-21"
            title="A wine bar and a record shop climb most from the city to the site"
            caption="FIT among the 9 brands ranked in both calls, Austin → East Cesar Chavez. Highlighted: the three largest climbs."
            source={SRC.tenant}
            formulaId="tenant.fit"
          />
        </Column>
      </Section>

      <Section id="liftmap" title="LiftMap" note="A coarse map (no neighbourhood claims) opens on all interest; the half-width map; the static schematic without map code">
        <Column>
          <LiftMap
            data={coarseLiftMap.payload}
            id="fig-22"
            title="At geohash 4 the map cannot name a neighbourhood"
            caption="Coarse cells only: the precision factor is 0, so no neighbourhood gets a lift."
            source={SRC.heatmap}
            formulaId="lift.confidence"
          />
          <div className="grid gap-6 sm:grid-cols-2">
            <LiftMap
              data={austinLiftMap.payload}
              width={328}
              id="fig-23"
              title="The map at half width"
              caption="The compact map labels four neighbourhoods."
              source={SRC.heatmap}
              formulaId="lift.area"
            />
            <LiftMap
              data={austinLiftMap.payload}
              width={328}
              interactive={false}
              initialMode="BASE"
              id="fig-24"
              title="Static schematic"
              caption="interactive={false}: the server drawing, without the map code."
              source={SRC.heatmap}
              formulaId="lift.area"
            />
          </div>
        </Column>
      </Section>

      <Section id="slope" title="SlopeChart" note="Three contexts with a dropped point; the tenant slope at half width">
        <Column>
          <SlopeChart
            data={marketSlope.payload}
            id="fig-25"
            title="Larkspur Kombucha gains most outside the national ranking"
            caption="FIT within each market's call, re-ranked over the slate. One brand was dropped from the Austin call."
            source={SRC.slate}
            formulaId="slate.market_alignment"
          />
          <div className="w-[360px] max-w-full">
            <SlopeChart
              data={tenantSlope.payload}
              width={328}
              id="fig-26"
              title="Tenant slope, half width"
              caption="Without the score column."
              source={SRC.tenant}
              formulaId="tenant.rank_shift"
            />
          </div>
        </Column>
      </Section>

      <Section id="momentum" title="MomentumStrip" note="Rising, flat and declining series, a scale break, a clipped outlier, NO SIGNAL and no data">
        <Column>
          <MomentumStrip
            data={momentumStrip.payload}
            asOf="2026-10-14"
            id="fig-27"
            title="Juniper Cola rose through the window; Brand Beta fell"
            caption="Population percentile by ISO week, Mar–Aug 2026. Historical: nothing after the window is drawn."
            source={SRC.trending}
            formulaId="mom.delta_26w"
          />
          <div className="w-[360px] max-w-full">
            <MomentumStrip
              data={momentumStrip.payload}
              width={328}
              id="fig-28"
              title="The strip at half width"
              source={SRC.trending}
              formulaId="mom.label"
            />
          </div>
        </Column>
      </Section>

      <Section id="position" title="PositionCard" note="Five axes with peer ranks and badges, no composite; the margin card with momentum unavailable">
        <div className="flex flex-wrap items-start gap-[60px]">
          <Column>
            <PositionCard
              data={tastePosition.payload}
              figureHrefs={{ D1: "#fig-2", D8: "#fig-9", D7: "#fig-8", D19: "#fig-27" }}
              id="fig-29"
              title="Distinctive and young, mid-pack on reach"
              caption="Each axis is measured against the same 6 peers; there is no overall score."
              source={SRC.position}
              formulaId="subs.distinctiveness"
            />
          </Column>
          <div className="flex w-[300px] max-w-full flex-col gap-7">
            <PositionCard
              data={tastePositionNoSignal.payload}
              id="fig-30"
              title="Momentum has no signal"
              source={SRC.position}
            />
          </div>
        </div>
      </Section>

      <Section id="contract" title="Contract fields" note="AxisItem.code, RankedRow.comparison, and BarsPayload.display / baseline / evenBand, with no display options passed">
        <div className="flex flex-wrap items-start gap-6">
          <div className="w-[360px] max-w-full">
            <MatrixGrid
              data={codedSimilarityMap.payload}
              id="fig-31"
              title="Codes from the payload"
              caption="JNP, ALF, BET … come from AxisItem.code."
              showMargin={false}
              source={SRC.pairs}
              formulaId="subs.similarity"
            />
          </div>
          <div className="w-[552px] max-w-full">
            <RankedTable
              data={nearestWithRivals.payload}
              width={384}
              id="fig-32"
              title="Grey rows from the payload"
              caption="The rivals carry RankedRow.comparison; no comparisonKeys passed."
              source={SRC.insights}
              formulaId="subs.similarity"
            />
          </div>
          <Column>
            <DivergingBars
              data={metroSplitSelfDescribed.payload}
              labelHeader="Metro"
              id="fig-33"
              title="A split the payload asked for, with a ±.03 even band"
              caption="display, baseline and evenBand come from the payload."
              source={SRC.computed}
              formulaId="share.pair_split"
            />
            <DivergingBars
              data={ageDumbbellSelfDescribed.payload}
              labelHeader="Age"
              baselineLabel="0 = avg"
              id="fig-34"
              title="A dumbbell the payload asked for"
              caption="display: dumbbell, baseline 0, from the payload."
              source={SRC.demographics}
              formulaId="dna.age_index"
            />
          </Column>
        </div>
      </Section>

      <Section id="exhibit" title="Exhibit" note="The dispatcher picks the family from the dataset kind and carries the fixed caption; one envelope per kind">
        <Column>
          <Exhibit dataset={sponsorSlate} id="fig-17" title="A Slate envelope through Exhibit" display={{ Slate: { tick: 0.7 } }} />
          <FigurePending id="fig-18" title="A figure still computing" note="Plot · computing in QUANT" />
          <Exhibit dataset={tasteMapThree} id="fig-90" title="Three screened brands: listed, not mapped" />
          {EXHIBIT_KINDS.map((dataset, i) => (
            <Exhibit key={dataset.id} dataset={dataset} id={`fig-${35 + i}`} display={{ GeoLift: { interactive: false } }} />
          ))}
        </Column>
      </Section>
    </SiteShell>
  );
}

/** One envelope of every DatasetKind, in DatasetKind order. */
const EXHIBIT_KINDS = [
  similarityMap,
  sponsorQuadrant,
  blockDna,
  tenantSlope,
  austinLiftMap,
  nearestAudiences,
  sponsorSlate,
  momentumStrip,
  priorsScorecard,
  tastePosition,
  tasteMap,
] as const;

function Section({ id, title, note, children }: { id: string; title: string; note: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="flex flex-col gap-6 pt-12">
      <div className="flex flex-col gap-1 border-b border-line pb-3">
        <h2 id={`${id}-title`} className="m-0 type-title text-ink">
          {title}
        </h2>
        <span className="type-label text-ink-2">{note}</span>
      </div>
      {children}
    </section>
  );
}

function Column({ children }: { children: ReactNode }) {
  return <div className="flex w-full max-w-[744px] flex-col gap-6">{children}</div>;
}
