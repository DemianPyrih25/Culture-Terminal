import {
  entityTypeUrn,
  placeSearchMarket,
  type EntityRegistry,
  type EventInputOf,
  type EvidenceInput,
  type Intent,
  type Mention,
  type QlooApi,
  type QlooCallMeta,
  type QlooParams,
  type QlooSearchEntity,
  type RegisteredEntity,
  type ResolvedMention,
  type RunCandidates,
} from "@ct/contracts";
import { classifyMatches, normaliseName, searchParams, unmatchedLimitation, type MatchAlternative } from "@ct/quant";
import { aliasMatch, BRAND_ALIASES, leadingNameMatch, type BrandAlias } from "./aliases";
import { pickerKey } from "./picker";

/**
 * The resolution gate (PLAN §4.1 step B, D20): one /search per CLERK mention, exact normalised name
 * and type only, for at most GATE_SEARCH_MAX mentions. A primary target that is not exact stops the
 * run with a picker; any other mention that is not exact is dropped with a limitation. A pinned
 * mention (a picker answer or a showcase pin) uses its pinned entity. Gate calls belong to no tool
 * call and the receipt counts them from the call log; they become evidence only when a mention was
 * dropped (gateEvidence), so the report carries SECONDARY_ENTITY_DROPPED as resolve_entities would,
 * or when the Taste Position card cites the primary's popularity as its reach (recordPosition).
 *
 * Part 11 (R3, D49): the obvious candidates CLERK listed (intent.candidates.obvious_entities) are looked
 * up the same way, in parallel, exact only, and registered as `obvious`; the question's own mentions are
 * registered as `user_named`. An obvious name with no exact match is left out quietly (no drop, no
 * penalty) and named once in the EXPECTED_CANDIDATE_MISSING limitation. A verified known alias
 * (config/brand_aliases.json) lets a mention apply the result its own search returned under the official
 * name ("Read 'KFC' as 'Kentucky Fried Chicken'"); the resolve event carries it.
 */

export interface GateInput {
  intent: Intent;
  /** The run's bookkeeping scope (forTool(null)). */
  qloo: Pick<QlooApi, "search" | "entities">;
  registry: EntityRegistry;
  /** Qloo entity ids keyed by normaliseName(mention text). */
  pins: Readonly<Record<string, string>>;
  /** The verified known aliases; defaults to config/brand_aliases.json's. */
  aliases?: readonly BrandAlias[];
}

export interface GateResolved {
  kind: "resolved";
  /** Every searched mention, for the `resolve` event. */
  entities: ResolvedMention[];
  primary: RegisteredEntity | null;
  /** Registered peer mentions, in question order. */
  peers: RegisteredEntity[];
  /** Mentions dropped or not applied (SECONDARY_ENTITY_DROPPED; −15 confidence each, §6.4). */
  dropped: number;
  /** One limitation sentence per dropped mention. */
  limitations: string[];
  /** Every gate call that answered (/search, and /entities for a pin), for gateEvidence. */
  calls: QlooCallMeta[];
  /** The calls that resolved the primary target; the Taste Position card cites them for its reach. */
  primaryCalls: QlooCallMeta[];
  /** The obvious candidates CLERK listed that matched exactly, registered as `obvious`, in CLERK's order. */
  obvious: RegisteredEntity[];
  /** The run's candidate entities (R3): the question's other exact mentions, then the obvious ones. */
  candidates: RunCandidates["entities"];
  /** Obvious names with no exact match under that name (EXPECTED_CANDIDATE_MISSING). */
  expectedMissing: string[];
  /** Obvious names whose lookup failed in this run (named in the same limitation, apart). */
  expectedFailed: string[];
}

export interface GateNeedsInput {
  kind: "needs_input";
  entities: ResolvedMention[];
  picker: EventInputOf<"needs_input">;
  reason: string;
}

export type GateOutcome =
  | GateResolved
  | GateNeedsInput
  | { kind: "refused"; reason: string }
  /** The primary target's lookup failed; `error` is the Qloo client's error. */
  | { kind: "failed"; error: unknown };

export const PRIVATE_PERSON_REASON =
  "The question is about a person who is not a public figure. Culture Terminal looks up public figures only and " +
  "reads their audience's taste, never an individual's.";

/** Mentions the gate looks up per question: resolve_entities' own cap (ResolveEntitiesInput). */
export const GATE_SEARCH_MAX = 8;
const MENTION_MAX = 60;
const clip = (s: string): string => (s.length <= MENTION_MAX ? s.trim() : `${s.slice(0, MENTION_MAX - 1).trim()}…`);

interface Target {
  mention: Mention;
  isPrimary: boolean;
  /** An obvious candidate CLERK listed, not a name the question gave. */
  obvious: boolean;
  params: QlooParams;
  pin: string | null;
}

/** An empty resolution: the gate's outcome when Qloo is disabled or nothing was named. */
export const EMPTY_GATE: GateResolved = {
  kind: "resolved",
  entities: [],
  primary: null,
  peers: [],
  dropped: 0,
  limitations: [],
  calls: [],
  primaryCalls: [],
  obvious: [],
  candidates: [],
  expectedMissing: [],
  expectedFailed: [],
};

type Miss = Exclude<ResolvedMention["match"], "exact">;

/** An applied entity (with the official name a known alias resolved to), or the miss class with the candidates to offer. */
type Resolution =
  | { applied: QlooSearchEntity; alternatives: readonly MatchAlternative[]; alias?: string }
  | { applied: null; match: Miss; alternatives: readonly MatchAlternative[] };

function classify(mention: Mention, results: readonly QlooSearchEntity[], aliases: readonly BrandAlias[]): Resolution {
  const c = classifyMatches({ text: mention.text, type: mention.entity_type }, results);
  const applied = c.matchClass === "exact" ? c.exact[0] : undefined;
  if (applied !== undefined) return { applied, alternatives: c.alternatives };
  // A verified alias accepts the result the search returned under the official name, never anything else.
  const aliased = aliasMatch(mention, results, aliases);
  if (aliased !== null) return { applied: aliased, alternatives: c.alternatives, alias: aliased.name };
  return { applied: null, match: c.matchClass === "ambiguous" ? "ambiguous" : "not_found", alternatives: c.alternatives };
}

function draftOf(r: QlooSearchEntity, mention: Mention, obvious: boolean): Omit<RegisteredEntity, "ref"> {
  return {
    entityId: r.entity_id,
    name: r.name,
    type: mention.entity_type,
    popularity: r.popularity ?? null,
    disambiguation: r.disambiguation ?? null,
    tags: (r.tags ?? []).map((t) => ({ tagId: t.tag_id, name: t.name, type: t.type })),
    candidate: obvious ? "obvious" : "user_named",
  };
}

function notExactReason(mention: Mention, match: Miss): string {
  const name = `'${clip(mention.text)}'`;
  if (match === "ambiguous") {
    return `${name} matches several ${mention.entity_type} entities in Qloo's hackathon dataset; pick the one you mean.`;
  }
  return `${name} has no exact ${mention.entity_type} match in Qloo's hackathon dataset; pick the one you mean or rephrase the question.`;
}

/** A pinned entity: from the mention's own /search when it is there, else described by /entities. */
async function resolvePinned(
  input: GateInput,
  pin: string,
  results: readonly QlooSearchEntity[],
  calls: QlooCallMeta[],
): Promise<Resolution> {
  let found = results.find((r) => r.entity_id === pin);
  if (found === undefined) {
    const described = await input.qloo.entities([pin]);
    calls.push(described.meta);
    found = described.data.results.find((r) => r.entity_id === pin);
  }
  if (found !== undefined) return { applied: found, alternatives: [] };
  // A pin that no longer resolves is offered again with the search's own candidates.
  const alternatives = results.slice(0, 5).map((r) => ({
    name: r.name,
    disambiguation: r.disambiguation ?? null,
    popularity: r.popularity ?? null,
    result: r,
  }));
  return { applied: null, match: "not_found", alternatives };
}

/** The question's primary target: the mention CLERK marked primary, else the first one. */
export function primaryMentionOf(intent: Intent): Mention | null {
  return intent.mentions.find((m) => m.role === "primary") ?? intent.mentions[0] ?? null;
}

const isPrivatePerson = (mention: Mention): boolean => mention.entity_type === "person" && !mention.public_figure;

/**
 * The normalised names of the persons CLERK did not mark as public figures. The gate never looks
 * them up, and resolve_entities refuses them too (SPEC §4.6), so no later call sends them to Qloo.
 */
export function privatePersonNames(intent: Intent): ReadonlySet<string> {
  return new Set(intent.mentions.filter(isPrivatePerson).flatMap((m) => normaliseName(m.text) || []));
}

/**
 * The code backstop for a primary person who is not a public figure (SPEC §4.6). It needs no Qloo
 * call, so the run applies it before the gate whether or not Qloo is enabled.
 */
export function privatePersonRefusal(intent: Intent): string | null {
  const primary = primaryMentionOf(intent);
  return primary !== null && isPrivatePerson(primary) ? PRIVATE_PERSON_REASON : null;
}

/** A pin is an own, non-empty string entry: inherited keys such as "constructor" are never pins. */
function pinOf(pins: Readonly<Record<string, string>>, key: string): string | null {
  if (!Object.hasOwn(pins, key)) return null;
  const pin: unknown = pins[key];
  return typeof pin === "string" && pin !== "" ? pin : null;
}

export async function runResolutionGate(input: GateInput): Promise<GateOutcome> {
  const { intent, registry } = input;
  const primaryMention = primaryMentionOf(intent);
  const limitations: string[] = [];
  let dropped = 0;
  const drop = (sentence: string) => {
    dropped += 1;
    limitations.push(sentence);
  };

  const targets: Target[] = [];
  const seen = new Set<string>();
  let unsearchablePrimary: Mention | null = null;
  // The primary goes first, so a repeated name never hides it behind a secondary copy.
  const ordered = primaryMention === null ? [] : [primaryMention, ...intent.mentions.filter((m) => m !== primaryMention)];
  for (const mention of ordered) {
    const key = normaliseName(mention.text);
    const isPrimary = mention === primaryMention;
    const dedupe = `${mention.entity_type}|${key}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    // Persons are resolved only as public figures (§4.6).
    if (isPrivatePerson(mention)) {
      if (isPrimary) return { kind: "refused", reason: PRIVATE_PERSON_REASON };
      drop(`'${clip(mention.text)}' is not marked as a public figure, so it was not looked up.`);
      continue;
    }
    // A place is searched around its map city, or the market CLERK put it in (D44).
    const metro = mention.entity_type === "place" ? placeSearchMarket(intent.geo) : null;
    const params = key === "" ? null : searchParams({ text: mention.text, type: mention.entity_type, metro });
    if (params === null) {
      if (isPrimary) unsearchablePrimary = mention;
      else drop(`'${clip(mention.text)}' is a place with no map city or market to search in, so it was not looked up.`);
      continue;
    }
    // The primary is ordered first, so the cap only ever leaves out secondary mentions.
    if (targets.length >= GATE_SEARCH_MAX) {
      drop(`'${clip(mention.text)}' was not looked up: a question is resolved for at most ${GATE_SEARCH_MAX} named entities.`);
      continue;
    }
    targets.push({ mention, isPrimary, obvious: false, params, pin: pinOf(input.pins, key) });
  }

  // The obvious candidates: searched like secondary mentions, never a private person, exact only (or a
  // unique top result that only adds a word or two to the name: leadingNameMatch).
  const privates = privatePersonNames(intent);
  for (const o of intent.candidates.obvious_entities) {
    const key = normaliseName(o.text);
    const dedupe = `${o.entity_type}|${key}`;
    if (key === "" || seen.has(dedupe) || privates.has(key)) continue;
    seen.add(dedupe);
    const mention: Mention = { text: o.text, entity_type: o.entity_type, role: "secondary", public_figure: true };
    const metro = o.entity_type === "place" ? placeSearchMarket(intent.geo) : null;
    const params = searchParams({ text: o.text, type: o.entity_type, metro });
    if (params === null) continue;
    targets.push({ mention, isPrimary: false, obvious: true, params, pin: null });
  }

  // In parallel even when the primary will need a picker: the answers are cached, so the rerun with
  // the picked pin resolves the other mentions for free.
  const searches = await Promise.allSettled(targets.map((t) => input.qloo.search(t.params)));
  const calls: QlooCallMeta[] = [];
  const entities: ResolvedMention[] = [];
  let primary: RegisteredEntity | null = null;
  let primaryMiss: { mention: Mention; match: Miss; alternatives: readonly MatchAlternative[] } | null = null;
  let primaryCalls: QlooCallMeta[] = [];
  const peers: RegisteredEntity[] = [];
  const obvious: RegisteredEntity[] = [];
  const named: RegisteredEntity[] = [];
  const expectedMissing: string[] = [];
  const expectedFailed: string[] = [];

  for (const [i, target] of targets.entries()) {
    const { mention } = target;
    const settled = searches[i];
    if (settled === undefined) continue;
    const callsBefore = calls.length;
    let resolution: Resolution;
    try {
      if (settled.status === "rejected" && target.pin === null) throw settled.reason;
      if (settled.status === "fulfilled") calls.push(settled.value.meta);
      const results = settled.status === "fulfilled" ? settled.value.data.results : [];
      resolution =
        target.pin !== null ? await resolvePinned(input, target.pin, results, calls) : classify(mention, results, input.aliases ?? BRAND_ALIASES);
      // An expected name CLERK wrote loosely ("Health-Ade") may take the top result that only adds a word or
      // two ("Health-Ade Kombucha"); the reading is shown like an alias's.
      if (target.obvious && resolution.applied === null && resolution.match === "not_found") {
        const lead = leadingNameMatch(mention, results, entityTypeUrn(mention.entity_type));
        if (lead !== null) resolution = { applied: lead, alternatives: [], alias: lead.name };
      }
    } catch (error) {
      if (target.isPrimary) return { kind: "failed", error };
      // An obvious candidate is CLERK's expectation, not the question's: its failure costs nothing.
      if (target.obvious) expectedFailed.push(clip(mention.text));
      else drop(`'${clip(mention.text)}' could not be looked up in Qloo for this run.`);
      continue;
    }

    if (target.obvious) {
      // Exact only (a verified alias counts as exact), and quietly: a name CLERK expected that the data does
      // not hold under it is listed once.
      if (resolution.applied === null) {
        expectedMissing.push(clip(mention.text));
        continue;
      }
      const known = registry.byEntityId(resolution.applied.entity_id);
      const registered = registry.registerEntity(draftOf(resolution.applied, mention, true));
      // The question already names this entity: it stays the user's own.
      if (known !== null && known.candidate === "user_named") continue;
      if (!obvious.includes(registered)) obvious.push(registered);
      entities.push({
        mention: mention.text,
        role: mention.role,
        entityType: mention.entity_type,
        match: "exact",
        ref: registered.ref,
        name: registered.name,
        popularity: registered.popularity,
        disambiguation: registered.disambiguation,
        alternatives: [],
        source: "gate",
        candidate: "obvious",
        ...(resolution.alias !== undefined ? { alias: resolution.alias } : {}),
      });
      continue;
    }

    const registered = resolution.applied === null ? null : registry.registerEntity(draftOf(resolution.applied, mention, false));
    entities.push({
      mention: mention.text,
      role: mention.role,
      entityType: mention.entity_type,
      match: resolution.applied === null ? resolution.match : "exact",
      ref: registered?.ref ?? null,
      name: registered?.name ?? null,
      popularity: registered?.popularity ?? null,
      disambiguation: registered?.disambiguation ?? null,
      alternatives: resolution.alternatives.map((a) => ({ name: a.name, disambiguation: a.disambiguation, popularity: a.popularity })),
      source: "gate",
      ...(registered === null ? {} : { candidate: "user_named" as const }),
      ...(resolution.applied !== null && resolution.alias !== undefined ? { alias: resolution.alias } : {}),
    });

    if (resolution.applied === null) {
      if (target.isPrimary) primaryMiss = { mention, match: resolution.match, alternatives: resolution.alternatives };
      else drop(unmatchedLimitation(clip(mention.text), resolution.match === "ambiguous" ? "ambiguous" : "not_found"));
    } else if (target.isPrimary) {
      primary = registered;
      primaryCalls = calls.slice(callsBefore);
    } else if (registered !== null) {
      if (!named.includes(registered)) named.push(registered);
      if (mention.role === "peer") peers.push(registered);
    }
  }

  if (unsearchablePrimary !== null) {
    const mention = unsearchablePrimary;
    const reason = `'${clip(mention.text)}' is a place, and places are searched inside a US city we cover (a map city or market); name its city.`;
    return { kind: "needs_input", entities, reason, picker: picker(mention, "not_found", []) };
  }
  if (primaryMiss !== null) {
    const { mention, match, alternatives } = primaryMiss;
    return { kind: "needs_input", entities, reason: notExactReason(mention, match), picker: picker(mention, match, alternatives) };
  }
  const userNamed = named.filter((e) => e !== primary);
  const expected = obvious.filter((e) => e !== primary && !userNamed.includes(e));
  const candidates: RunCandidates["entities"] = [
    ...userNamed.map((e) => ({ ref: e.ref, source: "user_named" as const })),
    ...expected.map((e) => ({ ref: e.ref, source: "obvious" as const })),
  ];
  return {
    kind: "resolved",
    entities,
    primary,
    peers,
    dropped,
    limitations,
    calls,
    primaryCalls,
    obvious: expected,
    candidates,
    expectedMissing,
    expectedFailed,
  };
}

/**
 * The EXPECTED_CANDIDATE_MISSING limitation text (R3): the obvious names the data does not hold under that
 * name, and apart the ones whose lookup failed; null when every obvious name resolved.
 */
export function expectedMissingText(gate: Pick<GateResolved, "expectedMissing" | "expectedFailed">): string | null {
  const list = (xs: readonly string[]) =>
    xs
      .map((x) => x.replace(/[\p{Cc}\p{Cf}]/gu, " ").trim())
      .filter((x) => x !== "")
      .join(", ");
  const missing = list(gate.expectedMissing);
  const failed = list(gate.expectedFailed);
  const parts = [
    ...(missing === "" ? [] : [`Expected names not found under that name in the data: ${missing}.`]),
    ...(failed === "" ? [] : [`Expected names that could not be looked up in this run: ${failed}.`]),
  ];
  return parts.length === 0 ? null : parts.join(" ");
}

/**
 * The gate's drops as one evidence bundle over its calls, flagged SECONDARY_ENTITY_DROPPED, so the
 * report shows that flag's limitation among the other flags, ordered by severity (SPEC §6.3). Null
 * when nothing was dropped, or when no gate call answered to cite.
 */
export function gateEvidence(gate: GateResolved): Extract<EvidenceInput, { calls: readonly QlooCallMeta[] }> | null {
  if (gate.dropped === 0 || gate.calls.length === 0) return null;
  return {
    skill: "resolve_entities",
    purpose: "Resolution gate: one /search per entity the question names",
    calls: gate.calls,
    status: "partial",
    summary: `${gate.dropped} named ${gate.dropped === 1 ? "entity was" : "entities were"} left out. ${gate.limitations.join(" ")}`,
    flags: ["SECONDARY_ENTITY_DROPPED"],
  };
}

function picker(mention: Mention, reason: Miss, alternatives: readonly MatchAlternative[]): EventInputOf<"needs_input"> {
  return {
    type: "needs_input",
    mention: mention.text,
    entityType: mention.entity_type,
    reason,
    candidates: alternatives.map((a) => ({
      key: pickerKey(a.result.entity_id),
      name: a.name,
      disambiguation: a.disambiguation,
      popularity: a.popularity,
    })),
  };
}
