import type { QlooParams, QlooTagSearchItem, SponsorCategory } from "@ct/contracts";

/**
 * The S10 sponsor categories, mirrored from config/sponsor_categories.json (the source, built from
 * probes G14 and P5); a test keeps the two equal. `tag` is the one filter tag P5 verified for the
 * category, or null: those categories find a genre:brand tag at runtime with the config's semantic
 * query. Public taxonomy URNs only (D29).
 */

export interface SponsorCategorySpec {
  label: string;
  /** The /v2/tags semantic search that finds the category's tag at runtime. */
  semanticQuery: string;
  /** The probe-verified brand filter tag, or null when none is verified yet. */
  tag: string | null;
}

export const SPONSOR_CATEGORIES: Readonly<Record<SponsorCategory, SponsorCategorySpec>> = {
  beer: { label: "Beer", semanticQuery: "beer", tag: "urn:tag:product_category:qloo:beer" },
  spirits: { label: "Spirits", semanticQuery: "whiskey", tag: null },
  rtd_seltzer: { label: "RTD and hard seltzer", semanticQuery: "hard seltzer", tag: null },
  outdoor_sporting_retail: { label: "Outdoor and sporting retail", semanticQuery: "outdoor gear", tag: null },
  apparel_footwear: { label: "Apparel and footwear", semanticQuery: "boots and footwear", tag: null },
  qsr: { label: "Quick-service restaurants", semanticQuery: "fast food", tag: null },
  energy_drinks: {
    label: "Energy drinks",
    semanticQuery: "energy drink",
    tag: "urn:tag:genre:brand:food_and_beverage:drinks:energy_drink",
  },
  auto: { label: "Auto", semanticQuery: "pickup trucks", tag: null },
  telecom: { label: "Telecom", semanticQuery: "wireless carrier", tag: null },
  fintech: { label: "Fintech", semanticQuery: "mobile payments app", tag: null },
};

const BRAND = "urn:entity:brand";
/** genre:brand leaves are verified as brand filters (S1, P5); the lookup asks for that taxonomy only (P5). */
export const BRAND_GENRE_TAG_TYPE = "urn:tag:genre:brand";
const BRAND_GENRE_PREFIX = `${BRAND_GENRE_TAG_TYPE}:`;
/** A few results are enough: the first genre:brand tag is taken. */
export const TAG_LOOKUP_TAKE = 5;

/** The runtime lookup for a category without a verified tag: semantic search, genre:brand tags only (G14, P5). */
export function tagLookupParams(spec: SponsorCategorySpec): QlooParams {
  return {
    "filter.query": spec.semanticQuery,
    "feature.semantic_search": true,
    "filter.parents.types": [BRAND],
    "filter.tag.types": [BRAND_GENRE_TAG_TYPE],
    take: TAG_LOOKUP_TAKE,
  };
}

/** The first genre:brand tag of a lookup, in Qloo's order; descriptive tags are never taken from it. */
export function pickCategoryTag(tags: readonly QlooTagSearchItem[]): QlooTagSearchItem | null {
  return tags.find((t) => t.id.startsWith(BRAND_GENRE_PREFIX)) ?? null;
}

/**
 * Two filter tags select overlapping brands when they are the same tag or one sits under the other
 * in the taxonomy (a whole-segment prefix): two categories sharing them would read one list twice.
 */
export function tagsOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}:`) || b.startsWith(`${a}:`);
}
