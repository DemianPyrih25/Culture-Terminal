import { MarketId, METRO_LABEL, type GeoApi, type MetroId, type Neighbourhood, type QlooParams, type QlooSearchEntity } from "@ct/contracts";
import { normaliseName } from "@ct/quant";
import { z } from "zod";
import raw from "../../../../config/metros.json";
import { MARKET_CATALOGUE, type RunMarket } from "../run/markets";

/**
 * Places GHOST names (SPEC §6.6): markets are matched against MARKET_CATALOGUE and neighbourhoods
 * against the gazetteer, neither costing a Qloo call; a place found in neither is looked up as a
 * Qloo locality with one /search.
 */

export const LOCALITY_TYPE = "urn:entity:locality";
/** Enough results to see every exact tie: a common town or neighbourhood name exists in many states. */
export const LOCALITY_SEARCH_TAKE = 10;

/** A catalogue market with its state's full name, so "Denver, Colorado" matches as well as "Denver, CO". */
export interface GhostMarket extends RunMarket {
  stateName: string | null;
}

const StateNames = z.object({ markets: z.array(z.object({ id: MarketId, state_name: z.string().min(1) })) });
const STATE_NAME = new Map(StateNames.parse(raw).markets.map((m) => [m.id, m.state_name]));

/** MARKET_CATALOGUE with state names from config/metros.json. */
export const GHOST_MARKETS: readonly GhostMarket[] = MARKET_CATALOGUE.map((m) => ({ ...m, stateName: STATE_NAME.get(m.id) ?? null }));

/** What place matching and the AREAS line need from the gazetteer. */
export type GazetteerLike = Pick<GeoApi, "metros" | "neighbourhoods" | "matchNeighbourhood" | "neighbourhood">;

/**
 * The USPS codes of the states and DC with their names: public taxonomy, not Qloo data (D29). ghost.md
 * asks for "Denver, CO", while a locality's disambiguation spells the state out ("Colorado, United States").
 */
const US_STATE_NAME: Readonly<Record<string, string>> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut",
  DE: "Delaware", DC: "District of Columbia", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois",
  IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
  MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana",
  NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York",
  NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania",
  RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah",
  VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
};

/** The state a qualifier names by its USPS code ("CO", "D.C."), or null. */
export function usStateName(qualifier: string): string | null {
  const code = normaliseName(qualifier);
  return /^[a-z]{2}$/.test(code) ? (US_STATE_NAME[code.toUpperCase()] ?? null) : null;
}

/** "Denver, CO" is head "Denver" and qualifier "CO"; text without a comma has no qualifier. */
export function splitPlace(text: string): { head: string; qualifier: string | null } {
  const at = text.indexOf(",");
  if (at < 0) return { head: text.trim(), qualifier: null };
  const qualifier = text.slice(at + 1).trim();
  return { head: text.slice(0, at).trim(), qualifier: qualifier === "" ? null : qualifier };
}

const same = (a: string, b: string | null): boolean => b !== null && a !== "" && normaliseName(a) === normaliseName(b);

/**
 * The catalogue market a pick names: its city (before any comma) is a market's label or search name
 * under normaliseName, and a qualifier, when given, is that market's state code or state name. Null
 * unless exactly one market fits.
 */
export function catalogueMarket(text: string, markets: readonly GhostMarket[] = GHOST_MARKETS): GhostMarket | null {
  const { head, qualifier } = splitPlace(text);
  const fits = markets.filter(
    (m) => (same(head, m.label) || same(head, m.query)) && (qualifier === null || same(qualifier, m.state) || same(qualifier, m.stateName)),
  );
  return fits.length === 1 ? (fits[0] ?? null) : null;
}

/**
 * The gazetteer neighbourhood a pick names: the whole text, else the part before a comma, matched by
 * the gazetteer's own normalised names and aliases. With the question's metro, only that metro's areas
 * count, and none when a qualifier names another metro: an area of another city is not a place the
 * brief could rank, so it is left to the locality search. With none, each metro is tried, and a
 * qualifier naming a metro settles a name two metros share; otherwise null unless exactly one metro
 * has it.
 */
export function gazetteerArea(text: string, geo: GazetteerLike, metro: MetroId | null = null): Neighbourhood | null {
  const { head, qualifier } = splitPlace(text);
  const named = qualifier === null ? [] : geo.metros().filter((m) => same(qualifier, METRO_LABEL[m]));
  const metros = metro === null ? geo.metros() : named.some((m) => m !== metro) ? [] : geo.metros().filter((m) => m === metro);
  const found = metros.flatMap((m) => {
    const area = geo.matchNeighbourhood(m, text) ?? (head === text.trim() ? null : geo.matchNeighbourhood(m, head));
    return area === null ? [] : [area];
  });
  if (found.length <= 1) return found[0] ?? null;
  const own = found.filter((a) => named.includes(a.metro));
  return own.length === 1 ? (own[0] ?? null) : null;
}

/** One /search for a place as a Qloo locality, by the name before any comma (as tools/dev localities pins markets). */
export function localitySearchParams(text: string): QlooParams {
  return { query: splitPlace(text).head, types: LOCALITY_TYPE, take: LOCALITY_SEARCH_TAKE };
}

/**
 * True when one comma-separated part of a disambiguation ("Maine, United States") is the qualifier,
 * or the state its USPS code stands for ("ME").
 */
function namesQualifier(disambiguation: string | null | undefined, qualifier: string): boolean {
  const state = usStateName(qualifier);
  return (disambiguation ?? "").split(",").some((part) => same(qualifier, part) || (state !== null && same(state, part)));
}

/**
 * The exact-match rule for a place (D20, as classifyMatches for entities): a locality-typed result
 * whose normalised name is the pick's city or neighbourhood. A qualifier narrows the matches to those
 * whose disambiguation names it, when any does ("Portland, Maine", or "Portland, ME" by its state
 * code); one that names none narrows nothing. Exactly one match left is exact; none or several is not.
 */
export function classifyLocality(text: string, results: readonly QlooSearchEntity[]): QlooSearchEntity | null {
  const { head, qualifier } = splitPlace(text);
  const seen = new Set<string>();
  const exact = results.filter((r) => {
    if (seen.has(r.entity_id)) return false;
    seen.add(r.entity_id);
    return r.types.includes(LOCALITY_TYPE) && same(head, r.name);
  });
  const narrowed = qualifier === null ? [] : exact.filter((r) => namesQualifier(r.disambiguation, qualifier));
  const pool = narrowed.length > 0 ? narrowed : exact;
  return pool.length === 1 ? (pool[0] ?? null) : null;
}
