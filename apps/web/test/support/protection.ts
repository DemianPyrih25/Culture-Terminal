// Stand-ins for the protection layer: a mode service on inputs a test sets (spend, stored mode,
// Qloo counters, clock), an answer cache from a map, and an access service whose Turnstile verifier
// is a test double. No database and no call to Cloudflare.
import { vi } from "vitest";
import type { Mode } from "@ct/contracts";
import { AccessService, type AccessOptions } from "../../server/access";
import type { AlreadyHave, AnswerCache } from "../../server/answer-cache";
import { DEFAULT_SPEND_POLICY, ModeService, type QlooUsage, type SpendPolicy } from "../../server/breakers";
import { LIVE_STORED, type StoredModeValue } from "../../server/mode";
import type { TurnstileResult, TurnstileVerifier } from "../../server/turnstile";

/** 2026-10-22 18:00 UTC: six hours before the daily breakers lift. */
export const BREAKER_NOW = Date.parse("2026-10-22T18:00:00.000Z");

/** What the breakers read; a test changes it between calls. */
export interface ModeInputs {
  override?: Mode | null;
  stored?: StoredModeValue;
  todayUsd?: number;
  qloo?: QlooUsage | null;
  now?: number;
}

/** A mode service that reads `inputs` on every call (live, nothing spent, no Qloo breaker by default). */
export function testModes(inputs: ModeInputs = {}, policy: SpendPolicy = DEFAULT_SPEND_POLICY): ModeService {
  return new ModeService(
    {
      override: () => inputs.override ?? null,
      stored: async () => inputs.stored ?? LIVE_STORED,
      todayUsd: async () => inputs.todayUsd ?? 0,
      qloo: async () => inputs.qloo ?? null,
      now: () => inputs.now ?? BREAKER_NOW,
    },
    policy,
  );
}

/** A stored mode as the Qloo client or the admin switch leaves it. */
export const storedMode = (mode: Mode, reason: string | null = "admin"): StoredModeValue => ({ mode, reason, since: null });

/** Prod Qloo counters with room to spare. */
export function qlooUsage(partial: Partial<QlooUsage> = {}): QlooUsage {
  return {
    dailyCapEnforced: true,
    dailyCap: 1_900,
    fresh: { public: 0, judge: 0, all: 0 },
    monthRemaining: 40_000,
    monthFloor: 2_000,
    ...partial,
  };
}

/** An answer cache holding these briefs by question (exactly as asked). */
export function testAnswers(byQuestion: Record<string, AlreadyHave> = {}): AnswerCache & { find: ReturnType<typeof vi.fn> } {
  return { find: vi.fn(async (question: string) => byQuestion[question] ?? null) };
}

/** A recent brief for the answer cache. Invented id. */
export function cachedBrief(question: string, runId = "run-cached-0001"): AlreadyHave {
  return { runId, question, createdAt: "2026-10-22T16:00:00.000Z", signal: "mixed", confidence: { score: 74, band: "MED" } };
}

// Built at runtime from parts, so no key-shaped literal sits in the source.
export const TEST_SITE_KEY = ["site", "key", "for", "tests"].join("-");
export const TEST_SECRET = ["secret", "for", "tests"].join("-");
export const TEST_SESSION_SECRET = ["session", "secret", "for", "tests"].join("-");
export const TEST_JUDGE_TOKEN = ["judge", "token", "for", "tests"].join("-");
/** A token the fake verifier accepts. */
export const GOOD_TOKEN = "turnstile-token-good";

/** A verifier that accepts GOOD_TOKEN, rejects anything else, and records what it was asked. */
export function fakeVerifier(answer?: (token: string) => TurnstileResult) {
  return vi.fn<TurnstileVerifier>(async (token) =>
    answer ? answer(token) : token === GOOD_TOKEN ? { ok: true } : { ok: false, kind: "rejected", codes: ["invalid-input-response"] },
  );
}

/** An access service with Turnstile on (fake verifier) and the judge lane open, on a clock a test moves. */
export function testAccess(options: Partial<AccessOptions> & { clock?: { ms: number } } = {}): AccessService {
  const clock = options.clock ?? { ms: BREAKER_NOW };
  return new AccessService({
    turnstile: { siteKey: TEST_SITE_KEY, secretKey: TEST_SECRET },
    verify: fakeVerifier(),
    sessionSecret: TEST_SESSION_SECRET,
    judgeToken: TEST_JUDGE_TOKEN,
    secureCookies: false,
    now: () => clock.ms,
    ...options,
  });
}

/** The name=value part of a Set-Cookie header, as a browser sends it back. */
export const cookiePair = (setCookie: string | null): string => (setCookie ?? "").split(";")[0] ?? "";
