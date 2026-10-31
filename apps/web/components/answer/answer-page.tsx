"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { DatasetEnvelope, RunState } from "@ct/contracts";
import { buildAnswerModel, datasetOf, type AnswerCell, type AnswerChart, type AnswerKeyNumber, type AnswerModel, type MoreChart } from "../../lib/answer";
import type { BriefModel } from "../../lib/brief";
import { PageHead, SiteShell, useShareLink, type MenuItem } from "../chrome";
import { useHowWeKnow } from "../drawer";
import { AreaMap } from "../figures/area-map";
import { FollowMenu, noteFollowOptions } from "../following";
import { LiftMapCard } from "../figures/lift-map-card";
import { AreaStandingCard, supplyForMap } from "../figures/lift-standing";
import { SupplyTable } from "../figures/supply-table";
import { absoluteUrl, Button, ChartCard, ChartTable, cx, Icon, IconButton, KeyNumber, Popover, Tag } from "../ui";
import { GUESS_CAPTION, GuessesCard, StateCard } from "../working";
import { AnswerActionsSheet } from "./actions-sheet";
import { AskNextCard } from "./ask-next";
import { AIAloneCard, ChangeCard, ConceptNote, NextStepsCard, ReadAsNote, SECTION_LABEL, UnlistedNote, VerdictCard, WhyRow } from "./cards";
import { ChartBodyView } from "./chart-bodies";
import { ContextRow } from "./context-cards";
import { useFetchedDatasets } from "./datasets";
import { ChartSheet, MoreCharts } from "./more-charts";

/**
 * The answer page (design/redesign-v3.pen xU0kc, Lmw5N, V1IQB; phones puFRb, BPiz6): a finished run on
 * /run/[id] and its permalink /r/[id]. One reading column: the page head, the verdict block and next steps,
 * the key numbers, the job's charts and the guesses, the places already there, AI alone and what could
 * change this, why we think this, the context row, more charts and ask next. From 1280 px a quiet rail
 * beside it holds the How we know entry and the page's contents (last in the markup, so the reading order
 * stays the column's). Numbers and charts open How we know (the drawer around the page,
 * components/drawer); a chart under "More charts" opens in a sheet. On phones the head's actions sit in an
 * actions sheet.
 */

/** What the page reads from the run besides the brief model (a full RunState fits). */
export type AnswerPageState = Pick<RunState, "resolves"> &
  Partial<Pick<RunState, "metrics" | "ghost" | "report" | "evidence" | "intent" | "aiContext" | "webContext">>;

export interface AnswerPageProps {
  model: BriefModel;
  state: AnswerPageState;
  runId?: string;
  /** How the page came: a stored run (static), the end of a live run or of a replay. */
  mode?: "live" | "replay" | "static";
  /** The answer's own path (Share) and its replay (null hides "Watch it being made"). */
  links: { permalink: string; replay: string | null };
  fallbackQuestion?: string | null;
  /** Datasets the server already read for the first paint (a permalink's lift map); the rest are fetched. */
  datasets?: Readonly<Record<string, DatasetEnvelope>>;
  /** A reader's own question, not a curated showcase (D31): the page says it is unlisted. */
  unlisted?: boolean;
}

/** Spans on the six-column grid from 900 px; below it every card takes the row. */
const SPAN: Readonly<Record<number, string>> = {
  2: "min-[900px]:col-span-2",
  3: "min-[900px]:col-span-3",
  4: "min-[900px]:col-span-4",
  6: "min-[900px]:col-span-6",
};

const ROW = "grid grid-cols-1 gap-6 max-md:gap-4 min-[900px]:grid-cols-6";

/** A block of the reading column a contents link can land on. */
const ANCHOR = "scroll-mt-6";

/** One entry of the rail's contents: a block's id and its name. */
interface PageSection {
  id: string;
  label: string;
}

function KeyNumbers({ numbers }: { numbers: readonly AnswerKeyNumber[] }) {
  const how = useHowWeKnow();
  if (numbers.length === 0) return null;
  return (
    <section aria-label="Key numbers" className="grid grid-cols-1 gap-5 max-md:gap-4 min-[720px]:grid-cols-3" data-key-numbers={numbers.length}>
      {numbers.map((k) => {
        const onSource = how.available && k.footnote !== null ? () => how.open({ tab: "numbers", footnote: k.footnote ?? undefined }) : undefined;
        const selected = how.isOpen && k.footnote !== null && how.focused === k.footnote;
        if (k.variant === "split") return <KeyNumber key={k.key} variant="split" label={k.label} sides={k.sides} onSource={onSource} selected={selected} />;
        return (
          <KeyNumber
            key={k.key}
            variant={k.variant}
            value={k.value}
            label={k.label}
            context={k.context ?? undefined}
            tag={k.tag ? <Tag preset={k.tag} /> : undefined}
            onSource={onSource}
            selected={selected}
          />
        );
      })}
    </section>
  );
}

function AnswerChartCard({ chart, className }: { chart: AnswerChart; className?: string }) {
  const how = useHowWeKnow();
  const table = chart.table ? <ChartTable label={chart.title} columns={chart.table.columns} rows={chart.table.rows} /> : undefined;
  return (
    <ChartCard
      kind={chart.kind}
      title={chart.title}
      titleAs="h2"
      legend={chart.legend}
      table={table}
      stacked={chart.stacked}
      caption={chart.caption}
      onSource={how.available ? () => how.open({ figure: chart.datasetId }) : undefined}
      className={className}
    >
      <ChartBodyView body={chart.body} label={chart.title} />
    </ChartCard>
  );
}

function MapSlot({ answer, className }: { answer: AnswerModel; className?: string }) {
  const how = useHowWeKnow();
  const chart = answer.charts.map;
  if (chart && chart.body.type === "map" && chart.body.data) {
    return (
      <LiftMapCard
        data={chart.body.data}
        kind={chart.kind}
        title={chart.title}
        caption={chart.body.caption}
        headingLevel={2}
        onSource={how.available ? () => how.open({ figure: chart.datasetId }) : undefined}
        className={className}
        osm={supplyForMap(chart.body.data, answer.supply.map((s) => s.data))}
      />
    );
  }
  // The map is on its way: hold its place at the card's height so the page does not move when it lands.
  if (answer.mapPending) {
    return (
      <section
        aria-label="Map loading"
        aria-busy="true"
        data-map-pending="true"
        className={cx("h-[560px] rounded-card bg-sunken motion-safe:animate-pulse min-[900px]:h-[464px]", className)}
      />
    );
  }
  const area = answer.area;
  if (area) {
    return (
      <AreaMap
        metro={area.metro}
        area={{ name: area.name }}
        corner={area.corner ? undefined : null}
        title={area.corner ? `Your corner, ${area.label}` : area.label}
        caption={`Outline: ${area.label} boundary.`}
        className={className}
      />
    );
  }
  return null;
}

function Cell({ cell, answer, model }: { cell: AnswerCell; answer: AnswerModel; model: BriefModel }) {
  const span = cx(SPAN[cell.span], "min-w-0");
  if (cell.slot === "guesses") return <GuessesCard priors={model.priors.items} variant="side" caption={GUESS_CAPTION.finished} className={span} />;
  if (cell.slot === "map") return <MapSlot answer={answer} className={span} />;
  const chart = answer.charts[cell.slot];
  return chart ? <AnswerChartCard chart={chart} className={span} /> : null;
}

/** The page head's actions: How we know, Follow, Share and the ellipsis menu (Watch, Export, Copy link). */
function HeadActions({ permalink, replay, follow }: { permalink: string; replay: string | null; follow?: ReactNode }) {
  const how = useHowWeKnow();
  const { share, toast } = useShareLink(permalink);
  const item = "flex h-10 w-full items-center gap-3 rounded-sm px-3 text-left text-[14px] leading-5 font-medium text-ink transition-colors hover:bg-sunken";
  return (
    <>
      {how.available ? (
        <Button variant="secondary" icon="shield-check" onClick={() => how.open({ tab: "summary" })}>
          How we know
        </Button>
      ) : null}
      {follow}
      <Button variant="secondary" icon="share-2" onClick={share}>
        Share
      </Button>
      <Popover
        label="More actions"
        width={240}
        placement="bottom-end"
        trigger={(props) => (
          <IconButton {...props} label="More actions" icon="ellipsis" />
        )}
      >
        {(close) => (
          <ul className="flex flex-col gap-0.5 p-1" aria-label="More actions">
            {replay ? (
              <li>
                <Link href={replay} className={item} onClick={close}>
                  <Icon name="circle-play" size={16} className="text-ink-2" />
                  Watch it being made
                </Link>
              </li>
            ) : null}
            <li>
              <button
                type="button"
                className={item}
                onClick={() => {
                  close();
                  window.print();
                }}
              >
                <Icon name="download" size={16} className="text-ink-2" />
                Export
              </button>
            </li>
            <li>
              <button
                type="button"
                className={item}
                onClick={() => {
                  close();
                  share();
                }}
              >
                <Icon name="link" size={16} className="text-ink-2" />
                Copy link
              </button>
            </li>
          </ul>
        )}
      </Popover>
      {toast}
    </>
  );
}

/**
 * The rail beside the reading column from 1280 px (xU0kc's context rail): the How we know entry with the
 * check line, then the page's contents. Hidden below 1280: the head's How we know and the verdict's check
 * line are the way in there.
 */
function AnswerRail({ check, sections }: { check: AnswerModel["verdict"]["check"]; sections: readonly PageSection[] }) {
  const how = useHowWeKnow();
  return (
    <aside aria-label="About this answer" className="hidden min-w-0 xl:col-start-2 xl:row-start-1 xl:block">
      <div className="sticky top-6 flex flex-col gap-8">
        {how.available ? (
          <section aria-labelledby="rail-how" className="flex flex-col gap-3 rounded-card border border-line bg-surface p-5">
            <h2 id="rail-how" className="font-display text-[18px] leading-6 font-medium text-ink">
              How we know
            </h2>
            {check ? (
              <p className="flex items-start gap-2 text-[13px] leading-5 text-ink-2">
                <Icon name={check.ok ? "circle-check" : "triangle-alert"} size={14} className={cx("mt-[3px] shrink-0", check.ok ? "text-good" : "text-caution")} />
                {check.text}
              </p>
            ) : (
              <p className="text-[13px] leading-5 text-ink-2">Every number, its source and the method behind it.</p>
            )}
            <Button variant="secondary" size="sm" icon="shield-check" className="self-start" onClick={() => how.open({ tab: "summary" })}>
              Open How we know
            </Button>
          </section>
        ) : null}
        {sections.length > 1 ? (
          <nav aria-label="Contents of this answer" className="flex flex-col gap-2">
            <p className={SECTION_LABEL}>On this page</p>
            <ul className="flex flex-col border-l border-line">
              {sections.map((s) => (
                <li key={s.id}>
                  <a href={`#${s.id}`} className="-ml-px block border-l border-transparent py-1.5 pl-3 text-[13px] leading-5 text-ink-2 hover:border-ink hover:text-ink">
                    {s.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        ) : null}
      </div>
    </aside>
  );
}

/** The chart a ?chart=D3 link opens, if the answer lists it. */
function chartFromUrl(more: readonly MoreChart[]): MoreChart | null {
  if (typeof window === "undefined") return null;
  const id = new URLSearchParams(window.location.search).get("chart");
  return more.find((c) => c.datasetId === id) ?? null;
}

function writeChartParam(chart: MoreChart | null) {
  const params = new URLSearchParams(window.location.search);
  if (chart) params.set("chart", chart.datasetId);
  else params.delete("chart");
  const search = params.toString();
  const url = `${window.location.pathname}${search ? `?${search}` : ""}${window.location.hash}`;
  window.history.replaceState(window.history.state, "", url);
}

export function AnswerPage({ model, state, runId = model.runId, links, fallbackQuestion = null, datasets, unlisted = false }: AnswerPageProps) {
  const fetched = useFetchedDatasets(model.evidence.figures, datasets);
  const run = useMemo(
    () => ({
      resolves: state.resolves,
      ghost: state.ghost ?? null,
      report: state.report ?? null,
      metrics: state.metrics,
      intent: state.intent ?? null,
      evidence: state.evidence,
      aiContext: state.aiContext ?? null,
      webContext: state.webContext ?? null,
    }),
    [state],
  );
  const answer = useMemo(() => buildAnswerModel(model, run, { datasets: fetched, fallbackQuestion }), [model, run, fetched, fallbackQuestion]);
  const { share: copyLink, toast: shareToast } = useShareLink(links.permalink);
  // Share from the phone sheet: the system share sheet where there is one, else the link is copied.
  const shareNative = () => {
    const url = absoluteUrl(links.permalink);
    if (typeof navigator !== "undefined" && typeof navigator.share === "function") void navigator.share({ url, title: answer.head.question }).catch(() => undefined);
    else copyLink();
  };
  const [sheet, setSheet] = useState<MoreChart | null>(null);

  // A shared link with ?chart= opens its chart once the page is in the browser.
  useEffect(() => {
    const asked = chartFromUrl(answer.more);
    if (!asked) return;
    const timer = setTimeout(() => setSheet(asked), 0);
    return () => clearTimeout(timer);
    // Only on arrival: later changes come from the page itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openSheet = (chart: MoreChart | null) => {
    setSheet(chart);
    writeChartParam(chart);
  };
  const sheetFigure = sheet ? (model.evidence.figures.find((f) => f.datasetId === sheet.datasetId) ?? null) : null;

  const how = useHowWeKnow();
  const menuItems: MenuItem[] = [
    ...(how.available ? [{ label: "How we know", icon: "shield-check", onSelect: () => how.open({ tab: "summary" }) } satisfies MenuItem] : []),
    ...(links.replay ? [{ label: "Watch it being made", icon: "circle-play", href: links.replay } satisfies MenuItem] : []),
  ];
  const { head, verdict } = answer;
  // Following (§2.4): the note's brand, place and question, each a follow of its own.
  const followOptions = useMemo(
    () => noteFollowOptions(runId, { question: head.question, job: answer.job ?? null, intent: state.intent ?? null, resolves: state.resolves }),
    [runId, head.question, answer.job, state.intent, state.resolves],
  );
  const ghost = answer.ghost;
  // Row E: AI alone + Change, or Change + the guesses when the guesses had no chart beside them.
  const besideChange = !ghost && answer.guessesBesideChange;
  const rowE: ReactNode = (
    <div className={ROW} data-row-e={ghost ? "ghost+change" : besideChange ? "change+guesses" : "change"}>
      {ghost ? <AIAloneCard ghost={ghost} className={cx(SPAN[answer.ghostSpan], "min-w-0")} /> : null}
      <ChangeCard changes={answer.changes} className={cx(ghost ? SPAN[6 - answer.ghostSpan] : besideChange ? SPAN[4] : SPAN[6], "min-w-0")} />
      {besideChange ? <GuessesCard priors={model.priors.items} variant="side" caption={GUESS_CAPTION.finished} className={cx(SPAN[2], "min-w-0")} /> : null}
    </div>
  );

  const hasRows = answer.rows.some((row) => row.length > 0);
  const hasPlaces = answer.standing !== null || answer.supply.length > 0;
  const hasWhy = answer.why.count > 0 || (answer.why.thesis?.length ?? 0) > 0;
  const hasContext = answer.context.ai !== null || answer.context.web !== null;
  const sections: PageSection[] = [
    { id: "answer-verdict", label: model.terminal?.kind === "incomplete" ? "What we found" : "Verdict" },
    ...(answer.keyNumbers.length > 0 ? [{ id: "answer-numbers", label: "Key numbers" }] : []),
    ...(hasRows ? [{ id: "answer-figures", label: "Charts" }] : []),
    ...(hasPlaces ? [{ id: "answer-places", label: "Places already there" }] : []),
    { id: "answer-change", label: "What could change this" },
    ...(hasWhy ? [{ id: "answer-why", label: "Why we think this" }] : []),
    ...(hasContext ? [{ id: "answer-context", label: "Context" }] : []),
    ...(answer.more.length > 0 ? [{ id: "answer-more", label: "More charts" }] : []),
    { id: "answer-ask", label: "Ask next" },
  ];

  return (
    <SiteShell header="inner" mobileHeader="answer" sharePath={links.permalink} menuItems={menuItems} mainClassName="pt-8 pb-16 max-md:pt-4 max-md:pb-6">
      <div data-answer={answer.job ?? "unknown"} className="grid grid-cols-1 gap-x-10 xl:grid-cols-[minmax(0,1fr)_260px]">
        <div className="flex min-w-0 flex-col gap-14 max-md:gap-10 xl:col-start-1 xl:row-start-1">
          <div className="flex flex-col gap-6 max-md:gap-4">
            <PageHead
              topic={head.topic}
              eyebrow={head.eyebrow}
              mobileEyebrow={head.mobileEyebrow}
              question={head.question}
              compare={head.compare ?? undefined}
              actions={<HeadActions permalink={links.permalink} replay={links.replay} follow={<FollowMenu options={followOptions} />} />}
              mobileActions={
                <>
                  <FollowMenu options={followOptions} />
                  <AnswerActionsSheet question={head.question} replay={links.replay} onShare={shareNative} />
                </>
              }
            />
            {unlisted || answer.concept || answer.readAs ? (
              <div className="flex flex-col gap-2">
                {unlisted ? <UnlistedNote /> : null}
                {answer.concept ? <ConceptNote text={answer.concept} level={answer.conceptLevel} /> : null}
                {answer.readAs ? <ReadAsNote readAs={answer.readAs} /> : null}
              </div>
            ) : null}
          </div>

          <div id="answer-verdict" className={cx("flex flex-col gap-10 max-md:gap-8", ANCHOR)}>
            {model.terminal?.kind === "incomplete" ? (
              // A digest: the evidence is here, the conclusion is not; its numbers and charts stay below.
              <StateCard terminal={model.terminal} question={head.question} className="min-w-0" />
            ) : (
              <VerdictCard verdict={verdict} topic={head.topic} className="min-w-0" />
            )}
            {answer.steps.length > 0 ? <NextStepsCard steps={answer.steps} className="min-w-0" /> : null}
          </div>

          {answer.keyNumbers.length > 0 ? (
            <div id="answer-numbers" className={ANCHOR}>
              <KeyNumbers numbers={answer.keyNumbers} />
            </div>
          ) : null}

          {hasRows ? (
            <div id="answer-figures" className={cx("flex flex-col gap-6 max-md:gap-4", ANCHOR)}>
              {answer.rows.map((row, i) => (
                <div key={i} className={ROW} data-row={row.map((c) => c.slot).join("+")}>
                  {row.map((cell) => (
                    <Cell key={cell.slot} cell={cell} answer={answer} model={model} />
                  ))}
                </div>
              ))}
            </div>
          ) : null}

          {hasPlaces ? (
            <div id="answer-places" className={cx("flex flex-col gap-6 max-md:gap-4", ANCHOR)}>
              {answer.standing ? <AreaStandingCard data={answer.standing.data} supply={answer.standing.supply} /> : null}
              {answer.supply.map((s) => (
                <SupplyTable
                  key={s.datasetId}
                  data={s.data}
                  kind={s.data.mix ? "What the area already has" : "Places already there"}
                  title={s.title}
                  headingLevel={2}
                  formulaId={s.formulaId}
                  onSource={how.available ? () => how.open({ figure: s.datasetId }) : undefined}
                />
              ))}
            </div>
          ) : null}

          <div id="answer-change" className={ANCHOR}>
            {rowE}
          </div>

          {hasWhy ? (
            <div id="answer-why" className={ANCHOR}>
              <WhyRow why={answer.why} />
            </div>
          ) : null}

          {hasContext ? (
            <div id="answer-context" className={ANCHOR}>
              <ContextRow context={answer.context} />
            </div>
          ) : null}

          {answer.more.length > 0 ? (
            <div id="answer-more" className={ANCHOR}>
              <MoreCharts charts={answer.more} onOpen={openSheet} />
            </div>
          ) : null}

          <div id="answer-ask" className={ANCHOR}>
            <AskNextCard runId={runId} moves={answer.ask.moves} placeholder={answer.ask.placeholder} />
          </div>
        </div>
        <AnswerRail check={verdict.check} sections={sections} />
      </div>
      {shareToast}
      <ChartSheet
        chart={sheet}
        figure={sheetFigure}
        dataset={sheetFigure ? datasetOf(sheetFigure, fetched) : null}
        onClose={() => openSheet(null)}
      />
    </SiteShell>
  );
}

/**
 * A permalink of a question we declined (the run's refusal card): the page head and the refused card with
 * its suggested question. No numbers, so no drawer.
 */
export function RefusedAnswerPage({
  model,
  fallbackQuestion = null,
  permalink,
  unlisted = false,
}: {
  model: BriefModel;
  fallbackQuestion?: string | null;
  permalink: string;
  unlisted?: boolean;
}) {
  const answer = useMemo(() => buildAnswerModel(model, { resolves: [] }, { fallbackQuestion }), [model, fallbackQuestion]);
  return (
    <SiteShell header="inner" mobileHeader="answer" sharePath={permalink} mainClassName="flex flex-col gap-10 pt-8 pb-16 max-md:gap-6 max-md:pt-4 max-md:pb-6">
      <div className="flex flex-col gap-6 max-md:gap-4">
        <PageHead topic={answer.head.topic} eyebrow={answer.head.eyebrow} mobileEyebrow={answer.head.mobileEyebrow} question={answer.head.question} />
        {unlisted ? <UnlistedNote /> : null}
      </div>
      {model.terminal ? <StateCard terminal={model.terminal} question={answer.head.question} className="max-w-[760px] min-w-0" /> : null}
    </SiteShell>
  );
}
