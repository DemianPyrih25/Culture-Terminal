import { isTaxonomyTag } from "@ct/contracts";
import { z } from "zod";
import raw from "../../../../../config/categories.json";
import { normaliseConcept, tagNameFromUrn, tagTypeOf, tagUse, type TagUse } from "./tags";

/**
 * The curated concept map for find_tags (scope place) and the geo_lift baseline, read from
 * config/categories.json (PLAN §4.3, §5.3 S6). It is ours, so a malformed file fails loudly at
 * start-up. Verified and research tags are served at zero cost; a concept whose tags are all
 * unverified is looked up live with its semantic query until a probe verifies them.
 */

const TagStatus = z.enum(["verified", "research", "unverified"]);
const taxonomyUrn = z.string().refine(isTaxonomyTag, { message: "curated tags must be taxonomy tags (PROBE consequence 1)" });

const CuratedTagEntry = z.object({
  urn: taxonomyUrn,
  status: TagStatus,
  verified_by: z.string().nullable().optional(),
  verified_as: z.enum(["heatmap_signal", "place_filter"]).optional(),
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

/** The curated concept a place concept names exactly (its key, label or an alias, normalised), or null. */
export function curatedConcept(text: string): CuratedConcept | null {
  return BY_NAME.get(normaliseConcept(text)) ?? null;
}

export function curatedConcepts(): readonly CuratedConcept[] {
  return CONCEPTS;
}
