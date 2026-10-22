import "server-only";

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

/** Agent runs one process holds at once (PLAN §10.4 global concurrency 3), apart from FAKE_RUN_MAX_ACTIVE. */
export function agentRunMaxActiveFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  return Math.round(numberFromEnv(env.AGENT_RUN_MAX_ACTIVE, 3, 1, 100));
}

/** The daily LLM breaker in USD (LLM_DAILY_USD_CAP, PLAN §4.2), which the pre-run check keeps to. */
export function llmDailyUsdCapFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  return numberFromEnv(env.LLM_DAILY_USD_CAP, 1.4, 0, 1000);
}

/** How long SIGTERM waits for active runs before marking them incomplete (SPEC §3.2: up to 180 s). */
export function shutdownGraceMsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  return Math.round(numberFromEnv(env.SHUTDOWN_GRACE_MS, 180_000, 0, 600_000));
}
