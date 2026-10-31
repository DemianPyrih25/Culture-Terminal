import {
  ANALYST_TOOLS,
  entityTypeUrn,
  type DigestRow,
  type EntityRef,
  type EntityType,
  type EvidenceId,
  type Flag,
  type MarketId,
  type Metric,
  type QlooCallMeta,
  type QlooParams,
  type QlooSearchEntity,
  type RegisteredEntity,
  type ResolvedMention,
  type SkillCtx,
  type SkillFor,
  type SkillResult,
  type SkillStatus,
  type ToolInput,
} from "@ct/contracts";
import { SKILL_LIMITATIONS } from "../limitations";
import { addSkillMetric, attemptAll, countUncached, registerEntity, searchTags, type EntityDraft } from "./common";
import { skillResult, type DigestTarget } from "./digest";
import { fixed2, safeText } from "./format";
import { latLonParam, placeSearchArea } from "./metros";
import { normaliseName, withoutHostBilling } from "./normalise";

/**
 * S0 resolve_entities (SPEC §5.3, D20): one /search per mention, and only an exact normalised name
 * of the right type is applied (a podcast's name may carry its host billing, withoutHostBilling). Ambiguous and unmatched names are offered with their candidates and
 * never substituted; popularity is shown but never used to choose. The one exception is the run's own
 * reading of a name (ResolveFallback, the gate's known-alias and leading-name rules): it may apply a result
 * the mention's own search returned, and the trace, evidence and digest row say the name was read so.
 */

export type SearchResult = QlooSearchEntity;

export type ResolveMatchClass = "exact" | "ambiguous" | "not_found";

export interface MatchAlternative {
  name: string;
  disambiguation: string | null;
  /** For people choosing in the picker; never used to choose (D20). */
  popularity: number | null;
  result: SearchResult;
}

export interface MatchClassification {
  matchClass: ResolveMatchClass;
  /** Results with the mention's normalised name and type, in Qloo's order. Two or more is ambiguous. */
  exact: SearchResult[];
  /** Up to five results other than an applied match: exact ties first (the picker's choices), then the rest. */
  alternatives: MatchAlternative[];
}

export const SEARCH_TAKE = 5;
const MAX_ALTERNATIVES = 5;

/** Classifies /search results for one mention. Shared with the resolution gate, which turns `ambiguous` into a picker. */
export function classifyMatches(
  mention: { text: string; type: EntityType },
  results: readonly SearchResult[],
): MatchClassification {
  const wanted = normaliseName(mention.text);
  const urn = entityTypeUrn(mention.type);
  const seen = new Set<string>();
  const distinct: SearchResult[] = [];
  for (const r of results) {
    if (seen.has(r.entity_id)) continue;
    seen.add(r.entity_id);
    distinct.push(r);
  }

  const ofType = distinct.filter((r) => r.types.includes(urn));
  const strict = wanted === "" ? [] : ofType.filter((r) => normaliseName(r.name) === wanted);
  // A podcast billed with its host ("Show Nova with Dana Lee") is the show the question names, but
  // only when no result carries the name exactly.
  const billed = strict.length > 0 || mention.type !== "podcast" ? [] : ofType.filter((r) => withoutHostBilling(normaliseName(r.name)) === wanted);
  const exact = strict.length > 0 ? strict : billed;
  const matchClass: ResolveMatchClass = exact.length === 1 ? "exact" : exact.length > 1 ? "ambiguous" : "not_found";
  const applied = matchClass === "exact" ? exact[0] : undefined;
  const alternatives = [...exact, ...distinct.filter((r) => !exact.includes(r))]
    .filter((r) => r !== applied)
    .slice(0, MAX_ALTERNATIVES)
    .map((r) => ({
      name: r.name,
      disambiguation: r.disambiguation ?? null,
      popularity: r.popularity ?? null,
      result: r,
    }));
  return { matchClass, exact, alternatives };
}

/**
 * The /search request for a mention, or null for a place with no map city or market centre to search
 * around (it would match anywhere). A place is searched within its metro's or market's radius (D44).
 */
export function searchParams(mention: { text: string; type: EntityType; metro: MarketId | null }): QlooParams | null {
  const base = { query: mention.text.trim(), types: entityTypeUrn(mention.type), take: SEARCH_TAKE };
  if (mention.type !== "place") return base;
  const area = mention.metro === null ? null : placeSearchArea(mention.metro);
  if (area === null) return null;
  return { ...base, "filter.location": latLonParam(area.centre), "filter.radius": area.radiusMiles };
}

/** The limitation for a name that was not applied (S0). */
export function unmatchedLimitation(text: string, matchClass: Exclude<ResolveMatchClass, "exact">): string {
  return matchClass === "ambiguous"
    ? `'${text}' matches several entities in Qloo's hackathon dataset; candidates offered, not applied.`
    : `'${text}' not found in Qloo's hackathon dataset; closest candidates offered, not applied.`;
}

type ResolveInput = ToolInput<"resolve_entities">;
type Mention = ResolveInput["mentions"][number];

/**
 * The run's reading of a name with no exact match (the agent's knownNameReading): one of `results`, or null
 * to keep the miss. A result the search did not return, or of another type, is never applied.
 */
export type ResolveFallback = (
  mention: { text: string; type: EntityType },
  results: readonly SearchResult[],
  match: Exclude<ResolveMatchClass, "exact">,
) => SearchResult | null;

/** The fallback's reading, kept only when it is one of the mention's own results of the right type. */
function readingOf(fallback: ResolveFallback | null, mention: Mention, results: readonly SearchResult[], c: MatchClassification): SearchResult | undefined {
  if (fallback === null || c.matchClass === "exact") return undefined;
  const read = fallback({ text: mention.text, type: mention.type }, results, c.matchClass);
  const urn = entityTypeUrn(mention.type);
  return results.find((r) => r.entity_id === read?.entity_id && r.types.includes(urn));
}

function draftFromSearch(r: SearchResult, type: EntityType): EntityDraft {
  return {
    entityId: r.entity_id,
    name: r.name,
    type,
    popularity: r.popularity ?? null,
    disambiguation: r.disambiguation ?? null,
    tags: searchTags(r.tags),
  };
}

function alternativeNames(alternatives: readonly MatchAlternative[]): string | null {
  if (alternatives.length === 0) return null;
  return alternatives
    .map((a) => safeText(a.disambiguation ? `${a.name} (${a.disambiguation})` : a.name, 60))
    .join("; ");
}

interface Accumulator {
  flags: Set<Flag>;
  evidenceIds: EvidenceId[];
  metrics: Metric[];
  rows: DigestRow[];
  registered: RegisteredEntity[];
  notices: string[];
  mentions: ResolvedMention[];
  exact: number;
}

function recordSearch(
  ctx: SkillCtx,
  acc: Accumulator,
  mention: Mention,
  results: readonly SearchResult[],
  meta: QlooCallMeta,
  fallback: ResolveFallback | null,
): void {
  const c = classifyMatches(mention, results);
  const read = readingOf(fallback, mention, results, c);
  const applied = c.matchClass === "exact" ? c.exact[0] : read;
  const alternatives = read === undefined ? c.alternatives : c.alternatives.filter((a) => a.result.entity_id !== read.entity_id);
  const text = safeText(mention.text);
  let ref: EntityRef | null = null;

  if (applied !== undefined) {
    const reg = registerEntity(ctx.registry, draftFromSearch(applied, mention.type));
    ref = reg.entity.ref;
    if (reg.isNew) acc.registered.push(reg.entity);
    acc.exact += 1;
  } else {
    acc.flags.add("SECONDARY_ENTITY_DROPPED");
  }

  const evidence = ctx.ledger.addEvidence({
    skill: "resolve_entities",
    purpose: `/search for '${text}' as ${mention.type}`,
    calls: [meta],
    status: applied !== undefined ? "ok" : results.length === 0 ? "empty" : "partial",
    summary:
      read !== undefined
        ? `'${text}' (${mention.type}): no exact match; read as '${safeText(read.name)}' (a verified short name, or an expected name written short), a result its own search returned.`
        : applied !== undefined
          ? `'${text}' (${mention.type}): exact match.`
          : unmatchedLimitation(text, c.matchClass === "ambiguous" ? "ambiguous" : "not_found"),
    flags: applied !== undefined ? [] : ["SECONDARY_ENTITY_DROPPED"],
  });
  acc.evidenceIds.push(evidence.id);

  if (read !== undefined) {
    acc.notices.push(`'${text}' has no exact match; code read it as '${safeText(read.name)}', a result its own search returned; say "read as" when you cite it.`);
  }

  if (applied !== undefined && ref !== null) {
    const popularity = applied.popularity ?? null;
    acc.metrics.push(
      addSkillMetric(ctx.ledger, {
        key: "popularity",
        label: `popularity ${safeText(applied.name)}`,
        subjectRefs: [ref],
        value: popularity,
        reason: "not_measured",
        display: popularity === null ? "" : fixed2(popularity),
        unit: "popularity",
        badge: "MEASURED",
        formulaId: "popularity",
        evidenceIds: [evidence.id],
        n: null,
        comparator: null,
      }),
    );
  }

  acc.rows.push({
    ref,
    name: text,
    values: {
      type: mention.type,
      // A reading counts as a match, as in the gate's resolve event; read_as (only on a reading) names it.
      match: applied !== undefined ? "exact" : c.matchClass,
      matched: applied !== undefined ? safeText(applied.name) : null,
      alternatives: alternativeNames(alternatives),
      ...(read !== undefined ? { read_as: safeText(read.name) } : {}),
    },
  });
  acc.mentions.push({
    mention: mention.text,
    role: "secondary",
    entityType: mention.type,
    match: applied !== undefined ? "exact" : c.matchClass,
    ref,
    name: applied?.name ?? null,
    popularity: applied?.popularity ?? null,
    disambiguation: applied?.disambiguation ?? null,
    alternatives: alternatives.map((a) => ({ name: a.name, disambiguation: a.disambiguation, popularity: a.popularity })),
    source: "tool",
    ...(read !== undefined ? { alias: read.name } : {}),
  });
}

async function runResolve(input: ResolveInput, ctx: SkillCtx, fallback: ResolveFallback | null): Promise<SkillResult> {
  const target: DigestTarget = { tool: "resolve_entities", step: input.step_id };
  const requests = input.mentions.map(searchParams);
  const attempts = await attemptAll(requests.map((p) => (p === null ? null : () => ctx.qloo.search(p))));
  const acc: Accumulator = {
    flags: new Set(),
    evidenceIds: [],
    metrics: [],
    rows: [],
    registered: [],
    notices: [],
    mentions: [],
    exact: 0,
  };

  input.mentions.forEach((mention, i) => {
    const attempt = attempts[i];
    if (attempt?.kind === "ok") {
      recordSearch(ctx, acc, mention, attempt.value.data.results, attempt.value.meta, fallback);
      return;
    }
    const truncated = attempt?.kind === "truncated";
    acc.flags.add(truncated ? "BUDGET_TRUNCATED" : "SECONDARY_ENTITY_DROPPED");
    if (!truncated) acc.notices.push(`'${safeText(mention.text)}' is a place with no metro or market centre to search in; not searched.`);
    acc.rows.push({
      ref: null,
      name: safeText(mention.text),
      values: { type: mention.type, match: truncated ? "budget_truncated" : "not_searched", matched: null, alternatives: null },
    });
  });

  // Only searched mentions are reported: a name never searched has no match class.
  if (acc.mentions.length > 0) ctx.emit({ type: "resolve", entities: acc.mentions });

  const status: SkillStatus = acc.flags.has("BUDGET_TRUNCATED")
    ? "partial"
    : acc.exact === input.mentions.length
      ? "ok"
      : acc.exact > 0
        ? "partial"
        : "empty";
  return skillResult(
    {
      status,
      evidenceIds: acc.evidenceIds,
      datasetIds: [],
      metrics: acc.metrics,
      rows: acc.rows,
      findings: [],
      flags: acc.flags,
      registered: acc.registered,
      notices: acc.notices,
    },
    target,
  );
}

/** resolve_entities with the run's reading of a name that has no exact match; null is exact only. */
export function resolveEntitiesSkillWith(fallback: ResolveFallback | null): SkillFor<"resolve_entities"> {
  return {
    id: "resolve_entities",
    mnemonic: "RES",
    kitWorkflows: ANALYST_TOOLS.resolve_entities.kitWorkflows,
    input: ANALYST_TOOLS.resolve_entities.input,
    estimateCalls: (input, probe) => countUncached(probe, "/search", input.mentions.map(searchParams)),
    run: (input, ctx) => runResolve(input, ctx, fallback),
    // The method bullet only: buildLimitations writes each raised flag's sentence from FLAG_TEXT.
    limitations: () => [...SKILL_LIMITATIONS.resolve_entities],
  };
}

export const resolveEntitiesSkill: SkillFor<"resolve_entities"> = resolveEntitiesSkillWith(null);
