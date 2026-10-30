import "server-only";
import type { ScreenerRequest, ScreenerResult } from "@ct/contracts";
import { normaliseName } from "@ct/quant";

/**
 * The screener's answer cache (cached like a run, D26): a finished screen answers the same request
 * again for SCREENER_ANSWER_TTL_MS at no Qloo cost, in any mode. After it expires the Qloo cache still
 * serves the same requests, so a recomputation is usually free of network calls too. Kept in this
 * process (one web service), least recently stored first.
 */

export const SCREENER_ANSWER_TTL_MS = 60 * 60_000;
export const SCREENER_ANSWER_MAX = 200;

/** The cache key: the seed as names are compared (normalised), the markets as a set, rows, map and pick. */
export function screenerKey(request: ScreenerRequest): string {
  const seed = request.seed.by === "tag" ? request.seed.query : request.seed.name;
  const markets = [...new Set(request.markets)].sort().join(",");
  return [request.seed.by, normaliseName(seed), markets, request.rows, request.map ? "map" : "", request.pick ?? ""].join("|");
}

export class ScreenerAnswers {
  private readonly answers = new Map<string, { screen: ScreenerResult; at: number }>();

  constructor(
    private readonly ttlMs: number = SCREENER_ANSWER_TTL_MS,
    private readonly max: number = SCREENER_ANSWER_MAX,
  ) {}

  get(key: string, now: number): ScreenerResult | null {
    const hit = this.answers.get(key);
    if (!hit) return null;
    if (hit.at + this.ttlMs <= now) {
      this.answers.delete(key);
      return null;
    }
    return hit.screen;
  }

  set(key: string, screen: ScreenerResult, now: number): void {
    this.answers.delete(key);
    this.answers.set(key, { screen, at: now });
    for (const oldest of this.answers.keys()) {
      if (this.answers.size <= this.max) break;
      this.answers.delete(oldest);
    }
  }
}
