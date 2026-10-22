import type { QlooParams } from "@ct/contracts";
import { hashHex, intBetween, round, unit } from "../hash";
import { type JsonObject, type MockReply, ok } from "../json";
import { displayName, normalizeName, slug } from "../names";
import { applyWindow, readList, readString } from "../params";
import { FINGERPRINT_TAGS, genreOptions, type MockTag, mockTag, taxonomyTypesFor } from "../tags";

/** `/v2/tags` semantic search (G14) and the `/v2/audiences` catalogue. */

const DESCRIPTIVE_TYPES: Readonly<Record<string, readonly string[]>> = {
  "urn:entity:brand": ["urn:tag:product_category:qloo", "urn:tag:product_service:qloo"],
  "urn:entity:place": ["urn:tag:cuisine:qloo", "urn:tag:amenity:qloo"],
};
const TAG_VARIANT_SUFFIXES = ["Lovers", "Culture", "Scene", "Shops", "Classics", "Fans"];

function descriptiveTypesFor(parent: string): readonly string[] {
  return DESCRIPTIVE_TYPES[parent] ?? ["urn:tag:keyword:qloo"];
}

/**
 * Candidates for a concept, best first: the main descriptive tag (most live results were
 * descriptive), the taxonomy tags signals need, catalogue tags whose names overlap the query,
 * then variants of every type so a `filter.tag.types` restriction still leaves 5–10 results.
 */
function conceptCandidates(query: string, parents: readonly string[]): MockTag[] {
  const name = displayName(query);
  const wanted = normalizeName(query);
  const descriptive = parents.flatMap(descriptiveTypesFor);
  const taxonomy = parents.flatMap(taxonomyTypesFor);
  const catalogue = [...FINGERPRINT_TAGS, ...parents.flatMap(genreOptions)].filter((t) => {
    const have = normalizeName(t.name);
    return have.length > 0 && (have.includes(wanted) || wanted.includes(have));
  });
  const types = [...descriptive, ...taxonomy];
  return [
    ...descriptive.slice(0, 1).map((t) => mockTag(t, name)),
    ...taxonomy.map((t) => mockTag(t, name)),
    ...catalogue.slice(0, 3).map(({ id, name: n, type }) => ({ id, name: n, type })),
    ...descriptive.slice(1).map((t) => mockTag(t, name)),
    ...TAG_VARIANT_SUFFIXES.flatMap((suffix) => types.map((t) => mockTag(t, `${name} ${suffix}`))),
  ];
}

export function searchTags(params: QlooParams): MockReply {
  const query = readString(params, "filter.query")?.trim();
  const parentList = readList(params, "filter.parents.types");
  const parents = parentList.length > 0 ? parentList : ["urn:entity:brand"];
  const tagTypes = readList(params, "filter.tag.types");
  const browse = !query;
  const candidates = browse ? FINGERPRINT_TAGS.map(({ id, name, type }) => ({ id, name, type })) : conceptCandidates(query, parents);

  const byId = new Map<string, MockTag>();
  for (const t of candidates) if ((tagTypes.length === 0 || tagTypes.includes(t.type)) && !byId.has(t.id)) byId.set(t.id, t);
  const unique = [...byId.values()];
  const limited = browse ? unique : unique.slice(0, intBetween(5, 10, "tag-count", normalizeName(query), parents.join(",")));
  const tags: JsonObject[] = applyWindow(limited, params).map((t) => ({
    id: t.id,
    name: t.name,
    type: t.type,
    parents: parents.map((p) => ({ type: p })),
    popularity: round(0.2 + 0.75 * unit("tag-popularity", t.id), 4),
    properties: {},
    tags: [],
  }));
  return ok({ success: true, results: { tags } });
}

/**
 * Invented audiences under Qloo's public parent categories: every family a desk may use (D21), plus
 * the denied ones (communities, political_preferences, …) so the client's allowlist has something
 * to block.
 */
const AUDIENCES: Readonly<Record<string, readonly string[]>> = {
  leisure: ["Trail Runners", "Weekend Campers", "Live Music Goers", "Home Cooks", "Board Gamers", "Golfers"],
  hobbies_and_interests: ["Photographers", "Gardeners", "Record Collectors", "DIY Makers", "Birdwatchers"],
  life_stage: ["New Parents", "Empty Nesters", "College Students", "Young Couples"],
  professional_area: ["Healthcare Workers", "Educators", "Software Engineers", "Small Business Owners"],
  spending_habits: ["Deal Seekers", "Premium Buyers", "Subscription Fans", "Impulse Shoppers"],
  investing_interests: ["Index Fund Savers", "Real Estate Investors", "Crypto Curious"],
  communities: ["Alumni Networks", "Volunteer Groups", "Online Forums"],
  political_preferences: ["Civic Participants", "Issue Voters", "Campaign Volunteers"],
  lifestyle_preferences_beliefs: ["Minimalists", "Eco Conscious Shoppers", "Wellness Seekers"],
  global_issues: ["Climate Concerned", "Humanitarian Donors"],
};

const parentLabel = (parent: string): string => displayName(parent.replace(/_/g, " "));

export function listAudiences(params: QlooParams): MockReply {
  const wanted = readList(params, "filter.parents.types");
  const rows: JsonObject[] = Object.entries(AUDIENCES)
    .filter(([parent]) => wanted.length === 0 || wanted.includes(`urn:audience:${parent}`) || wanted.includes(parent))
    .flatMap(([parent, names]) =>
      names.map((name) => {
        const id = `urn:audience:${parent}:mock_${slug(name)}`;
        return {
          id,
          entity_id: `mock-aud-${hashHex("audience", id).slice(0, 12)}`,
          name,
          type: `urn:audience:${parent}`,
          parents: [{ id: `urn:audience:${parent}`, name: parentLabel(parent), type: `urn:audience:${parent}` }],
          disambiguation: null,
          tags: [],
        };
      }),
    );
  return ok({ success: true, results: { audiences: applyWindow(rows, params) } });
}
