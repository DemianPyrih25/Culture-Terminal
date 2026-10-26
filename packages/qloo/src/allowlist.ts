/**
 * Qloo parameter allowlist, frozen from the gating probe (tools/probe/run-probe.ts, docs/PROBE_FINDINGS.md).
 *
 * The client validates every request against ALLOW[path][filter.type] and throws QlooParamError on any
 * path, filter.type or parameter not listed (§5.1): Qloo silently ignores invalid parameters, so an
 * unlisted one must fail loudly here instead.
 *
 * Each value records where the parameter was proven:
 *   "verified Gx"  exercised live by probe gate Gx (or the resolution sweep) on the hackathon host;
 *   "verified Sx"  exercised live by skill Sx before it shipped (same host, compared with and without the parameter);
 *   "verified P5"  exercised live by the Part 5 parameter probe before the remaining skills were built (same
 *                  host, compared with and without the parameter; docs/PROBE_FINDINGS.md "Verified after the gates");
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
      "filter.location": "verified S0 (lat,lon form only; with filter.radius every place result fell inside the radius of the requested metro)",
      "filter.radius": "verified S0 (miles; only together with filter.location)",
    },
  },

  "/entities": {
    [ANY_TYPE]: {
      entity_ids: "verified S0 (batch describe; rows have the /search shape)",
    },
  },

  "/v2/insights": {
    "urn:entity:brand": {
      "filter.type": "verified G1",
      "signal.interests.entities": "verified G1",
      "signal.interests.tags":
        "verified P5 (taxonomy tags only: a seed plus a genre:brand tag replaced 9 of 20 rows; G1: a descriptive *:qloo:* tag gave a flat floor row)",
      "signal.demographics.audiences": "verified G1",
      "signal.demographics.age": "verified G4 (rows come back unsorted by affinity, as for persons in P5: rank by affinity, never by row order)",
      "signal.location":
        "verified G2 (locality UUID, POLYGON, POINT); verified P5 with signal.interests.entities (both apply: the order differs from either signal alone, the location decides which candidates are scored)",
      "signal.location.query": "verified G2",
      "filter.results.entities": "verified G1",
      "filter.popularity.max": "verified G9",
      "filter.tags":
        "verified S1, P5 (a urn:tag:genre:brand:* tag or a descriptive urn:tag:product_category:qloo:* tag restricts results to brands carrying it, 20/20 each; two tags combine as a union, 20/20 rows carrying either and 9/20 both; S1 same-category discovery, S10 sponsor categories)",
      "filter.exclude.entities": "verified S1 (an excluded entity drops out of results; the signal entity is absent even without it)",
      "filter.exclude.tags": "verified P5 (rows carrying the excluded genre:brand tag fell from 9/20 to 0/20; S9 brand domain)",
      "feature.explainability": "verified G15 (on urn:entity:artist)",
      take: "verified G1",
    },

    "urn:entity:artist": {
      "filter.type": "verified G15",
      "signal.interests.entities": "verified G15",
      "signal.interests.tags": "verified P5 (seeds plus a genre:music tag: rows carrying it rose from 3/15 to 6/15, 4 of 15 rows replaced)",
      "filter.results.entities": "verified P5 (5/5 candidates returned, same affinities as the open call; rank_candidates)",
      "feature.explainability": "verified G15",
      "filter.popularity.max": "verified P5 (cap 0.97: rows above it fell from 6/15 to 0/15, all 9 rows under it kept)",
      take: "verified G15",
    },
    "urn:entity:podcast": {
      "filter.type": "verified G15 (on urn:entity:artist)",
      "signal.interests.entities": "verified G15 (on urn:entity:artist)",
      "signal.interests.tags": "verified P5 (seeds plus a genre:media tag: rows carrying it rose from 4/15 to 8/15, 10 of 15 rows replaced)",
      "feature.explainability": "verified G15 (on urn:entity:artist)",
      "filter.popularity.max": "verified P5 (cap 0.99: rows above it fell from 5/15 to 0/15, all 10 rows under it kept)",
      take: "verified G15 (on urn:entity:artist)",
    },
    "urn:entity:tv_show": {
      "filter.type": "verified G15 (on urn:entity:artist)",
      "signal.interests.entities": "verified G15 (on urn:entity:artist)",
      "signal.interests.tags":
        "verified P5 (seeds plus a genre:media tag: rows carrying it rose from 3/15 to 12/15, 13 of 15 rows replaced; one row had popularity null)",
      "feature.explainability": "verified G15 (on urn:entity:artist)",
      "filter.popularity.max": "verified P5 (cap 0.8: rows above it fell from 6/15 to 0/15, all 9 rows under it kept)",
      take: "verified G15 (on urn:entity:artist)",
    },
    "urn:entity:movie": {
      "filter.type": "verified G15 (on urn:entity:artist)",
      "signal.interests.entities": "verified G15 (on urn:entity:artist)",
      "signal.interests.tags":
        "verified P5 (applied: seeds plus a genre:media tag replaced 9 and 7 of 15 rows for two tags; the direction depends on the tag, rows carrying it fell from 3/15 to 0/15 for one and rose from 5/15 to 10/15 for the other, so it is never a genre steer)",
      "feature.explainability": "verified G15 (on urn:entity:artist)",
      "filter.popularity.max": "verified P5 (cap 0.99: rows above it fell from 6/15 to 0/15, all 9 rows under it kept)",
      take: "verified G15 (on urn:entity:artist)",
    },

    "urn:entity:person": {
      "filter.type": "verified G3",
      "signal.location": "verified G3 (locality UUID); verified P5 (POINT and POLYGON: 5/5 scored, identical to each other, order differs from the locality UUID)",
      "signal.demographics.age": "verified P5 (5/5 scored, affinities differ by bucket; rows come back unsorted, so sort by affinity)",
      "filter.results.entities": "verified G3",
      take: "verified G3",
    },

    // signal.interests.tags is not allowlisted here: P5 found it rank-inert on destinations (same 50 rows in
    // the same order, every affinity shifted alike for unrelated tags). S5 sends seeds only.
    "urn:entity:destination": {
      "filter.type": "verified G5",
      "signal.interests.entities": "verified G5",
      "filter.geocode.country_code": "verified G5",
      "filter.results.entities": "verified G5",
      take: "verified G5",
      page: "verified G5",
    },

    // A location signal scores only part of a candidate list (the same 6 of 12 under every P5 location);
    // an entity signal scored all 12.
    "urn:entity:place": {
      "filter.type": "verified G10",
      "filter.location": "verified G10 (locality UUID)",
      "filter.tags": "verified G10 (taxonomy category tag)",
      "signal.location":
        "verified P5 (a north Austin POINT reordered the scored places, rho 0.26 against the city locality; an East Austin POINT and POLYGON kept the city order; city affinities saturate near 1, so read ranks)",
      "signal.interests.entities": "verified P5 (12/12 candidates scored, order differs from a location signal; venues that fit, SPEC §7.3 step 3)",
      "filter.results.entities": "verified P5 (returned rows stay inside the candidate list)",
      take: "verified G10",
      page: "verified G10",
    },

    // operator.signal.interests.tags is removed: in P5 union, intersection and no operator gave identical maps
    // for two live genre:place tags. Several tags combine by default, so S6 sends none.
    // Concept tags and entity analogs go in separate calls: in a combined P5 map the analog's cells held the
    // top 160 places, so the analog's footprint, not the concept, set the hot spots.
    "urn:heatmap": {
      "filter.type": "verified G6",
      "filter.location": "verified G6 (locality UUID)",
      "signal.interests.tags":
        "verified G6, P5 (urn:tag:genre:place:* tags only: each gave ~1k cells with tag_affinity and two combine; a urn:tag:category:place:* tag returned 0 cells, like *:qloo:* tags)",
      "signal.interests.entities":
        "verified P5 (alone: 199 of ~1k cells, 176 of them among the 199 most popular, carrying entity_<type>_affinity; with a tag, its cells took the top 160 places while tag_affinity stayed identical to the tag alone; S6 analog-only concept calls)",
    },

    "urn:tag": {
      "filter.type": "verified G8",
      "signal.location":
        "verified G8 (POINT, POLYGON; equivalent at neighbourhood scale); verified P5 (metro locality UUID: city fingerprints differ by metro, no panel_size; the unfiltered city lists held 1 and 0 genre:music tags of 50)",
      "signal.location.query": "verified in research (live neighbourhood query; BLOCK ladder step 3)",
      "filter.tag.types":
        "verified G8; verified P5 (urn:tag:genre:music: 50/50 music tags with each metro locality UUID against 1/50 and 0/50 without, and with the G8 polygon against 4/50; S7 SOUND city and area calls)",
      take: "verified G8",
    },

    "urn:demographics": {
      "filter.type": "verified G12",
      "signal.interests.entities": "verified G12; verified P5 (mixed types in one batch: brands, artist, tv_show and person, 7/7 blocks)",
      take: "verified G12",
    },
  },

  "/v2/tags": {
    [ANY_TYPE]: {
      "filter.query": "verified G14",
      "feature.semantic_search": "verified G14",
      "filter.parents.types": "verified G14",
      "filter.tag.types": "verified P5 (10/10 results of the requested tag types, against 4/10 and 1/10 without; find_tags taxonomy-only search)",
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
