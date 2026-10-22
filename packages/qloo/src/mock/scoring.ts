import { isTaxonomyTag, type QlooParams } from "@ct/contracts";
import { type EntityRecord, LOCALITY, lookupRecord, recordForName } from "./entities";
import { unit } from "./hash";
import { typeOfId } from "./ids";
import { BRAND_FAMILIES, displayName } from "./names";
import { readList, readString } from "./params";
import { type MockTag, tagById } from "./tags";

/**
 * Affinity model of the synthetic insights endpoint, built to keep the properties the probe froze
 * (PROBE_FACTS): an entity signal's score is a function of the unordered pair, so it is symmetric
 * and independent of the candidate set (G1); about one candidate in eight has no relationship and
 * gets the shared floor value (G1); location, age and audience contexts reshape scores and
 * silently drop about one candidate in eight per context (G2).
 */

/** The one affinity every unrelated candidate shares; below every scored value. */
export const FLOOR_AFFINITY = 0.0213;
const UNRELATED_SHARE = 1 / 8;
const DROP_SHARE = 1 / 8;
const SCORE_MIN = 0.05;
const SCORE_SPAN = 0.9;

export interface Signals {
  entities: readonly string[];
  tags: readonly string[];
  /** Keys of context signals (age, audience, location); each reshapes scores and drops candidates. */
  contexts: readonly string[];
  /** Locality echoed under query.localities when signal.location.query named it. */
  queriedLocality: EntityRecord | null;
}

/** The location context key: a locality id and the name it was searched by give one key (G2). */
function locationContext(params: QlooParams): { key: string | null; locality: EntityRecord | null } {
  const value = readString(params, "signal.location");
  if (value !== undefined) return { key: `location:${value}`, locality: null };
  const query = readString(params, "signal.location.query");
  if (query === undefined) return { key: null, locality: null };
  const locality = recordForName(LOCALITY, displayName(query));
  return { key: `location:${locality.id}`, locality };
}

export function readSignals(params: QlooParams): Signals {
  const contexts = readList(params, "signal.demographics.audiences").map((a) => `audience:${a}`);
  const age = readString(params, "signal.demographics.age");
  if (age !== undefined) contexts.push(`age:${age}`);
  const location = locationContext(params);
  if (location.key !== null) contexts.push(location.key);
  return {
    entities: readList(params, "signal.interests.entities"),
    tags: readList(params, "signal.interests.tags"),
    contexts,
    queriedLocality: location.locality,
  };
}

const scaled = (v: number): number => SCORE_MIN + SCORE_SPAN * v;

/**
 * Whether an entity carries a tag: its own tags, plus any other tag on a quarter of entities by
 * hash, since live entities carry many genre tags besides their first. Brand-family leaves are
 * the exception and stay exclusive, so a family filter means one family.
 */
export function hasTag(rec: EntityRecord, tagId: string): boolean {
  if (rec.tags.some((t) => t.id === tagId)) return true;
  const ownFamily = BRAND_FAMILIES.some((f) => tagId === `urn:tag:genre:brand:mock_${f}`);
  return !ownFamily && unit("has-tag", tagId, rec.id) < 0.25;
}

/** The tags of `tagIds` an entity carries beyond its own, as rows to echo on a filtered result. */
export function matchedTags(rec: EntityRecord, tagIds: readonly string[]): MockTag[] {
  return tagIds
    .filter((id) => !rec.tags.some((t) => t.id === id) && hasTag(rec, id))
    .map(tagById);
}

/**
 * Score of entity signal A for candidate B: depends only on the unordered pair {A, B}. The genre
 * bonus needs both types fixed by the ids; an id the mock did not issue takes the call's filter
 * type, so its genre would change with the call and break symmetry across filter types.
 */
function pairScore(a: EntityRecord, b: EntityRecord): number {
  const [lo, hi] = a.id < b.id ? [a.id, b.id] : [b.id, a.id];
  if (unit("unrelated", lo, hi) < UNRELATED_SHARE) return FLOOR_AFFINITY;
  const typed = typeOfId(a.id) !== null && typeOfId(b.id) !== null;
  const sameGenre = typed && a.tags[0] !== undefined && a.tags[0].id === b.tags[0]?.id;
  return scaled(0.4 * ((a.popularity + b.popularity) / 2) + 0.45 * unit("pair", lo, hi) + (sameGenre ? 0.15 : 0));
}

/** Descriptive `*:qloo:*` tags give a flat floor row (G1): only taxonomy tags act as signals. */
function tagScore(tagId: string, c: EntityRecord): number {
  if (!isTaxonomyTag(tagId)) return FLOOR_AFFINITY;
  const carries = hasTag(c, tagId);
  if (!carries && unit("unrelated", tagId, c.id) < UNRELATED_SHARE) return FLOOR_AFFINITY;
  return scaled(0.35 * c.popularity + 0.4 * unit("tag", tagId, c.id) + (carries ? 0.25 : 0));
}

/** A context-only row; metro rows come back compressed (G2, G3), so read ranks, not values. */
function contextScore(contexts: readonly string[], c: EntityRecord): number {
  const key = contexts.join("&");
  if (unit("unrelated", key, c.id) < UNRELATED_SHARE) return FLOOR_AFFINITY;
  const v = 0.3 * c.popularity + 0.7 * unit("context", key, c.id);
  return contexts.every((k) => k.startsWith("location:")) ? 0.42 + 0.2 * v : scaled(v);
}

/**
 * A candidate's affinity under the signals, "dropped" when a context leaves it out, or null when
 * there is no signal (a filter-only call returns rows without query.affinity, G1 control).
 */
export function affinityFor(signals: Signals, c: EntityRecord, seedType: string): number | "dropped" | null {
  if (signals.contexts.some((k) => unit("dropped", k, c.id) < DROP_SHARE)) return "dropped";
  const parts = [
    ...signals.entities.map((id) => pairScore(lookupRecord(id, seedType), c)),
    ...signals.tags.map((t) => tagScore(t, c)),
  ];
  if (parts.length === 0) return signals.contexts.length > 0 ? contextScore(signals.contexts, c) : null;
  const related = parts.filter((p) => p !== FLOOR_AFFINITY);
  if (related.length === 0) return FLOOR_AFFINITY;
  const base = related.reduce((s, p) => s + p, 0) / related.length;
  return signals.contexts.reduce((s, k) => s * (0.85 + 0.3 * unit("reshape", k, c.id)), base);
}
