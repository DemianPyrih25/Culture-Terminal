import "server-only";
import type { SideConfig } from "@ct/agent";
import { Mode, RUN_QUEUE_DEFAULTS } from "@ct/contracts";
import type { VisitorLimits } from "./visitor-limits";

function numberFromEnv(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = raw === undefined || raw.trim() === "" ? Number.NaN : Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Length of the Foundation fake agent run (PLAN Part 1): 200 s proves the stream outlives proxies. */
export function fakeRunSecondsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  return numberFromEnv(env.FAKE_RUN_SECONDS, 200, 1, 900);
}

/**
 * Concurrent fake runs per process. Each one writes a few hundred rows, so a public URL needs a cap.
 * Agent runs have their own slots (AGENT_RUN_MAX_ACTIVE), which fake runs never take.
 */
export function fakeRunMaxActiveFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  return Math.round(numberFromEnv(env.FAKE_RUN_MAX_ACTIVE, 20, 1, 500));
}

/**
 * Fake runs started per rolling hour, counted in the database. Concurrency alone does not bound
 * storage: a caller can start and cancel runs as fast as slots free up.
 */
export function fakeRunHourlyCapFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  return Math.round(numberFromEnv(env.FAKE_RUN_HOURLY_CAP, 60, 1, 10_000));
}

/** Finished fake runs older than this are deleted with their events. At least the cap's hour. */
export function fakeRunRetentionMsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  return Math.round(numberFromEnv(env.FAKE_RUN_RETENTION_HOURS, 6, 1, 720) * 3_600_000);
}

/**
 * Public-lane agent runs started per rolling hour by every process together, counted in the database
 * (D24 overall: 120 an hour). Runs that never left the queue are not counted.
 */
export function agentRunHourlyCapFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  return Math.round(numberFromEnv(env.AGENT_RUN_HOURLY_CAP, 120, 1, 10_000));
}

/**
 * Agent runs of both lanes one process holds at once (D24, PLAN §10.4 global concurrency 6), the judge
 * lane's JUDGE_RUN_MAX_ACTIVE among them while it is open (run-manager laneSlots); apart from FAKE_RUN_MAX_ACTIVE.
 */
export function agentRunMaxActiveFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  return Math.round(numberFromEnv(env.AGENT_RUN_MAX_ACTIVE, RUN_QUEUE_DEFAULTS.maxActive, 1, 100));
}

/**
 * Agent runs that may wait for a slot when every one is busy (D24: queue 12); one more is refused with
 * RUN_QUEUE_FULL_MESSAGE. 0 turns the queue off: a run that finds no slot is refused at once.
 */
export function runQueueMaxFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  return Math.round(numberFromEnv(env.RUN_QUEUE_MAX, RUN_QUEUE_DEFAULTS.queueMax, 0, 500));
}

/** Seconds a queued run waits for a slot before it ends unrun with queue_timeout (D24: 120 s). */
export function runQueueWaitSFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  return Math.round(numberFromEnv(env.RUN_QUEUE_WAIT_S, RUN_QUEUE_DEFAULTS.waitS, 5, 600));
}

/** Agent runs of both lanes started per rolling 24 hours by every process together (D24 overall: 500). */
export function agentRunDailyCapFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  return Math.round(numberFromEnv(env.AGENT_RUN_DAILY_CAP, 500, 1, 100_000));
}

/**
 * The daily LLM breaker in USD (LLM_DAILY_USD_CAP, D24/D43: $8 a day over the judging days), which the
 * pre-run check keeps to. The side context calls count toward it.
 */
export function llmDailyUsdCapFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  return numberFromEnv(env.LLM_DAILY_USD_CAP, 8, 0, 1000);
}

/**
 * Today's LLM spend in USD at which the judge lane steps down to the economy ANALYST (LLM_ECONOMY_USD,
 * D24: $6, times the lane's share: judge $2.40 of its own share, public $3.60).
 */
export function llmEconomyUsdFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  return numberFromEnv(env.LLM_ECONOMY_USD, 6, 0, 1000);
}

/** Share of the daily LLM budget held back for the judge lane (LLM_JUDGE_SHARE, SPEC §10.4: 40%). */
export function llmJudgeShareFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  return numberFromEnv(env.LLM_JUDGE_SHARE, 0.4, 0, 0.9);
}

/** Judge-lane runs started per rolling hour, counted in the database apart from the public lane's (D24: 30). */
export function judgeRunHourlyCapFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  return Math.round(numberFromEnv(env.JUDGE_RUN_HOURLY_CAP, 30, 1, 10_000));
}

/** Of AGENT_RUN_MAX_ACTIVE, the slots held for judge-lane runs, which public runs never take (D24: 2). */
export function judgeRunMaxActiveFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  return Math.round(numberFromEnv(env.JUDGE_RUN_MAX_ACTIVE, 2, 1, 100));
}

/** Judge-lane runs started per rolling 24 hours, counted in the database (D24: 120). */
export function judgeRunDailyCapFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  return Math.round(numberFromEnv(env.JUDGE_RUN_DAILY_CAP, 120, 1, 10_000));
}

/**
 * The public lane's per-visitor limits (D24: 2 at once, 10 an hour, 30 a day): VISITOR_MAX_ACTIVE,
 * VISITOR_HOURLY_CAP and VISITOR_DAILY_CAP. A day below the hour is raised to it, so the hour can be met.
 */
export function visitorLimitsFromEnv(env: NodeJS.ProcessEnv = process.env): VisitorLimits {
  const maxActive = Math.round(numberFromEnv(env.VISITOR_MAX_ACTIVE, 2, 1, 20));
  const perHour = Math.round(numberFromEnv(env.VISITOR_HOURLY_CAP, 10, 1, 1_000));
  const perDay = Math.max(perHour, Math.round(numberFromEnv(env.VISITOR_DAILY_CAP, 30, 1, 10_000)));
  return { maxActive, perHour, perDay };
}

/**
 * The side calls' timeouts, the agent's SIDE_TIMEOUTS (25 s and 45 s), repeated here so reading the config
 * never loads the agent package (a test holds the two equal).
 */
export const SIDE_TIMEOUT_MS = { ai: 25_000, web: 45_000 } as const;

/** "1" (the default) or "0": a switch read from the environment; anything else keeps the default. */
function switchFromEnv(raw: string | undefined, fallback: boolean): boolean {
  const value = raw?.trim();
  if (value === "1") return true;
  if (value === "0") return false;
  return fallback;
}

/** Searches one answer's "From the web" call may make (WEB_SEARCH_MAX_USES, D45: 3, clamped 1 to 5). */
export function webSearchMaxUsesFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  return Math.round(numberFromEnv(env.WEB_SEARCH_MAX_USES, 3, 1, 5));
}

/**
 * The side context calls (R4, R5, D45): AI_CONTEXT_ENABLED and WEB_SEARCH_ENABLED ("0" turns either off;
 * default on), WEB_SEARCH_MAX_USES, and the fixed timeouts. Economy mode turns the web call off by itself
 * (the agent passes the run's mode); a server without an Anthropic key runs no agent run at all.
 */
export function sideConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SideConfig {
  return {
    aiEnabled: switchFromEnv(env.AI_CONTEXT_ENABLED, true),
    webEnabled: switchFromEnv(env.WEB_SEARCH_ENABLED, true),
    webMaxUses: webSearchMaxUsesFromEnv(env),
    aiTimeoutMs: SIDE_TIMEOUT_MS.ai,
    webTimeoutMs: SIDE_TIMEOUT_MS.web,
  };
}

/** Whether OSM_USER_AGENT is set (D46: without it OpenStreetMap is not configured). Never the value itself. */
export function osmConfiguredFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.OSM_USER_AGENT?.trim() ?? "") !== "";
}

/**
 * MODE_OVERRIDE (live, economy or replay_only): forces the mode on every lane for a demo, whatever
 * the breakers say. Null when unset or not one of the three.
 */
export function modeOverrideFromEnv(env: NodeJS.ProcessEnv = process.env): Mode | null {
  const parsed = Mode.safeParse(env.MODE_OVERRIDE?.trim().toLowerCase());
  return parsed.success ? parsed.data : null;
}

/**
 * Question previews (POST /api/preview) one process answers per rolling hour. Each one that is not
 * already in hand costs a CLERK call, so this caps that spend before the daily LLM breaker does.
 */
export function previewHourlyCapFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  return Math.round(numberFromEnv(env.PREVIEW_HOURLY_CAP, 120, 1, 10_000));
}

/**
 * QLOO_DISABLED=1 (SPEC §6, the fail-closed demo): no Qloo call at all. A preview then skips the
 * resolution gate's lookups and estimates no data requests; passed to the run manager as
 * `qlooEnabled: false`, agent runs take the V7 path.
 */
export function qlooDisabledFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.QLOO_DISABLED?.trim() === "1";
}

/**
 * The static prod fresh Qloo calls per UTC day (QLOO_DAILY_FRESH_CAP, the Qloo client's own setting). During
 * judging the client replaces it with a cap recomputed each UTC day (QlooClient.dailyFreshCap, D24); this
 * is the fallback where no client is at hand.
 */
export function qlooDailyFreshCapFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  return Math.round(numberFromEnv(env.QLOO_DAILY_FRESH_CAP, 1_900, 1, 1_000_000));
}

/** How long SIGTERM waits for active runs before marking them incomplete (SPEC §3.2: up to 180 s). */
export function shutdownGraceMsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  return Math.round(numberFromEnv(env.SHUTDOWN_GRACE_MS, 180_000, 0, 600_000));
}

/**
 * The site's public origin, for the absolute URLs page metadata needs (a showcase's og:image and
 * twitter:image): PUBLIC_SITE_URL, else Railway's RAILWAY_PUBLIC_DOMAIN. A bare host gets https://.
 * Undefined when unset or not a URL: Next then falls back to http://localhost:<PORT> instead of the
 * root layout failing to load, which would fail every page while /api/health stays green.
 */
export function publicSiteUrlFromEnv(env: NodeJS.ProcessEnv = process.env): URL | undefined {
  const raw = env.PUBLIC_SITE_URL?.trim() || env.RAILWAY_PUBLIC_DOMAIN?.trim() || "";
  if (raw === "") return undefined;
  try {
    return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return undefined;
  }
}
