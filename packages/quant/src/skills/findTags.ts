import {
  ANALYST_TOOLS,
  isTaxonomyTag,
  type DigestRow,
  type EvidenceId,
  type Finding,
  type Flag,
  type QlooParams,
  type QlooResult,
  type QlooTagSearchItem,
  type QlooTagsResponse,
  type RegisteredTag,
  type SkillCtx,
  type SkillFor,
  type SkillResult,
  type SkillStatus,
  type TagScope,
  type ToolInput,
} from "@ct/contracts";
import { emptyResultFinding } from "../findings";
import { SKILL_LIMITATIONS } from "../limitations";
import { addSkillEvidence, attemptAllKeepingFailures, countUncached, type Attempt } from "./common";
import { skillResult, type DigestTarget } from "./digest";
import { curatedConcept, HEATMAP_BASELINE, isVerifiedPlaceFilter, type CuratedConcept, type CuratedStatus } from "./findTags/curated";
import { conceptWords, nameMatches, normaliseConcept, tagTypeOf, tagUse, type TagUse } from "./findTags/tags";
import { safeName, safeText } from "./format";

/**
 * find_tags (TAGS, SPEC §4.3): business concepts to tag refs (T#). Place concepts named in the
 * curated map (config/categories.json) get its verified and research tags at zero cost; every other
 * concept costs one /v2/tags semantic search restricted to taxonomy tag types (P5), whose results
 * pass an all-words name filter and keep the top three. Only taxonomy tags act as signals (G1, G6),
 * and only urn:tag:genre:place:* tags shape a heatmap (P5): category:place tags filter the geo_lift
 * supply sample, so every row says what its tag can do.
 */

type FindInput = ToolInput<"find_tags">;
type Concept = FindInput["concepts"][number];

/** Results per semantic search before the name filter (SPEC §4.3). */
export const TAG_SEARCH_TAKE = 20;
/** Tags returned per concept, taxonomy tags first. */
export const TAGS_PER_CONCEPT = 3;

const PARENT_TYPES: Readonly<Record<TagScope, readonly string[]>> = {
  place: ["urn:entity:place"],
  brand: ["urn:entity:brand"],
  media: ["urn:entity:artist", "urn:entity:podcast", "urn:entity:tv_show", "urn:entity:movie"],
};

/**
 * Taxonomy tag types per scope (P5: filter.tag.types returned 10/10 tags of the requested types).
 * Place asks for genre:place, the heatmap concept tags, and category:place, the supply filter, in one call.
 */
const TAG_TYPES: Readonly<Record<TagScope, readonly string[]>> = {
  place: ["urn:tag:genre:place", "urn:tag:category:place"],
  brand: ["urn:tag:genre:brand"],
  media: ["urn:tag:genre:music", "urn:tag:genre:media"],
};

/** The /v2/tags semantic search for one query. */
export function tagSearchParams(query: string, scope: TagScope): QlooParams {
  return {
    "filter.query": query,
    "feature.semantic_search": true,
    "filter.parents.types": [...PARENT_TYPES[scope]],
    "filter.tag.types": [...TAG_TYPES[scope]],
    take: TAG_SEARCH_TAKE,
  };
}

export interface ConceptPlan {
  concept: Concept;
  /** The curated concept the text names, for place concepts only. */
  curated: CuratedConcept | null;
  /** The live search query, or null when the curated map serves the concept (or it has no words). */
  query: string | null;
  request: QlooParams | null;
}

/**
 * How a concept is answered: curated tags when the map serves it, else a live search for the map's
 * semantic query (an unverified curated concept) or the concept text, normalised so concepts that
 * differ only in case or punctuation share one cached request. A curated concept whose supply filter
 * failed its gate is served and searched both (filterFallback): the search only adds a supply filter.
 */
export function planConcept(concept: Concept): ConceptPlan {
  const curated = concept.scope === "place" ? curatedConcept(concept.text) : null;
  if (curated !== null && curated.served.length > 0 && !curated.filterFallback) return { concept, curated, query: null, request: null };
  const query = normaliseConcept(curated?.semanticQuery ?? concept.text);
  return { concept, curated, query: query === "" ? null : query, request: query === "" ? null : tagSearchParams(query, concept.scope) };
}

/**
 * The tags a search keeps for its query: those passing the all-words name filter, plus the curated
 * candidates of an unverified concept whatever their name. Taxonomy tags come first, candidates
 * ahead of the rest (for place, the first heatmap tag and the first supply filter lead), then
 * descriptive tags, at most three, in Qloo's order otherwise. The restaurant baseline comes last
 * unless it is a candidate: as a concept tag it is what geo_lift measures against, so it maps nothing.
 */
export function pickTags(
  items: readonly QlooTagSearchItem[],
  query: string,
  scope: TagScope,
  candidates: ReadonlySet<string> = new Set(),
): QlooTagSearchItem[] {
  const wanted = conceptWords(query);
  const seen = new Set<string>();
  const matching = items.filter((t) => {
    if (seen.has(t.id) || !(candidates.has(t.id) || nameMatches(wanted, conceptWords(t.name)))) return false;
    seen.add(t.id);
    return true;
  });
  const trails = (t: QlooTagSearchItem) => t.id === HEATMAP_BASELINE.tagId && !candidates.has(t.id);
  const ordered = [...matching.filter((t) => candidates.has(t.id)), ...matching.filter((t) => !candidates.has(t.id) && !trails(t))];
  const taxonomy = ordered.filter((t) => isTaxonomyTag(t.id));
  const labels = ordered.filter((t) => !isTaxonomyTag(t.id));
  const lead = scope === "place" ? (["heatmap_signal", "place_filter"] as const).flatMap((use) => taxonomy.find((t) => tagUse(t.id) === use) ?? []) : [];
  return [...new Set([...lead, ...taxonomy, ...labels, ...matching.filter(trails)])].slice(0, TAGS_PER_CONCEPT);
}

const requestKey = (plan: ConceptPlan): string | null => (plan.query === null ? null : `${plan.concept.scope}|${plan.query}`);

/** One live search, shared by every concept that asks the same query. */
interface Search {
  query: string;
  scope: TagScope;
  request: QlooParams;
  /** Curated candidates of the unverified concepts behind this query, kept whatever their name. */
  candidates: Set<string>;
  attempt: Attempt<QlooResult<QlooTagsResponse>> | null;
  picked: QlooTagSearchItem[];
  evidenceId: EvidenceId | null;
}

type Outcome = "found" | "none" | "budget_truncated" | "error";

interface FoundTag {
  tag: RegisteredTag;
  use: TagUse;
  source: "curated" | "search";
  status: CuratedStatus | "live";
}

interface Run {
  ctx: SkillCtx;
  flags: Set<Flag>;
  evidenceIds: EvidenceId[];
  findings: Finding[];
  registered: RegisteredTag[];
  notices: string[];
}

function register(run: Run, draft: Omit<RegisteredTag, "ref">): RegisteredTag {
  const known = run.ctx.registry.byTagId(draft.tagId);
  if (known !== null) return known;
  const tag = run.ctx.registry.registerTag(draft);
  run.registered.push(tag);
  return tag;
}

function recordSearch(run: Run, search: Search): void {
  const attempt = search.attempt;
  if (attempt?.kind !== "ok") return;
  const returned = attempt.value.data.results.tags;
  search.picked = pickTags(returned, search.query, search.scope, search.candidates);
  const usable = search.picked.filter((t) => isTaxonomyTag(t.id)).length;
  const query = safeText(search.query, 60);
  const evidence = addSkillEvidence(run.ctx.ledger, {
    skill: "find_tags",
    purpose: `/v2/tags semantic search for '${query}' (${search.scope})`,
    calls: [attempt.value.meta],
    status: usable > 0 ? "ok" : search.picked.length > 0 ? "partial" : "empty",
    summary:
      `${returned.length} tags returned for '${query}'; ${search.picked.length} kept after the name filter, ` +
      `${usable} of them taxonomy tags.`,
    flags: [],
  });
  if (evidence === null) return;
  search.evidenceId = evidence.id;
  run.evidenceIds.push(evidence.id);
  if (usable > 0) return;
  const finding = run.ctx.ledger.addFinding({
    ...emptyResultFinding({
      what: `the tag search for '${query}' (${search.scope})`,
      suggestion: {
        tool: "find_tags",
        reason: "Name the concept as a common venue type, product category or genre in one or two words.",
      },
    }),
    metricIds: [],
  });
  run.findings.push(finding);
}

function curatedTags(run: Run, curated: CuratedConcept): FoundTag[] {
  return curated.served.slice(0, TAGS_PER_CONCEPT).map((t) => ({
    tag: register(run, { tagId: t.tagId, name: t.name, type: t.type, signalCapable: isTaxonomyTag(t.tagId) }),
    use: t.use,
    source: "curated",
    status: t.status,
  }));
}

function searchedTags(run: Run, search: Search): FoundTag[] {
  return search.picked.map((t) => ({
    tag: register(run, { tagId: t.id, name: t.name, type: t.type === "" ? tagTypeOf(t.id) : t.type, signalCapable: isTaxonomyTag(t.id) }),
    use: tagUse(t.id),
    source: "search",
    status: "live",
  }));
}

function outcomeOf(search: Search | null, tags: readonly FoundTag[]): Outcome {
  if (tags.some((t) => t.use !== "label_only")) return "found";
  if (search?.attempt?.kind === "truncated") return "budget_truncated";
  if (search?.attempt?.kind === "failed") return "error";
  return "none";
}

function rowsFor(concept: Concept, tags: readonly FoundTag[], outcome: Outcome): DigestRow[] {
  const text = safeText(concept.text, 60);
  if (tags.length === 0) return [{ ref: null, name: text, values: { concept: text, scope: concept.scope, match: outcome } }];
  return tags.map((t) => ({
    ref: t.tag.ref,
    name: safeName(t.tag.name),
    values: { concept: text, scope: concept.scope, use: t.use, source: t.source, status: t.status },
  }));
}

/**
 * What the model needs to use place tags right: which tag drives the map, which only filters supply,
 * that the restaurant baseline maps nothing as a concept, and that an unverified category tag counts
 * no similar venues (`filterNoticed`: the supply-filter fallback has said so already).
 */
function placeNotices(concept: Concept, tags: readonly FoundTag[], filterNoticed = false): string[] {
  if (concept.scope !== "place" || tags.length === 0) return [];
  const notices: string[] = [];
  const baseline = tags.find((t) => t.tag.tagId === HEATMAP_BASELINE.tagId);
  if (baseline !== undefined) {
    notices.push(
      `${baseline.tag.ref} (${safeName(baseline.tag.name)}) is the geo_lift baseline: beside a more specific genre:place tag ` +
        "geo_lift leaves it out, and alone it gives every neighbourhood a lift of 1.",
    );
  }
  const uses = new Set(tags.filter((t) => t !== baseline).map((t) => t.use));
  if (!uses.has("heatmap_signal") && uses.has("place_filter")) {
    notices.push(
      `'${safeText(concept.text, 60)}' has no genre:place tag${baseline === undefined ? "" : " besides the baseline"}, so geo_lift cannot map it ` +
        "from tags: pass analog venues or brands as concept_entities with its category tag, which filters supply only.",
    );
  }
  const filters = tags.filter((t) => t.use === "place_filter");
  if (!filterNoticed && filters.length > 0 && !filters.some((t) => isVerifiedPlaceFilter(t.tag.tagId))) {
    const named = filters.map((t) => `${t.tag.ref} (${safeName(t.tag.name)})`).join(", ");
    notices.push(
      `'${safeText(concept.text, 60)}' has no verified venue category: ${named} ${filters.length === 1 ? "is" : "are"} not probe-verified, so ` +
        "geo_lift counts no similar venues with it and the competitor count stays unknown, never 0.",
    );
  }
  return notices;
}

/**
 * A curated concept's tags with its supply-filter fallback (filterFallback): the served tags, then the
 * first place_filter the live search found, labelled live, with a notice either way.
 */
function fallbackTags(run: Run, curated: CuratedConcept, search: Search | null): { tags: FoundTag[]; notice: string } {
  const served = curatedTags(run, curated);
  const label = safeText(curated.label, 60);
  const pick = search?.picked.find((t) => tagUse(t.id) === "place_filter" && !served.some((s) => s.tag.tagId === t.id));
  const found = search === null || pick === undefined ? undefined : searchedTags(run, { ...search, picked: [pick] })[0];
  if (found === undefined) {
    const why = search?.attempt?.kind === "ok" ? "the live tag search found none" : "the live tag search did not answer";
    return {
      tags: served,
      notice: `${label} has no verified supply filter and ${why}, so geo_lift counts no similar venues for it: the competitor count is unknown.`,
    };
  }
  return {
    tags: [...served, found],
    notice:
      `${label}'s supply filter ${found.tag.ref} (${safeName(found.tag.name)}) was found by semantic search at run time, not probe-verified: ` +
      "it may return no venue where many exist, so geo_lift counts no similar venues with it and the competitor count stays unknown.",
  };
}

const PLACE_TAG_NOTICE =
  "In geo_lift concept_tags, heatmap_signal tags (genre:place) shape the map; place_filter tags (category:place) only filter its supply sample.";

async function runFindTags(input: FindInput, ctx: SkillCtx): Promise<SkillResult> {
  const target: DigestTarget = { tool: "find_tags", step: input.step_id };
  const plans = input.concepts.map(planConcept);
  const searches = new Map<string, Search>();
  for (const plan of plans) {
    const key = requestKey(plan);
    if (key === null || plan.query === null || plan.request === null) continue;
    const search = searches.get(key) ?? {
      query: plan.query,
      scope: plan.concept.scope,
      request: plan.request,
      candidates: new Set<string>(),
      attempt: null,
      picked: [],
      evidenceId: null,
    };
    for (const id of plan.curated?.candidates ?? []) search.candidates.add(id);
    searches.set(key, search);
  }
  const list = [...searches.values()];
  const attempts = await attemptAllKeepingFailures(
    list.map((s) => () => ctx.qloo.tags(s.request)),
    ctx.signal,
  );
  list.forEach((s, i) => {
    s.attempt = attempts[i] ?? null;
  });
  // With nothing curated and no answer at all there is nothing to keep: the error goes to the caller.
  const firstFailure = attempts.find((a) => a.kind === "failed");
  if (firstFailure?.kind === "failed" && attempts.every((a) => a.kind !== "ok") && plans.every((p) => p.request !== null)) {
    throw firstFailure.error;
  }

  const run: Run = { ctx, flags: new Set(), evidenceIds: [], findings: [], registered: [], notices: [] };
  for (const s of list) recordSearch(run, s);
  if (attempts.some((a) => a.kind === "truncated")) run.flags.add("BUDGET_TRUNCATED");
  for (const s of list) {
    if (s.attempt?.kind === "failed") run.notices.push(`The tag search for '${safeText(s.query, 60)}' failed (${s.attempt.code}); not looked up.`);
  }

  const rows: DigestRow[] = [];
  const outcomes: Outcome[] = [];
  let placeTags = false;
  for (const plan of plans) {
    const key = requestKey(plan);
    const search = key === null ? null : (searches.get(key) ?? null);
    const fallback = plan.curated?.filterFallback === true && plan.curated.served.length > 0 ? fallbackTags(run, plan.curated, search) : null;
    if (fallback !== null) run.notices.push(fallback.notice);
    const tags =
      fallback !== null
        ? fallback.tags
        : plan.request === null && plan.curated !== null
          ? curatedTags(run, plan.curated)
          : search === null
            ? []
            : searchedTags(run, search);
    const outcome = outcomeOf(search, tags);
    outcomes.push(outcome);
    rows.push(...rowsFor(plan.concept, tags, outcome));
    run.notices.push(...placeNotices(plan.concept, tags, fallback !== null));
    if (plan.query === null && plan.curated === null) {
      run.notices.push(`'${safeText(plan.concept.text, 60)}' has no words to search for; not looked up.`);
    }
    placeTags ||= tags.some((t) => t.use === "heatmap_signal" || t.use === "place_filter");
  }
  if (placeTags) run.notices.unshift(PLACE_TAG_NOTICE);

  const found = outcomes.filter((o) => o === "found").length;
  const gaps = outcomes.some((o) => o === "budget_truncated" || o === "error");
  const status: SkillStatus = found === plans.length ? "ok" : found > 0 || gaps ? "partial" : "empty";
  return skillResult(
    {
      status,
      evidenceIds: run.evidenceIds,
      datasetIds: [],
      metrics: [],
      rows,
      findings: run.findings,
      flags: run.flags,
      registered: run.registered,
      // Concepts sharing a search (or the baseline) would repeat the same notice.
      notices: [...new Set(run.notices)],
    },
    target,
  );
}

export const findTagsSkill: SkillFor<"find_tags"> = {
  id: "find_tags",
  mnemonic: "TAGS",
  kitWorkflows: ANALYST_TOOLS.find_tags.kitWorkflows,
  input: ANALYST_TOOLS.find_tags.input,
  // Curated concepts cost nothing; each distinct live search costs one call unless it is cached.
  estimateCalls: (input, probe) => countUncached(probe, "/v2/tags", input.concepts.map((c) => planConcept(c).request)),
  run: runFindTags,
  // The method bullet only: buildLimitations writes each raised flag's sentence from FLAG_TEXT.
  limitations: () => [...SKILL_LIMITATIONS.find_tags],
};
