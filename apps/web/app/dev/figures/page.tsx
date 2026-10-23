import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import {
  DivergingBars,
  Exhibit,
  FigurePending,
  MatrixGrid,
  QuadrantScatter,
  RankedTable,
  ScorecardList,
  ScorecardTable,
  slateToRanked,
} from "../../../components/figures";
import {
  EXPECTED_RIVALS,
  FIXTURE_SOURCES as SRC,
  SCORECARD_BINDINGS,
  ageIndexPair,
  agePeers,
  annotatedSimilarityMap,
  areaBrandShifts,
  blockDna,
  domainLists,
  marginBrands,
  metroSplit,
  nearestAudiences,
  priorsScorecard,
  shareGrid,
  similarityMap,
  sponsorQuadrant,
  sponsorSlate,
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
          MatrixGrid, RankedTable, DivergingBars, QuadrantScatter and ScorecardTable in every mode, from invented
          fixtures. Each figure has a table view and a method link; nothing here is Qloo data.
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

      <Section id="exhibit" title="Exhibit" note="The dispatcher picks the family from the dataset kind and carries the fixed caption">
        <Column>
          <Exhibit dataset={sponsorSlate} id="fig-17" number={17} title="A Slate envelope through Exhibit" display={{ Slate: { tick: 0.7 } }} />
          <FigurePending id="fig-18" number={18} title="A figure still computing" note="Plot · computing in QUANT" />
        </Column>
      </Section>
    </main>
  );
}

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
