import {
  InsightsFilterType,
  insightsResponseSchema,
  QlooAudiencesResponse,
  QlooEntitiesResponse,
  QlooSearchResponse,
  QlooTagsResponse,
  QlooTrendingResponse,
} from "@ct/contracts";
import type { z } from "zod";
import type { QlooPath } from "./allowlist";

/**
 * The contracts response schema each endpoint is validated against (lenient: unknown keys pass, a
 * missing optional field never rejects a response). A body that fails it is a QlooResponseError.
 */
export function responseSchema(path: QlooPath, filterType: string | null): z.ZodType {
  switch (path) {
    case "/search":
      return QlooSearchResponse;
    case "/entities":
      return QlooEntitiesResponse;
    case "/v2/tags":
      return QlooTagsResponse;
    case "/v2/audiences":
      return QlooAudiencesResponse;
    case "/v2/trending":
      return QlooTrendingResponse;
    case "/v2/insights":
      return insightsResponseSchema(InsightsFilterType.parse(filterType));
  }
}

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

const RESULT_ARRAYS = ["entities", "heatmap", "tags", "demographics", "trending", "audiences"] as const;

/** Rows in a validated body, for the trace: the length of its results array, or null when it has none. */
export function rowCount(data: unknown): number | null {
  if (!isRecord(data)) return null;
  const results = data.results;
  if (Array.isArray(results)) return results.length;
  if (!isRecord(results)) return null;
  for (const key of RESULT_ARRAYS) {
    const rows = results[key];
    if (Array.isArray(rows)) return rows.length;
  }
  return null;
}
