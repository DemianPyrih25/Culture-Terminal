import { z } from "zod";
import categories from "../../../../config/categories.json";
import sponsors from "../../../../config/sponsor_categories.json";

/**
 * What /method says about coverage (PLAN §11.2 exit rule): each place type and sponsor category with
 * the probe gate that verified it, or the named fallback that runs instead. Read from the configs the
 * skills read (config/categories.json for find_tags and geo_lift, config/sponsor_categories.json for
 * the sponsor slate), so the page cannot claim a gate the config does not record.
 */

/** The fallback the configs name for a category with no verified tag (PLAN §11.2). */
export const SEMANTIC_TAG_SEARCH = "semantic_tag_search";

const Tag = z.object({
  status: z.enum(["verified", "research", "unverified"]),
  verified_by: z.string().nullable().optional(),
  verified_as: z.enum(["heatmap_signal", "place_filter", "brand_filter"]).optional(),
  fallback: z.literal(SEMANTIC_TAG_SEARCH).optional(),
});

const Categories = z.object({
  categories: z.array(z.object({ key: z.string(), label: z.string(), tags: z.array(Tag) })),
});

const Sponsors = z.object({
  categories: z.record(
    z.string(),
    z.object({ label: z.string(), tags: z.array(Tag), tag_status: z.string(), fallback: z.literal(SEMANTIC_TAG_SEARCH).optional() }),
  ),
});

export interface PlaceTypeCoverage {
  key: string;
  label: string;
  /** The gate that verified its heatmap signal (geo_lift's concept tag), or null. */
  signal: string | null;
  /** The gate that verified its venue filter (geo_lift's supply sample), or null. */
  filter: string | null;
  /** True when, with no verified venue filter, one is found by semantic tag search at run time and labelled so. */
  filterSearched: boolean;
}

export interface SponsorCoverage {
  key: string;
  label: string;
  /** The gate that verified its brand filter tag, or null when it runs on the fallback. */
  gate: string | null;
  /** True when its tag is found by semantic tag search at run time and labelled so. */
  searched: boolean;
}

export interface CoverageFacts {
  placeTypes: PlaceTypeCoverage[];
  sponsors: SponsorCoverage[];
}

type TagEntry = z.infer<typeof Tag>;

function gateFor(tags: readonly TagEntry[], use: NonNullable<TagEntry["verified_as"]>): string | null {
  const tag = tags.find((t) => t.status === "verified" && t.verified_as === use && typeof t.verified_by === "string");
  return tag?.verified_by ?? null;
}

export function coverageFacts(): CoverageFacts {
  const places = Categories.parse(categories);
  const brands = Sponsors.parse(sponsors);
  return {
    placeTypes: places.categories.map((c) => ({
      key: c.key,
      label: c.label,
      signal: gateFor(c.tags, "heatmap_signal"),
      filter: gateFor(c.tags, "place_filter"),
      filterSearched: gateFor(c.tags, "place_filter") === null && c.tags.some((t) => t.status === "unverified" && t.fallback === SEMANTIC_TAG_SEARCH),
    })),
    sponsors: Object.entries(brands.categories).map(([key, c]) => {
      const gate = c.tag_status === "verified" ? gateFor(c.tags, "brand_filter") : null;
      return { key, label: c.label, gate, searched: gate === null && c.fallback === SEMANTIC_TAG_SEARCH };
    }),
  };
}
