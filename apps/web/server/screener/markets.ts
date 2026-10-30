import { MarketId } from "@ct/contracts";
import { z } from "zod";
import metros from "../../../../config/metros.json";

/**
 * The markets a screen can read metro breadth in: every market in config/metros.json (the map cities
 * are markets too), in config order. A market is read only when its Qloo locality is pinned in kv
 * (server/localities.ts); one that is not shows its cells as unavailable, with that reason.
 */

export interface ScreenerMarketOption {
  id: MarketId;
  label: string;
}

const Config = z.object({ markets: z.array(z.object({ id: MarketId, label: z.string().min(1) })) });

export const SCREENER_MARKET_OPTIONS: readonly ScreenerMarketOption[] = Config.parse(metros).markets.map((m) => ({ id: m.id, label: m.label }));

const BY_ID: ReadonlyMap<string, ScreenerMarketOption> = new Map(SCREENER_MARKET_OPTIONS.map((m) => [m.id, m]));

export function screenerMarket(id: string): ScreenerMarketOption | null {
  return BY_ID.get(id) ?? null;
}

/** Ids config/metros.json does not list: a screen naming one is refused (400), never read without it. */
export function unknownMarkets(ids: readonly string[]): string[] {
  return ids.filter((id) => !BY_ID.has(id));
}
