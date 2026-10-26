import {
  entityTypeUrn,
  isTaxonomyTag,
  type Domain,
  type EntityRegistry,
  type QlooParams,
  type RegisteredEntity,
  type RegisteredTag,
  type ToolInput,
} from "@ct/contracts";
import type { EntityTagRef } from "../common";
import { safeName } from "../format";
import { categoryTagOf } from "../peerSelection";

/**
 * The S9 requests (SPEC §5.3 S9; PROBE_FINDINGS "Part 5 consequences" 5): one open insights call per
 * domain with the seeds, the seed tags as taste context, explainability and a popularity cap. Every
 * parameter is allowlisted for all five domains (G15, P5); the brand call also excludes the seeds'
 * own genre:brand category (P5).
 */

export type CrossDomainInput = ToolInput<"cross_domain">;

/** Results per domain (SPEC §5.3 S9). */
export const XDOM_TAKE = 15;

/**
 * Genre taxonomy tags: the only seed tags P5 verified as S9 taste signals. Category tags are filters
 * (G10) and a category:place tag gave no signal at all (P5), so they never reach the calls.
 */
export const GENRE_PREFIX = "urn:tag:genre:";

/** Display and call order: the media lists first, brands last (the A08 margin figure). */
export const DOMAIN_ORDER: readonly Domain[] = ["artist", "podcast", "tv_show", "movie", "brand"];

/** Group headings of the Ranked dataset. */
export const DOMAIN_LABEL: Readonly<Record<Domain, string>> = {
  artist: "Music · artists",
  podcast: "Podcasts",
  tv_show: "TV · series",
  movie: "Movies",
  brand: "Brands",
};

/** The domain as an adjective in texts: "the music results", "the TV call". */
export const DOMAIN_NOUN: Readonly<Record<Domain, string>> = {
  artist: "music",
  podcast: "podcast",
  tv_show: "TV",
  movie: "movie",
  brand: "brand",
};

/** One result of the domain, counted in evidence summaries: "1 artist", "15 artists". */
export const DOMAIN_ITEM: Readonly<Record<Domain, string>> = {
  artist: "artist",
  podcast: "podcast",
  tv_show: "TV show",
  movie: "movie",
  brand: "brand",
};

/** The requested domains in DOMAIN_ORDER, so the same request always gives the same calls and groups. */
export function orderedDomains(domains: readonly Domain[]): Domain[] {
  return DOMAIN_ORDER.filter((d) => domains.includes(d));
}

/** What a cross_domain input resolves to in the registry, with a notice for every ref left out. */
export interface CrossDomainPlan {
  seeds: RegisteredEntity[];
  /** Genre taxonomy seed tags only: descriptive tags give no signal (G1), category tags are filters. */
  tags: RegisteredTag[];
  /** The brand seeds' genre:brand leaves, excluded from the brand domain (P5). */
  excludeTags: EntityTagRef[];
  domains: Domain[];
  popularityMax: number;
  notices: string[];
}

export function planCrossDomain(input: CrossDomainInput, registry: EntityRegistry): CrossDomainPlan {
  const notices: string[] = [];
  const seeds: RegisteredEntity[] = [];
  for (const ref of input.seeds) {
    const e = registry.entity(ref);
    if (e === null) notices.push(`${ref} is not in the registry; left out of the seeds.`);
    else seeds.push(e);
  }

  const tags: RegisteredTag[] = [];
  for (const ref of input.seed_tags) {
    const t = registry.tag(ref);
    if (t === null) notices.push(`${ref} is not in the registry; left out of the seed tags.`);
    else if (!t.signalCapable || !isTaxonomyTag(t.tagId)) {
      notices.push(`${ref} (${safeName(t.name)}) is a descriptive tag, which gives no taste signal; left out.`);
    } else if (!t.tagId.startsWith(GENRE_PREFIX)) {
      notices.push(`${ref} (${safeName(t.name)}) is a category tag, which acts as a filter, not a taste signal; left out.`);
    } else tags.push(t);
  }

  const domains = orderedDomains(input.domains);
  const excludeTags: EntityTagRef[] = [];
  if (domains.includes("brand")) {
    for (const seed of seeds.filter((s) => s.type === "brand")) {
      const category = categoryTagOf(seed);
      if (category === null) {
        notices.push(`${safeName(seed.name)} has no genre:brand tag, so the brand list may include its own category.`);
      } else if (!excludeTags.some((t) => t.tagId === category.tagId)) excludeTags.push(category);
    }
  }
  return { seeds, tags, excludeTags, domains, popularityMax: input.popularity_max, notices };
}

/** One domain's request, without filter.type (the insights() argument). */
export function domainParams(plan: CrossDomainPlan, domain: Domain): QlooParams {
  const exclude = domain === "brand" ? plan.excludeTags.map((t) => t.tagId) : [];
  return {
    "signal.interests.entities": plan.seeds.map((s) => s.entityId),
    ...(plan.tags.length > 0 ? { "signal.interests.tags": plan.tags.map((t) => t.tagId) } : {}),
    "feature.explainability": true,
    "filter.popularity.max": plan.popularityMax,
    ...(exclude.length > 0 ? { "filter.exclude.tags": exclude } : {}),
    take: XDOM_TAKE,
  };
}

/** The request as the cache probe sees it: has() takes no separate filter type. */
export function probeParams(plan: CrossDomainPlan, domain: Domain): QlooParams {
  return { "filter.type": entityTypeUrn(domain), ...domainParams(plan, domain) };
}
