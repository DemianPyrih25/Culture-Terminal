import { MarketId, type GeoApi, type Intent, type MetroId, type RunCandidates } from "@ct/contracts";
import { CLERK_PROMPT } from "../prompts.generated";
import { AREA_ALSO_NAMED } from "./areaMentions";
import { runAreaMetros } from "./areas";
import type { GateResolved } from "./gate";
import { compareCities, MARKET_CATALOGUE, type RunMarket } from "./markets";

/**
 * The run's candidates (R3, D49): what the question names and what a specialist would check first, so a
 * set the run scores always holds them, marked "You named" or "Expected", whatever the data would have
 * picked. Entities come from the resolution gate (exact matches only). Areas are the question's area, the
 * other areas it names and CLERK's obvious areas, matched by the gazetteer's names and aliases in the
 * run's map cities (a taste_twins question's obvious areas in its target city). Markets are the market ids
 * the question names (CLERK's named markets and compared cities) and CLERK's obvious markets, each listed
 * in config/metros.json and on the run's MARKETS. A name nothing matches is left out, never guessed.
 */

type Source = "user_named" | "obvious";

const KNOWN_MARKETS: ReadonlySet<string> = new Set(MARKET_CATALOGUE.map((m) => m.id));

/**
 * The intent with the candidate market ids config/metros.json does not list dropped (R3): normalizeIntent
 * keeps only well-formed ids, since contracts cannot read config; the agent drops the unknown ones.
 */
export function withKnownMarkets(intent: Intent): Intent {
  const keep = (ids: readonly string[]) => ids.filter((id) => KNOWN_MARKETS.has(id));
  const { named_markets: named, obvious_markets: obvious } = intent.candidates;
  if (keep(named).length === named.length && keep(obvious).length === obvious.length) return intent;
  return { ...intent, candidates: { ...intent.candidates, named_markets: keep(named), obvious_markets: keep(obvious) } };
}

/** The entity types a job's obvious candidates may take; absent: any. creator_fit scores creators, never brands. */
const OBVIOUS_TYPES: Partial<Record<Intent["job"], readonly string[]>> = {
  creator_fit: ["artist", "podcast", "person"],
};

/**
 * The invented candidate names of clerk.md's worked examples ("Brand Ember"): a CLERK that copies an example's
 * candidates instead of naming real ones lists these, and they are never a real expectation.
 */
export const EXAMPLE_CANDIDATE_NAMES: ReadonlySet<string> = new Set(
  [...CLERK_PROMPT.matchAll(/"obvious_entities":\[([^\]]*)\]/g)].flatMap((m) => [...(m[1] ?? "").matchAll(/"text":"([^"]+)"/g)].map((t) => t[1] ?? "")),
);

/**
 * The intent with obvious entities CLERK should not have listed left out: a copied example name, or a type its
 * job never scores (a brand listed as a creator).
 */
export function withJobCandidates(intent: Intent): Intent {
  const types = OBVIOUS_TYPES[intent.job];
  const kept = intent.candidates.obvious_entities.filter((e) => !EXAMPLE_CANDIDATE_NAMES.has(e.text.trim()) && (types === undefined || types.includes(e.entity_type)));
  if (kept.length === intent.candidates.obvious_entities.length) return intent;
  return { ...intent, candidates: { ...intent.candidates, obvious_entities: kept } };
}

/** A trailing "(80211)" CLERK adds to an expected area: the ZIP code, and the name without it. */
const ZIP_NOTE = /\s*\((\d{5})\)\s*$/;

/**
 * The gazetteer area a name matches in the first of `metros` that holds it, or null. An expected area may
 * carry its main ZIP code ("Highlands (80211)", clerk.md): the name is tried first, then the ZIP, which is
 * how cities mapped by ZIP area (whose areas carry few neighbourhood names) still find it.
 */
function matchArea(geo: Pick<GeoApi, "matchNeighbourhood">, metros: readonly MetroId[], text: string): { metro: MetroId; id: string } | null {
  const raw = text.trim();
  if (raw === "") return null;
  const zip = ZIP_NOTE.exec(raw)?.[1] ?? null;
  const name = raw.replace(ZIP_NOTE, "").trim();
  for (const key of [raw, name, ...(zip === null ? [] : [zip])]) {
    if (key === "") continue;
    for (const metro of metros) {
      const hit = geo.matchNeighbourhood(metro, key);
      if (hit !== null) return { metro, id: hit.id };
    }
  }
  return null;
}

export function candidateAreas(intent: Pick<Intent, "job" | "geo" | "candidates" | "constraints">, geo: Pick<GeoApi, "matchNeighbourhood">): RunCandidates["areas"] {
  const metros = runAreaMetros(intent);
  const out: { metro: MetroId; id: string; source: Source }[] = [];
  const add = (hit: { metro: MetroId; id: string } | null, source: Source) => {
    if (hit !== null && !out.some((a) => a.metro === hit.metro && a.id === hit.id)) out.push({ ...hit, source });
  };
  const alsoNamed = intent.constraints.notes.flatMap((n) => (n.startsWith(AREA_ALSO_NAMED) ? [n.slice(AREA_ALSO_NAMED.length)] : []));
  for (const text of [intent.geo.area ?? "", ...intent.candidates.named_areas, ...alsoNamed]) add(matchArea(geo, metros, text), "user_named");
  // A taste_twins question looks for twins in its target city: that is where the obvious areas are.
  const target = intent.job === "taste_twins" ? intent.geo.target_metro : null;
  const obviousIn = target !== null ? [target] : metros;
  for (const text of intent.candidates.obvious_areas) add(matchArea(geo, obviousIn, text), "obvious");
  return out;
}

export function candidateMarkets(intent: Pick<Intent, "geo" | "candidates">, markets: readonly RunMarket[]): RunCandidates["markets"] {
  const usable = new Set<string>(markets.map((m) => m.id));
  const out: { id: MarketId; source: Source }[] = [];
  const add = (raw: string, source: Source) => {
    const id = MarketId.safeParse(raw.trim().toLowerCase());
    if (id.success && usable.has(id.data) && !out.some((m) => m.id === id.data)) out.push({ id: id.data, source });
  };
  for (const id of [...intent.candidates.named_markets, ...compareCities(intent)]) add(id, "user_named");
  for (const id of intent.candidates.obvious_markets) add(id, "obvious");
  return out;
}

/** The run's RunCandidates from the gate's entities and the intent's areas and markets. */
export function buildRunCandidates(args: {
  intent: Pick<Intent, "job" | "geo" | "candidates" | "constraints">;
  gate: Pick<GateResolved, "candidates">;
  geo: Pick<GeoApi, "matchNeighbourhood">;
  markets: readonly RunMarket[];
}): RunCandidates {
  return {
    entities: args.gate.candidates,
    areas: candidateAreas(args.intent, args.geo),
    markets: candidateMarkets(args.intent, args.markets),
  };
}
