import { EntityFilterType, type QlooParams } from "@ct/contracts";
import { PROBE_FACTS } from "../../allowlist";
import { clamp, round, unit } from "../hash";
import { type JsonObject, type MockReply, ok } from "../json";
import { applyWindow, MockBadRequest, readList, readString } from "../params";

/**
 * `/v2/trending` (G11): up to 46 points between the requested dates, newest first. Series are
 * step-shaped: most points carry the previous value forward, as live series did. Only the types
 * the probe saw data for return points; one entity in ten gets a flat placeholder series so the
 * flatline guard has something to catch.
 */

const DAY_MS = 86_400_000;
const MAX_POINTS = 46;
const SERIES_TYPES: ReadonlySet<string> = new Set(PROBE_FACTS.trendingTypes);

function parseDate(params: QlooParams, key: string): number {
  const value = readString(params, key);
  const ms = value !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(value) ? Date.parse(`${value}T00:00:00Z`) : Number.NaN;
  if (!Number.isFinite(ms)) throw new MockBadRequest(`${key} must be a YYYY-MM-DD date`);
  return ms;
}

const rankOf = (percentile: number): number => Math.round(1 + (1 - percentile) * 120_000);

function series(id: string, startMs: number, endMs: number): JsonObject[] {
  const days = Math.round((endMs - startMs) / DAY_MS);
  const n = Math.min(MAX_POINTS, days + 1);
  const steps = Math.max(n - 1, 1);
  const placeholder = unit("trend-flat", id) < 0.1;
  // The drift is spread over the ~45% of steps that move, so the window's total stays within ±0.15.
  const drift = ((unit("trend-drift", id) - 0.5) * 0.3) / steps / 0.45;
  let percentile = round(0.25 + 0.65 * unit("trend-start", id), 4);
  let previous = { percentile, rank: rankOf(percentile) };
  const points: JsonObject[] = [];
  for (let i = 0; i < n; i++) {
    if (i > 0 && !placeholder && unit("trend-hold", id, i) >= 0.55) {
      percentile = round(clamp(percentile + drift + 0.03 * (unit("trend-step", id, i) - 0.5), 0.005, 0.995), 4);
    }
    const rank = rankOf(percentile);
    points.push({
      date: new Date(startMs + Math.round((i * days) / steps) * DAY_MS).toISOString().slice(0, 10),
      population_percentile: percentile,
      population_rank: String(rank),
      population_rank_velocity: i === 0 ? 0 : previous.rank - rank,
      velocity_fold_change: i === 0 || rank === previous.rank ? 1 : round(previous.rank / rank, 4),
      population_percent_delta: i === 0 ? 0 : round((percentile - previous.percentile) / previous.percentile, 4),
    });
    previous = { percentile, rank };
  }
  return points.reverse();
}

export function trendingSeries(filterType: string | null, params: QlooParams): MockReply {
  if (filterType === null || !EntityFilterType.safeParse(filterType).success) {
    throw new MockBadRequest(`unsupported filter.type for /v2/trending: ${filterType ?? "(none)"}`);
  }
  const [id] = readList(params, "signal.interests.entities");
  if (id === undefined) throw new MockBadRequest("/v2/trending needs signal.interests.entities");
  const startMs = parseDate(params, "filter.start_date");
  const endMs = parseDate(params, "filter.end_date");
  if (endMs < startMs) throw new MockBadRequest("filter.end_date is before filter.start_date");
  const points = SERIES_TYPES.has(filterType) ? series(id, startMs, endMs) : [];
  return ok({ success: true, results: { trending: applyWindow(points, params) } });
}
