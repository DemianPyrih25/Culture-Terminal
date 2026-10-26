import type { Lane } from "@ct/contracts";
import type { ReactNode } from "react";
import { formatUsd, formatUtcDate } from "../../lib/brief/format";
import type { HourCount, StatusLevel, StatusReport } from "../../server/status";
import { BriefRow } from "../layout/brief-row";
import { GRID_COLUMNS_MD, GRID_COLUMNS_XL, SCROLL_ANCHOR_CLASS } from "../layout/grid";
import { Outline } from "../layout/outline";
import type { OutlineItem } from "../layout/scrollspy";
import { ButtonLink } from "../ui/button";
import { cx } from "../ui/cx";
import { MetaLine } from "../ui/meta-line";
import { SectionHead } from "../ui/section-head";
import {
  BREAKER_LABEL,
  breakerDetail,
  cacheRate,
  count,
  ENV_LABEL,
  formatUptime,
  LANE_LABEL,
  laneView,
  leadSentence,
  utcShort,
  utcTime,
} from "./format";
import { RunStrip } from "./run-strip";
import { Amount, LevelTag, NoteMark, StateTag, StatusNote, StatusRow, StatusRows } from "./status-rows";
import { UsageMeter } from "./usage-meter";

/** The page's sections, in order: the outline links to them. */
export const STATUS_SECTIONS: readonly OutlineItem[] = [
  { id: "mode", label: "Mode" },
  { id: "spend", label: "LLM spend" },
  { id: "runs", label: "Runs" },
  { id: "qloo", label: "Qloo" },
  { id: "system", label: "System" },
];

const LANES: readonly Lane[] = ["public", "judge"];

/** Top bar (56) plus the gap the library leaves: where the outline rests and the spy line falls. */
const OUTLINE_TOP = 84;

export interface StatusViewProps {
  report: StatusReport;
}

const NotRead = ({ children = "Not read" }: { children?: ReactNode }) => <span className="text-dim">{children}</span>;

function Section({
  id,
  number,
  title,
  aside,
  notes,
  children,
}: {
  id: string;
  number: number;
  title: string;
  aside?: ReactNode;
  notes?: ReactNode;
  children: ReactNode;
}) {
  return (
    <BriefRow notes={notes} className="pt-[18px]">
      <section>
        <SectionHead id={id} number={number} title={title} aside={aside} className={SCROLL_ANCHOR_CLASS} />
        <div className="pt-1">{children}</div>
      </section>
    </BriefRow>
  );
}

/** A label with its sidenote's number. */
const Marked = ({ text, n }: { text: string; n: number }) => (
  <>
    {text}
    <NoteMark n={n} />
  </>
);

function ModeSection({ report }: StatusViewProps) {
  const { mode, breakers } = report;
  const aside = mode.override !== null ? `MODE_OVERRIDE=${mode.override}` : mode.stored.since ? `Stored ${utcShort(mode.stored.since)}` : "Never switched";
  return (
    <Section
      id="mode"
      number={1}
      title="Mode"
      aside={aside}
      notes={
        <StatusNote n={1} trace="live → economy → replay only">
          Each breaker can only step a lane down, and the lowest wins. Paused lanes still serve showcases, replays and cached answers at no
          cost; the app never answers from the model alone.
        </StatusNote>
      }
    >
      <StatusRows label="Lanes and breakers">
        {LANES.map((lane, i) => {
          const decision = mode.lanes?.[lane] ?? null;
          const view = decision ? laneView(decision, report.live.blocks) : null;
          return (
            <StatusRow
              key={lane}
              label={i === 0 ? <Marked text={LANE_LABEL[lane]} n={1} /> : LANE_LABEL[lane]}
              note={view ? <StateTag tag={view.tag} state={view.state} /> : <LevelTag level="unknown" />}
            >
              {view ? <span data-lane={lane}>{view.detail}</span> : <NotRead>The breakers could not be read</NotRead>}
            </StatusRow>
          );
        })}
        {breakers.map((breaker) => (
          <StatusRow key={breaker.key} label={BREAKER_LABEL[breaker.key]} note={<LevelTag level={breaker.level} />}>
            <span data-breaker={breaker.key}>{breakerDetail(breaker.key, report)}</span>
          </StatusRow>
        ))}
      </StatusRows>
    </Section>
  );
}

function SpendSection({ report }: StatusViewProps) {
  const { llm } = report;
  const today = llm.todayUsd;
  const usd = (v: number | null) => (v === null ? "–" : formatUsd(v));
  return (
    <Section
      id="spend"
      number={2}
      title="LLM spend"
      aside="Resets 00:00 UTC"
      notes={
        <StatusNote n={2} trace={`LLM_DAILY_USD_CAP ${formatUsd(llm.capUsd)}`}>
          Today&apos;s spend across both lanes. The public lane steps down first; the rest of the budget is held for judges.
        </StatusNote>
      }
    >
      <StatusRows label="LLM spend">
        <StatusRow label={<Marked text="Spent today" n={2} />} note={`public ${usd(llm.laneUsd.public)} · judge ${usd(llm.laneUsd.judge)}`}>
          {today === null ? <NotRead /> : <Amount used={formatUsd(today)} of={`of ${formatUsd(llm.capUsd)} cap`} />}
        </StatusRow>
        {LANES.map((lane) => {
          const b = llm.budgets[lane];
          return (
            <StatusRow key={lane} label={LANE_LABEL[lane]}>
              <UsageMeter
                value={today}
                max={b.cap}
                label={`LLM spend today against the ${lane} lane's budget`}
                valueText={today === null ? undefined : `${formatUsd(today)} of ${formatUsd(b.cap)}`}
                ticks={[
                  { at: b.economyAt, label: `Economy from ${formatUsd(b.economyAt)}` },
                  { at: b.replayAt, label: `Paused from ${formatUsd(b.replayAt)}` },
                ]}
                tripped={today !== null && today >= b.replayAt}
              />
              <Amount used={`economy at ${formatUsd(b.economyAt)}`} of={`· paused at ${formatUsd(b.replayAt)}`} />
            </StatusRow>
          );
        })}
        <StatusRow label="Anthropic key" note="never shown">
          {llm.configured ? <Amount used="Set" /> : <Amount used="Not set" of="· live runs are refused, test runs still work" />}
        </StatusRow>
      </StatusRows>
    </Section>
  );
}

function HourRow({ label, hour, n }: { label: string; hour: HourCount; n?: number }) {
  const full = hour.lastHour !== null && hour.lastHour >= hour.hourlyCap;
  return (
    <StatusRow label={n ? <Marked text={label} n={n} /> : label} note="all servers">
      <UsageMeter
        value={hour.lastHour}
        max={hour.hourlyCap}
        label={label}
        valueText={hour.lastHour === null ? undefined : `${hour.lastHour} of ${hour.hourlyCap}`}
        tripped={full}
      />
      {hour.lastHour === null ? <NotRead /> : <Amount used={count(hour.lastHour)} of={`of ${count(hour.hourlyCap)}`} />}
    </StatusRow>
  );
}

function RunsSection({ report }: StatusViewProps) {
  const { runs } = report;
  const recentRow = (name: string, recent: StatusReport["runs"]["recent"]["live"], n?: number) => (
    <StatusRow label={n ? <Marked text={name} n={n} /> : name}>
      {recent === null ? <NotRead /> : <RunStrip statuses={recent} slots={runs.recentLimit} label={name} />}
    </StatusRow>
  );
  return (
    <Section
      id="runs"
      number={3}
      title="Runs"
      aside="Outcomes only, no questions"
      notes={
        <StatusNote n={3} trace="status counts · D31">
          Statuses and counts only, the newest run on the left. Questions never appear here: the briefs people run are unlisted.
        </StatusNote>
      }
    >
      <StatusRows label="Runs">
        <HourRow label="Public runs, last hour" hour={runs.lanes.public} />
        <HourRow label="Judge runs, last hour" hour={runs.lanes.judge} />
        <HourRow label="Test runs, last hour" hour={runs.test} />
        <StatusRow label="In progress here" note={`${count(runs.slots.public)} public + ${count(runs.slots.judge)} judge slots`}>
          {runs.activeHere === null ? (
            <NotRead />
          ) : (
            <Amount
              used={count(runs.activeHere)}
              of={`live and test · ${runs.accepting === false ? "draining for a restart" : "taking new runs"}`}
            />
          )}
        </StatusRow>
        {recentRow(`Last ${runs.recentLimit} live runs`, runs.recent.live, 3)}
        {recentRow(`Last ${runs.recentLimit} test runs`, runs.recent.test)}
      </StatusRows>
    </Section>
  );
}

function QlooSection({ report }: StatusViewProps) {
  const { qloo } = report;
  if (!qloo.configured) {
    return (
      <Section id="qloo" number={4} title="Qloo" aside="Not configured">
        <StatusRows label="Qloo">
          <StatusRow label="Client">Not configured: live Qloo needs a key; QLOO_MOCK=1 runs on synthetic data.</StatusRow>
        </StatusRows>
      </Section>
    );
  }
  const level = (key: "qloo_daily" | "qloo_floor") => report.breakers.find((b) => b.key === key)?.level;
  const { today, month } = qloo;
  const rate = cacheRate(qloo.cache);
  const used = month.limit !== null && month.remaining !== null ? Math.max(0, month.limit - month.remaining) : null;
  return (
    <Section
      id="qloo"
      number={4}
      title="Qloo"
      aside={month.resetsAt ? `${ENV_LABEL[qloo.env]} · month resets ${formatUtcDate(month.resetsAt)}` : ENV_LABEL[qloo.env]}
      notes={
        <StatusNote n={4} trace={`floor ${count(month.floor)} · ${qloo.env}`}>
          Below {count(month.floor)} calls left this month the app switches to replay only. A cached answer costs no call.
        </StatusNote>
      }
    >
      <StatusRows label="Qloo">
        <StatusRow label="Fresh calls today" note={today.enforced ? "resets 00:00 UTC" : "cap in prod only"}>
          <UsageMeter
            value={today.network}
            max={today.cap}
            label="Fresh Qloo calls today"
            valueText={`${today.network} of ${today.cap}`}
            tripped={level("qloo_daily") === "tripped"}
          />
          <Amount used={count(today.network)} of={`of ${count(today.cap)}`} />
        </StatusRow>
        {qloo.env === "mock" ? null : (
          <StatusRow label="By lane" note="60% public · 40% judges">
            <span>
              Public{" "}
              <Amount used={today.lanes.public.used === null ? "–" : count(today.lanes.public.used)} of={`of ${count(today.lanes.public.cap)}`} />
              <span className="px-2 text-faint">·</span>
              Judge{" "}
              <Amount used={today.lanes.judge.used === null ? "–" : count(today.lanes.judge.used)} of={`of ${count(today.lanes.judge.cap)}`} />
            </span>
          </StatusRow>
        )}
        <StatusRow label={<Marked text="Left this month" n={4} />} note={`floor ${count(month.floor)}`}>
          {month.limit !== null ? (
            <UsageMeter
              value={used}
              max={month.limit}
              label="Qloo calls used this month"
              valueText={used === null ? undefined : `${used} used of ${month.limit}`}
              ticks={[{ at: month.limit - month.floor, label: "Replay only below the floor" }]}
              tripped={level("qloo_floor") === "tripped"}
            />
          ) : null}
          {month.remaining === null ? (
            <NotRead>No reading yet: the next Qloo response brings one</NotRead>
          ) : (
            <Amount used={count(month.remaining)} of={month.limit === null ? "left" : `left of ${count(month.limit)}`} />
          )}
        </StatusRow>
        <StatusRow label="Cache hit rate today">
          <UsageMeter
            value={rate}
            max={100}
            label="Qloo cache hit rate today"
            valueText={rate !== null ? `${rate}%` : qloo.cache === null ? undefined : "no calls yet today"}
          />
          {qloo.cache === null ? (
            <NotRead />
          ) : rate === null ? (
            <NotRead>No calls yet today</NotRead>
          ) : (
            <Amount
              used={`${rate}%`}
              of={`· ${count(qloo.cache.served)} of ${qloo.cache.sampled ? `the latest ${count(qloo.cache.total)}` : count(qloo.cache.total)} from cache`}
            />
          )}
        </StatusRow>
        <StatusRow label="Last data response">
          {qloo.lastSuccessAt ? <Amount used={utcShort(qloo.lastSuccessAt)} /> : <NotRead>None yet</NotRead>}
        </StatusRow>
      </StatusRows>
    </Section>
  );
}

const MIGRATION_TEXT: Readonly<Record<StatusReport["migrations"]["state"], string>> = {
  applied: "Applied",
  // Startup retries only while the database is unreachable; any other failure waits for a person.
  pending: "Pending: not applied by this server; see the startup log",
  skipped: "Left to the deploy (RUN_MIGRATIONS=0)",
};

type LocalityState = NonNullable<StatusReport["localities"]>["state"];

/** The locality pins as a breaker's tag: some markets unpinned warn; none pinned, or unreadable pins, trip. */
const LOCALITY_LEVEL: Readonly<Record<LocalityState, StatusLevel>> = {
  complete: "clear",
  partial: "warn",
  missing: "tripped",
  malformed: "tripped",
};

/** kv metro_localities against the markets every run needs (server/localities.ts): market ids and counts only. */
function LocalitiesRow({ pins }: { pins: StatusReport["localities"] }) {
  const unpinned = pins && pins.missing.length > 0 ? `· not pinned: ${pins.missing.join(", ")}` : undefined;
  return (
    <StatusRow label="Market localities" note={<LevelTag level={pins ? LOCALITY_LEVEL[pins.state] : "unknown"} />}>
      {pins === null ? (
        <NotRead />
      ) : (
        <span data-localities={pins.state}>
          {pins.state === "malformed" ? (
            <Amount used="Malformed" of="· every locality lookup fails; see the log" />
          ) : pins.state === "missing" ? (
            <Amount used="Not set" of={unpinned} />
          ) : (
            <Amount
              used={`${count(pins.required.length - pins.missing.length)} of ${count(pins.required.length)} pinned`}
              of={unpinned ?? `· ${count(pins.pinned)} markets in all`}
            />
          )}
        </span>
      )}
    </StatusRow>
  );
}

function SystemSection({ report }: StatusViewProps) {
  const { db, migrations } = report;
  return (
    <Section
      id="system"
      number={5}
      title="System"
      aside={`Version ${report.version}`}
      notes={
        <StatusNote n={5} trace="GET /api/health">
          Uptime checks read the health endpoint; it answers 503 while the database or its migrations are missing.
        </StatusNote>
      }
    >
      <StatusRows label="System">
        <StatusRow label={<Marked text="Database" n={5} />}>
          {db.ok ? (
            <Amount used="Reachable" of={db.latencyMs === null ? undefined : `· ${db.latencyMs} ms`} />
          ) : (
            <span className="font-medium text-negative">Unreachable</span>
          )}
        </StatusRow>
        <StatusRow label="Migrations">
          <Amount used={MIGRATION_TEXT[migrations.state]} of={migrations.journal ? `· ${count(migrations.journal.count)} in the journal` : undefined} />
          {migrations.journal?.latest ? <span className="font-mono text-[11px] text-dim">{migrations.journal.latest}</span> : null}
        </StatusRow>
        <LocalitiesRow pins={report.localities} />
        <StatusRow label="Version" note={`up ${formatUptime(report.uptimeS)}`}>
          <span className="font-mono text-[12px] text-ink">{report.version}</span>
        </StatusRow>
        <StatusRow label="Read" note="reused for 5 s">
          <Amount used={utcTime(report.readAt)} of={`· in ${report.readMs} ms`} />
        </StatusRow>
      </StatusRows>
    </Section>
  );
}

/**
 * /status in Concept A, after A12 Settings: the outline, OPERATIONS · CULTURE TERMINAL with the
 * reading's time and Reload, the answer first (what a public live question gets now), then five
 * numbered sections of label · value · note rows, their notes in the margin. A server reading,
 * rendered as it was taken.
 */
export function StatusView({ report }: StatusViewProps) {
  return (
    <div className={cx("w-full flex-1 px-4 pt-7 pb-16 md:grid md:px-0", GRID_COLUMNS_MD, "xl:grid", GRID_COLUMNS_XL)}>
      <div className="hidden md:col-start-2 md:row-start-1 md:block">
        <div className="sticky" style={{ top: OUTLINE_TOP }}>
          <Outline
            heading="On this page"
            items={STATUS_SECTIONS}
            spyOffset={OUTLINE_TOP + 24}
            meta={{ trace: `Read ${utcTime(report.readAt)}`, text: "Statuses and counts only: no questions, names or request ids." }}
          />
        </div>
      </div>
      <div className="min-w-0 md:col-start-4 md:row-start-1 xl:col-[4/span_3] xl:grid xl:grid-cols-subgrid xl:content-start">
        <BriefRow>
          <header className="flex flex-col gap-4 pb-[18px] sm:flex-row sm:items-end sm:justify-between">
            <div className="flex flex-col gap-[10px]">
              <MetaLine desk="Operations" job="Culture Terminal" extra={[`Version ${report.version}`]} />
              <h1 className="m-0 font-serif text-[32px] leading-10 font-medium text-ink">Status</h1>
            </div>
            <div className="flex shrink-0 items-center gap-4 pb-1">
              <span className="text-[12px] text-dim">Read {utcTime(report.readAt)}</span>
              <ButtonLink href="/status" prefetch={false} variant="quiet" hint={null}>
                Reload
              </ButtonLink>
            </div>
          </header>
          <p className="m-0 max-w-[680px] pb-[22px] type-answer text-ink" data-live-state={report.live.state}>
            {leadSentence(report)}
          </p>
        </BriefRow>
        <ModeSection report={report} />
        <SpendSection report={report} />
        <RunsSection report={report} />
        <QlooSection report={report} />
        <SystemSection report={report} />
      </div>
    </div>
  );
}
