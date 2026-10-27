import { isTaxonomyTag } from "@ct/contracts";
import { z } from "zod";
import raw from "../../../../../config/categories.json";
import { normaliseConcept, tagNameFromUrn, tagTypeOf, tagUse, type TagUse } from "./tags";

/**
 * The curated concept map for find_tags (scope place) and the geo_lift baseline, read from
 * config/categories.json (PLAN §4.3, §5.3 S6). It is ours, so a malformed file fails loudly at
 * start-up. Verified and research tags are served at zero cost; a concept whose tags are all
 * unverified is looked up live with its semantic query until a probe verifies them, and so is a
 * concept whose supply filter failed its gate (fallback semantic_tag_search, PLAN §11.2).
 */

const TagStatus = z.enum(["verified", "research", "unverified"]);
const taxonomyUrn = z.string().refine(isTaxonomyTag, { message: "curated tags must be taxonomy tags (PROBE consequence 1)" });

const CuratedTagEntry = z.object({
  urn: taxonomyUrn,
  status: TagStatus,
  verified_by: z.string().nullable().optional(),
  verified_as: z.enum(["heatmap_signal", "place_filter"]).optional(),
  /** The named fallback of an unverified tag (PLAN §11.2): a live semantic search, labelled. */
  fallback: z.literal("semantic_tag_search").optional(),
});

const CategoryEntry = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  aliases: z.array(z.string().min(1)),
  semantic_query: z.string().min(1),
  tags: z.array(CuratedTagEntry),
});

const CategoriesConfig = z.object({
  baseline: z.object({ urn: taxonomyUrn, status: TagStatus }),
  categories: z.array(CategoryEntry),
});

export type CuratedStatus = "verified" | "research";

/** A tag the map serves at zero cost. */
export interface CuratedTag {
  tagId: string;
  name: string;
  type: string;
  status: CuratedStatus;
  use: TagUse;
}

export interface CuratedConcept {
  key: string;
  label: string;
  /** The /v2/tags query for a live lookup, shared by every alias so they share one cached request. */
  semanticQuery: string;
  /** Verified and research tags; empty when every tag is still unverified. */
  served: CuratedTag[];
  /**
   * True when the entry's supply filter (a category:place tag) failed its gate and names the
   * semantic_tag_search fallback, and no served tag filters supply: the served tags still answer, and
   * a live lookup of the semantic query looks for a supply filter, labelled live.
   */
  filterFallback: boolean;
  /**
   * Every tag the entry names, unverified ones included. A live lookup keeps these whatever their
   * display name, since a name such as "Book Store" can miss the all-words filter for its own query.
   */
  candidates: string[];
}

const config = CategoriesConfig.parse(raw);

/** The pinned geo_lift baseline (G6): restaurants, a genre:place tag. */
export const HEATMAP_BASELINE = {
  tagId: config.baseline.urn,
  label: "Restaurants",
} as const;

if (tagUse(HEATMAP_BASELINE.tagId) !== "heatmap_signal") {
  throw new Error(`config/categories.json: the baseline ${HEATMAP_BASELINE.tagId} is not a genre:place tag`);
}

function curatedTag(urn: string, status: CuratedStatus): CuratedTag {
  return { tagId: urn, name: tagNameFromUrn(urn), type: tagTypeOf(urn), status, use: tagUse(urn) };
}

const CONCEPTS: readonly CuratedConcept[] = config.categories.map((c) => ({
  key: c.key,
  label: c.label,
  semanticQuery: c.semantic_query,
  served: c.tags.flatMap((t) => (t.status === "unverified" ? [] : [curatedTag(t.urn, t.status)])),
  filterFallback:
    c.tags.some((t) => t.status === "unverified" && t.fallback === "semantic_tag_search" && tagUse(t.urn) === "place_filter") &&
    !c.tags.some((t) => t.status !== "unverified" && tagUse(t.urn) === "place_filter"),
  candidates: c.tags.map((t) => t.urn),
}));

const BY_NAME: ReadonlyMap<string, CuratedConcept> = (() => {
  const byName = new Map<string, CuratedConcept>();
  config.categories.forEach((c, i) => {
    const concept = CONCEPTS[i] as CuratedConcept;
    for (const name of [c.key, c.label, ...c.aliases]) {
      const key = normaliseConcept(name);
      const taken = byName.get(key);
      if (taken !== undefined && taken.key !== concept.key) {
        throw new Error(`config/categories.json: "${name}" names both ${taken.key} and ${concept.key}`);
      }
      byName.set(key, concept);
    }
  });
  return byName;
})();

/**
 * The category:place tags a probe gate verified as place filters (G10, C1, C1b): the only tags
 * geo_lift counts similar venues with. A category tag found at run time, or one still unverified in
 * the config, may return no venue where many exist (C1: the first bookstore and pizza candidates gave
 * 0 Nashville places), so a count from it could read as "no competitors"; without a verified filter
 * the competitor count is unknown, never 0 (PLAN §8.3).
 */
const VERIFIED_PLACE_FILTERS: ReadonlySet<string> = new Set(
  config.categories.flatMap((c) => c.tags.filter((t) => t.status === "verified" && t.verified_as === "place_filter").map((t) => t.urn)),
);

export function isVerifiedPlaceFilter(tagId: string): boolean {
  return VERIFIED_PLACE_FILTERS.has(tagId);
}

/** The curated concept that serves a tag (its label names the place type in plain words), or null. */
export function curatedConceptOfTag(tagId: string): CuratedConcept | null {
  return CONCEPTS.find((c) => c.served.some((t) => t.tagId === tagId) || c.candidates.includes(tagId)) ?? null;
}

/** The curated concept a place concept names exactly (its key, label or an alias, normalised), or null. */
export function curatedConcept(text: string): CuratedConcept | null {
  return BY_NAME.get(normaliseConcept(text)) ?? null;
}

export function curatedConcepts(): readonly CuratedConcept[] {
  return CONCEPTS;
}
