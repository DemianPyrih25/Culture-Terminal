import type { RegisteredEntity } from "@ct/contracts";
import { isNoiseTag } from "../../tagNoise";

/**
 * S3 facet tags (SPEC §5.3 S3, probe G13): the entities' /search tag lists (fetched by /entities,
 * the same row shape), grouped by namespace. /v2/analysis/compare is not used (G13: near-empty); the
 * a-only, b-only and shared lists are qualitative presence, never measured differences (D15).
 */

export interface FacetTag {
  tagId: string;
  name: string;
  /** Facet key: one of SPEC_FACETS, or the tag's own namespace. */
  facet: string;
}

/** The SPEC facets in display order; any other namespace follows as its own group, alphabetically. */
export const SPEC_FACETS: readonly { key: string; label: string; namespaces: readonly string[] }[] = [
  { key: "aesthetic", label: "Aesthetic", namespaces: ["aesthetic_property", "aesthetic"] },
  { key: "emotional_tone", label: "Emotional tone", namespaces: ["emotional_tone"] },
  { key: "lifestyle", label: "Lifestyle", namespaces: ["lifestyle"] },
  { key: "customer_segment", label: "Customer segment", namespaces: ["customer_segment"] },
  { key: "personal_style", label: "Personal style", namespaces: ["personal_style", "style"] },
  { key: "product", label: "Product", namespaces: ["product_category", "product_service", "product"] },
  { key: "genre", label: "Genre", namespaces: ["genre"] },
];

const FACET_OF_NAMESPACE = new Map(SPEC_FACETS.flatMap((f) => f.namespaces.map((ns) => [ns, f.key] as const)));
const FACET_RANK = new Map(SPEC_FACETS.map((f, i) => [f.key, i]));
const FACET_LABEL = new Map(SPEC_FACETS.map((f) => [f.key, f.label]));

/** `urn:tag:<namespace>:…` → namespace; a tag id of another shape falls back to its type, then "other". */
export function namespaceOf(tag: { tagId: string; type: string }): string {
  const m = /^urn:tag:([a-z0-9_]+)/i.exec(tag.tagId) ?? /^urn:tag:([a-z0-9_]+)/i.exec(tag.type);
  return m?.[1]?.toLowerCase() ?? "other";
}

export function facetOf(tag: { tagId: string; type: string }): string {
  const ns = namespaceOf(tag);
  return FACET_OF_NAMESPACE.get(ns) ?? ns;
}

/**
 * Whether a facet is one of the seven SPEC facets, the only ones the distinctive rule scores. Other
 * namespaces (core_value, competitor_brand, similar_brand, …) are listed as context: brand-reference
 * tags name other brands, so they would almost never repeat across peers and always look distinctive.
 */
export function isSpecFacet(facet: string): boolean {
  return FACET_RANK.has(facet);
}

/** "Aesthetic"; an unlisted namespace reads as words: "core_value" → "Core value". */
export function facetLabel(facet: string): string {
  const known = FACET_LABEL.get(facet);
  if (known !== undefined) return known;
  const words = facet.replace(/_/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Facet order: the SPEC facets first, then other namespaces alphabetically. */
export function compareFacets(a: string, b: string): number {
  const ra = FACET_RANK.get(a) ?? SPEC_FACETS.length;
  const rb = FACET_RANK.get(b) ?? SPEC_FACETS.length;
  return ra - rb || (a < b ? -1 : a > b ? 1 : 0);
}

/**
 * An entity's distinct tags as facet tags, in Qloo's order. Noise tags (a place name, or a nationality
 * or generic word among music tags) go through the shared filter (ANSWER_QUALITY §10) and are left out,
 * so they never take a facet row, a shared/only slot or a distinctive count.
 */
export function facetTags(entity: Pick<RegisteredEntity, "tags">): FacetTag[] {
  const seen = new Set<string>();
  const out: FacetTag[] = [];
  for (const t of entity.tags) {
    if (seen.has(t.tagId)) continue;
    if (isNoiseTag({ name: t.name, tagId: t.tagId, type: t.type })) continue;
    seen.add(t.tagId);
    out.push({ tagId: t.tagId, name: t.name, facet: facetOf(t) });
  }
  return out;
}

export interface ProfiledTag {
  tag: FacetTag;
  /** Peers carrying the tag; null when no peer's tags are known. */
  peerCount: number | null;
  /**
   * On the target and on fewer than half of the peers (FORMULAS dna.distinctive_tags); null without
   * peers, and for a tag outside the SPEC facets, which is context and never scored.
   */
  distinctive: boolean | null;
}

export interface FacetGroup {
  facet: string;
  label: string;
  tags: ProfiledTag[];
}

export interface FacetProfile {
  groups: FacetGroup[];
  /** Peers whose tags are known: the denominator of the distinctive rule. */
  peers: number;
  /** Distinctive tags in display order; empty without peers. */
  distinctive: FacetTag[];
  /** The target's tags in the SPEC facets: the "of N" of the distinctive count. */
  total: number;
}

function byName(a: FacetTag, b: FacetTag): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/**
 * The target's tags grouped by facet, each with how many peers carry it; only tags in the SPEC
 * facets can be distinctive. The caller passes peers of the target's own type, since tags are
 * type-specific. Peers without any tag are left out of the denominator: an unknown tag list is not
 * evidence that a trait is absent. Inside a group, distinctive tags come first, then by fewer peers,
 * then by name.
 */
export function facetProfile(target: readonly FacetTag[], peerTagIds: readonly ReadonlySet<string>[]): FacetProfile {
  const known = peerTagIds.filter((s) => s.size > 0);
  const peers = known.length;
  const profiled: ProfiledTag[] = target.map((tag) => {
    if (peers === 0) return { tag, peerCount: null, distinctive: null };
    const peerCount = known.filter((s) => s.has(tag.tagId)).length;
    return { tag, peerCount, distinctive: isSpecFacet(tag.facet) ? peerCount < peers / 2 : null };
  });
  const facets = [...new Set(profiled.map((p) => p.tag.facet))].sort(compareFacets);
  const groups = facets.map((facet) => ({
    facet,
    label: facetLabel(facet),
    tags: profiled
      .filter((p) => p.tag.facet === facet)
      .sort(
        (a, b) =>
          Number(b.distinctive === true) - Number(a.distinctive === true) ||
          (a.peerCount ?? 0) - (b.peerCount ?? 0) ||
          byName(a.tag, b.tag),
      ),
  }));
  const distinctive = groups.flatMap((g) => g.tags.filter((t) => t.distinctive === true).map((t) => t.tag));
  return { groups, peers, distinctive, total: target.filter((t) => isSpecFacet(t.facet)).length };
}

export interface TagContrast {
  aOnly: FacetTag[];
  shared: FacetTag[];
  bOnly: FacetTag[];
}

function inFacetOrder(tags: readonly FacetTag[]): FacetTag[] {
  return [...tags].sort((a, b) => compareFacets(a.facet, b.facet) || byName(a, b));
}

/** Tags only on A, on both, and only on B: qualitative presence (D15). */
export function contrastTags(a: readonly FacetTag[], b: readonly FacetTag[]): TagContrast {
  const aIds = new Set(a.map((t) => t.tagId));
  const bIds = new Set(b.map((t) => t.tagId));
  return {
    aOnly: inFacetOrder(a.filter((t) => !bIds.has(t.tagId))),
    shared: inFacetOrder(a.filter((t) => bIds.has(t.tagId))),
    bOnly: inFacetOrder(b.filter((t) => !aIds.has(t.tagId))),
  };
}
