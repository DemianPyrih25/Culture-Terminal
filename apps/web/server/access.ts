import "server-only";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Lane } from "@ct/contracts";
import { clientIp, clientKey, clientKeySecret } from "./client-ip";
import { log } from "./log";
import { createSiteverify, turnstileKeysFromEnv, type TurnstileKeys, type TurnstileVerifier } from "./turnstile";

export { clientIp };

/**
 * Who is asking (SPEC §10.3): the lane, from a signed judge cookie, and whether a person passed
 * Turnstile, from a signed two-hour cookie minted on a verified token. Both cookies are httpOnly
 * HMACs of their expiry: nothing in them is secret or personal, and neither can be forged without
 * the server's key.
 *
 * - Judge lane: GET /api/judge?token=<JUDGE_TOKEN> sets ct_judge. Its key is derived from the token,
 *   so rotating JUDGE_TOKEN revokes every judge cookie at once. Wrong tokens are limited per minute.
 * - Human check: a live run or a preview needs ct_human or a Turnstile token (which then mints
 *   ct_human). Without Turnstile keys the check is skipped and logged once in dev and tests; in
 *   production it fails closed (no live run) unless TURNSTILE_DISABLED=1 says to skip it.
 */

export const HUMAN_COOKIE = "ct_human";
export const JUDGE_COOKIE = "ct_judge";
/**
 * Set to "passed" on an answer whose request passed the human check (by cookie or token): only then
 * does the browser hold itself verified. components/protection/human-check.ts reads the same name.
 */
export const HUMAN_CHECK_HEADER = "x-human-check";
/** SPEC §10.3: a successful verify mints a two-hour cookie. */
export const HUMAN_TTL_S = 2 * 3600;
/** Long enough for the judging period; a rotated JUDGE_TOKEN ends it sooner. */
export const JUDGE_TTL_S = 14 * 24 * 3600;
/** Wrong judge links this process answers per minute; past it every judge link is refused (429) for the rest of the minute. */
export const JUDGE_MISSES_PER_MINUTE = 20;
/** A judge token shorter than this is logged at startup: the link must not be guessable. */
export const JUDGE_TOKEN_MIN_CHARS = 24;

// Cookies ------------------------------------------------------------------------------------------

/** The request's cookies by name (the first of a repeated name wins). */
export function readCookies(header: string | null | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (header ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at <= 0) continue;
    const name = part.slice(0, at).trim();
    if (name !== "" && !out.has(name)) out.set(name, part.slice(at + 1).trim());
  }
  return out;
}

const mac = (key: Buffer, purpose: string, expS: number): string =>
  createHmac("sha256", key).update(`${purpose}.${expS}`).digest("base64url");

/** "<expiry s>.<hmac>": a value only the holder of `key` can make, good until its expiry. */
export function signedValue(key: Buffer, purpose: string, expS: number): string {
  return `${expS}.${mac(key, purpose, expS)}`;
}

/** Whether `value` is a signedValue of this key and purpose that has not expired at `nowS`. */
export function verifySigned(key: Buffer, purpose: string, value: string | undefined, nowS: number): boolean {
  const match = /^(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(value ?? "");
  if (!match) return false;
  const expS = Number(match[1]);
  if (!(expS > nowS)) return false;
  const expected = Buffer.from(mac(key, purpose, expS));
  const given = Buffer.from(match[2] ?? "");
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export function cookieHeader(name: string, value: string, maxAgeS: number, secure: boolean): string {
  return `${name}=${value}; Path=/; Max-Age=${maxAgeS}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

/** Equal secrets, compared in constant time (both are hashed first, so their lengths do not leak). */
export function sameSecret(given: string, expected: string): boolean {
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

// The service --------------------------------------------------------------------------------------

export type HumanCheck =
  /** off: no Turnstile keys; cookie: a valid ct_human; token: a verified token (setCookie mints ct_human). */
  | { ok: true; via: "off" | "cookie" | "token"; setCookie: string | null }
  /**
   * missing: no cookie and no token. rejected: Cloudflare said no. unavailable: Cloudflare could not
   * be asked. unconfigured: the check is required but its keys are not set (production).
   */
  | { ok: false; kind: "missing" | "rejected" | "unavailable" | "unconfigured" };

/** The human check as /api/health reports it: on, off (skipped on purpose) or required without its keys. */
export type HumanCheckSetting = "on" | "off" | "unconfigured";

/** A judge link's outcome: the cookie, a wrong token (404), or too many wrong ones this minute (429). */
export type JudgeLink = { kind: "open"; cookie: string } | { kind: "wrong" } | { kind: "locked"; retryAfterS: number };

export interface AccessOptions {
  /** Null skips the human check (local dev), unless `required`. */
  turnstile: TurnstileKeys | null;
  /** True: without Turnstile keys every request that spends is refused, never let through (production). */
  required?: boolean;
  /** Default: Cloudflare's siteverify with the secret key. */
  verify?: TurnstileVerifier;
  /** SESSION_HMAC_SECRET. Without it ct_human is signed with a key made at startup, so a restart ends it. */
  sessionSecret: string | null;
  /** JUDGE_TOKEN: null leaves the judge lane closed. */
  judgeToken: string | null;
  /**
   * IP_HASH_SALT, for the visitor keys runs record (runs.ip_hash) and the per-visitor limits count;
   * without it they change on a restart, and the limits start over (warned in production).
   */
  ipSalt?: string | null;
  /** Mark cookies Secure (production, behind TLS). */
  secureCookies: boolean;
  now?: () => number;
}

export class AccessService {
  private readonly turnstile: TurnstileKeys | null;
  private readonly required: boolean;
  private readonly verify: TurnstileVerifier | null;
  private readonly humanKey: Buffer;
  private readonly judgeKey: Buffer | null;
  private readonly judgeToken: string | null;
  private readonly ipKey: Buffer;
  private readonly secure: boolean;
  private readonly now: () => number;
  /** When this process answered each wrong judge link of the last minute. */
  private judgeMisses: number[] = [];
  private warnedOff = false;

  constructor(options: AccessOptions) {
    this.turnstile = options.turnstile;
    this.required = options.required ?? false;
    this.verify = options.turnstile ? (options.verify ?? createSiteverify(options.turnstile.secretKey)) : null;
    const session = options.sessionSecret?.trim() || null;
    this.humanKey = session ? createHash("sha256").update(`ct-human|${session}`).digest() : randomBytes(32);
    this.judgeToken = options.judgeToken?.trim() || null;
    this.judgeKey = this.judgeToken
      ? createHash("sha256").update(`ct-judge|${this.judgeToken}|${session ?? ""}`).digest()
      : null;
    this.ipKey = clientKeySecret(options.ipSalt);
    this.secure = options.secureCookies;
    this.now = options.now ?? Date.now;
    if (this.turnstile && !session) log.warn("SESSION_HMAC_SECRET is not set: the human-check cookie ends when the server restarts");
    // The runs keep the visitor keys (runs.ip_hash): a key made at startup matches none of them after a restart.
    if (this.secure && !options.ipSalt?.trim()) log.warn("IP_HASH_SALT is not set: the per-visitor limits start over when the server restarts");
    if (this.judgeToken !== null && this.judgeToken.length < JUDGE_TOKEN_MIN_CHARS) {
      log.warn(
        { length: this.judgeToken.length, min: JUDGE_TOKEN_MIN_CHARS },
        "JUDGE_TOKEN is short: a guessed judge link opens the judge lane; use a long random string",
      );
    }
    if (!this.turnstile && this.required) log.error("Turnstile keys are not set: live runs and previews are refused until they are");
  }

  private nowS(): number {
    return Math.floor(this.now() / 1000);
  }

  /** The Turnstile site key for the browser's widget; null when the check is off. */
  get siteKey(): string | null {
    return this.turnstile?.siteKey ?? null;
  }

  get judgeLaneOpen(): boolean {
    return this.judgeKey !== null;
  }

  get humanCheck(): HumanCheckSetting {
    return this.turnstile ? "on" : this.required ? "unconfigured" : "off";
  }

  /** The visitor's key for the per-visitor limits (client-ip.ts); null without an address. */
  clientKey(request: Request | undefined): string | null {
    return clientKey(request, this.ipKey);
  }

  /** The judge lane for a valid ct_judge cookie (while JUDGE_TOKEN is set), the public lane otherwise. */
  laneOf(request: Request | undefined): Lane {
    if (!this.judgeKey || !request) return "public";
    const value = readCookies(request.headers.get("cookie")).get(JUDGE_COOKIE);
    return verifySigned(this.judgeKey, "judge", value, this.nowS()) ? "judge" : "public";
  }

  /** Whether the request needs no Turnstile token: the check is off, or ct_human is valid. */
  isVerified(request: Request | undefined): boolean {
    if (!this.turnstile) return !this.required;
    const value = request ? readCookies(request.headers.get("cookie")).get(HUMAN_COOKIE) : undefined;
    return verifySigned(this.humanKey, "human", value, this.nowS());
  }

  /** The human check for a request that spends: a valid cookie, else the token, verified once. */
  async checkHuman(request: Request | undefined, token: string | null | undefined): Promise<HumanCheck> {
    if (!this.turnstile || !this.verify) {
      if (this.required) return { ok: false, kind: "unconfigured" };
      if (!this.warnedOff) log.warn("TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY are not both set: the human check is skipped");
      this.warnedOff = true;
      return { ok: true, via: "off", setCookie: null };
    }
    if (this.isVerified(request)) return { ok: true, via: "cookie", setCookie: null };
    if (!token) return { ok: false, kind: "missing" };
    const result = await this.verify(token, clientIp(request));
    if (!result.ok) {
      if (result.kind === "unavailable") log.error({ error: result.error }, "turnstile: siteverify could not be asked");
      else log.info({ codes: result.codes }, "turnstile: token rejected");
      return { ok: false, kind: result.kind };
    }
    const value = signedValue(this.humanKey, "human", this.nowS() + HUMAN_TTL_S);
    return { ok: true, via: "token", setCookie: cookieHeader(HUMAN_COOKIE, value, HUMAN_TTL_S, this.secure) };
  }

  /** The Set-Cookie of a judge link with this token, or null when it is not the judge token. */
  judgeCookie(token: string | null | undefined): string | null {
    if (!this.judgeKey || !this.judgeToken || !token || !sameSecret(token, this.judgeToken)) return null;
    return cookieHeader(JUDGE_COOKIE, signedValue(this.judgeKey, "judge", this.nowS() + JUDGE_TTL_S), JUDGE_TTL_S, this.secure);
  }

  /**
   * GET /api/judge with this token. After JUDGE_MISSES_PER_MINUTE wrong ones in a minute, every
   * judge link is refused until the oldest leaves the minute, the right one too, or a script could
   * still try codes as fast as it likes. A closed lane is always "wrong".
   */
  openJudgeLane(token: string | null | undefined): JudgeLink {
    if (!this.judgeKey) return { kind: "wrong" };
    const now = this.now();
    this.judgeMisses = this.judgeMisses.filter((at) => at > now - 60_000);
    const oldest = this.judgeMisses[0];
    if (this.judgeMisses.length >= JUDGE_MISSES_PER_MINUTE && oldest !== undefined) {
      return { kind: "locked", retryAfterS: Math.max(1, Math.ceil((oldest + 60_000 - now) / 1000)) };
    }
    const cookie = this.judgeCookie(token);
    if (cookie !== null) return { kind: "open", cookie };
    this.judgeMisses.push(now);
    return { kind: "wrong" };
  }
}

/** JUDGE_TOKEN, or JUDGE_CODE as the plan first named it. */
export function judgeTokenFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.JUDGE_TOKEN?.trim() || env.JUDGE_CODE?.trim() || null;
}

/** TURNSTILE_DISABLED=1: run production without the human check, on purpose (it is required otherwise). */
export function turnstileDisabledFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TURNSTILE_DISABLED?.trim() === "1";
}

/** Whether the request carries `Authorization: Bearer <ADMIN_TOKEN>`; always false while ADMIN_TOKEN is unset. */
export function isAdmin(request: Request, adminToken: string | null | undefined = process.env.ADMIN_TOKEN): boolean {
  const expected = adminToken?.trim() ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization")?.trim() ?? "");
  return expected !== "" && match !== null && sameSecret(match[1] ?? "", expected);
}

/**
 * The access options from the environment. In production the human check is required (SPEC §10.3):
 * with a Turnstile key missing, live runs are refused rather than let through, unless
 * TURNSTILE_DISABLED=1 turns the check off on purpose.
 */
export function accessOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): AccessOptions {
  const site = env.TURNSTILE_SITE_KEY?.trim() ?? "";
  const secret = env.TURNSTILE_SECRET_KEY?.trim() ?? "";
  const disabled = turnstileDisabledFromEnv(env);
  const required = env.NODE_ENV === "production" && !disabled;
  if ((site === "") !== (secret === "")) {
    log.error(
      required
        ? "only one of TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY is set: live runs are refused"
        : "only one of TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY is set: the human check is off",
    );
  }
  if (disabled && env.NODE_ENV === "production") log.warn("TURNSTILE_DISABLED=1: live runs need no human check");
  return {
    turnstile: disabled ? null : turnstileKeysFromEnv(env),
    required,
    sessionSecret: env.SESSION_HMAC_SECRET?.trim() || null,
    judgeToken: judgeTokenFromEnv(env),
    ipSalt: env.IP_HASH_SALT?.trim() || null,
    secureCookies: env.NODE_ENV === "production",
  };
}

const KEY = "__ctAccess";
type GlobalWithAccess = typeof globalThis & { [KEY]?: AccessService };

/** The process-wide access service, on globalThis like the container's singletons (one key per process). */
export function getAccessService(): AccessService {
  const g = globalThis as GlobalWithAccess;
  return (g[KEY] ??= new AccessService(accessOptionsFromEnv()));
}
