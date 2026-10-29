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
import { tasteTwinsSkill } from "./tasteTwins";
import { conceptVectorSkill } from "./conceptVector";
import { companyFinancialsSkill } from "./companyFinancials";
import { areaEconomicsSkill } from "./areaEconomics";

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
  taste_twins: tasteTwinsSkill,
  concept_vector: conceptVectorSkill,
  company_financials: companyFinancialsSkill,
  area_economics: areaEconomicsSkill,
};

export { unavailableSkill } from "./unavailable";
// The listed-company map S13 reads (config/listed_companies.json); the agent offers company_financials only for a mapped brand.
export { LISTED_COMPANIES, listedCompanyOf, makeCompanyFinancialsSkill, type ListedCompanies, type ListedCompany } from "./companyFinancials";
// Request builders shared with tools/dev/cli/warm-metros.ts, so warmed city sides are the keys skills ask for.
export { brandParams, tagParams } from "./blockDna/calls";
export { cityLocation } from "./blockDna/location";
export { PANEL_MIN_CITIES, panelMetros } from "./blockDna/city";
export { resolveEntitiesSkill, classifyMatches, searchParams, unmatchedLimitation, SEARCH_TAKE } from "./resolve";
export type { MatchAlternative, MatchClassification, ResolveMatchClass, SearchResult } from "./resolve";
export { peerLandscapeSkill, estimatePeerLandscapeCalls, discoveryParams, DISCOVERY_TAKE } from "./peerLandscape";
export { normaliseName } from "./normalise";
// The S10 category check; the coverage probe's C2 gate applies the same rule.
export { MAIN_LINE_MIN_TAGS, offCategoryBranch } from "./sponsorSlate/slate";
export { marketLabel, METRO_CENTRES, PLACE_SEARCH_MIN_RADIUS_MILES, metroCentreLatLon, metroReachKm, placeSearchArea, type PlaceSearchArea } from "./metros";
// How find_tags names and types a tag URN; run-skill --tags registers tags the same way.
export { tagNameFromUrn, tagTypeOf } from "./findTags/tags";
// The curated place types; CLERK's backstop reads a place mention that names one as the concept, not a venue.
export { curatedConcept } from "./findTags/curated";
export { buildSkillDigest, fitSkillDigest, orderedFlags, skillErrorResult, skillResult } from "./digest";
export type { DigestParts, DigestTarget } from "./digest";
export { addSkillEvidence, addSkillMetric, attemptAll, countUncached, isBudgetError, registerEntity } from "./common";
export type { Attempt, EntityDraft, MetricSpec, Registration } from "./common";
// The supply-label rule geo_lift, the CHECKER (V10) and the web answer read competitor counts by; the lift map
// mirrors its numbers for the client bundle and for runs stored before the rule.
export { BUSY_QUADRANTS, MIN_BUSY_AREA_VENUES, MIN_RANKED_AREAS, MIN_SUPPLY_VENUES, supplyLabelHolds, THIN_SUPPLY_LABEL } from "./geoLift/lift";
