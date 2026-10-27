"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { DatasetEnvelope, RunState } from "@ct/contracts";
import { buildAnswerModel, datasetOf, type AnswerCell, type AnswerChart, type AnswerKeyNumber, type AnswerModel, type MoreChart } from "../../lib/answer";
import type { BriefModel } from "../../lib/brief";
import { PageHead, SiteShell, useShareLink, type MenuItem } from "../chrome";
import { useHowWeKnow } from "../drawer";
import { AreaMap } from "../figures/area-map";
import { LiftMapCard } from "../figures/lift-map-card";
import { Button, ChartCard, ChartTable, cx, Icon, IconButton, KeyNumber, Popover, Tag } from "../ui";
import { GUESS_CAPTION, GuessesCard, StateCard } from "../working";
import { AskNextCard } from "./ask-next";
import { AIAloneCard, ChangeCard, NextStepsCard, VerdictCard, WhyRow } from "./cards";
import { ChartBodyView } from "./chart-bodies";
import { useFetchedDatasets } from "./datasets";
import { ChartSheet, MoreCharts } from "./more-charts";

/**
 * The answer page (design/redesign.pen N05, N07–N12; phones N18): a finished run on /run/[id] and its
 * permalink /r/[id]. The page head, then rows of cards on a six-column grid: the verdict and next steps,
 * the key numbers, the job's charts and the guesses, AI alone and what could change this, why we think
 * this, more charts and ask next. Numbers and charts open How we know (the drawer around the page,
 * components/drawer); a chart under "More charts" opens in a sheet.
 */

/** What the page reads from the run besides the brief model (a full RunState fits). */
export type AnswerPageState = Pick<RunState, "resolves"> & Partial<Pick<RunState, "metrics" | "ghost" | "report" | "evidence">>;

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
}

/** Spans on the six-column grid from 900 px; below it every card takes the row. */
const SPAN: Readonly<Record<number, string>> = {
  2: "min-[900px]:col-span-2",
  3: "min-[900px]:col-span-3",
  4: "min-[900px]:col-span-4",
  6: "min-[900px]:col-span-6",
};

const ROW = "grid grid-cols-1 gap-6 max-md:gap-4 min-[900px]:grid-cols-6";

function KeyNumbers({ numbers }: { numbers: readonly AnswerKeyNumber[] }) {
  const how = useHowWeKnow();
  if (numbers.length === 0) return null;
  return (
    <section aria-label="Key numbers" className="grid grid-cols-1 gap-6 max-md:gap-4 min-[720px]:grid-cols-3" data-key-numbers={numbers.length}>
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

/** The page head's actions: How we know, Share and the ellipsis menu. */
function HeadActions({ permalink, replay }: { permalink: string; replay: string | null }) {
  const how = useHowWeKnow();
  const { share, toast } = useShareLink(permalink);
  const item = "flex h-10 w-full items-center gap-3 rounded-sm px-3 text-left text-[15px] leading-6 font-medium text-ink transition-colors hover:bg-sunken";
  return (
    <>
      {how.available ? (
        <Button variant="secondary" icon="shield-check" onClick={() => how.open({ tab: "summary" })}>
          How we know
        </Button>
      ) : null}
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
                  <Icon name="circle-play" size={18} className="text-ink-2" />
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
                <Icon name="download" size={18} className="text-ink-2" />
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
                <Icon name="link" size={18} className="text-ink-2" />
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

export function AnswerPage({ model, state, runId = model.runId, links, fallbackQuestion = null, datasets }: AnswerPageProps) {
  const fetched = useFetchedDatasets(model.evidence.figures, datasets);
  const run = useMemo(() => ({ resolves: state.resolves, ghost: state.ghost ?? null, report: state.report ?? null, metrics: state.metrics }), [state]);
  const answer = useMemo(() => buildAnswerModel(model, run, { datasets: fetched, fallbackQuestion }), [model, run, fetched, fallbackQuestion]);
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

  return (
    <SiteShell header="inner" mobileHeader="answer" sharePath={links.permalink} menuItems={menuItems} mainClassName="flex flex-col gap-6 pt-6 pb-12 max-md:gap-4 max-md:pt-4 max-md:pb-2">
      <div data-answer={answer.job ?? "unknown"} className="contents">
        <PageHead
          topic={head.topic}
          eyebrow={head.eyebrow}
          mobileEyebrow={head.mobileEyebrow}
          question={head.question}
          compare={head.compare ?? undefined}
          actions={<HeadActions permalink={links.permalink} replay={links.replay} />}
          className="pb-0.5"
        />

        <div className={ROW}>
          {model.terminal?.kind === "incomplete" ? (
            // A digest: the evidence is here, the conclusion is not; its numbers and charts stay below.
            <StateCard terminal={model.terminal} question={head.question} className={cx(answer.steps.length > 0 ? SPAN[4] : SPAN[6], "min-w-0")} />
          ) : (
            <VerdictCard verdict={verdict} topic={head.topic} className={cx(answer.steps.length > 0 ? SPAN[4] : SPAN[6], "min-w-0")} />
          )}
          {answer.steps.length > 0 ? <NextStepsCard steps={answer.steps} className={cx(SPAN[2], "min-w-0")} /> : null}
        </div>

        <KeyNumbers numbers={answer.keyNumbers} />

        {answer.rows.map((row, i) => (
          <div key={i} className={ROW} data-row={row.map((c) => c.slot).join("+")}>
            {row.map((cell) => (
              <Cell key={cell.slot} cell={cell} answer={answer} model={model} />
            ))}
          </div>
        ))}

        {rowE}

        <WhyRow why={answer.why} />

        <MoreCharts charts={answer.more} onOpen={openSheet} />

        <AskNextCard runId={runId} moves={answer.ask.moves} placeholder={answer.ask.placeholder} />
      </div>
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
export function RefusedAnswerPage({ model, fallbackQuestion = null, permalink }: { model: BriefModel; fallbackQuestion?: string | null; permalink: string }) {
  const answer = useMemo(() => buildAnswerModel(model, { resolves: [] }, { fallbackQuestion }), [model, fallbackQuestion]);
  return (
    <SiteShell header="inner" mobileHeader="answer" sharePath={permalink} mainClassName="flex flex-col gap-6 pt-6 pb-12 max-md:gap-4 max-md:pt-4 max-md:pb-2">
      <PageHead topic={answer.head.topic} eyebrow={answer.head.eyebrow} mobileEyebrow={answer.head.mobileEyebrow} question={answer.head.question} />
      {model.terminal ? (
        <div className={ROW}>
          <StateCard terminal={model.terminal} question={answer.head.question} className={cx(SPAN[4], "min-w-0")} />
        </div>
      ) : null}
    </SiteShell>
  );
}
