import type { Lane } from "@ct/contracts";
import type { ReactNode } from "react";
import { formatUsd, formatUtcDate } from "../../lib/brief/format";
import type { HourCount, StatusLevel, StatusReport } from "../../server/status";
import { ButtonLink } from "../ui/button";
import { Card } from "../ui/card";
import { chipClassName } from "../ui/chip";
import { Icon } from "../ui/icons";
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
  queueReading,
  queueText,
  utcShort,
  utcTime,
} from "./format";
import { RunStrip } from "./run-strip";
import { Amount, LevelTag, StateTag, StatusRow, StatusRows } from "./status-rows";
import { UsageMeter } from "./usage-meter";

/** The page's sections, in order: the index links to them. */
export const STATUS_SECTIONS: readonly { id: string; label: string }[] = [
  { id: "mode", label: "Mode" },
  { id: "spend", label: "LLM spend" },
  { id: "runs", label: "Runs" },
  { id: "qloo", label: "Qloo" },
  { id: "today", label: "Shared use" },
  { id: "system", label: "System" },
];

const LANES: readonly Lane[] = ["public", "judge"];

export interface StatusViewProps {
  report: StatusReport;
}

const NotRead = ({ children = "Not read" }: { children?: ReactNode }) => <span className="text-ink-2">{children}</span>;

/** A note under a section: what the rows mean, and where it comes from. */
function StatusNote({ children, trace }: { children: ReactNode; trace?: ReactNode }) {
  return (
    <div className="flex gap-2 border-t border-line pt-4" data-status-note="true">
      <Icon name="lightbulb" size={16} className="mt-0.5 shrink-0 text-ink-2" />
      <p className="type-label text-ink-2">
        {children}
        {trace ? <span className="block pt-0.5 font-mono text-[12px] leading-[18px] [overflow-wrap:anywhere]">{trace}</span> : null}
      </p>
    </div>
  );
}

function Section({ id, title, aside, notes, children }: { id: string; title: string; aside?: ReactNode; notes?: ReactNode; children: ReactNode }) {
  return (
    <Card id={id} aria-labelledby={`${id}-title`} className="flex scroll-mt-6 flex-col gap-3" data-section={id}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id={`${id}-title`} className="type-title text-ink max-md:type-title-sm">
          {title}
        </h2>
        {aside ? <p className="type-label text-ink-2">{aside}</p> : null}
      </div>
      {children}
      {notes}
    </Card>
  );
}

function ModeSection({ report }: StatusViewProps) {
  const { mode, breakers } = report;
  const aside = mode.override !== null ? `MODE_OVERRIDE=${mode.override}` : mode.stored.since ? `Stored ${utcShort(mode.stored.since)}` : "Never switched";
  return (
    <Section
      id="mode"
      title="Mode"
      aside={aside}
      notes={
        <StatusNote trace="live → economy → replay only">
          Each breaker can only step a lane down, and the lowest wins. Paused lanes still serve answers already made, replays and cached answers at no
          cost; the app never answers from the model alone.
        </StatusNote>
      }
    >
      <StatusRows label="Lanes and breakers">
        {LANES.map((lane) => {
          const decision = mode.lanes?.[lane] ?? null;
          const view = decision ? laneView(decision, report.live.blocks) : null;
          return (
            <StatusRow
              key={lane}
              label={LANE_LABEL[lane]}
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
      title="LLM spend"
      aside="Resets 00:00 UTC"
      notes={
        <StatusNote trace={`LLM_DAILY_USD_CAP ${formatUsd(llm.capUsd)}`}>
          Today&apos;s spend across both lanes. The public lane steps down first; the rest of the budget is held for judges.
        </StatusNote>
      }
    >
      <StatusRows label="LLM spend">
        <StatusRow label="Spent today" note={`public ${usd(llm.laneUsd.public)} · judge ${usd(llm.laneUsd.judge)}`}>
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

function HourRow({ label, hour }: { label: string; hour: HourCount }) {
  const full = hour.lastHour !== null && hour.lastHour >= hour.hourlyCap;
  return (
    <StatusRow label={label} note="all servers">
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

/** Runs waiting for a slot in the global queue (D24), against how many may wait. */
function QueueRow({ runs }: { runs: StatusReport["runs"] }) {
  const queue = queueReading(runs);
  if (queue === null) return null;
  const text = queueText(queue);
  return (
    <StatusRow label="Waiting for a slot" note="this server">
      {queue.max > 0 ? (
        <UsageMeter
          value={queue.waiting}
          max={queue.max}
          label="Runs waiting for a slot"
          valueText={queue.waiting === null ? undefined : `${queue.waiting} of ${queue.max}`}
          tripped={queue.waiting !== null && queue.waiting >= queue.max}
        />
      ) : null}
      <span data-queue={queue.max === 0 ? "off" : (queue.waiting ?? "unread")}>
        {queue.waiting === null && queue.max > 0 ? <NotRead /> : <Amount used={text.used} of={text.of} />}
      </span>
    </StatusRow>
  );
}

function RunsSection({ report }: StatusViewProps) {
  const { runs } = report;
  const recentRow = (name: string, recent: StatusReport["runs"]["recent"]["live"]) => (
    <StatusRow label={name}>
      {recent === null ? <NotRead /> : <RunStrip statuses={recent} slots={runs.recentLimit} label={name} />}
    </StatusRow>
  );
  return (
    <Section
      id="runs"
      title="Runs"
      aside="Outcomes only, no questions"
      notes={
        <StatusNote trace="status counts · D31">
          Statuses and counts only, the newest run on the left. Questions never appear here: the answers people run are unlisted.
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
        <QueueRow runs={runs} />
        {recentRow(`Last ${runs.recentLimit} live runs`, runs.recent.live)}
        {recentRow(`Last ${runs.recentLimit} test runs`, runs.recent.test)}
      </StatusRows>
    </Section>
  );
}

function QlooSection({ report }: StatusViewProps) {
  const { qloo } = report;
  if (!qloo.configured) {
    return (
      <Section id="qloo" title="Qloo" aside="Not configured">
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
      title="Qloo"
      aside={month.resetsAt ? `${ENV_LABEL[qloo.env]} · month resets ${formatUtcDate(month.resetsAt)}` : ENV_LABEL[qloo.env]}
      notes={
        <StatusNote trace={`floor ${count(month.floor)} · ${qloo.env}`}>
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
              <span className="px-2 text-ink-3">·</span>
              Judge{" "}
              <Amount used={today.lanes.judge.used === null ? "–" : count(today.lanes.judge.used)} of={`of ${count(today.lanes.judge.cap)}`} />
            </span>
          </StatusRow>
        )}
        <StatusRow label="Left this month" note={`floor ${count(month.floor)}`}>
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

/** Unpinned markets named on the row up to this many; more are counted. */
const UNPINNED_NAMED = 6;

/** The breaker level of the pins: a map city a run needs sets it; a market only it can lower to a warning. */
function localityLevel(pins: NonNullable<StatusReport["localities"]>): StatusLevel {
  const level = LOCALITY_LEVEL[pins.state];
  return level === "clear" && pins.markets.missing.length > 0 ? "warn" : level;
}

/**
 * kv metro_localities against every market in config/metros.json and the map cities every run needs
 * (server/localities.ts, server/status.ts): market ids and counts only.
 */
function LocalitiesRow({ pins }: { pins: StatusReport["localities"] }) {
  if (pins === null) {
    return (
      <StatusRow label="Market localities" note={<LevelTag level="unknown" />}>
        <NotRead />
      </StatusRow>
    );
  }
  const cities = `${count(pins.required.length - pins.missing.length)} of ${count(pins.required.length)} map cities`;
  const { total, missing } = pins.markets;
  const otherMissing = missing.filter((id) => !pins.missing.includes(id));
  const unpinned = [...pins.missing, ...otherMissing];
  const named =
    unpinned.length === 0
      ? ""
      : ` · not pinned: ${unpinned.slice(0, UNPINNED_NAMED).join(", ")}${unpinned.length > UNPINNED_NAMED ? ` and ${count(unpinned.length - UNPINNED_NAMED)} more` : ""}`;
  return (
    <StatusRow label="Market localities" note={<LevelTag level={localityLevel(pins)} />}>
      <span data-localities={pins.state}>
        {pins.state === "malformed" ? (
          <Amount used="Malformed" of="· every locality lookup fails; see the log" />
        ) : pins.state === "missing" ? (
          <Amount used="Not set" of={`· ${count(total)} markets and ${count(pins.required.length)} map cities to pin`} />
        ) : (
          <Amount used={`${count(total - missing.length)} of ${count(total)} markets pinned`} of={`· ${cities}${named}`} />
        )}
      </span>
    </StatusRow>
  );
}

/**
 * Today's use of what answers share outside their own Qloo calls (Part 11): brand screens, the side
 * context calls ("What AI knows", "From the web") and OpenStreetMap requests against the daily cap.
 * Counts and spend only. A reading from a server before Part 11 has none, and the section is left out.
 */
function TodaySection({ report }: StatusViewProps) {
  const today = report.today;
  if (!today) return null;
  const { context, osm } = today;
  const usd = (v: number) => formatUsd(v);
  const contextText =
    context.aiUsd === null && context.webUsd === null
      ? null
      : `AI ${context.aiUsd === null ? "not read" : usd(context.aiUsd)} · web ${context.webUsd === null ? "not read" : usd(context.webUsd)}`;
  return (
    <Section id="today" title="Shared use" aside="Today, UTC">
      <StatusRows label="Shared use">
        <StatusRow label="Brand screens" note="all servers">
          {today.screens === null ? <NotRead /> : <Amount used={count(today.screens)} of={today.screens === 1 ? "screen today" : "screens today"} />}
        </StatusRow>
        <StatusRow label="Context calls" note={context.webSearches === null ? undefined : `${count(context.webSearches)} ${context.webSearches === 1 ? "search" : "searches"}`}>
          {contextText === null ? <NotRead /> : <Amount used={contextText} of="spent today, part of the LLM spend" wrap />}
        </StatusRow>
        <StatusRow label="OpenStreetMap requests" note={osm.configured ? "resets 00:00 UTC" : undefined}>
          {!osm.configured ? (
            <span className="text-ink-2">Not configured: place counts need OSM_USER_AGENT.</span>
          ) : osm.requests === null ? (
            <NotRead />
          ) : (
            <>
              <UsageMeter value={osm.requests} max={Math.max(1, osm.dailyMax)} label="OpenStreetMap requests today" valueText={`${count(osm.requests)} of ${count(osm.dailyMax)}`} />
              <Amount used={count(osm.requests)} of={`of ${count(osm.dailyMax)}`} />
            </>
          )}
        </StatusRow>
      </StatusRows>
    </Section>
  );
}

function SystemSection({ report }: StatusViewProps) {
  const { db, migrations } = report;
  return (
    <Section
      id="system"
      title="System"
      aside={`Version ${report.version}`}
      notes={
        <StatusNote trace="GET /api/health">
          Uptime checks read the health endpoint; it answers 503 while the database or its migrations are missing.
        </StatusNote>
      }
    >
      <StatusRows label="System">
        <StatusRow label="Database">
          {db.ok ? (
            <Amount used="Reachable" of={db.latencyMs === null ? undefined : `· ${db.latencyMs} ms`} />
          ) : (
            <span className="font-medium text-danger-ink">Unreachable</span>
          )}
        </StatusRow>
        <StatusRow label="Migrations">
          <Amount wrap used={MIGRATION_TEXT[migrations.state]} of={migrations.journal ? `· ${count(migrations.journal.count)} in the journal` : undefined} />
          {migrations.journal?.latest ? <span className="type-mono text-ink-2">{migrations.journal.latest}</span> : null}
        </StatusRow>
        <LocalitiesRow pins={report.localities} />
        <StatusRow label="Version" note={`up ${formatUptime(report.uptimeS)}`}>
          <span className="type-mono text-ink">{report.version}</span>
        </StatusRow>
        <StatusRow label="Read" note="reused for 5 s">
          <Amount used={utcTime(report.readAt)} of={`· in ${report.readMs} ms`} />
        </StatusRow>
      </StatusRows>
    </Section>
  );
}

/**
 * /status, the operator page: the reading's time and Reload, the answer first (what a public live
 * question gets now), then five cards of label · value · note rows. A server reading, rendered as it
 * was taken. Statuses and counts only: no questions, names or request ids.
 */
export function StatusView({ report }: StatusViewProps) {
  return (
    <div className="flex flex-col gap-6 pt-12 pb-12 max-md:gap-4 max-md:pt-6 max-md:pb-8">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="type-display-m text-ink max-md:type-display-m-sm">Status</h1>
          <p className="type-label text-ink-2">Operations · Version {report.version}</p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <span className="type-label text-ink-2">Read {utcTime(report.readAt)}</span>
          <ButtonLink href="/status" prefetch={false} variant="secondary" size="sm" icon="rotate-ccw" trailing={null}>
            Reload
          </ButtonLink>
        </div>
      </header>
      <p className="max-w-[744px] type-lead text-ink" data-live-state={report.live.state}>
        {leadSentence(report)}
      </p>
      <nav aria-label="Sections" className="flex flex-wrap gap-2">
        {STATUS_SECTIONS.map((s) => (
          <a key={s.id} href={`#${s.id}`} className={chipClassName(false)}>
            {s.label}
          </a>
        ))}
      </nav>
      <ModeSection report={report} />
      <SpendSection report={report} />
      <RunsSection report={report} />
      <QlooSection report={report} />
      <TodaySection report={report} />
      <SystemSection report={report} />
    </div>
  );
}
