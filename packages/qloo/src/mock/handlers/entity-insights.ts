import type { QlooParams } from "@ct/contracts";
import { affinityValue, describeRecord, type EntityRecord, type ExplainShare, PLACE, toInsightsEntity, universe } from "../entities";
import { round, unit } from "../hash";
import { type JsonObject, type MockReply, ok } from "../json";
import { DEFAULT_METRO, type Metro, metroOfLocation } from "../metros";
import { applyWindow, readBool, readList, readNumber, readString } from "../params";
import { affinityFor, hasTag, matchedTags, readSignals, type Signals } from "../scoring";

/** `/v2/insights` for urn:entity:* filter types. */

interface Row {
  rec: EntityRecord;
  affinity: number | null;
}

/** Places come from one metro: filter.location, else the location signal, else the default. */
function placeMetro(params: QlooParams): Metro {
  const location = readString(params, "filter.location") ?? readString(params, "signal.location") ?? readString(params, "signal.location.query");
  return (location !== undefined ? metroOfLocation(location) : null) ?? DEFAULT_METRO;
}

/** The result filters of the request as one predicate (read once, applied per candidate). */
function filterFor(params: QlooParams): (rec: EntityRecord) => boolean {
  const excluded = new Set(readList(params, "filter.exclude.entities"));
  const popularityMax = readNumber(params, "filter.popularity.max");
  const tags = readList(params, "filter.tags");
  const excludedTags = readList(params, "filter.exclude.tags");
  const country = readString(params, "filter.geocode.country_code")?.toUpperCase();
  return (rec) =>
    !excluded.has(rec.id) &&
    (popularityMax === undefined || rec.popularity <= popularityMax) &&
    (tags.length === 0 || tags.some((t) => hasTag(rec, t))) &&
    !excludedTags.some((t) => hasTag(rec, t)) &&
    (country === undefined || rec.geo?.geocode?.country_code === country);
}

function rank(rows: Row[]): Row[] {
  return rows.sort((a, b) => {
    const byScore = (b.affinity ?? b.rec.popularity) - (a.affinity ?? a.rec.popularity);
    return byScore !== 0 ? byScore : a.rec.id < b.rec.id ? -1 : 1;
  });
}

/** Per-seed shares of one result (G15): about three in four near-uniform, the rest skewed. */
function explainShares(seeds: readonly string[], rec: EntityRecord): ExplainShare[] {
  const skewed = unit("explain-skew", rec.id, seeds.join(",")) < 0.25;
  const weights = seeds.map((s) => (skewed ? 0.05 + unit("explain-weight", s, rec.id) ** 2 : 1 + 0.08 * (unit("explain-weight", s, rec.id) - 0.5)));
  const total = weights.reduce((s, w) => s + w, 0);
  return seeds.map((s, i) => ({ entity_id: s, score: round((weights[i] ?? 0) / total, 4) }));
}

function effectOnTop(seeds: readonly string[], shares: readonly ExplainShare[][], n: number): JsonObject[] {
  const top = shares.slice(0, n);
  return seeds.map((s) => {
    const values = top.map((row) => row.find((x) => x.entity_id === s)?.score ?? 0);
    return { entity_id: s, avg_score: round(values.reduce((a, b) => a + b, 0) / Math.max(values.length, 1), 4) };
  });
}

function topLevelQuery(signals: Signals, seeds: readonly string[], shares: readonly ExplainShare[][] | null): JsonObject | null {
  const query: JsonObject = {};
  const locality = signals.queriedLocality;
  if (locality) {
    query.localities = {
      signal: {
        entity_id: locality.id,
        name: locality.name,
        subtype: locality.type,
        location: { lat: round(locality.geo?.at.lat ?? 0, 6), lon: round(locality.geo?.at.lon ?? 0, 6) },
        popularity: locality.popularity,
        disambiguation: locality.disambiguation,
      },
    };
  }
  if (shares) {
    query.explainability = {
      "signal.interests.entities": {
        effect_on_top3_recs: effectOnTop(seeds, shares, 3),
        effect_on_top5_recs: effectOnTop(seeds, shares, 5),
        effect_on_top10_recs: effectOnTop(seeds, shares, 10),
        effect_on_all_recs: effectOnTop(seeds, shares, shares.length),
      },
    };
  }
  return Object.keys(query).length > 0 ? query : null;
}

export function entityInsights(type: string, params: QlooParams): MockReply {
  const signals = readSignals(params);
  const candidates = readList(params, "filter.results.entities");
  const pool = candidates.length > 0 ? candidates.map((id) => describeRecord(id, type)) : universe(type, type === PLACE ? placeMetro(params) : DEFAULT_METRO);

  const passes = filterFor(params);
  const rows: Row[] = [];
  for (const rec of pool) {
    if (!passes(rec)) continue;
    const affinity = affinityFor(signals, rec, type);
    if (affinity === "dropped") continue;
    rows.push({ rec, affinity: affinity === null ? null : affinityValue(affinity) });
  }
  const page = applyWindow(rank(rows), params);

  const seeds = signals.entities;
  const explain = readBool(params, "feature.explainability") && seeds.length > 0;
  const shares = explain ? page.map((row) => explainShares(seeds, row.rec)) : null;
  const filterTags = readList(params, "filter.tags");
  const entities = page.map((row, i) =>
    toInsightsEntity(row.rec, { affinity: row.affinity, tags: matchedTags(row.rec, filterTags), explain: shares?.[i] ?? null }),
  );

  const body: JsonObject = { success: true, results: { entities } };
  const query = topLevelQuery(signals, seeds, shares);
  if (query) body.query = query;
  return ok(body);
}
