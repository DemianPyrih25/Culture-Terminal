import { MarketId, MetroId, type GeoApi, type Intent, type LocalityApi, type SkillId, type ToolInput } from "@ct/contracts";
import { z } from "zod";
import raw from "../../../../config/metros.json";
import { capIssueLines, describedValue } from "../llm/inputs";

/**
 * The run's MARKETS (director.md §1): the market ids a skill can read as a locality context (SHARE
 * metros, SLATE markets, RANK metro contexts). config/metros.json lists every market with its label;
 * a market is usable only once kv pins its locality (D29), so the run offers the pinned ones. A run
 * with no locality seam, or none pinned, offers the gazetteer metros as before, and their contexts
 * come back "not pinned" in the digest rather than as numbers.
 */

const MarketsConfig = z.object({
  markets: z.array(z.object({ id: MarketId, label: z.string().min(1), state: z.string().min(2), query: z.string().min(1) })).min(1),
});

export interface RunMarket {
  id: MarketId;
  label: string;
  /** Two-letter state, e.g. TN; it tells same-named cities apart. */
  state: string;
  /** The city's /search name, e.g. "New York" for nyc: a second name CLERK may write. */
  query: string;
}

/** Every market config/metros.json knows, major markets first, in file order. */
export const MARKET_CATALOGUE: readonly RunMarket[] = MarketsConfig.parse(raw).markets;

const byId = new Map(MARKET_CATALOGUE.map((m) => [m.id, m]));

/** The tiers config/metros.json sorts markets into: the largest metros, and the mid-size tour and launch markets. */
export const MARKET_TIERS = ["major", "secondary"] as const;
export type MarketTier = (typeof MARKET_TIERS)[number];

/** Read apart from RunMarket, whose shape other modules build on. */
const TiersConfig = z.object({ markets: z.array(z.object({ id: MarketId, tier: z.enum(MARKET_TIERS) })) });
const TIERS: ReadonlyMap<string, MarketTier> = new Map(TiersConfig.parse(raw).markets.map((m) => [m.id, m.tier]));

/** A market's tier, or null for an id config/metros.json does not list. */
export const marketTier = (id: MarketId): MarketTier | null => TIERS.get(id) ?? null;

function gazetteerMarkets(geo: GeoApi): RunMarket[] {
  return geo.metros().flatMap((id) => byId.get(id) ?? []);
}

/** The markets this run can use: the catalogue's pinned markets, else the gazetteer metros. */
export async function runMarkets(localities: LocalityApi | null, geo: GeoApi): Promise<RunMarket[]> {
  if (localities === null) return gazetteerMarkets(geo);
  const settled = await Promise.allSettled(MARKET_CATALOGUE.map((m) => Promise.resolve().then(() => localities.market(m.id))));
  const pinned = MARKET_CATALOGUE.filter((_, i) => {
    const s = settled[i];
    return s?.status === "fulfilled" && s.value !== null;
  });
  return pinned.length > 0 ? pinned : gazetteerMarkets(geo);
}

const words = (s: string): string => ` ${s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;

/**
 * Markets the question names, in the order it names them: the question's gazetteer metro, then the
 * cities CLERK listed in its notes ("markets: Denver, Chicago", clerk.md), matched to MARKETS labels
 * by whole words. Only markets the run can use are returned.
 */
export function namedMarkets(intent: Intent, markets: readonly RunMarket[]): MarketId[] {
  const usable = new Set(markets.map((m) => m.id));
  const notes = words(intent.constraints.notes.join(" ; "));
  const at = (name: string) => notes.indexOf(words(name));
  const found = markets
    .map((m) => ({ id: m.id, at: Math.min(...[at(m.label), at(m.query)].map((i) => (i < 0 ? Infinity : i))) }))
    .filter((m) => m.at !== Infinity)
    .sort((a, b) => a.at - b.at)
    .map((m) => m.id);
  const metro = intent.geo.metro;
  const named = [...(metro !== null && usable.has(metro) ? [metro] : []), ...found];
  return [...new Set(named)];
}

/**
 * The market tier the CLERK notes ask for ("eight secondary-market dates", clerk.md), by whole word,
 * or null when they name neither tier or both.
 */
export function askedTier(intent: Intent): MarketTier | null {
  const notes = words(intent.constraints.notes.join(" ; "));
  const asked = MARKET_TIERS.filter((tier) => notes.includes(` ${tier} `));
  return asked.length === 1 ? (asked[0] ?? null) : null;
}

/**
 * Market ids a skill input names that are not among the run's MARKETS, as INVALID_INPUT issue lines
 * (share_of_taste metros, sponsor_slate markets, rank_candidates metro contexts). MarketId is a
 * format only, so an id the model made up parses, and the skill could only return it as an
 * unavailable row in the exhibit; refused, the call can be sent again with ids from MARKETS. Empty
 * when every market id is the run's.
 */
export function unknownMarketIssues(tool: SkillId, input: unknown, markets: readonly RunMarket[]): string[] {
  const usable = new Set<string>(markets.map((m) => m.id));
  const named: { path: string; id: string }[] = [];
  if (tool === "share_of_taste") (input as ToolInput<"share_of_taste">).metros.forEach((id, i) => named.push({ path: `metros.${i}`, id }));
  if (tool === "sponsor_slate") (input as ToolInput<"sponsor_slate">).markets.forEach((id, i) => named.push({ path: `markets.${i}`, id }));
  if (tool === "rank_candidates") {
    (input as ToolInput<"rank_candidates">).contexts.forEach((c, i) => {
      if (c.kind === "metro") named.push({ path: `contexts.${i}.market`, id: c.market });
    });
  }
  const example = markets[0] === undefined ? "" : `, such as "${markets[0].id}"`;
  return capIssueLines(
    named.filter((m) => !usable.has(m.id)).map((m) => `${m.path}: expected a market id from MARKETS${example}; got ${describedValue(m.id)}`),
  );
}

/** "nashville (Nashville, TN)": how the run context lists a market. */
export const describeMarket = (m: RunMarket): string => `${m.id} (${m.label}, ${m.state})`;

/** True for a market that is also a gazetteer metro (areas, LIFT, BLOCK). */
export const isGazetteerMetro = (id: MarketId): id is MetroId => MetroId.safeParse(id).success;
