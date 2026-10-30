import type { Mode } from "@ct/contracts";
import { DEFAULT_DAILY_FRESH_CAP, DEFAULT_JUDGING_END_DATE, DEFAULT_TAG_CAP } from "./budget";
import type { QlooClientOptions } from "./client";
import { createHttpTransport, DEFAULT_QLOO_BASE_URL, normaliseBaseUrl } from "./http-transport";
import type { QlooLogger } from "./logger";
import { createMockTransport } from "./mock";
import type { QlooEnv, QlooStore } from "./store";
import type { Transport } from "./transport-types";

/**
 * Client options from the environment (SPEC §11.5, .env.example):
 * - QLOO_MOCK: "1" uses the synthetic mock transport (env "mock", no key, no network); "0" or unset is live.
 * - QLOO_API_KEY: required when live.
 * - QLOO_BASE_URL: default https://hackathon.api.qloo.com.
 * - QLOO_TAG: call-log label, default "dev"; each parallel dev agent sets its own.
 * - QLOO_TAG_CAP: network calls allowed for the tag over all time. It is a dev cap (SPEC §5.1 step 5):
 *   dev defaults to 200 and refuses "off". Prod has it off unless set to a number (an explicit opt-in;
 *   "" and "off" keep it off), since its daily cap and month floor already guard the quota. Mock mode
 *   never applies it: synthetic calls cost nothing.
 * - QLOO_RPS: global requests per second, default 1.5 (prod sets 7).
 * - QLOO_DAILY_FRESH_CAP: prod fresh calls per UTC day outside the judging window, default 1,900 (lowered
 *   during abuse).
 * - JUDGING_END_DATE: the last judging day (UTC, YYYY-MM-DD), default 2026-11-16. Until then the prod daily
 *   cap is recomputed each UTC day from the month's remaining calls (dailyFreshCapFor, D24); "off" keeps the
 *   static cap only.
 * - Environment: "prod" when NODE_ENV=production and QLOO_ENV is not "dev"; otherwise "dev". QLOO_ENV=dev
 *   lets a production build (e.g. a local `next start`) keep the development floor and caps.
 */

export interface QlooEnvDeps {
  store: QlooStore;
  logger?: QlooLogger;
  onModeChange?: (mode: Mode) => void;
  /** Injectable fetch for the live transport (tests). */
  fetch?: typeof fetch;
}

const MAX_RPS = 10;

export function resolveQlooEnv(env: NodeJS.ProcessEnv): QlooEnv {
  if (parseMockFlag(env.QLOO_MOCK)) return "mock";
  return env.NODE_ENV === "production" && env.QLOO_ENV?.trim() !== "dev" ? "prod" : "dev";
}

export function qlooClientOptionsFromEnv(env: NodeJS.ProcessEnv, deps: QlooEnvDeps): QlooClientOptions {
  const qlooEnv = resolveQlooEnv(env);
  const baseUrl = normaliseBaseUrl(env.QLOO_BASE_URL?.trim() || DEFAULT_QLOO_BASE_URL);
  let transport: Transport;
  if (qlooEnv === "mock") {
    transport = createMockTransport();
  } else {
    const apiKey = env.QLOO_API_KEY?.trim();
    if (!apiKey) {
      throw new Error("QLOO_API_KEY is not set. Set it for live Qloo calls, or set QLOO_MOCK=1 to run on synthetic data without a key.");
    }
    transport = createHttpTransport({ baseUrl, apiKey, fetch: deps.fetch });
  }
  return {
    transport,
    env: qlooEnv,
    baseUrl,
    tag: env.QLOO_TAG?.trim() || "dev",
    tagCap: parseTagCap(env.QLOO_TAG_CAP, qlooEnv),
    rps: parseRps(env.QLOO_RPS),
    dailyFreshCap: parsePositiveInt("QLOO_DAILY_FRESH_CAP", env.QLOO_DAILY_FRESH_CAP) ?? DEFAULT_DAILY_FRESH_CAP,
    judgingEndDate: parseJudgingEndDate(env.JUDGING_END_DATE),
    store: deps.store,
    logger: deps.logger,
    onModeChange: deps.onModeChange,
  };
}

function parseMockFlag(raw: string | undefined): boolean {
  const value = raw?.trim() ?? "";
  if (value === "1") return true;
  if (value === "0" || value === "") return false;
  throw new Error(`QLOO_MOCK must be "1" (synthetic data) or "0" (live Qloo), got "${value}"`);
}

function parseTagCap(raw: string | undefined, env: QlooEnv): number | null {
  const value = raw?.trim().toLowerCase() ?? "";
  let cap: number | null = null;
  if (value !== "" && value !== "off") {
    cap = Number(value);
    if (!Number.isInteger(cap) || cap < 0) throw new Error(`QLOO_TAG_CAP must be a non-negative integer or "off", got "${raw}"`);
  }
  if (env === "mock") return null;
  if (env === "prod") return cap;
  if (value === "off") {
    throw new Error("QLOO_TAG_CAP=off is allowed only in production or mock mode; development keeps a per-tag cap (default 200)");
  }
  return cap ?? DEFAULT_TAG_CAP;
}

function parseRps(raw: string | undefined): number {
  const value = raw?.trim();
  if (!value) return 1.5;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > MAX_RPS) throw new Error(`QLOO_RPS must be a number in (0, ${MAX_RPS}], got "${raw}"`);
  return n;
}

/** JUDGING_END_DATE: a real calendar day as YYYY-MM-DD, "off" for none; unset is the default day. */
export function parseJudgingEndDate(raw: string | undefined): string | null {
  const value = raw?.trim() ?? "";
  if (value === "") return DEFAULT_JUDGING_END_DATE;
  if (value.toLowerCase() === "off") return null;
  const ms = /^\d{4}-\d{2}-\d{2}$/.test(value) ? Date.parse(`${value}T00:00:00.000Z`) : Number.NaN;
  const valid = Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value;
  if (!valid) throw new Error(`JUDGING_END_DATE must be a date as YYYY-MM-DD or "off", got "${raw}"`);
  return value;
}

function parsePositiveInt(name: string, raw: string | undefined): number | null {
  const value = raw?.trim();
  if (!value) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a positive integer, got "${raw}"`);
  return n;
}
