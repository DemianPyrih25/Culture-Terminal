import "server-only";
import { z } from "zod";

/**
 * Cloudflare Turnstile (SPEC §10.3): the browser's widget hands out a single-use token, and the
 * server checks it with siteverify before a live run or a preview. Tests inject a verifier, so they
 * never reach Cloudflare.
 */

export const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
/** Turnstile tokens are at most 2048 characters. */
export const TURNSTILE_TOKEN_MAX = 2048;
const VERIFY_TIMEOUT_MS = 10_000;

export interface TurnstileKeys {
  /** Public: the browser's widget renders with it. */
  siteKey: string;
  secretKey: string;
}

/**
 * Both keys, or null when either is unset (local dev): verification is then skipped. One without
 * the other is a misconfiguration, reported by the caller.
 */
export function turnstileKeysFromEnv(env: NodeJS.ProcessEnv = process.env): TurnstileKeys | null {
  const siteKey = env.TURNSTILE_SITE_KEY?.trim() ?? "";
  const secretKey = env.TURNSTILE_SECRET_KEY?.trim() ?? "";
  return siteKey !== "" && secretKey !== "" ? { siteKey, secretKey } : null;
}

export type TurnstileResult =
  | { ok: true }
  /** Cloudflare said no: the token is bad, used or expired. */
  | { ok: false; kind: "rejected"; codes: string[] }
  /** Cloudflare could not be asked, or answered something unreadable. */
  | { ok: false; kind: "unavailable"; error: string };

/** Checks one token; `remoteIp` is the visitor's address when known. Never throws. */
export type TurnstileVerifier = (token: string, remoteIp: string | null) => Promise<TurnstileResult>;

const SiteverifyAnswer = z.looseObject({
  success: z.boolean(),
  "error-codes": z.array(z.string()).optional(),
});

/** The siteverify call itself, with this secret. `fetchFn` is injectable for tests. */
export function createSiteverify(secretKey: string, fetchFn: typeof fetch = fetch, timeoutMs = VERIFY_TIMEOUT_MS): TurnstileVerifier {
  return async (token, remoteIp) => {
    const form = new URLSearchParams({ secret: secretKey, response: token });
    if (remoteIp) form.set("remoteip", remoteIp);
    let body: unknown;
    try {
      const res = await fetchFn(SITEVERIFY_URL, { method: "POST", body: form, signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) return { ok: false, kind: "unavailable", error: `siteverify answered ${res.status}` };
      body = await res.json();
    } catch (err) {
      return { ok: false, kind: "unavailable", error: err instanceof Error ? err.message : String(err) };
    }
    const parsed = SiteverifyAnswer.safeParse(body);
    if (!parsed.success) return { ok: false, kind: "unavailable", error: "siteverify answer is unreadable" };
    if (parsed.data.success) return { ok: true };
    return { ok: false, kind: "rejected", codes: parsed.data["error-codes"] ?? [] };
  };
}
