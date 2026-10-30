// Part 11 contracts: confidence caps, R3 candidates, context blocks, the Supply payload, local_supply,
// OpenStreetMap provenance and the shapes runs stored before Part 11 still parse with. Invented values only.
import { describe, expect, it } from "vitest";
import {
  AI_CONTEXT_HEADING,
  AiContextBlock,
  applyEvent,
  CONFIDENCE_CAP,
  CONFIDENCE_PENALTY,
  ConfidenceRule,
  confidenceBand,
  DATASET_PAYLOADS,
  DatasetEnvelope,
  DEFAULT_RUN_LIMITS,
  EMPTY_CANDIDATES,
  Flag,
  FindingKind,
  GeoLiftNeighbourhood,
  Intent,
  initialRunState,
  isPublicDataTool,
  MAX_OBVIOUS,
  Metric,
  normalizeIntent,
  parseToolInput,
  PUBLIC_DATA_NOTICE,
  PUBLIC_ENDPOINTS,
  PUBLIC_NOT_CONFIGURED_REASON,
  PublicProvenanceRequest,
  Receipt,
  Report,
  ResolvedMention,
  RunLimits,
  stampEvent,
  StoredIntent,
  strongerCandidate,
  strongerConceptMatch,
  SupplyPayload,
  TOOL_MNEMONIC,
  VIZ_COMPAT,
  WEB_CONTEXT_HEADING,
  WebContextBlock,
  weakerConceptMatch,
  type SupplyPayload as SupplyPayloadT,
} from "../src/index";
import { aiContextBlock, intent, report, RUN_ID, ts, webContextBlock } from "./fixtures";

describe("confidence caps (R1, D47)", () => {
  it("caps instead of subtracting for the cap rules", () => {
    for (const rule of ConfidenceRule.options) {
      if (CONFIDENCE_CAP[rule] !== undefined) expect(CONFIDENCE_PENALTY[rule], rule).toBe(0);
    }
    expect(CONFIDENCE_CAP).toEqual({ signal_mixed: 70, signal_weak: 45, thin_sample: 70, category_level: 60, concept_partly_tagged: 70 });
  });

  it("keeps a mixed signal or a thin headline out of HIGH and a weak signal in LOW", () => {
    expect(confidenceBand(CONFIDENCE_CAP.signal_mixed!)).toBe("MED");
    expect(confidenceBand(CONFIDENCE_CAP.thin_sample!)).toBe("MED");
    expect(confidenceBand(CONFIDENCE_CAP.category_level!)).toBe("MED");
    expect(confidenceBand(CONFIDENCE_CAP.signal_weak!)).toBe("LOW");
  });

  it("parses a breakdown line with its cap, and one stored without", () => {
    const confidence = {
      score: 60,
      band: "MED",
      breakdown: [
        { rule: "category_level", label: "The concept is not in the data; only its broader category was read", count: 1, points: -40, cap: 60 },
        { rule: "thin_result", label: "A call returned fewer than five rows", count: 1, points: -10 },
      ],
    };
    expect(Report.shape.verdict.shape.confidence.parse(confidence)).toEqual(confidence);
  });
});

describe("R3 candidates", () => {
  const withCandidates = (c: Partial<Intent["candidates"]>, over: Partial<Intent> = {}): Intent => ({
    ...intent,
    ...over,
    candidates: { ...EMPTY_CANDIDATES, ...c },
  });

  it("caps, dedupes and never repeats a mention or the primary", () => {
    const out = normalizeIntent(
      withCandidates({
        obvious_entities: [
          { text: "juniper  cola", entity_type: "brand" },
          { text: "Aurora Footwear!", entity_type: "brand" },
          ...["Brand A", "Brand B", "brand a", "Brand C", "Brand D", "Brand E", "Brand F", "Brand G"].map((text) => ({
            text,
            entity_type: "brand" as const,
          })),
        ],
      }),
    );
    expect(out.candidates.obvious_entities.map((e) => e.text)).toEqual(["Brand A", "Brand B", "Brand C", "Brand D", "Brand E", "Brand F"]);
    expect(out.candidates.obvious_entities).toHaveLength(MAX_OBVIOUS.entities);
  });

  it("keeps obvious areas apart from the named ones and caps markets to well-formed ids", () => {
    const out = normalizeIntent(
      withCandidates(
        {
          named_areas: ["Riverside", "Old Mill"],
          obvious_areas: ["riverside", "Harbor Point", "Old Mill", "North End", "Elm Park", "Hill Row", "Fifth"],
          named_markets: ["austin", "Not A Market!", "austin"],
          obvious_markets: ["austin", "denver", "kansas_city", "x", "boise", "tulsa"],
        },
        { geo: { ...intent.geo, area: "Elm Park", cities: ["denver"] } },
      ),
    );
    expect(out.candidates.named_areas).toEqual(["Riverside", "Old Mill"]);
    expect(out.candidates.obvious_areas).toEqual(["Harbor Point", "North End", "Hill Row", "Fifth"]);
    expect(out.candidates.named_markets).toEqual(["austin"]);
    expect(out.candidates.obvious_markets).toEqual(["kansas_city", "boise", "tulsa"]);
  });

  it("reads a stored intent without candidates as all-empty lists", () => {
    const { candidates: _drop, ...old } = intent;
    void _drop;
    expect(StoredIntent.parse(old).candidates).toEqual(EMPTY_CANDIDATES);
    expect(StoredIntent.parse({ ...old, candidates: { named_areas: ["Riverside"] } }).candidates).toEqual({
      ...EMPTY_CANDIDATES,
      named_areas: ["Riverside"],
    });
  });

  it("keeps the strongest candidate source and the right concept match", () => {
    expect(strongerCandidate("obvious", "user_named")).toBe("user_named");
    expect(strongerCandidate(undefined, "obvious")).toBe("obvious");
    expect(strongerCandidate(undefined, undefined)).toBe("data");
    expect(weakerConceptMatch("exact", "proxy")).toBe("proxy");
    expect(weakerConceptMatch(undefined, "category")).toBe("category");
    expect(strongerConceptMatch("category", "exact")).toBe("exact");
  });

  it("carries the candidate source and alias on a resolved mention", () => {
    const m = {
      mention: "KFC",
      role: "primary",
      entityType: "brand",
      match: "exact",
      ref: "R1",
      name: "Example Fried Chicken",
      popularity: 0.9,
      disambiguation: null,
      alternatives: [],
      source: "gate",
      candidate: "user_named",
      alias: "Example Fried Chicken",
    };
    expect(ResolvedMention.parse(m)).toEqual(m);
    const { candidate: _c, alias: _a, ...old } = m;
    void _c;
    void _a;
    expect(ResolvedMention.safeParse(old).success).toBe(true);
  });
});

describe("vocabulary additions", () => {
  it("adds the Part 11 flags, findings, tool and dataset kind", () => {
    for (const f of ["EXPECTED_CANDIDATE_MISSING", "CATEGORY_LEVEL_READ", "PROXY_TAG_IGNORED", "SUBJECT_NO_DATA", "OSM_NOT_CONFIGURED", "OSM_SUPPLY_FLOOR", "NOT_SEPARATELY_REPORTED"]) {
      expect(Flag.safeParse(f).success, f).toBe(true);
    }
    for (const k of ["OVERSUPPLIED", "UNDERSUPPLIED", "LOW_STREET_ACTIVITY"]) expect(FindingKind.safeParse(k).success, k).toBe(true);
    expect(TOOL_MNEMONIC.local_supply).toBe("SUPP");
    expect(VIZ_COMPAT.Supply).toBe("SupplyTable");
    expect(DATASET_PAYLOADS.Supply).toBe(SupplyPayload);
    expect(isPublicDataTool("local_supply")).toBe(true);
    expect(PUBLIC_DATA_NOTICE).toMatch(/OpenStreetMap/);
    expect(PUBLIC_ENDPOINTS["/api/interpreter"]).toEqual({ source: "osm", host: "overpass-api.de", label: "OpenStreetMap (Overpass API)" });
    expect(PUBLIC_NOT_CONFIGURED_REASON.osm).toBe("OpenStreetMap is not configured on this server");
  });
});

describe("metrics and provenance", () => {
  const metric = {
    id: "M4",
    key: "osm.density_index",
    label: "Cafés per km², Riverside vs the city",
    subjectRefs: ["riverside"],
    value: 1.1,
    reason: null,
    display: "about the city's level",
    unit: "index",
    badge: "DERIVED",
    formulaId: "osm.density_index",
    evidenceIds: ["E2"],
    n: 14,
    conf: null,
    comparator: "CITY",
    window: null,
    period: "OpenStreetMap data as of 2026-10-01",
    thin: false,
    conceptRead: "exact",
    level: "about_level",
  } as const;

  it("parses the new optional metric fields and old metrics without them", () => {
    expect(Metric.parse(metric)).toEqual(metric);
    const { thin: _t, conceptRead: _c, level: _l, ...old } = metric;
    void _t;
    void _c;
    void _l;
    expect(Metric.safeParse(old).success).toBe(true);
    expect(Metric.safeParse({ ...metric, level: "small" }).success).toBe(false);
  });

  it("records an Overpass request as a read-only POST with its query text", () => {
    const req = {
      source: "osm",
      method: "POST",
      host: "overpass-api.de",
      path: "/api/interpreter",
      query: {},
      body: '[out:json][timeout:25];nwr["amenity"="cafe"](around:500,36.1,-86.7);out count;',
      reference: "osm-2026-10-01T00:00:00Z",
    };
    expect(PublicProvenanceRequest.parse(req)).toEqual(req);
    expect(PublicProvenanceRequest.safeParse({ ...req, method: "DELETE" }).success).toBe(false);
  });
});

describe("GeoLift popularity (R7)", () => {
  it("parses raw, rawPct and standing, and a neighbourhood stored without them", () => {
    const n = {
      id: "riverside",
      name: "Riverside",
      n: 8,
      lift: 1.4,
      conf: 0.7,
      demandPct: 0.9,
      supplyPct: null,
      supplyCount: null,
      whiteSpace: null,
      quadrant: null,
      reason: null,
      source: "obvious",
      raw: 0.31,
      rawPct: 0.4,
      standing: "hidden",
    };
    expect(GeoLiftNeighbourhood.parse(n)).toEqual(n);
    const { source: _s, raw: _r, rawPct: _p, standing: _st, ...old } = n;
    void _s;
    void _r;
    void _p;
    void _st;
    expect(GeoLiftNeighbourhood.safeParse(old).success).toBe(true);
    expect(GeoLiftNeighbourhood.safeParse({ ...n, standing: "famous" }).success).toBe(false);
  });
});

describe("Supply payload (R6)", () => {
  const supply = (): SupplyPayloadT => ({
    source: "osm",
    attribution: "© OpenStreetMap contributors",
    licence: "ODbL-1.0",
    licenceUrl: "https://www.openstreetmap.org/copyright",
    osmBase: "2026-10-01T00:00:00Z",
    scope: "areas",
    metro: "nashville",
    market: null,
    radiusKm: null,
    types: [{ key: "cafe", label: "Cafés and coffee shops", tags: ["amenity=cafe"] }],
    rows: [
      {
        id: "riverside",
        name: "Riverside",
        areaKm2: 4.2,
        source: "user_named",
        counts: { cafe: 14 },
        perKm2: { cafe: 3.33 },
        index: { cafe: 1.6 },
        activity: 120,
        activityPerKm2: 28.6,
      },
    ],
    city: { label: "Nashville", areaKm2: 1300, approximate: true, counts: { cafe: 2700 }, perKm2: { cafe: 2.08 }, activityPerKm2: 9.1 },
    mix: { over: [{ typeKey: "cafe", index: 1.6, count: 14 }], under: [] },
    places: [
      { name: "Example Café 1", brand: null, lat: 36.17, lon: -86.75, typeKey: "cafe", area: "riverside", osmUrl: "https://www.openstreetmap.org/node/1" },
    ],
    completeness: "OpenStreetMap is mapped by volunteers: counts are a floor, not a census.",
    caption: "Cafés per km² in the areas checked against Nashville as a whole.",
  });

  it("parses inside a dataset envelope", () => {
    const d = { id: "D3", kind: "Supply", title: "Cafés nearby", evidenceIds: ["E2"], formulaIds: ["osm.count"], payload: supply() };
    expect(DatasetEnvelope.parse(d)).toEqual(d);
  });

  it("requires the attribution and licence verbatim and caps the place list", () => {
    expect(SupplyPayload.safeParse({ ...supply(), attribution: "OpenStreetMap" }).success).toBe(false);
    expect(SupplyPayload.safeParse({ ...supply(), licence: "CC-BY" }).success).toBe(false);
    const many = Array.from({ length: 61 }, (_, i) => ({ ...supply().places[0]!, name: `Example Café ${i + 1}` }));
    expect(SupplyPayload.safeParse({ ...supply(), places: many }).success).toBe(false);
  });
});

describe("local_supply input (R6)", () => {
  const base = { place_types: ["cafe"], mix: false, list_places: true, trigger_finding_id: null, step_id: "S3" };

  it("takes a map city with areas, or a market alone", () => {
    expect(parseToolInput("local_supply", { ...base, metro: "nashville", areas: ["riverside"], market: null }).ok).toBe(true);
    expect(parseToolInput("local_supply", { ...base, metro: null, areas: [], market: "kansas_city" }).ok).toBe(true);
  });

  it("refuses both scopes, neither, too many areas or types, and repeats", () => {
    const bad = [
      { ...base, metro: "nashville", areas: ["riverside"], market: "austin" },
      { ...base, metro: null, areas: [], market: null },
      { ...base, metro: "nashville", areas: [], market: null },
      { ...base, metro: "nashville", areas: Array.from({ length: 9 }, (_, i) => `area-${i}`), market: null },
      { ...base, place_types: ["a", "b", "c", "d", "e"], metro: null, areas: [], market: "austin" },
      { ...base, metro: "nashville", areas: ["riverside", "riverside"], market: null },
    ];
    for (const input of bad) expect(parseToolInput("local_supply", input).ok).toBe(false);
  });
});

describe("context blocks (R4, R5)", () => {
  it("parses the invented blocks and refuses a non-http link or an over-long item", () => {
    expect(AiContextBlock.parse(aiContextBlock())).toEqual(aiContextBlock());
    expect(WebContextBlock.parse(webContextBlock())).toEqual(webContextBlock());
    const web = webContextBlock();
    expect(WebContextBlock.safeParse({ ...web, items: [{ ...web.items[0]!, url: "javascript:alert(1)" }] }).success).toBe(false);
    expect(WebContextBlock.safeParse({ ...web, items: [{ ...web.items[0]!, url: "ftp://files.example.com/x" }] }).success).toBe(false);
    const ai = aiContextBlock();
    expect(AiContextBlock.safeParse({ ...ai, items: [{ ...ai.items[0]!, text: "x".repeat(241) }] }).success).toBe(false);
    expect(AiContextBlock.safeParse({ ...ai, items: Array.from({ length: 9 }, () => ai.items[0]) }).success).toBe(false);
    for (const text of ["It has 40 stores.", "Sales grew 5%.", "A $2 deal.", "Opened in ٢٠٢٤."]) {
      expect(AiContextBlock.safeParse({ ...ai, items: [{ ...ai.items[0]!, text }] }).success, text).toBe(false);
    }
    expect(AI_CONTEXT_HEADING).toBe("What AI knows (not verified)");
    expect(WEB_CONTEXT_HEADING).toBe("From the web");
  });

  it("puts the blocks on the report and the side spend on the receipt, and reads old reports", () => {
    const withBlocks = {
      ...report,
      aiContext: aiContextBlock(),
      webContext: null,
      audit: [],
      receipt: {
        ...report.receipt,
        models: { ...report.receipt.models, context: "claude-sonnet-5-5", web: null },
        context: { aiUsd: 0.012, webUsd: 0, webSearches: 0 },
      },
    };
    expect(Report.parse(withBlocks)).toEqual(withBlocks);
    expect(Report.parse(report)).toEqual(report);
    expect(Receipt.safeParse({ ...report.receipt, context: { aiUsd: -1, webUsd: 0, webSearches: 0 } }).success).toBe(false);
  });

  it("folds context events into the run state", () => {
    let s = initialRunState(RUN_ID);
    s = applyEvent(s, stampEvent({ type: "context.web", block: webContextBlock(), usd: 0.04, ms: 900 }, { seq: 1, ts: ts(1), runId: RUN_ID }));
    expect(s.webContext).toEqual(webContextBlock());
    expect(s.aiContext).toBeNull();
    s = applyEvent(s, stampEvent({ type: "context.ai", block: aiContextBlock(), usd: 0.01, ms: 500 }, { seq: 2, ts: ts(2), runId: RUN_ID }));
    expect(s.aiContext).toEqual(aiContextBlock());
    expect(s.timeline.map((e) => e.type)).toEqual(["context.web", "context.ai"]);
  });
});

describe("run limits", () => {
  it("holds three follow-up calls for a concept test and reads stored limits without it", () => {
    expect(DEFAULT_RUN_LIMITS).toMatchObject({ qlooCalls: 40, qlooWarnAt: 30, followupCalls: 8, conceptReserveCalls: 3 });
    expect(RunLimits.parse(DEFAULT_RUN_LIMITS)).toEqual(DEFAULT_RUN_LIMITS);
    const { conceptReserveCalls: _r, ...stored } = DEFAULT_RUN_LIMITS;
    void _r;
    expect(RunLimits.parse(stored).conceptReserveCalls).toBe(3);
  });
});
