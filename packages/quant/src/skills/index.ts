import type { SkillRegistry } from "@ct/contracts";
import { findTagsSkill } from "./findTags";
import { rankCandidatesSkill } from "./rankCandidates";
import { shareOfTasteSkill } from "./shareOfTaste";
import { audienceDnaSkill } from "./audienceDna";
import { momentumSkill } from "./momentum";
import { destinationAffinitySkill } from "./destinationAffinity";
import { geoLiftSkill } from "./geoLift";
import { blockDnaSkill } from "./blockDna";
import { crossDomainSkill } from "./crossDomain";
import { sponsorSlateSkill } from "./sponsorSlate";
import { peerLandscapeSkill } from "./peerLandscape";
import { resolveEntitiesSkill } from "./resolve";

/**
 * The skills behind the ANALYST tools (PLAN §10.1): one per SkillId, each in its own module. Every
 * skill is built; unavailableSkill stays for switching one off without changing the tool set.
 */
export const SKILLS: SkillRegistry = {
  resolve_entities: resolveEntitiesSkill,
  find_tags: findTagsSkill,
  rank_candidates: rankCandidatesSkill,
  peer_landscape: peerLandscapeSkill,
  share_of_taste: shareOfTasteSkill,
  audience_dna: audienceDnaSkill,
  momentum: momentumSkill,
  destination_affinity: destinationAffinitySkill,
  geo_lift: geoLiftSkill,
  block_dna: blockDnaSkill,
  cross_domain: crossDomainSkill,
  sponsor_slate: sponsorSlateSkill,
};

export { unavailableSkill } from "./unavailable";
export { resolveEntitiesSkill, classifyMatches, searchParams, unmatchedLimitation, SEARCH_TAKE } from "./resolve";
export type { MatchAlternative, MatchClassification, ResolveMatchClass, SearchResult } from "./resolve";
export { peerLandscapeSkill, estimatePeerLandscapeCalls, discoveryParams, DISCOVERY_TAKE } from "./peerLandscape";
export { normaliseName } from "./normalise";
export { METRO_CENTRES, PLACE_SEARCH_RADIUS_MILES, metroCentreLatLon } from "./metros";
// How find_tags names and types a tag URN; run-skill --tags registers tags the same way.
export { tagNameFromUrn, tagTypeOf } from "./findTags/tags";
export { buildSkillDigest, fitSkillDigest, orderedFlags, skillErrorResult, skillResult } from "./digest";
export type { DigestParts, DigestTarget } from "./digest";
export { addSkillEvidence, addSkillMetric, attemptAll, countUncached, isBudgetError, registerEntity } from "./common";
export type { Attempt, EntityDraft, MetricSpec, Registration } from "./common";
