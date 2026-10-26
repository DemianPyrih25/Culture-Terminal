import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import {
  CategoryMap,
  Constellation,
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
  TwinCards,
  geoLiftBars,
  slateToRanked,
} from "../../../components/figures";
import {
  EXPECTED_RIVALS,
  FIXTURE_SOURCES as SRC,
  NEIGHBOURHOOD_HALO,
  NEIGHBOURHOOD_SEEDS,
  SCORECARD_BINDINGS,
  ageDumbbellSelfDescribed,
  ageIndexPair,
  agePeers,
  annotatedSimilarityMap,
  areaBrandShifts,
  austinLiftMap,
  blockDna,
  categoryTasteMap,
  coarseLiftMap,
  codedSimilarityMap,
  domainLists,
  marginBrands,
  marketSlope,
  metroSplit,
  metroSplitSelfDescribed,
  momentumStrip,
  nearestAudiences,
  neighbourhood,
  nearestWithRivals,
  priorsScorecard,
  shareGrid,
  similarityMap,
  sponsorQuadrant,
  sponsorSlate,
  tastePosition,
  tasteTwins,
  tastePositionNoSignal,
  tenantSlope,
} from "../../../components/figures/fixtures";

// Development gallery: every figure family in every mode, drawn from invented fixtures (D29), laid
// out at the widths the Concept A frames use so it can be compared with design/exports/concept-a.

export const metadata: Metadata = {
  title: "Figures · dev gallery",
  robots: { index: false, follow: false },
};

export default function FiguresGallery() {
  if (process.env.NODE_ENV === "production") notFound();
  return (
    <main className="mx-auto w-full max-w-[1100px] px-4 pt-10 pb-24 md:px-[70px]">
      <header className="flex flex-col gap-2 border-b border-line pb-6">
        <span className="type-label text-accent">Culture Terminal · dev</span>
        <h1 className="m-0 font-serif text-[32px] leading-[40px] font-medium text-ink">Figures</h1>
        <p className="m-0 max-w-reading type-body text-dim">
          All nine families (MatrixGrid, RankedTable, DivergingBars, QuadrantScatter, ScorecardTable, SlopeChart,
          LiftMap, MomentumStrip and PositionCard) in every mode, then the P1 figures (Constellation, CategoryMap and
          TwinCards), from invented fixtures. Each figure has a table view and a method link; nothing here is Qloo data.
        </p>
      </header>

      <Section id="a05" title="A05 · Brief, brand health" note="Lollipop at 384 px beside the pairwise matrix at 272 px">
        <div className="flex max-w-reading flex-wrap items-start gap-6">
          <div className="w-[384px] max-w-full">
            <RankedTable
              data={nearestAudiences.payload}
              variant="lollipop"
              width={384}
              number={1}
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
          <div className="w-[272px] max-w-full">
            <MatrixGrid
              data={similarityMap.payload}
              number={2}
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
            number={3}
            id="fig-3"
            title="Brand Alpha and Brand Beta share an audience"
            caption="Pairwise audience similarity, 0–1, with each cell's rank in its row and the hub score per column."
            source={SRC.pairs}
            formulaId="subs.rank_in_row"
          />
          <MatrixGrid
            data={shareGrid.payload}
            width={680}
            number={4}
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
            number={5}
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
            number={6}
            id="fig-6"
            title="Beer leads, and its best fit is an ale most sponsors would miss"
            caption="Best fit per category. Fit = taste overlap with The Velvet Lanterns listeners, 0–1; tick at 0.70."
            source={SRC.slate}
            formulaId="slate.best_fit"
          />
          <QuadrantScatter
            data={sponsorQuadrant.payload}
            number={7}
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
            number={8}
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
            number={9}
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
              number={10}
              id="fig-10"
              title="The audience peaks at 25–29 and thins after 45"
              caption="Affinity index, −1 to 1 (0 = average). Grey: average of 6 beverage peers, within call."
              source={SRC.demographics}
              formulaId="dna.age_index"
            />
            <RankedTable
              data={domainLists.payload}
              variant="lists"
              number={11}
              id="fig-11"
              title="Its neighbourhood: slow radio and quiet drama"
              caption="Percentile within each domain's call, top items per domain."
              source={SRC.insights}
              formulaId="xdom.under_the_radar"
            />
          </Column>
          <div className="flex w-sidenotes max-w-full flex-col gap-7">
            <RankedTable
              data={marginBrands.payload}
              variant="bars"
              size="margin"
              aside="Percentile in call"
              number={12}
              id="fig-12"
              title="Outdoor goods and clean beauty"
              source={SRC.brands}
              formulaId="xdom.under_the_radar"
            />
            <RankedTable
              data={areaBrandShifts.payload}
              variant="bars"
              size="margin"
              aside="Rank gain vs city"
              numberStyle={{ digits: 0 }}
              number={13}
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
            number={14}
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
            number={15}
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
            number={16}
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

      <Section id="a06" title="A06 · Brief, location" note="The lift map (keys 1/2/3 switch RAW / BASE / LIFT), the lift per neighbourhood as dots, the tenant slope">
        <Column>
          <LiftMap
            data={austinLiftMap.payload}
            number={19}
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
            number={20}
            id="fig-20"
            title="Downtown sits just under the baseline; the east side over-indexes"
            caption="Lift vs the restaurant baseline; dots right of the 1.00 line over-index. Two neighbourhoods have too few cells to claim a lift."
            source={SRC.heatmap}
            formulaId="lift.area"
          />
          <SlopeChart
            data={tenantSlope.payload}
            number={21}
            id="fig-21"
            title="A wine bar and a record shop climb most from the city to the site"
            caption="FIT among the 9 brands ranked in both calls, Austin → East Cesar Chavez. Highlighted: the three largest climbs."
            source={SRC.tenant}
            formulaId="tenant.fit"
          />
        </Column>
      </Section>

      <Section id="liftmap" title="LiftMap" note="A coarse map (no neighbourhood claims) opens on RAW, press 3 for its faint lift; the half-width map; the static schematic without map code">
        <Column>
          <LiftMap
            data={coarseLiftMap.payload}
            number={22}
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
              number={23}
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
              number={24}
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
            number={25}
            id="fig-25"
            title="Larkspur Kombucha gains most outside the national ranking"
            caption="FIT within each market's call, re-ranked over the slate. One brand was dropped from the Austin call."
            source={SRC.slate}
            formulaId="slate.market_alignment"
          />
          <div className="w-[328px] max-w-full">
            <SlopeChart
              data={tenantSlope.payload}
              width={328}
              number={26}
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
            number={27}
            id="fig-27"
            title="Juniper Cola rose through the window; Brand Beta fell"
            caption="Population percentile by ISO week, Mar–Aug 2026. Historical: nothing after the window is drawn."
            source={SRC.trending}
            formulaId="mom.delta_26w"
          />
          <div className="w-[328px] max-w-full">
            <MomentumStrip
              data={momentumStrip.payload}
              width={328}
              number={28}
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
              number={29}
              id="fig-29"
              title="Distinctive and young, mid-pack on reach"
              caption="Each axis is measured against the same 6 peers; there is no overall score."
              source={SRC.position}
              formulaId="subs.distinctiveness"
            />
          </Column>
          <div className="flex w-sidenotes max-w-full flex-col gap-7">
            <PositionCard
              data={tastePositionNoSignal.payload}
              size="margin"
              aside="Among 7"
              number={30}
              id="fig-30"
              title="Momentum has no signal"
              source={SRC.position}
            />
          </div>
        </div>
      </Section>

      <Section id="contract" title="Contract fields" note="AxisItem.code, RankedRow.comparison, and BarsPayload.display / baseline / evenBand, with no display options passed">
        <div className="flex flex-wrap items-start gap-6">
          <div className="w-[272px] max-w-full">
            <MatrixGrid
              data={codedSimilarityMap.payload}
              number={31}
              id="fig-31"
              title="Codes from the payload"
              caption="JNP, ALF, BET … come from AxisItem.code."
              showMargin={false}
              source={SRC.pairs}
              formulaId="subs.similarity"
            />
          </div>
          <div className="w-[384px] max-w-full">
            <RankedTable
              data={nearestWithRivals.payload}
              width={384}
              number={32}
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
              number={33}
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
              number={34}
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
          <Exhibit dataset={sponsorSlate} id="fig-17" number={17} title="A Slate envelope through Exhibit" display={{ Slate: { tick: 0.7 } }} />
          <FigurePending id="fig-18" number={18} title="A figure still computing" note="Plot · computing in QUANT" />
          {EXHIBIT_KINDS.map((dataset, i) => (
            <Exhibit key={dataset.id} dataset={dataset} id={`fig-${35 + i}`} number={35 + i} display={{ GeoLift: { interactive: false } }} />
          ))}
        </Column>
      </Section>

      <Section
        id="constellation"
        title="Constellation"
        note="S9 in P1: two seeds with explainability edges, a domain the budget skipped and a gated result; one seed with spokes at half width. Tab to a domain to name all of it"
      >
        <Column>
          <Constellation
            data={neighbourhood.payload}
            seeds={NEIGHBOURHOOD_SEEDS}
            halo={NEIGHBOURHOOD_HALO}
            number={45}
            id="fig-45"
            title="Both brands live next to slow radio and outdoor goods"
            caption="Cultural neighbourhood of the two seeds. Distance from the centre = 1 − FIT within each domain's call; ringed: the domain's under-the-radar pick."
            source={SRC.neighbourhood}
            formulaId="xdom.edge"
          />
          <div className="w-[328px] max-w-full">
            <Constellation
              data={domainLists.payload}
              seeds={[{ ref: "R1", label: "Juniper Cola" }]}
              width={328}
              number={46}
              id="fig-46"
              title="One seed, half width"
              caption="Spokes carry the distance when there are no edges."
              source={SRC.insights}
              formulaId="xdom.under_the_radar"
            />
          </div>
        </Column>
      </Section>

      <Section
        id="taste-map"
        title="CategoryMap"
        note="Category Taste Map: 13 entities by classical MDS on 1 − similarity, near-substitutes joined, stress on the map; half width with coded labels. Tab to a point for its nearest peer"
      >
        <Column>
          <CategoryMap
            data={categoryTasteMap.payload}
            number={47}
            id="fig-47"
            title="Juniper Cola sits with the colas, a long way from the ales"
            caption="Category Taste Map: nearer means a more similar audience. Ringed: the subject. Lines join near-substitutes."
            source={SRC.tasteMap}
            formulaId="subs.similarity"
          />
          <div className="w-[328px] max-w-full">
            <CategoryMap
              data={categoryTasteMap.payload}
              width={328}
              number={48}
              id="fig-48"
              title="The taste map at half width"
              source={SRC.tasteMap}
              formulaId="subs.near_substitutes"
            />
          </div>
        </Column>
      </Section>

      <Section
        id="twins"
        title="TwinCards"
        note="S11 in P1: East Nashville and its Austin twin with mirrored DNA bars; a runner-up drawn against the same source; a candidate the budget never measured at half width"
      >
        <Column>
          <TwinCards
            data={tasteTwins.payload}
            number={49}
            id="fig-49"
            title="East Nashville's twin in Austin is Holly"
            caption="Rank gain of each tag over its own city (d, clipped at ±25). Twin score = Spearman ρ between the two areas' d over 14 tags."
            source={SRC.twins}
            formulaId="block.rank_delta"
          />
          <TwinCards
            data={tasteTwins.payload}
            candidateKey="east-cesar-chavez"
            maxRows={8}
            number={50}
            id="fig-50"
            title="East Cesar Chavez shares the wine, not the brunch"
            caption="The third candidate against the same source."
            source={SRC.twins}
            formulaId="block.rank_delta"
          />
          <div className="w-[328px] max-w-full">
            <TwinCards
              data={tasteTwins.payload}
              candidateKey="rosedale"
              number={51}
              id="fig-51"
              title="Rosedale was never measured"
              caption="No bars and no callouts for a candidate without a BLOCK call: only its reason."
              source={SRC.twins}
              formulaId="block.rank_delta"
            />
          </div>
        </Column>
      </Section>
    </main>
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
] as const;

function Section({ id, title, note, children }: { id: string; title: string; note: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="flex flex-col gap-6 pt-12">
      <div className="flex flex-wrap items-baseline gap-x-3 border-b border-line-strong pb-2">
        <h2 id={`${id}-title`} className="m-0 type-label text-ink">
          {title}
        </h2>
        <span className="font-ui text-[12px] text-dim">{note}</span>
      </div>
      {children}
    </section>
  );
}

function Column({ children }: { children: ReactNode }) {
  return <div className="flex w-full max-w-reading flex-col gap-7">{children}</div>;
}
