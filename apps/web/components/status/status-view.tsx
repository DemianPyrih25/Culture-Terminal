import type { Lane } from "@ct/contracts";
import type { ReactNode } from "react";
import type { BreakerKey, HourCount, StatusLevel, StatusReport } from "../../server/status";
import { ButtonLink } from "../ui/button";
import { Card } from "../ui/card";
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
  { id: "mode", label: "Service" },
  { id: "runs", label: "Runs" },
  { id: "qloo", label: "Qloo" },
  { id: "system", label: "System" },
];

const LANES: readonly Lane[] = ["public", "judge"];

/**
 * The breakers shown as service health. Spend, the hourly run cap and Qloo's daily cap and month floor
 * are budgets, not health: they live with the plan, and their effect still shows in each lane's state.
 */
const HEALTH_BREAKERS: ReadonlySet<BreakerKey> = new Set<BreakerKey>(["stored", "override", "qloo_auth", "qloo_switch", "draining"]);

export interface StatusViewProps {
  report: StatusReport;
}

const EYEBROW = "text-[11px] leading-4 font-semibold tracking-[0.08em] uppercase text-ink-3";

const NotRead = ({ children = "Not read" }: { children?: ReactNode }) => <span className="text-ink-3">{children}</span>;

/** A note under a section: what the rows mean, and where it comes from. */
function StatusNote({ children, trace }: { children: ReactNode; trace?: ReactNode }) {
  return (
    <div className="flex gap-2.5 rounded-b-card border-t border-line bg-sunken/50 px-5 py-3.5" data-status-note="true">
      <Icon name="lightbulb" size={15} className="mt-0.5 shrink-0 text-caution" />
      <p className="type-caption text-ink-2">
        {children}
        {trace ? <span className="block pt-1 font-mono text-[11px] leading-4 text-ink-3 [overflow-wrap:anywhere]">{trace}</span> : null}
      </p>
    </div>
  );
}

function Section({ id, title, aside, notes, children }: { id: string; title: string; aside?: ReactNode; notes?: ReactNode; children: ReactNode }) {
  const n = STATUS_SECTIONS.findIndex((s) => s.id === id) + 1;
  return (
    <Card id={id} aria-labelledby={`${id}-title`} padding="none" className="flex scroll-mt-6 flex-col" data-section={id}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-line px-5 pt-4.5 pb-3.5">
        {n > 0 ? (
          <span aria-hidden="true" className="font-mono text-[11px] leading-4 text-ink-3">
            {String(n).padStart(2, "0")}
          </span>
        ) : null}
        <h2 id={`${id}-title`} className="font-display text-[22px] leading-[28px] text-ink max-md:text-[19px] max-md:leading-6">
          {title}
        </h2>
        {aside ? <p className="ml-auto type-caption text-ink-3">{aside}</p> : null}
      </div>
      <div className="px-5 py-1">{children}</div>
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
      title="Service"
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
        {breakers.filter((b) => HEALTH_BREAKERS.has(b.key)).map((breaker) => (
          <StatusRow key={breaker.key} label={BREAKER_LABEL[breaker.key]} note={<LevelTag level={breaker.level} />}>
            <span data-breaker={breaker.key}>{breakerDetail(breaker.key, report)}</span>
          </StatusRow>
        ))}
      </StatusRows>
    </Section>
  );
}

function HourRow({ label, hour }: { label: string; hour: HourCount }) {
  return (
    <StatusRow label={label} note="all servers">
      {hour.lastHour === null ? <NotRead /> : <Amount used={count(hour.lastHour)} of={hour.lastHour === 1 ? "run started" : "runs started"} />}
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
  const rate = cacheRate(qloo.cache);
  return (
    <Section
      id="qloo"
      title="Qloo"
      aside={ENV_LABEL[qloo.env]}
      notes={
        <StatusNote trace={qloo.env}>
          A cached answer costs no call. When Qloo cannot be reached or its quota runs low, live runs step down to replay only and say so.
        </StatusNote>
      }
    >
      <StatusRows label="Qloo">
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
        <StatusRow label="Anthropic key" note="never shown">
          {report.llm.configured ? <Amount used="Set" /> : <Amount used="Not set" of="· live runs are refused, test runs still work" />}
        </StatusRow>
        {report.today ? (
          <StatusRow label="OpenStreetMap">
            {report.today.osm.configured ? <Amount used="Configured" /> : <span className="text-ink-2">Not configured: place counts need OSM_USER_AGENT.</span>}
          </StatusRow>
        ) : null}
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
 * question gets now), then service health, runs, Qloo and the system as label · value · note rows, with
 * an index and a note on how to read the page beside them. A server reading, rendered as it was taken.
 * Statuses and counts only: no questions, names or request ids. Spend and caps live with the plan.
 */
export function StatusView({ report }: StatusViewProps) {
  return (
    <div className="flex flex-col gap-7 pt-12 pb-16 max-md:gap-5 max-md:pt-6 max-md:pb-8">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-col gap-2">
          <h1 className="type-display-m text-ink max-md:type-display-m-sm">Status</h1>
          <p className="flex flex-wrap items-center gap-x-2.5 type-label text-ink-3">
            <span>Operations · Version {report.version}</span>
            <span aria-hidden="true" className="size-[3px] rounded-full bg-ink-3" />
            <span>Read {utcTime(report.readAt)}</span>
          </p>
        </div>
        <ButtonLink href="/status" prefetch={false} variant="secondary" size="sm" icon="rotate-ccw" trailing={null} className="shrink-0 self-start sm:self-auto">
          Reload
        </ButtonLink>
      </header>
      <p className="max-w-[860px] border-b border-line pb-6 font-display text-[24px] leading-[32px] text-ink max-md:text-[19px] max-md:leading-[27px]" data-live-state={report.live.state}>
        {leadSentence(report)}
      </p>
      <nav aria-label="Sections" className="flex flex-wrap items-center gap-2 lg:hidden">
        <span className="pr-1 type-caption text-ink-3">Jump to</span>
        {STATUS_SECTIONS.map((s) => (
          <a key={s.id} href={`#${s.id}`} className="inline-flex h-7 items-center rounded-control border border-line bg-surface px-3 type-caption text-ink-2 hover:text-ink">
            {s.label}
          </a>
        ))}
      </nav>
      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_272px]">
        <div className="flex min-w-0 flex-col gap-6 max-md:gap-4">
          <ModeSection report={report} />
          <RunsSection report={report} />
          <QlooSection report={report} />
          <SystemSection report={report} />
        </div>
        <aside className="flex flex-col gap-6 max-lg:hidden">
          <nav aria-label="On this page" className="flex flex-col gap-2.5 border-b border-line pb-5">
            <p className={EYEBROW}>On this page</p>
            <ol className="flex flex-col border-l border-line">
              {STATUS_SECTIONS.map((s, i) => (
                <li key={s.id}>
                  <a href={`#${s.id}`} className="-ml-px flex items-baseline gap-2.5 border-l border-transparent py-1 pl-2.5 type-label text-ink-2 hover:border-accent hover:text-accent">
                    <span aria-hidden="true" className="font-mono text-[11px] text-ink-3">
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    {s.label}
                  </a>
                </li>
              ))}
            </ol>
          </nav>
          <div className="flex flex-col gap-2.5">
            <p className={EYEBROW}>About this page</p>
            <p className="type-label text-ink-2">Operator page. Not indexed and not linked from the app.</p>
            <p className="type-caption text-ink-3">Every value is read on load and reused for 5 seconds, so Reload more often shows the same reading.</p>
            <p className="type-caption text-ink-3">A value we could not read says Not read. We never fill a gap with an estimate.</p>
          </div>
        </aside>
      </div>
    </div>
  );
}
