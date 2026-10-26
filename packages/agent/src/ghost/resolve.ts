import {
  GhostPickCategory,
  type EntityRef,
  type EntityRegistry,
  type EntityType,
  type GhostAnswer,
  type MarketId,
  type MetroId,
  type QlooApi,
  type QlooParams,
  type QlooSearchEntity,
} from "@ct/contracts";
import { classifyMatches, searchParams } from "@ct/quant";
import { gazetteer } from "../run/gazetteer";
import {
  catalogueMarket,
  classifyLocality,
  gazetteerArea,
  GHOST_MARKETS,
  localitySearchParams,
  type GazetteerLike,
  type GhostMarket,
} from "./places";

/**
 * GHOST's picks looked up in Qloo (SPEC §6.6): at most GHOST_SEARCH_MAX /search calls per answer,
 * through the same cached Qloo client the skills use, so a name the run already searched costs
 * nothing. Markets and neighbourhoods are tried against the market catalogue and the gazetteer first.
 *
 * The exact-match rule is S0's (D20, classifyMatches): a pick resolves when exactly one result has
 * the category's entity type and the pick's name under normaliseName; ambiguous and inexact names do
 * not resolve and are never swapped for a near match. Places follow classifyLocality.
 */

/** SPEC §6.6: GHOST's picks are resolved through the cached /search, at most ten per answer. */
export const GHOST_SEARCH_MAX = 10;

/** The cached Qloo /search (QlooApi.search), as the skills call it. */
export type GhostSearch = QlooApi["search"];

/**
 * How a pick was looked up. catalogue, gazetteer and search are checked lookups; skipped (past the
 * search cap) and failed (the search threw) leave the pick unchecked.
 */
export type GhostLookup = "catalogue" | "gazetteer" | "search" | "skipped" | "failed";

export interface ResolvedGhostPick {
  /** As GHOST wrote it (after tidyGhostAnswer). */
  name: string;
  category: GhostPickCategory;
  /** 1-based place in GHOST's list. */
  rank: number;
  /** The run's R# for the matched entity, when the registry holds it; registration never happens here. */
  ref: EntityRef | null;
  /** The matched Qloo entity id. Server-side only: it never goes into a diff, an event or the model. */
  entityId: string | null;
  /** A MARKET_CATALOGUE market. */
  market: MarketId | null;
  /** A gazetteer neighbourhood. */
  area: { metro: MetroId; id: string } | null;
  /** The name it matched exactly: Qloo's, the catalogue's or the gazetteer's; null when it matched nothing. */
  matchedName: string | null;
  /** Qloo popularity (0–1) of the matched entity; null for catalogue and gazetteer matches. */
  popularity: number | null;
  exact: boolean;
  lookup: GhostLookup;
}

export interface ResolveGhostPicksOptions {
  answer: GhostAnswer;
  search: GhostSearch;
  /** Searches allowed for this answer; GHOST_SEARCH_MAX by default and at most. */
  max?: number;
  /** Maps an exact match to the run's ref (byEntityId). */
  registry?: Pick<EntityRegistry, "byEntityId">;
  /** Defaults to the shared gazetteer. */
  geo?: GazetteerLike;
  /** The question's gazetteer metro: only its areas match a neighbourhood pick (gazetteerArea). */
  metro?: MetroId | null;
  /** Defaults to GHOST_MARKETS (MARKET_CATALOGUE). */
  markets?: readonly GhostMarket[];
  /** One line per pick left unchecked: over the search cap, or a search that failed. */
  log?: (line: string) => void;
  /** Checked before the searches start. */
  signal?: AbortSignal;
}

/** The entity type an entity list is searched as: every competitor, tenant and partner GHOST names is a brand (ghost.md). */
const ENTITY_TYPE: Readonly<Record<Exclude<GhostPickCategory, "markets" | "neighbourhoods">, EntityType>> = {
  competitors: "brand",
  tenants: "brand",
  partners: "brand",
};

const isPlace = (c: GhostPickCategory): c is "markets" | "neighbourhoods" => c === "markets" || c === "neighbourhoods";

function unresolved(name: string, category: GhostPickCategory, rank: number, lookup: GhostLookup): ResolvedGhostPick {
  return { name, category, rank, ref: null, entityId: null, market: null, area: null, matchedName: null, popularity: null, exact: false, lookup };
}

/** The pick's /search: brands as S0 searches them (cache keys shared with resolve_entities), places as localities. */
function searchFor(name: string, category: GhostPickCategory): QlooParams {
  if (isPlace(category)) return localitySearchParams(name);
  const params = searchParams({ text: name, type: ENTITY_TYPE[category], metro: null });
  // searchParams is null only for a place entity with no metro, which no list searches as.
  if (params === null) throw new Error(`resolveGhostPicks: no /search for a ${category} pick`);
  return params;
}

/** The one result the pick names exactly, or null. */
function exactMatch(name: string, category: GhostPickCategory, results: readonly QlooSearchEntity[]): QlooSearchEntity | null {
  if (isPlace(category)) return classifyLocality(name, results);
  const c = classifyMatches({ text: name, type: ENTITY_TYPE[category] }, results);
  return c.matchClass === "exact" ? (c.exact[0] ?? null) : null;
}

function fromSearch(
  pick: ResolvedGhostPick,
  results: readonly QlooSearchEntity[],
  registry: ResolveGhostPicksOptions["registry"],
): ResolvedGhostPick {
  const match = exactMatch(pick.name, pick.category, results);
  if (match === null) return { ...pick, lookup: "search" };
  return {
    ...pick,
    ref: registry?.byEntityId(match.entity_id)?.ref ?? null,
    entityId: match.entity_id,
    matchedName: match.name,
    popularity: match.popularity ?? null,
    exact: true,
    lookup: "search",
  };
}

/**
 * Every pick of the answer, in category then rank order. Catalogue and gazetteer matches cost no
 * search. The rest share the cap in rank order across categories (every list's first pick, then
 * every second), so each list's top picks are looked up first; the searches run together and the
 * Qloo client paces them. A pick past the cap is "skipped" and one whose search threw is "failed":
 * both stay unchecked and are logged.
 */
export async function resolveGhostPicks(options: ResolveGhostPicksOptions): Promise<ResolvedGhostPick[]> {
  const { answer, search, registry, log } = options;
  const geo = options.geo ?? gazetteer();
  const markets = options.markets ?? GHOST_MARKETS;
  const max = Math.max(0, Math.min(GHOST_SEARCH_MAX, Math.floor(options.max ?? GHOST_SEARCH_MAX)));

  const picks: ResolvedGhostPick[] = GhostPickCategory.options.flatMap((category) =>
    answer.picks[category].map((name, i) => {
      const rank = i + 1;
      if (category === "markets") {
        const market = catalogueMarket(name, markets);
        if (market !== null) {
          return { ...unresolved(name, category, rank, "catalogue"), market: market.id, matchedName: market.label, exact: true };
        }
      }
      if (category === "neighbourhoods") {
        const area = gazetteerArea(name, geo, options.metro ?? null);
        if (area !== null) {
          return { ...unresolved(name, category, rank, "gazetteer"), area: { metro: area.metro, id: area.id }, matchedName: area.name, exact: true };
        }
      }
      // Waits for a search: it stays "skipped" unless the cap lets one run.
      return unresolved(name, category, rank, "skipped");
    }),
  );

  const pending = picks
    .map((pick, at) => ({ pick, at }))
    .filter(({ pick }) => pick.lookup === "skipped")
    .sort((a, b) => a.pick.rank - b.pick.rank || a.at - b.at);
  const searched = pending.slice(0, max);
  for (const { pick } of pending.slice(max)) log?.(`GHOST search cap (${max}): ${pick.category} #${pick.rank} "${pick.name}" not looked up`);

  options.signal?.throwIfAborted();
  const settled = await Promise.allSettled(searched.map(({ pick }) => Promise.resolve().then(() => search(searchFor(pick.name, pick.category)))));
  searched.forEach(({ pick, at }, i) => {
    const s = settled[i];
    if (s?.status === "fulfilled") {
      picks[at] = fromSearch(pick, s.value.data.results, registry);
      return;
    }
    const why = s?.status === "rejected" && s.reason instanceof Error ? s.reason.message : "no result";
    log?.(`GHOST search failed: ${pick.category} #${pick.rank} "${pick.name}": ${why}`);
    picks[at] = { ...pick, lookup: "failed" };
  });
  return picks;
}
