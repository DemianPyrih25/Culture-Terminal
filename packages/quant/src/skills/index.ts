import type { SkillRegistry } from "@ct/contracts";
import { peerLandscapeSkill } from "./peerLandscape";
import { resolveEntitiesSkill } from "./resolve";
import { unavailableSkill } from "./unavailable";

/**
 * The skills behind the ANALYST tools (PLAN §10.1): one per SkillId. S0 and S1 are built; the rest
 * answer "not available in this build" until their parts land.
 */
export const SKILLS: SkillRegistry = {
  resolve_entities: resolveEntitiesSkill,
  find_tags: unavailableSkill("find_tags"),
  rank_candidates: unavailableSkill("rank_candidates"),
  peer_landscape: peerLandscapeSkill,
  share_of_taste: unavailableSkill("share_of_taste"),
  audience_dna: unavailableSkill("audience_dna"),
  momentum: unavailableSkill("momentum"),
  destination_affinity: unavailableSkill("destination_affinity"),
  geo_lift: unavailableSkill("geo_lift"),
  block_dna: unavailableSkill("block_dna"),
  cross_domain: unavailableSkill("cross_domain"),
  sponsor_slate: unavailableSkill("sponsor_slate"),
};

export { unavailableSkill } from "./unavailable";
export { resolveEntitiesSkill, classifyMatches, searchParams, unmatchedLimitation, SEARCH_TAKE } from "./resolve";
export type { MatchAlternative, MatchClassification, ResolveMatchClass, SearchResult } from "./resolve";
export { peerLandscapeSkill, estimatePeerLandscapeCalls, discoveryParams, DISCOVERY_TAKE } from "./peerLandscape";
export { normaliseName } from "./normalise";
export { METRO_CENTRES, PLACE_SEARCH_RADIUS_MILES, metroCentreLatLon } from "./metros";
export { buildSkillDigest, fitSkillDigest, orderedFlags, skillErrorResult, skillResult } from "./digest";
export type { DigestParts, DigestTarget } from "./digest";
export { addSkillEvidence, addSkillMetric, attemptAll, countUncached, isBudgetError, registerEntity } from "./common";
export type { Attempt, EntityDraft, MetricSpec, Registration } from "./common";
