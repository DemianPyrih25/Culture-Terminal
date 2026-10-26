import type { Mode, RunStatus } from "@ct/contracts";
import { formatUsd, formatUtcShortDateTime, formatUtcTime, plural } from "../../lib/brief/format";
import type { BreakerKey, LaneDecision, LiveBlock, QlooConfigured, StatusLevel, StatusReport } from "../../server/status";

/**
 * Text for /status (Concept A, D36). Pure, so the page and its tests print the same words. Times are
 * UTC. Nothing here prints a question, an entity, a request id or a key (D31).
 */

/** "1,900". */
export const count = (n: number): string => n.toLocaleString("en-US");

/** "19:04:12 UTC". */
export const utcTime = (iso: string): string => `${formatUtcTime(iso)} UTC`;

/** "22 Oct, 19:04 UTC". */
export const utcShort = (iso: string): string => `${formatUtcShortDateTime(iso)} UTC`;

/** Uptime: "40 s", "6 min", "3 h 12 min", "2 d 4 h". */
export function formatUptime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s} s`;
  const minutes = Math.floor(s / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${minutes % 60} min`;
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? `${days} d` : `${days} d ${hours % 24} h`;
}

export interface Tag {
  mark: string;
  word: string;
  tone: string;
}

/** A breaker's state, as A/Prior prints a verdict: a mark and a small caps word in its tone. */
export const LEVEL_TAG: Readonly<Record<StatusLevel, Tag>> = {
  clear: { mark: "✓", word: "Clear", tone: "text-accent" },
  half: { mark: "–", word: "Past 50%", tone: "text-text-2" },
  high: { mark: "–", word: "Past 80%", tone: "text-negative" },
  warn: { mark: "–", word: "Warning", tone: "text-negative" },
  stepped: { mark: "–", word: "Economy", tone: "text-negative" },
  tripped: { mark: "×", word: "Tripped", tone: "text-negative" },
  bypassed: { mark: "–", word: "Bypassed", tone: "text-negative" },
  off: { mark: "·", word: "Not enforced", tone: "text-dim" },
  unknown: { mark: "·", word: "Not read", tone: "text-dim" },
};

/** A lane's mode as a tag: ✓ LIVE, – ECONOMY, × PAUSED. */
export const MODE_TAG: Readonly<Record<Mode, Tag>> = {
  live: { mark: "✓", word: "Live", tone: "text-accent" },
  economy: { mark: "–", word: "Economy", tone: "text-negative" },
  replay_only: { mark: "×", word: "Paused", tone: "text-negative" },
};

export const MODE_NAME: Readonly<Record<Mode, string>> = { live: "Live", economy: "Economy", replay_only: "Replay only" };

export const BREAKER_LABEL: Readonly<Record<BreakerKey, string>> = {
  stored: "Stored mode",
  override: "Override",
  llm_spend: "LLM spend",
  qloo_floor: "Qloo month floor",
  qloo_daily: "Qloo daily cap",
  qloo_auth: "Qloo key",
  live_hourly: "Public runs per hour",
  qloo_switch: "Qloo calls",
  draining: "New runs",
};

export const LANE_LABEL = { public: "Public lane", judge: "Judge lane" } as const;

export const ENV_LABEL: Readonly<Record<QlooConfigured["env"], string>> = {
  mock: "Mock data, no key",
  dev: "Development key",
  prod: "Production key",
};

/** Longest stored reason printed: the admin switch takes up to 200 characters. */
const REASON_MAX = 60;
const clip = (text: string) => (text.length > REASON_MAX ? `${text.slice(0, REASON_MAX - 1)}…` : text);

/** What a lane's decision means now: who writes its briefs, or why it stepped down and until when. */
export function laneDetail(decision: LaneDecision): string {
  const until = decision.until ? ` until ${formatUtcTime(decision.until).slice(0, 5)} UTC` : "";
  if (decision.mode === "live") return "Sonnet 5.5 writes each brief";
  const why = decision.reason ? `: ${decision.reason}` : "";
  return decision.mode === "economy" ? `Haiku 5.5 writes each brief${until}${why}` : `No live runs${until}${why}`;
}

/** Blocks that keep every live run off this server, whatever the breakers decide. */
const SERVER_BLOCKS: ReadonlySet<LiveBlock> = new Set(["no_database", "draining", "no_anthropic", "no_qloo"]);

export const UNAVAILABLE_TAG: Tag = { mark: "×", word: "Unavailable", tone: "text-negative" };
export const LIMITED_TAG: Tag = { mark: "–", word: "Limited", tone: "text-negative" };

export interface LaneView {
  detail: string;
  tag: Tag;
  /** Its data-state: the mode, or "unavailable" / "limited" when this server overrules it. */
  state: string;
}

/**
 * A lane's row: its decision, unless this server overrules it. The breakers may say live while the
 * server takes no live run (setup, restart), or while QLOO_DISABLED leaves runs without evidence.
 */
export function laneView(decision: LaneDecision, blocks: readonly LiveBlock[]): LaneView {
  const by = `${MODE_NAME[decision.mode]} by the breakers`;
  if (blocks.some((block) => SERVER_BLOCKS.has(block))) {
    return { detail: `${by} · this server takes no live runs`, tag: UNAVAILABLE_TAG, state: "unavailable" };
  }
  if (blocks.includes("qloo_disabled") && decision.mode !== "replay_only") {
    return { detail: `${by} · no Qloo calls: runs answer as insufficient evidence`, tag: LIMITED_TAG, state: "limited" };
  }
  return { detail: laneDetail(decision), tag: MODE_TAG[decision.mode], state: decision.mode };
}

/** What one breaker reads now, from the report's numbers. */
export function breakerDetail(key: BreakerKey, report: StatusReport): string {
  const { mode, llm, runs, qloo } = report;
  switch (key) {
    case "stored": {
      const { stored } = mode;
      const by = stored.reason ? ` · set by ${clip(stored.reason)}` : "";
      const since = stored.since ? ` · ${utcShort(stored.since)}` : stored.reason === null && stored.mode === "live" ? " · never switched" : "";
      return `${MODE_NAME[stored.mode]}${by}${since}`;
    }
    case "override":
      if (mode.override === null) return "MODE_OVERRIDE not set";
      return mode.override === "live" ? "MODE_OVERRIDE=live: the breakers are bypassed" : `MODE_OVERRIDE=${mode.override}, for a demo`;
    case "llm_spend": {
      const b = llm.budgets.public;
      const today = llm.todayUsd === null ? "Today's spend could not be read" : `${formatUsd(llm.todayUsd)} today`;
      return `${today} · public economy at ${formatUsd(b.economyAt)}, paused at ${formatUsd(b.replayAt)}`;
    }
    case "live_hourly": {
      const hour = runs.lanes.public;
      return hour.lastHour === null ? "The last hour could not be counted" : `${count(hour.lastHour)} of ${count(hour.hourlyCap)} started in the last hour`;
    }
    case "draining":
      return runs.accepting === null ? "This server could not say" : runs.accepting ? "Accepted on this server" : "Refused while this server restarts";
    case "qloo_switch":
      return qloo.disabled ? "Switched off (QLOO_DISABLED): runs answer as insufficient evidence" : "Allowed";
  }
  if (!qloo.configured) return "Qloo is not configured";
  switch (key) {
    case "qloo_floor":
      return qloo.month.remaining === null
        ? `No reading yet · floor ${count(qloo.month.floor)}`
        : `${count(qloo.month.remaining)} calls left this month · floor ${count(qloo.month.floor)}`;
    case "qloo_daily":
      return `${count(qloo.today.network)} of ${count(qloo.today.cap)} fresh calls today${qloo.today.enforced ? "" : " · held in production only"}`;
    case "qloo_auth":
      return `Rejected ${plural(qloo.authErrors, "time")} in a row · replay only at ${qloo.authErrorsTrip}`;
  }
}

const STILL_SERVED = "Showcases, replays and cached answers still work.";
const QLOO_OFF = "Qloo calls are switched off (QLOO_DISABLED): live runs answer as insufficient evidence.";

const BLOCK_SENTENCE: Readonly<Record<Exclude<LiveBlock, "replay_only">, string>> = {
  no_database: "The database is unreachable: briefs can be neither read nor written until it is back.",
  draining: "This server is restarting and takes no new runs; runs in progress finish first.",
  no_anthropic: "Live analysis is unavailable: this server has no Anthropic API key. Recorded briefs and test runs still work.",
  no_qloo: "Live analysis is unavailable: Qloo is not configured on this server. Recorded briefs and test runs still work.",
  live_hourly: "Live analysis is on, but this hour's public runs are used: new questions wait for the hour to turn.",
  qloo_disabled: `${QLOO_OFF} ${STILL_SERVED}`,
};

/** "The judge lane stays live.": said when judges get more than the public lane. */
function judgeSentence(report: StatusReport): string | null {
  const lanes = report.mode.lanes;
  if (lanes === null || lanes.judge.mode === lanes.public.mode) return null;
  if (lanes.judge.mode === "live") return "The judge lane stays live.";
  return lanes.judge.mode === "economy" ? "The judge lane runs on the economy analyst." : "The judge lane is paused.";
}

/** The answer first (A/Answer): what a public live question gets now, then what to watch. */
export function leadSentence(report: StatusReport): string {
  const { live } = report;
  const first = live.blocks[0];
  let head: string;
  if (first === "replay_only") head = `${live.message ?? "Live analysis is paused."} ${STILL_SERVED}`;
  else if (first) head = BLOCK_SENTENCE[first];
  else if (live.state === "economy") head = live.message ?? "Live briefs run on the economy analyst.";
  else head = "Live analysis is on: Sonnet 5.5 writes each brief.";
  const parts = [head];
  if (live.state !== "unavailable") {
    const judge = judgeSentence(report);
    if (judge) parts.push(judge);
    // Behind a pause or a full hour, the runs that do start still go without evidence.
    if (first !== "qloo_disabled" && live.blocks.includes("qloo_disabled")) parts.push(QLOO_OFF);
  }
  const high = report.breakers.filter((b) => b.level === "high").map((b) => BREAKER_LABEL[b.key]);
  if (high.length > 0) parts.push(`${listText(high)} ${high.length === 1 ? "is" : "are"} past 80%.`);
  const { qloo } = report;
  if (qloo.configured && report.breakers.some((b) => b.key === "qloo_auth" && b.level === "warn")) {
    parts.push(`The Qloo key was rejected ${plural(qloo.authErrors, "time")} in a row; at ${qloo.authErrorsTrip} live analysis pauses.`);
  }
  if (report.mode.override === "live") parts.push("MODE_OVERRIDE bypasses every breaker.");
  return parts.join(" ");
}

/** "a", "a and b", "a, b and c". */
function listText(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

// Run outcomes --------------------------------------------------------------------------------------------

/** Statuses in the order the legend lists them: finished well, then stopped, then still going. */
export const STATUS_ORDER: readonly RunStatus[] = [
  "completed",
  "incomplete",
  "needs_input",
  "refused",
  "cancelled",
  "failed",
  "running",
  "queued",
];

export const STATUS_WORD: Readonly<Record<RunStatus, string>> = {
  completed: "completed",
  incomplete: "incomplete",
  needs_input: "awaiting a pick",
  refused: "refused",
  cancelled: "cancelled",
  failed: "failed",
  running: "running",
  queued: "queued",
};

/** Counts per status, in STATUS_ORDER, leaving out the absent ones. */
export function statusCounts(statuses: readonly RunStatus[]): { status: RunStatus; n: number }[] {
  return STATUS_ORDER.flatMap((status) => {
    const n = statuses.filter((s) => s === status).length;
    return n > 0 ? [{ status, n }] : [];
  });
}

/** "17 completed · 2 incomplete · 1 failed". */
export function outcomesText(statuses: readonly RunStatus[]): string {
  return statusCounts(statuses)
    .map(({ status, n }) => `${n} ${STATUS_WORD[status]}`)
    .join(" · ");
}

// Qloo ----------------------------------------------------------------------------------------------------

/** Today's cache hit rate as a whole percent; null with no call today. */
export function cacheRate(cache: QlooConfigured["cache"]): number | null {
  if (cache === null || cache.total === 0) return null;
  return Math.round((cache.served / cache.total) * 100);
}
