import { z } from "zod";
import { AgeBucket } from "./enums";

/**
 * Qloo request and response shapes (keys only, from docs/PROBE_FINDINGS.md "Response shapes").
 * QUANT parses responses with these; the Qloo client may use them to validate. Objects are loose:
 * unknown keys pass through, fields the probe did not see on every row are optional, and fields it saw
 * as null on some rows are nullish: one bad row must never reject a whole response.
 * `query.measurements.audience_growth` is deliberately absent (D15: never read).
 */

export const QlooPath = z.enum(["/search", "/entities", "/v2/insights", "/v2/tags", "/v2/audiences", "/v2/trending"]);
export type QlooPath = z.infer<typeof QlooPath>;

export const EntityFilterType = z.enum([
  "urn:entity:brand",
  "urn:entity:artist",
  "urn:entity:podcast",
  "urn:entity:tv_show",
  "urn:entity:movie",
  "urn:entity:person",
  "urn:entity:destination",
  "urn:entity:place",
]);
export type EntityFilterType = z.infer<typeof EntityFilterType>;

/** Every `filter.type` the insights endpoint is used with (the allowlist keys). */
export const InsightsFilterType = z.enum([
  ...EntityFilterType.options,
  "urn:heatmap",
  "urn:tag",
  "urn:demographics",
]);
export type InsightsFilterType = z.infer<typeof InsightsFilterType>;

/** Request parameters as sent: allowlisted keys only (the client throws on any other). */
export type QlooParamValue = string | number | boolean | readonly string[];
export type QlooParams = Readonly<Record<string, QlooParamValue>>;

/** Tag reference on a /search result. */
export const QlooSearchTag = z.looseObject({ tag_id: z.string(), name: z.string(), type: z.string() });
/**
 * Tag reference on an insights entity (note `id`, not `tag_id`). Some tags arrive with only `type`
 * (G15), so every field is optional and consumers skip a tag without an id and a name.
 */
export const QlooEntityTag = z.looseObject({
  id: z.string().optional(),
  name: z.string().optional(),
  type: z.string().optional(),
});

export const QlooLatLon = z.looseObject({ lat: z.number(), lon: z.number(), geohash: z.string().optional() });

/** Place geocode (G10): `name` and `metro` are null on many rows, so every field is nullish. */
export const QlooGeocode = z.looseObject({
  name: z.string().nullish(),
  city: z.string().nullish(),
  metro: z.string().nullish(),
  admin1_region: z.string().nullish(),
  admin2_region: z.string().nullish(),
  country: z.string().nullish(),
  country_code: z.string().nullish(),
});

export const QlooSearchEntity = z.looseObject({
  entity_id: z.string(),
  name: z.string(),
  types: z.array(z.string()),
  popularity: z.number().optional(),
  disambiguation: z.string().nullish(),
  properties: z.record(z.string(), z.unknown()).optional(),
  tags: z.array(QlooSearchTag).optional(),
});
export type QlooSearchEntity = z.infer<typeof QlooSearchEntity>;

export const QlooSearchResponse = z.looseObject({ results: z.array(QlooSearchEntity) });
export type QlooSearchResponse = z.infer<typeof QlooSearchResponse>;

/** /entities batch describe. Verified live: its rows have the /search shape. */
export const QlooEntitiesResponse = z.looseObject({ results: z.array(QlooSearchEntity) });
export type QlooEntitiesResponse = z.infer<typeof QlooEntitiesResponse>;

/** Per-result explainability: each seed's share of the result (G15). */
export const QlooExplainShare = z.looseObject({ entity_id: z.string(), score: z.number() });

export const QlooEntity = z.looseObject({
  entity_id: z.string(),
  name: z.string(),
  type: z.string().optional(),
  subtype: z.string().nullish(),
  popularity: z.number().optional(),
  disambiguation: z.string().nullish(),
  properties: z
    .looseObject({
      description: z.string().nullish(),
      short_description: z.string().nullish(),
      geocode: QlooGeocode.nullish(),
    })
    .optional(),
  tags: z.array(QlooEntityTag).optional(),
  location: QlooLatLon.optional(),
  query: z
    .looseObject({
      affinity: z.number().optional(),
      distance: z.number().optional(),
      explainability: z.looseObject({ "signal.interests.entities": z.array(QlooExplainShare).optional() }).optional(),
    })
    .optional(),
});
export type QlooEntity = z.infer<typeof QlooEntity>;

export const QlooLocalitySignal = z.looseObject({
  entity_id: z.string(),
  name: z.string(),
  subtype: z.string().nullish(),
  location: z.looseObject({ lat: z.number(), lon: z.number() }).optional(),
  popularity: z.number().optional(),
  disambiguation: z.string().nullish(),
});

export const QlooEffectOnTop = z.looseObject({ entity_id: z.string(), avg_score: z.number() });

export const QlooEntityInsightsResponse = z.looseObject({
  success: z.boolean().optional(),
  results: z.looseObject({ entities: z.array(QlooEntity) }),
  query: z
    .looseObject({
      localities: z.looseObject({ signal: QlooLocalitySignal.optional() }).optional(),
      explainability: z
        .looseObject({
          "signal.interests.entities": z
            .looseObject({
              effect_on_top3_recs: z.array(QlooEffectOnTop).optional(),
              effect_on_top5_recs: z.array(QlooEffectOnTop).optional(),
              effect_on_top10_recs: z.array(QlooEffectOnTop).optional(),
              effect_on_all_recs: z.array(QlooEffectOnTop).optional(),
            })
            .optional(),
        })
        .optional(),
    })
    .optional(),
});
export type QlooEntityInsightsResponse = z.infer<typeof QlooEntityInsightsResponse>;

export const QlooHeatmapCell = z.looseObject({
  location: z.looseObject({ latitude: z.number(), longitude: z.number(), geohash: z.string() }),
  query: z.looseObject({
    affinity: z.number(),
    affinity_rank: z.number().nullish(),
    popularity: z.number().nullish(),
    tag_affinity: z.number().nullish(),
    tag_affinity_rank: z.number().nullish(),
  }),
});
export type QlooHeatmapCell = z.infer<typeof QlooHeatmapCell>;

export const QlooHeatmapResponse = z.looseObject({
  success: z.boolean().optional(),
  results: z.looseObject({ heatmap: z.array(QlooHeatmapCell) }),
});
export type QlooHeatmapResponse = z.infer<typeof QlooHeatmapResponse>;

/** A `filter.type=urn:tag` row: the location fingerprint used by Block DNA (G8). */
export const QlooTagInsightRow = z.looseObject({
  tag_id: z.string(),
  name: z.string(),
  types: z.array(z.string()).optional(),
  subtype: z.string().nullish(),
  tag_value: z.string().nullish(),
  popularity: z.number().optional(),
  query: z.looseObject({ affinity: z.number().optional() }).optional(),
});
export type QlooTagInsightRow = z.infer<typeof QlooTagInsightRow>;

export const QlooTagInsightsResponse = z.looseObject({
  success: z.boolean().optional(),
  results: z.looseObject({ tags: z.array(QlooTagInsightRow) }),
  query: z
    .looseObject({
      geospatial: z
        .looseObject({ panel_size: z.looseObject({ context: z.number(), target: z.number() }).optional() })
        .optional(),
    })
    .optional(),
});
export type QlooTagInsightsResponse = z.infer<typeof QlooTagInsightsResponse>;

/** One `urn:demographics` block: indices, not shares (G12). Entities with no block are "not measured". */
export const QlooDemographicsBlock = z.looseObject({
  entity_id: z.string(),
  query: z.looseObject({
    age: z.record(AgeBucket, z.number()),
    gender: z.looseObject({ male: z.number(), female: z.number() }),
  }),
});
export type QlooDemographicsBlock = z.infer<typeof QlooDemographicsBlock>;

export const QlooDemographicsResponse = z.looseObject({
  success: z.boolean().optional(),
  results: z.looseObject({ demographics: z.array(QlooDemographicsBlock) }),
});
export type QlooDemographicsResponse = z.infer<typeof QlooDemographicsResponse>;

/** A trending point (G11): newest first; population_rank arrives as a string. */
export const QlooTrendingPoint = z.looseObject({
  date: z.string(),
  population_percentile: z.number(),
  population_rank: z.string(),
  population_rank_velocity: z.number().optional(),
  velocity_fold_change: z.number().optional(),
  population_percent_delta: z.number().optional(),
});
export type QlooTrendingPoint = z.infer<typeof QlooTrendingPoint>;

export const QlooTrendingResponse = z.looseObject({
  success: z.boolean().optional(),
  results: z.looseObject({ trending: z.array(QlooTrendingPoint) }),
});
export type QlooTrendingResponse = z.infer<typeof QlooTrendingResponse>;

/** A /v2/tags search result (G14). */
export const QlooTagSearchItem = z.looseObject({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  parents: z.array(z.looseObject({ type: z.string() })).optional(),
  popularity: z.number().optional(),
});
export type QlooTagSearchItem = z.infer<typeof QlooTagSearchItem>;

export const QlooTagsResponse = z.looseObject({
  success: z.boolean().optional(),
  results: z.looseObject({ tags: z.array(QlooTagSearchItem) }),
});
export type QlooTagsResponse = z.infer<typeof QlooTagsResponse>;

export const QlooAudience = z.looseObject({
  id: z.string(),
  entity_id: z.string().optional(),
  name: z.string(),
  type: z.string(),
  parents: z.array(z.looseObject({ id: z.string().optional(), name: z.string().optional(), type: z.string() })).optional(),
  disambiguation: z.string().nullish(),
});
export type QlooAudience = z.infer<typeof QlooAudience>;

export const QlooAudiencesResponse = z.looseObject({
  success: z.boolean().optional(),
  results: z.looseObject({ audiences: z.array(QlooAudience) }),
});
export type QlooAudiencesResponse = z.infer<typeof QlooAudiencesResponse>;

/** Response type of `insights(filterType, …)` by filter type. */
export type InsightsResponse<F extends InsightsFilterType> = F extends "urn:heatmap"
  ? QlooHeatmapResponse
  : F extends "urn:tag"
    ? QlooTagInsightsResponse
    : F extends "urn:demographics"
      ? QlooDemographicsResponse
      : QlooEntityInsightsResponse;

/** Runtime counterpart of InsightsResponse, for code that validates by filter type. */
export function insightsResponseSchema(filterType: InsightsFilterType): z.ZodType {
  switch (filterType) {
    case "urn:heatmap":
      return QlooHeatmapResponse;
    case "urn:tag":
      return QlooTagInsightsResponse;
    case "urn:demographics":
      return QlooDemographicsResponse;
    default:
      return QlooEntityInsightsResponse;
  }
}

/**
 * Taxonomy tags (`urn:tag:genre:…`, `urn:tag:category:…`) are the only tags that act as insight or
 * heatmap signals. Descriptive `*:qloo:*` tags from semantic search returned flat rows (G1) and empty
 * heatmaps (G6), so they are never used as signals (PROBE consequence 1).
 */
export function isTaxonomyTag(tagId: string): boolean {
  return /^urn:tag:(?:genre|category):/.test(tagId) && !/:qloo(?::|$)/.test(tagId);
}

/**
 * Audience keys are Qloo's public audience URNs (`urn:audience:<parent>:<leaf>`, D29 allows them).
 * The desk allowlist (D21, config/audiences.allow.json) is enforced inside the Qloo client.
 */
export const AudienceKey = z
  .string()
  .regex(/^urn:audience:[a-z][a-z0-9_]*:[^\s,]+$/, { message: "expected an audience URN like urn:audience:leisure:<leaf>" })
  .describe("audience URN from the AUDIENCES list in the run context");
export type AudienceKey = z.infer<typeof AudienceKey>;

/** The parent category of an audience key (`leisure` for urn:audience:leisure:…), checked against D21. */
export function audienceParent(key: AudienceKey): string {
  return key.split(":")[2] ?? "";
}
