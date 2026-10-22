import type {
  EntityRegistry,
  EventInputOf,
  EvidenceInput,
  Intent,
  Mention,
  QlooApi,
  QlooCallMeta,
  QlooParams,
  QlooSearchEntity,
  RegisteredEntity,
  ResolvedMention,
} from "@ct/contracts";
import { classifyMatches, normaliseName, searchParams, unmatchedLimitation, type MatchAlternative } from "@ct/quant";
import { pickerKey } from "./picker";

/**
 * The resolution gate (PLAN §4.1 step B, D20): one /search per CLERK mention, exact normalised name
 * and type only, for at most GATE_SEARCH_MAX mentions. A primary target that is not exact stops the
 * run with a picker; any other mention that is not exact is dropped with a limitation. A pinned
 * mention (a picker answer or a showcase pin) uses its pinned entity. Gate calls belong to no tool
 * call and the receipt counts them from the call log; they become evidence only when a mention was
 * dropped (gateEvidence), so the report carries SECONDARY_ENTITY_DROPPED as resolve_entities would.
 */

export interface GateInput {
  intent: Intent;
  /** The run's bookkeeping scope (forTool(null)). */
  qloo: Pick<QlooApi, "search" | "entities">;
  registry: EntityRegistry;
  /** Qloo entity ids keyed by normaliseName(mention text). */
  pins: Readonly<Record<string, string>>;
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
  params: QlooParams;
  pin: string | null;
}

type Miss = Exclude<ResolvedMention["match"], "exact">;

/** An applied entity, or the miss class with the candidates to offer. */
type Resolution =
  | { applied: QlooSearchEntity; alternatives: readonly MatchAlternative[] }
  | { applied: null; match: Miss; alternatives: readonly MatchAlternative[] };

function classify(mention: Mention, results: readonly QlooSearchEntity[]): Resolution {
  const c = classifyMatches({ text: mention.text, type: mention.entity_type }, results);
  const applied = c.matchClass === "exact" ? c.exact[0] : undefined;
  if (applied !== undefined) return { applied, alternatives: c.alternatives };
  return { applied: null, match: c.matchClass === "ambiguous" ? "ambiguous" : "not_found", alternatives: c.alternatives };
}

function draftOf(r: QlooSearchEntity, mention: Mention): Omit<RegisteredEntity, "ref"> {
  return {
    entityId: r.entity_id,
    name: r.name,
    type: mention.entity_type,
    popularity: r.popularity ?? null,
    disambiguation: r.disambiguation ?? null,
    tags: (r.tags ?? []).map((t) => ({ tagId: t.tag_id, name: t.name, type: t.type })),
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
    const metro = mention.entity_type === "place" ? intent.geo.metro : null;
    const params = key === "" ? null : searchParams({ text: mention.text, type: mention.entity_type, metro });
    if (params === null) {
      if (isPrimary) unsearchablePrimary = mention;
      else drop(`'${clip(mention.text)}' is a place with no supported metro to search in, so it was not looked up.`);
      continue;
    }
    // The primary is ordered first, so the cap only ever leaves out secondary mentions.
    if (targets.length >= GATE_SEARCH_MAX) {
      drop(`'${clip(mention.text)}' was not looked up: a question is resolved for at most ${GATE_SEARCH_MAX} named entities.`);
      continue;
    }
    targets.push({ mention, isPrimary, params, pin: pinOf(input.pins, key) });
  }

  // In parallel even when the primary will need a picker: the answers are cached, so the rerun with
  // the picked pin resolves the other mentions for free.
  const searches = await Promise.allSettled(targets.map((t) => input.qloo.search(t.params)));
  const calls: QlooCallMeta[] = [];
  const entities: ResolvedMention[] = [];
  let primary: RegisteredEntity | null = null;
  let primaryMiss: { mention: Mention; match: Miss; alternatives: readonly MatchAlternative[] } | null = null;
  const peers: RegisteredEntity[] = [];

  for (const [i, target] of targets.entries()) {
    const { mention } = target;
    const settled = searches[i];
    if (settled === undefined) continue;
    let resolution: Resolution;
    try {
      if (settled.status === "rejected" && target.pin === null) throw settled.reason;
      if (settled.status === "fulfilled") calls.push(settled.value.meta);
      const results = settled.status === "fulfilled" ? settled.value.data.results : [];
      resolution = target.pin !== null ? await resolvePinned(input, target.pin, results, calls) : classify(mention, results);
    } catch (error) {
      if (target.isPrimary) return { kind: "failed", error };
      drop(`'${clip(mention.text)}' could not be looked up in Qloo for this run.`);
      continue;
    }

    const registered = resolution.applied === null ? null : registry.registerEntity(draftOf(resolution.applied, mention));
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
    });

    if (resolution.applied === null) {
      if (target.isPrimary) primaryMiss = { mention, match: resolution.match, alternatives: resolution.alternatives };
      else drop(unmatchedLimitation(clip(mention.text), resolution.match === "ambiguous" ? "ambiguous" : "not_found"));
    } else if (target.isPrimary) {
      primary = registered;
    } else if (mention.role === "peer" && registered !== null) {
      peers.push(registered);
    }
  }

  if (unsearchablePrimary !== null) {
    const mention = unsearchablePrimary;
    const reason = `'${clip(mention.text)}' is a place, and places are searched inside a supported metro (Nashville or Austin); name one.`;
    return { kind: "needs_input", entities, reason, picker: picker(mention, "not_found", []) };
  }
  if (primaryMiss !== null) {
    const { mention, match, alternatives } = primaryMiss;
    return { kind: "needs_input", entities, reason: notExactReason(mention, match), picker: picker(mention, match, alternatives) };
  }
  return { kind: "resolved", entities, primary, peers, dropped, limitations, calls };
}

/**
 * The gate's drops as one evidence bundle over its calls, flagged SECONDARY_ENTITY_DROPPED, so the
 * report shows that flag's limitation among the other flags, ordered by severity (SPEC §6.3). Null
 * when nothing was dropped, or when no gate call answered to cite.
 */
export function gateEvidence(gate: GateResolved): EvidenceInput | null {
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
