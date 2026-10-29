import { METRO_LABEL, MetroId, normalizeIntent, type GeoApi, type Intent, type Job, type Mention } from "@ct/contracts";
import { curatedConcept } from "@ct/quant";

/**
 * The code backstop for CLERK's geography rule ("cities, neighbourhoods and regions go in geo, never
 * in mentions"): on a location job, a place mention whose text is a gazetteer area name or alias of
 * the question's map city is that area, not a venue. Sent to the resolution gate it would search
 * Qloo for a venue of that name, find only venues near it and stop the run with a picker. Applied to
 * every intent before the gate, so a preview's intent and CLERK's own are read the same way.
 */

/** How a second area the question names is kept in constraints.notes ("area also named: Lark Hill"). */
export const AREA_ALSO_NAMED = "area also named: ";

/** The jobs that read a neighbourhood from geo.area: taste_twins reads its source area there. */
export const AREA_JOBS: ReadonlySet<Job> = new Set<Job>(["site_selection", "area_profile", "tenant_mix", "taste_twins"]);

type AreaGeo = Pick<GeoApi, "matchNeighbourhood">;

/**
 * True when a place mention names a curated place type ("bookstore", "pizza", "cafes"), singular or
 * plural: the business the question is about, not one venue. Sent to the resolution gate it would
 * search Qloo for a venue called "bookstore" and stop the run with a picker of unrelated shops.
 */
function namesPlaceType(text: string): boolean {
  const t = text.trim();
  const singular = /ies$/i.test(t) ? `${t.slice(0, -3)}y` : /s$/i.test(t) ? t.slice(0, -1) : t;
  return curatedConcept(t) !== null || curatedConcept(singular) !== null;
}

/** The one map city whose gazetteer names `text`, or null when none or several do. */
function onlyMetroNaming(geo: AreaGeo, text: string): MetroId | null {
  const metros = MetroId.options.filter((metro) => geo.matchNeighbourhood(metro, text) !== null);
  return metros.length === 1 ? (metros[0] ?? null) : null;
}

/**
 * True when the question already places itself outside the map cities: an unsupported city, or a
 * market a venue is searched in (D44). Its place mentions are read there, so a bare name is never
 * moved to a map city whose gazetteer happens to share it ("Georgetown" in a Washington question).
 */
function placedElsewhere(geo: Intent["geo"]): boolean {
  return geo.unsupported_place !== null || geo.market !== null;
}

/**
 * The intent with gazetteer areas moved out of its place mentions: the first becomes geo.area when
 * CLERK left it empty (and sets the metro when the question named none, placed itself nowhere else
 * and one map city has the area), a repeat of geo.area is dropped, and another area is dropped into constraints.notes, since
 * a run reads one area and the ANALYST can still pick the other from AREAS. Each move is recorded in
 * assumptions unless CLERK's own already name the area. A place mention that names a curated place type
 * moves to constraints.concepts instead. Returns the same object when nothing moved.
 */
export function areaMentionsToGeo(intent: Intent, geo: AreaGeo): Intent {
  if (!AREA_JOBS.has(intent.job)) return intent;
  let { metro, area } = intent.geo;
  const mentions: Mention[] = [];
  const notes = [...intent.constraints.notes];
  const assumptions = [...intent.assumptions];
  const concepts = [...intent.constraints.concepts];
  for (const mention of intent.mentions) {
    if (mention.entity_type === "place" && namesPlaceType(mention.text)) {
      const text = mention.text.trim();
      if (!concepts.some((c) => c.toLowerCase() === text.toLowerCase())) concepts.push(text);
      assumptions.push(`'${text}' read as the type of business, not one venue`);
      continue;
    }
    const inMetro = mention.entity_type !== "place" ? null : (metro ?? (area === null && !placedElsewhere(intent.geo) ? onlyMetroNaming(geo, mention.text) : null));
    const named = inMetro === null ? null : geo.matchNeighbourhood(inMetro, mention.text);
    if (inMetro === null || named === null) {
      mentions.push(mention);
      continue;
    }
    const text = mention.text.trim();
    // CLERK often says already how it read the name; the assumption is added only when it did not.
    const assume = (sentence: string) => {
      if (!assumptions.some((a) => a.toLowerCase().includes(text.toLowerCase()))) assumptions.push(sentence);
    };
    if (area === null) {
      metro = inMetro;
      area = text;
      assume(`'${text}' read as the ${METRO_LABEL[inMetro]} area ${named.name}, not a venue`);
    } else if (geo.matchNeighbourhood(inMetro, area)?.id !== named.id) {
      notes.push(`${AREA_ALSO_NAMED}${text}`);
      assume(`'${text}' read as a ${METRO_LABEL[inMetro]} area, not a venue`);
    }
  }
  if (mentions.length === intent.mentions.length) return intent;
  return normalizeIntent({
    ...intent,
    mentions,
    geo: { ...intent.geo, metro, area },
    constraints: { ...intent.constraints, concepts, notes },
    assumptions,
  });
}
