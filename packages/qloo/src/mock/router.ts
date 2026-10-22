import { EntityFilterType } from "@ct/contracts";
import type { CanonicalRequest } from "../transport-types";
import { describeEntities, searchEntities } from "./handlers/search";
import { listAudiences, searchTags } from "./handlers/catalogs";
import { demographicsInsights } from "./handlers/demographics";
import { entityInsights } from "./handlers/entity-insights";
import { heatmapInsights } from "./handlers/heatmap";
import { tagInsights } from "./handlers/tag-insights";
import { trendingSeries } from "./handlers/trending";
import type { MockReply } from "./json";
import { MockBadRequest, readString } from "./params";

function insights(request: CanonicalRequest): MockReply {
  const filterType = request.filterType ?? readString(request.params, "filter.type");
  switch (filterType) {
    case "urn:heatmap":
      return heatmapInsights(request.params);
    case "urn:tag":
      return tagInsights(request.params);
    case "urn:demographics":
      return demographicsInsights(request.params);
    default:
      if (filterType !== undefined && EntityFilterType.safeParse(filterType).success) return entityInsights(filterType, request.params);
      throw new MockBadRequest(`unsupported filter.type for /v2/insights: ${filterType ?? "(none)"}`);
  }
}

function dispatch(request: CanonicalRequest): MockReply {
  switch (request.path) {
    case "/search":
      return searchEntities(request.params);
    case "/entities":
      return describeEntities(request.params);
    case "/v2/insights":
      return insights(request);
    case "/v2/tags":
      return searchTags(request.params);
    case "/v2/audiences":
      return listAudiences(request.params);
    case "/v2/trending":
      return trendingSeries(request.filterType ?? readString(request.params, "filter.type") ?? null, request.params);
    default:
      throw new MockBadRequest(`unknown path ${String(request.path)}`);
  }
}

/** Answers a canonical request with synthetic data; malformed requests get HTTP 400 like the API. */
export function answer(request: CanonicalRequest): MockReply {
  try {
    return dispatch(request);
  } catch (error) {
    if (error instanceof MockBadRequest) return { status: 400, body: { error: error.message } };
    throw error;
  }
}
