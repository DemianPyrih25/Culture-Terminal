import "server-only";
import { Mode } from "@ct/contracts";

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
 * Agent runs started per rolling hour by every process together, counted in the database. A coarse
 * global ceiling on LLM and Qloo spend until the lane limits (PLAN §10.4) arrive.
 */
export function agentRunHourlyCapFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  return Math.round(numberFromEnv(env.AGENT_RUN_HOURLY_CAP, 20, 1, 10_000));
}

/**
 * Agent runs of both lanes one process holds at once (PLAN §10.4 global concurrency 3), the judge
 * lane's JUDGE_RUN_MAX_ACTIVE among them while it is open (run-manager laneSlots); apart from FAKE_RUN_MAX_ACTIVE.
 */
export function agentRunMaxActiveFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  return Math.round(numberFromEnv(env.AGENT_RUN_MAX_ACTIVE, 3, 1, 100));
}

/** Agent runs of both lanes started per rolling 24 hours by every process together (SPEC §10.4 global: 200). */
export function agentRunDailyCapFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  return Math.round(numberFromEnv(env.AGENT_RUN_DAILY_CAP, 200, 1, 100_000));
}

/** The daily LLM breaker in USD (LLM_DAILY_USD_CAP, PLAN §4.2), which the pre-run check keeps to. */
export function llmDailyUsdCapFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  return numberFromEnv(env.LLM_DAILY_USD_CAP, 1.4, 0, 1000);
}

/** Today's LLM spend in USD at which the judge lane steps down to the economy ANALYST (LLM_ECONOMY_USD, SPEC §4.2). */
export function llmEconomyUsdFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  return numberFromEnv(env.LLM_ECONOMY_USD, 1, 0, 1000);
}

/** Share of the daily LLM budget held back for the judge lane (LLM_JUDGE_SHARE, SPEC §10.4: 40%). */
export function llmJudgeShareFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  return numberFromEnv(env.LLM_JUDGE_SHARE, 0.4, 0, 0.9);
}

/** Judge-lane runs started per rolling hour, counted in the database apart from the public lane's (SPEC §10.4: 20). */
export function judgeRunHourlyCapFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  return Math.round(numberFromEnv(env.JUDGE_RUN_HOURLY_CAP, 20, 1, 10_000));
}

/** Of AGENT_RUN_MAX_ACTIVE, the slots held for judge-lane runs, which public runs never take (SPEC §10.4: 1). */
export function judgeRunMaxActiveFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  return Math.round(numberFromEnv(env.JUDGE_RUN_MAX_ACTIVE, 1, 1, 100));
}

/** Judge-lane runs started per rolling 24 hours, counted in the database (SPEC §10.4: 60). */
export function judgeRunDailyCapFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  return Math.round(numberFromEnv(env.JUDGE_RUN_DAILY_CAP, 60, 1, 10_000));
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

/** Prod fresh Qloo calls per UTC day (QLOO_DAILY_FRESH_CAP, the Qloo client's own setting): the preview's quota share. */
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
