/**
 * Qloo parameter allowlist, frozen from the gating probe (tools/probe/run-probe.ts, docs/PROBE_FINDINGS.md).
 *
 * The client validates every request against ALLOW[path][filter.type] and throws QlooParamError on any
 * path, filter.type or parameter not listed (§5.1): Qloo silently ignores invalid parameters, so an
 * unlisted one must fail loudly here instead.
 *
 * Each value records where the parameter was proven:
 *   "verified Gx"  exercised live by probe gate Gx (or the resolution sweep) on the hackathon host;
 *   "UNVERIFIED"   needed by a P0 skill but not covered by a gate. The skill that first uses it verifies
 *                  it live before the skill is built, then this entry is updated.
 *
 * Names, query strings and public taxonomy URNs only (D29). No Qloo values or UUIDs.
 */

export const PROBE_VERIFIED_ON = "2026-10-21";

export type QlooPath =
  | "/search"
  | "/entities"
  | "/v2/insights"
  | "/v2/tags"
  | "/v2/audiences"
  | "/v2/trending";

/** Key used for paths whose parameters do not depend on filter.type. */
export const ANY_TYPE = "*";

type ParamTable = Readonly<Record<string, string>>;

export const ALLOW: Readonly<Record<QlooPath, Readonly<Record<string, ParamTable>>>> = {
  "/search": {
    [ANY_TYPE]: {
      query: "verified SWEEP",
      types: "verified SWEEP",
      take: "verified SWEEP",
      "filter.location": "UNVERIFIED (S0 place resolution; lat,lon form only)",
      "filter.radius": "UNVERIFIED (S0 place resolution; miles)",
    },
  },

  "/entities": {
    [ANY_TYPE]: {
      entity_ids: "UNVERIFIED (batch describe)",
    },
  },

  "/v2/insights": {
    "urn:entity:brand": {
      "filter.type": "verified G1",
      "signal.interests.entities": "verified G1",
      "signal.interests.tags": "verified G1 (taxonomy tags only; descriptive *:qloo:* tags gave a flat floor row)",
      "signal.demographics.audiences": "verified G1",
      "signal.demographics.age": "verified G4",
      "signal.location": "verified G2 (locality UUID, POLYGON, POINT)",
      "signal.location.query": "verified G2",
      "filter.results.entities": "verified G1",
      "filter.popularity.max": "verified G9",
      "filter.tags": "UNVERIFIED (S1 same-category discovery, S10 sponsor categories)",
      "filter.exclude.entities": "UNVERIFIED (S1 discovery)",
      "filter.exclude.tags": "UNVERIFIED (S9 brand domain)",
      "feature.explainability": "verified G15 (on urn:entity:artist)",
      take: "verified G1",
    },

    "urn:entity:artist": {
      "filter.type": "verified G15",
      "signal.interests.entities": "verified G15",
      "signal.interests.tags": "UNVERIFIED (S9; taxonomy tags only)",
      "feature.explainability": "verified G15",
      "filter.popularity.max": "verified G9 (on urn:entity:brand)",
      take: "verified G15",
    },
    "urn:entity:podcast": {
      "filter.type": "verified G15 (on urn:entity:artist)",
      "signal.interests.entities": "verified G15 (on urn:entity:artist)",
      "signal.interests.tags": "UNVERIFIED (S9; taxonomy tags only)",
      "feature.explainability": "verified G15 (on urn:entity:artist)",
      "filter.popularity.max": "verified G9 (on urn:entity:brand)",
      take: "verified G15 (on urn:entity:artist)",
    },
    "urn:entity:tv_show": {
      "filter.type": "verified G15 (on urn:entity:artist)",
      "signal.interests.entities": "verified G15 (on urn:entity:artist)",
      "signal.interests.tags": "UNVERIFIED (S9; taxonomy tags only)",
      "feature.explainability": "verified G15 (on urn:entity:artist)",
      "filter.popularity.max": "verified G9 (on urn:entity:brand)",
      take: "verified G15 (on urn:entity:artist)",
    },
    "urn:entity:movie": {
      "filter.type": "verified G15 (on urn:entity:artist)",
      "signal.interests.entities": "verified G15 (on urn:entity:artist)",
      "signal.interests.tags": "UNVERIFIED (S9; taxonomy tags only)",
      "feature.explainability": "verified G15 (on urn:entity:artist)",
      "filter.popularity.max": "verified G9 (on urn:entity:brand)",
      take: "verified G15 (on urn:entity:artist)",
    },

    "urn:entity:person": {
      "filter.type": "verified G3",
      "signal.location": "verified G3 (locality UUID)",
      "filter.results.entities": "verified G3",
      take: "verified G3",
    },

    "urn:entity:destination": {
      "filter.type": "verified G5",
      "signal.interests.entities": "verified G5",
      "filter.geocode.country_code": "verified G5",
      "filter.results.entities": "verified G5",
      take: "verified G5",
      page: "verified G5",
    },

    "urn:entity:place": {
      "filter.type": "verified G10",
      "filter.location": "verified G10 (locality UUID)",
      "filter.tags": "verified G10 (taxonomy category tag)",
      take: "verified G10",
      page: "verified G10",
    },

    "urn:heatmap": {
      "filter.type": "verified G6",
      "filter.location": "verified G6 (locality UUID)",
      "signal.interests.tags": "verified G6 (taxonomy genre:place tag; descriptive *:qloo:* tags returned no cells)",
      "operator.signal.interests.tags": "UNVERIFIED (S6 multi-tag concepts; G6 did not isolate it)",
      "signal.interests.entities": "UNVERIFIED (S6 analogs)",
    },

    "urn:tag": {
      "filter.type": "verified G8",
      "signal.location": "verified G8 (POINT, POLYGON; equivalent at neighbourhood scale)",
      "signal.location.query": "verified in research (live neighbourhood query; BLOCK ladder step 3)",
      "filter.tag.types": "verified G8",
      take: "verified G8",
    },

    "urn:demographics": {
      "filter.type": "verified G12",
      "signal.interests.entities": "verified G12",
      take: "verified G12",
    },
  },

  "/v2/tags": {
    [ANY_TYPE]: {
      "filter.query": "verified G14",
      "feature.semantic_search": "verified G14",
      "filter.parents.types": "verified G14",
      "filter.tag.types": "UNVERIFIED (restricting concept search to taxonomy tags)",
      take: "verified G14",
    },
  },

  "/v2/audiences": {
    [ANY_TYPE]: {
      "filter.parents.types": "verified SWEEP",
      take: "verified SWEEP",
    },
  },

  "/v2/trending": {
    [ANY_TYPE]: {
      "filter.type": "verified G11",
      "signal.interests.entities": "verified G11",
      "filter.start_date": "verified G11",
      "filter.end_date": "verified G11",
      take: "verified G11",
    },
  },
};

/**
 * Parameters rejected with a specific reason, before the generic unknown-parameter check.
 * Keys are `path|filter.type|param`; "*" matches any path or type.
 */
export const FORBIDDEN: Readonly<Record<string, string>> = {
  "*|*|bias.trends": "D15: injects noise; never sent",
  "/v2/insights|urn:entity:brand|filter.location": "§5.1: brands have no location; use signal.location",
  "/v2/insights|urn:tag|signal.location.radius": "G8: no effect on the result",
  "/v2/insights|urn:heatmap|output.heatmap.boundary": "locality boundary does not work; we roll up through our gazetteer",
};

/** Facts frozen by the probe that the client, QUANT and skills build on. */
export const PROBE_FACTS = {
  /** G1: score(signal A, candidate B) equals score(signal B, candidate A); triangular SUBS is valid. */
  pairSymmetric: true,
  /** G1: a candidate's score for a fixed signal does not depend on the rest of the candidate set. */
  candidateSetInvariant: true,
  /** G1 control: a rank call with no signal returns entities without query.affinity. */
  noSignalRankHasAffinity: false,
  /**
   * G1: candidates with no relationship to the signal share one floor affinity. Ties at a row's
   * minimum are "not scored in this context", never a rank.
   */
  floorTiesAreUnscored: true,
  /** G2: locality UUID and signal.location.query give identical rows; candidates can be dropped per context. */
  localityUuidEqualsQuery: true,
  /** G11: the historical window with real data, and the types that return points in it. */
  trendingWindow: { start: "2025-04-01", end: "2025-09-30" },
  trendingTypes: ["urn:entity:brand", "urn:entity:tv_show"],
  /** G12: urn:demographics batch size, sent with take=50. */
  demographicsBatchMax: 30,
  /** G6: the pinned heatmap baseline tag. */
  heatmapBaselineTag: "urn:tag:genre:place:restaurant",
  /** G7: heatmap price_level counts do not depend on the signal; S6 supply uses the places sample (G10). */
  heatmapPriceCountsAreConceptSpecific: false,
} as const;
