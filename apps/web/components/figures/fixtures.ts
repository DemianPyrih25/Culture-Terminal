import type { AxisItem, DatasetOf, MatrixCell, NoValueReason, QuadrantName, QuadrantPoint, ValueCell } from "@ct/contracts";
import type { FigureSource } from "./figure-frame";
import { marketSlope, momentumStrip, tastePosition, tastePositionNoSignal, tenantSlope } from "./fixtures-desks";
import { austinLiftMap, coarseLiftMap } from "./fixtures-geo";
import { standingLiftMap, supplyAreas } from "./fixtures-part11";
import type { ProseBindings } from "./prose";

export { MOMENTUM_WINDOW, marketSlope, momentumStrip, tastePosition, tastePositionNoSignal, tenantSlope } from "./fixtures-desks";
export { austinLiftMap, coarseLiftMap } from "./fixtures-geo";
export { standingLiftMap, supplyAreas } from "./fixtures-part11";

/**
 * Invented figure fixtures for the /dev/figures gallery and the figure tests (D29: no Qloo values,
 * ids or request ids; every brand, artist and number here is made up, and none is traced from the
 * design exports). Each one parses with the DatasetEnvelope schema of @ct/contracts.
 */

const v = (value: number): ValueCell => ({ value, reason: null });
const none = (reason: NoValueReason): ValueCell => ({ value: null, reason });
const axis = (key: string, label: string, ref: string | null = null, group: string | null = null): AxisItem =>
  ({ key, label, ref, group }) as AxisItem;

/** Ranks within a row among scored cells, 1 = highest; ties keep column order. */
function rowRanks(values: readonly (number | null)[]): (number | null)[] {
  const order = values
    .map((value, j) => ({ value, j }))
    .filter((c): c is { value: number; j: number } => c.value !== null)
    .sort((a, b) => b.value - a.value || a.j - b.j);
  const ranks: (number | null)[] = values.map(() => null);
  order.forEach((c, k) => (ranks[c.j] = k + 1));
  return ranks;
}

function matrixCells(values: readonly (readonly (number | NoValueReason)[])[]): MatrixCell[][] {
  return values.map((row) => {
    const nums = row.map((c) => (typeof c === "number" ? c : null));
    const ranks = rowRanks(nums);
    return row.map((c, j) =>
      typeof c === "number" ? { value: c, reason: null, rank: ranks[j] ?? null } : { value: null, reason: c, rank: null },
    );
  });
}

// Matrix · similarity (A05 figure 2) --------------------------------------------------------------

const MAP = [
  axis("R1", "Juniper Cola", "R1"),
  axis("R2", "Brand Alpha", "R2"),
  axis("R3", "Brand Beta", "R3"),
  axis("R4", "Saltmarsh Seltzer", "R4"),
  axis("R5", "Kettle Ridge Tonic", "R5"),
  axis("R6", "Granite Hollow Ale", "R6"),
];

export const similarityMap: DatasetOf<"Matrix"> = {
  id: "D1",
  kind: "Matrix",
  title: "Substitution Map",
  evidenceIds: ["E1"],
  formulaIds: ["subs.similarity", "subs.rank_in_row", "subs.hub"],
  payload: {
    mode: "similarity",
    valueLabel: "Audience taste similarity",
    unit: "similarity",
    comparator: "PEERS",
    rows: MAP,
    cols: MAP.map((a) => ({ ...a })),
    cells: matrixCells([
      ["self", 0.34, 0.29, 0.12, 0.47, 0.38],
      [0.34, "self", 0.71, 0.44, 0.25, 0.18],
      [0.29, 0.71, "self", 0.53, 0.31, 0.09],
      [0.12, 0.44, 0.53, "self", "not_scored", 0.27],
      [0.47, 0.25, 0.31, "not_scored", "self", 0.64],
      [0.38, 0.18, 0.09, 0.27, 0.64, "self"],
    ]),
    margin: {
      label: "Hub score",
      values: [v(0.32), v(0.38), v(0.39), none("not_scored"), v(0.42), v(0.31)],
    },
    targetKey: "R1",
    annotations: [
      { text: "Kettle Ridge Tonic: nearest to Juniper Cola", rowKey: null, colKey: "R5" },
      { text: "Closest pair: Brand Alpha and Brand Beta", rowKey: "R2", colKey: "R3" },
    ],
  },
};

/** The same map with a cell note and a note on a whole row (rowKey only); the contract allows two. */
export const annotatedSimilarityMap: DatasetOf<"Matrix"> = {
  ...similarityMap,
  id: "D13",
  payload: {
    ...similarityMap.payload,
    annotations: [
      { text: "Closest pair: Brand Alpha and Brand Beta", rowKey: "R2", colKey: "R3" },
      { text: "Saltmarsh Seltzer: one pair not scored", rowKey: "R4", colKey: null },
    ],
  },
};

// Matrix · share (SHARE grid with sections) ---------------------------------------------------------

export const shareGrid: DatasetOf<"Matrix"> = {
  id: "D2",
  kind: "Matrix",
  title: "Share of taste",
  evidenceIds: ["E2"],
  formulaIds: ["share.pct"],
  payload: {
    mode: "share",
    valueLabel: "Share of taste within call",
    unit: "pct",
    comparator: "WITHIN_CALL",
    rows: [
      axis("nashville", "Nashville", null, "Metro"),
      axis("austin", "Austin", null, "Metro"),
      axis("denver", "Denver", null, "Metro"),
      axis("portland", "Portland", null, "Metro"),
      axis("25_to_29", "25–29", null, "Age"),
      axis("35_to_44", "35–44", null, "Age"),
      axis("55_and_older", "55+", null, "Age"),
    ],
    cols: [axis("R1", "Juniper Cola", "R1"), axis("R2", "Brand Alpha", "R2"), axis("R3", "Brand Beta", "R3")],
    cells: matrixCells([
      [0.41, 0.36, 0.23],
      [0.29, 0.47, 0.24],
      [0.33, 0.35, 0.32],
      [0.52, 0.48, "dropped"],
      [0.48, 0.3, 0.22],
      [0.31, 0.38, 0.31],
      [0.19, 0.44, 0.37],
    ]),
    margin: null,
    targetKey: "R1",
    annotations: [],
  },
};

// Ranked · nearest audiences (A05 figure 1) -----------------------------------------------------------

type RankedRowFixture = DatasetOf<"Ranked">["payload"]["groups"][number]["rows"][number];

const rankedRow = (
  key: string,
  rank: number | null,
  label: string,
  cell: ValueCell,
  extra: Partial<RankedRowFixture> = {},
): RankedRowFixture => ({
  key,
  rank,
  label,
  sublabel: null,
  ref: null,
  tagRef: null,
  type: "brand",
  cells: [cell],
  flags: [],
  explain: [],
  ...extra,
});

export const nearestAudiences: DatasetOf<"Ranked"> = {
  id: "D3",
  kind: "Ranked",
  title: "Nearest audiences",
  evidenceIds: ["E1"],
  formulaIds: ["subs.similarity"],
  payload: {
    columns: [{ key: "similarity", label: "Similarity to Juniper Cola", unit: "similarity", comparator: "PEERS" }],
    groups: [
      {
        key: "nearest",
        label: "Nearest audiences",
        rows: [
          rankedRow("R5", 1, "Kettle Ridge Tonic", v(0.47), { ref: "R5" }),
          rankedRow("R7", 2, "Larkspur Kombucha", v(0.43), { ref: "R7" }),
          rankedRow("R6", 3, "Granite Hollow Ale", v(0.38), { ref: "R6" }),
          rankedRow("R2", 4, "Brand Alpha", v(0.34), { ref: "R2" }),
          rankedRow("R8", 5, "Tidewell Water", v(0.31), { ref: "R8" }),
          rankedRow("R3", 6, "Brand Beta", v(0.29), { ref: "R3" }),
          rankedRow("R9", 7, "Ember Root Beer", v(0.22), { ref: "R9" }),
          rankedRow("R4", 8, "Saltmarsh Seltzer", v(0.12), { ref: "R4" }),
          rankedRow("R10", null, "Brand Gamma", none("not_scored"), { ref: "R10" }),
        ],
      },
    ],
    caption: null,
  },
};

/** The rivals the priors named: drawn in data-2 grey. */
export const EXPECTED_RIVALS = ["R2", "R3", "R4"] as const;

// Ranked · lists per domain (A08 figure 2) -----------------------------------------------------------

const PERCENTILE_COLUMN = { key: "pct", label: "Pctl", unit: "pct", comparator: "WITHIN_CALL" } as const;

export const domainLists: DatasetOf<"Ranked"> = {
  id: "D4",
  kind: "Ranked",
  title: "Cultural neighbourhood",
  evidenceIds: ["E3"],
  formulaIds: ["xdom.under_the_radar", "xdom.edge"],
  payload: {
    columns: [PERCENTILE_COLUMN],
    groups: [
      {
        key: "artist",
        label: "Music · artists",
        rows: [
          rankedRow("T1", 1, "The Velvet Lanterns", v(0.97), { type: "artist" }),
          rankedRow("T2", 2, "Marigold Static", v(0.92), { type: "artist" }),
          rankedRow("T3", 3, "Harbor & Pine", v(0.9), { type: "artist" }),
          rankedRow("T4", 4, "Low Orchard", v(0.83), { type: "artist" }),
          rankedRow("T5", 5, "Saint Ferro", v(0.79), { type: "artist" }),
        ],
      },
      {
        key: "podcast",
        label: "Podcasts",
        rows: [
          rankedRow("P1", 1, "Field Notes Weekly", v(0.95), { type: "podcast" }),
          rankedRow("P2", 2, "The Long Table", v(0.87), { type: "podcast" }),
          rankedRow("P3", 3, "Quiet Hours", v(0.85), { type: "podcast" }),
          rankedRow("P4", 4, "Small Print Radio", v(0.76), { type: "podcast" }),
        ],
      },
      {
        key: "tv_show",
        label: "TV · series",
        rows: [
          rankedRow("V1", 1, "Harbor Lights", v(0.93), { type: "tv_show" }),
          rankedRow("V2", 2, "The Night Kitchen", v(0.88), { type: "tv_show" }),
          rankedRow("V3", 3, "Westerly", v(0.8), { type: "tv_show" }),
          rankedRow("V4", null, "Paper Moons", none("not_measured"), { type: "tv_show" }),
        ],
      },
    ],
    caption: null,
  },
};

// Ranked · brands in the margin (A08 figure 3) ----------------------------------------------------------

export const marginBrands: DatasetOf<"Ranked"> = {
  id: "D5",
  kind: "Ranked",
  title: "Brands also loved",
  evidenceIds: ["E3"],
  formulaIds: ["xdom.under_the_radar"],
  payload: {
    columns: [PERCENTILE_COLUMN],
    groups: [
      {
        key: "brand",
        label: "Brands",
        rows: [
          rankedRow("B1", 1, "Northwind Outfitters", v(0.96), { sublabel: "outdoor" }),
          rankedRow("B2", 2, "Fernleaf Apothecary", v(0.89), { sublabel: "beauty" }),
          rankedRow("B3", 3, "Pale Harbor", v(0.84), { sublabel: "apparel" }),
          rankedRow("B4", 4, "Stonecrop Goods", v(0.78), { sublabel: "home" }),
          rankedRow("B5", 5, "Driftline", v(0.73), { sublabel: "footwear" }),
        ],
      },
    ],
    caption: null,
  },
};

// Ranked · area brands vs the city (signed margin bars) -------------------------------------------------

export const areaBrandShifts: DatasetOf<"Ranked"> = {
  id: "D14",
  kind: "Ranked",
  title: "Area brands vs the city",
  evidenceIds: ["E6"],
  formulaIds: ["block.rank_delta"],
  payload: {
    columns: [{ key: "delta", label: "Rank gain vs city", unit: "delta", comparator: "CITY" }],
    groups: [
      {
        key: "brand",
        label: "Brands",
        rows: [
          rankedRow("B11", 1, "Copperline Coffee", v(9), { sublabel: "café" }),
          rankedRow("B12", 2, "Thistle & Sons", v(4), { sublabel: "grocer" }),
          rankedRow("B13", 3, "Brand Delta", v(-3), { sublabel: "gym" }),
          rankedRow("B14", 4, "Brand Epsilon", v(-7), { sublabel: "fast food" }),
          rankedRow("B15", null, "Brand Zeta", none("not_scored"), { sublabel: "bank" }),
        ],
      },
    ],
    caption: "Venue-goer taste signals, not residents or census.",
  },
};

// Slate · sponsor fit (A07 figure 1) ------------------------------------------------------------------

type SlateEntryFixture = NonNullable<DatasetOf<"Slate">["payload"]["rows"][number]["best"]>;

const entry = (ref: string, label: string, fit: number, popularity: number, utr = false): SlateEntryFixture => ({
  ref: ref as SlateEntryFixture["ref"],
  label,
  fit: v(fit),
  popularity,
  utr,
  topMarkets: [
    { market: "nashville", label: "Nashville", delta: 0.04 },
    { market: "austin", label: "Austin", delta: 0.02 },
  ],
});

/** The fixed SLATE caption (PLAN S10). */
export const SLATE_CAPTION = "Taste fit only; no fee, availability or ROI data.";

export const sponsorSlate: DatasetOf<"Slate"> = {
  id: "D6",
  kind: "Slate",
  title: "Sponsor slate",
  evidenceIds: ["E4"],
  formulaIds: ["slate.best_fit", "slate.under_the_radar"],
  payload: {
    seed: { ref: "R1", label: "The Velvet Lanterns" },
    rows: [
      { category: "spirits", label: "Whiskey", best: entry("R12", "Blackfern Rye", 0.77, 0.53), runnerUp: null, reason: null },
      { category: "beer", label: "Beer", best: entry("R11", "Granite Hollow Ale", 0.86, 0.18, true), runnerUp: null, reason: null },
      { category: "auto", label: "Trucks", best: entry("R13", "Ironwood Trucks", 0.68, 0.87), runnerUp: null, reason: null },
      {
        category: "apparel_footwear",
        label: "Boots & apparel",
        best: entry("R14", "Saddlebrook Boots", 0.63, 0.66),
        runnerUp: null,
        reason: null,
      },
      {
        category: "outdoor_sporting_retail",
        label: "Outdoor",
        best: entry("R15", "Northwind Outfitters", 0.74, 0.76),
        runnerUp: null,
        reason: null,
      },
      { category: "energy_drinks", label: "Energy drink", best: entry("R16", "Voltline", 0.45, 0.94), runnerUp: null, reason: null },
      { category: "fintech", label: "Fintech", best: null, runnerUp: null, reason: "budget_truncated" },
    ],
    markets: [
      { id: "nashville", label: "Nashville" },
      { id: "austin", label: "Austin" },
    ],
    caption: SLATE_CAPTION,
  },
};

// Bars · head-to-head split (A04 figure 1) ------------------------------------------------------------

type BarFixture = DatasetOf<"Bars">["payload"]["groups"][number]["bars"][number];

const bar = (key: string, label: string, values: ValueCell[], extra: Partial<BarFixture> = {}): BarFixture => ({
  key,
  label,
  tagRef: null,
  values,
  isNew: false,
  ranks: null,
  ...extra,
});

const pair = (a: number, b: number) => [v(a), v(b)];
const PAIR_SERIES = [axis("R1", "Juniper Cola", "R1"), axis("R2", "Brand Alpha", "R2")];

export const metroSplit: DatasetOf<"Bars"> = {
  id: "D7",
  kind: "Bars",
  title: "Share of taste by metro",
  evidenceIds: ["E2"],
  formulaIds: ["share.pct", "share.metros_won"],
  payload: {
    mode: "butterfly",
    comparator: "WITHIN_CALL",
    valueLabel: "Share of taste by metro",
    unit: "pct",
    series: PAIR_SERIES,
    groups: [
      {
        key: "metro",
        label: "Metro",
        family: null,
        bars: [
          bar("portland", "Portland", pair(0.66, 0.34)),
          bar("seattle", "Seattle", pair(0.57, 0.43)),
          bar("chicago", "Chicago", pair(0.51, 0.49)),
          bar("denver", "Denver", pair(0.46, 0.54)),
          bar("atlanta", "Atlanta", pair(0.4, 0.6)),
          bar("austin", "Austin", pair(0.33, 0.67)),
          bar("boston", "Boston", [v(0.64), none("dropped")]),
          bar("nashville", "Nashville", [none("not_measured"), none("not_measured")]),
        ],
      },
    ],
    method: null,
    domain: null,
    caption: null,
  },
};

// Bars · age index for two brands (A04 figure 2; head-to-head butterfly) ---------------------------------

const AGES = [
  ["24_and_younger", "≤24"],
  ["25_to_29", "25–29"],
  ["30_to_34", "30–34"],
  ["35_to_44", "35–44"],
  ["45_to_54", "45–54"],
  ["55_and_older", "55+"],
] as const;

/** dna.age_index runs from −1 (well below average) through 0 (average) to 1. */
export const ageIndexPair: DatasetOf<"Bars"> = {
  id: "D8",
  kind: "Bars",
  title: "Age index, two brands",
  evidenceIds: ["E5"],
  formulaIds: ["dna.age_index"],
  payload: {
    mode: "butterfly",
    comparator: "BASELINE",
    valueLabel: "Age index, −1 to 1",
    unit: "index",
    series: PAIR_SERIES,
    groups: [
      {
        key: "age",
        label: "Age",
        family: null,
        bars: [
          [0.18, -0.22],
          [0.36, -0.05],
          [0.21, 0.14],
          [-0.07, 0.29],
          [-0.24, 0.17],
          [-0.38, -0.02],
        ].map(([a, b], i) => bar(AGES[i]![0], AGES[i]![1], pair(a!, b!))),
      },
    ],
    method: null,
    domain: null,
    caption: null,
  },
};

// Bars · audience vs peers (A08 figure 1) -------------------------------------------------------------

export const agePeers: DatasetOf<"Bars"> = {
  id: "D9",
  kind: "Bars",
  title: "Audience DNA vs peers",
  evidenceIds: ["E5"],
  formulaIds: ["dna.age_index", "dna.gender_index"],
  payload: {
    mode: "butterfly",
    comparator: "BASELINE",
    valueLabel: "Affinity index, −1 to 1",
    unit: "index",
    series: [axis("R1", "Juniper Cola", "R1"), axis("peers", "Beverage peers, average of 6")],
    groups: [
      {
        key: "age",
        label: "Age",
        family: null,
        bars: [
          bar("24_and_younger", "≤24", pair(0.18, 0.1)),
          bar("25_to_29", "25–29", pair(0.36, 0.12)),
          bar("30_to_34", "30–34", pair(0.21, 0.08)),
          bar("35_to_44", "35–44", pair(-0.07, 0.02)),
          bar("45_to_54", "45–54", pair(-0.24, -0.06)),
          bar("55_and_older", "55+", [none("not_measured"), v(-0.11)]),
        ],
      },
      {
        key: "gender",
        label: "Gender",
        family: null,
        bars: [bar("female", "Women", pair(0.14, 0.05)), bar("male", "Men", pair(-0.14, -0.05))],
      },
    ],
    method: null,
    domain: null,
    caption: null,
  },
};

// Bars · Block DNA, deltas vs the city (diverging) ------------------------------------------------------

export const blockDna: DatasetOf<"Bars"> = {
  id: "D10",
  kind: "Bars",
  title: "Block DNA",
  evidenceIds: ["E6"],
  formulaIds: ["block.rank_delta", "block.new_tag"],
  payload: {
    mode: "diverging",
    comparator: "CITY",
    valueLabel: "Tag rank gain vs the city",
    unit: "delta",
    series: [axis("riverside", "Riverside District")],
    groups: [
      {
        key: "WHO",
        label: "Venue-goer taste tags",
        family: "WHO",
        bars: [
          bar("T21", "Natural wine", [v(14)], { isNew: true, ranks: { subject: 3, comparator: 17 } }),
          bar("T22", "Vinyl listening", [v(9)], { ranks: { subject: 5, comparator: 14 } }),
          bar("T23", "Late-night tacos", [v(6)], { ranks: { subject: 4, comparator: 10 } }),
          bar("T24", "Sports bars", [v(-8)], { ranks: { subject: 19, comparator: 11 } }),
        ],
      },
      {
        key: "VIBE",
        label: "Vibe",
        family: "VIBE",
        bars: [
          bar("T25", "Live music", [v(11)], { isNew: true, ranks: { subject: 2, comparator: 13 } }),
          bar("T26", "Cozy", [v(7)], { ranks: { subject: 6, comparator: 13 } }),
          bar("T27", "Upscale", [v(-5)], { ranks: { subject: 15, comparator: 10 } }),
        ],
      },
      {
        key: "WHAT",
        label: "What",
        family: "WHAT",
        bars: [
          bar("T28", "Small plates", [v(5)], { ranks: { subject: 7, comparator: 12 } }),
          bar("T29", "Chain dining", [v(-12)], { ranks: { subject: 20, comparator: 8 } }),
          bar("T30", "Brunch", [none("not_scored")], { ranks: { subject: null, comparator: 9 } }),
        ],
      },
    ],
    method: "POLYGON",
    domain: null,
    caption: "Venue-goer taste signals, not residents or census.",
  },
};

// Quadrant · fit vs popularity (A07 figure 2) ----------------------------------------------------------

const X_SPLIT = 0.5;
const Y_SPLIT = 0.55;

function quadrantOf(x: number, y: number): QuadrantName {
  if (y >= Y_SPLIT) return x >= X_SPLIT ? "HEARTLAND" : "HIDDEN_POCKET";
  return x >= X_SPLIT ? "MASS" : "COLD";
}

const point = (
  key: string,
  label: string,
  x: number,
  y: number,
  extra: Partial<QuadrantPoint> = {},
): QuadrantPoint => ({
  key,
  label,
  ref: null,
  x,
  y,
  quadrant: quadrantOf(x, y),
  score: null,
  labelled: false,
  group: null,
  utr: false,
  geo: null,
  ...extra,
});

/** A small linear congruential generator, so the invented scatter is the same on every run. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

// Grey candidates (x popularity, y fit): generated from a fixed seed, not traced from any design.
const nextCandidate = lcg(7177);
const round2 = (value: number) => Math.round(value * 100) / 100;
const CANDIDATES: readonly (readonly [number, number])[] = Array.from(
  { length: 24 },
  () => [round2(0.04 + 0.92 * nextCandidate()), round2(0.2 + 0.5 * nextCandidate())] as const,
);

export const sponsorQuadrant: DatasetOf<"Quadrant"> = {
  id: "D11",
  kind: "Quadrant",
  title: "Fit against popularity",
  evidenceIds: ["E4", "E7"],
  formulaIds: ["slate.under_the_radar", "trvl.quadrant"],
  payload: {
    xLabel: "Popularity",
    yLabel: "Fit",
    xUnit: "popularity",
    yUnit: "pct",
    xSplit: X_SPLIT,
    ySplit: Y_SPLIT,
    quadrantLabels: {
      HEARTLAND: "Priced in",
      HIDDEN_POCKET: "Under the radar",
      MASS: "Famous · poor fit",
      COLD: "Weak fit · niche",
    },
    points: [
      ...CANDIDATES.map(([x, y], i) => point(`C${i + 1}`, `Candidate ${String(i + 1).padStart(2, "0")}`, x, y)),
      point("R11", "Granite Hollow Ale", 0.18, 0.86, { labelled: true, utr: true, group: "Beer" }),
      point("R12", "Blackfern Rye", 0.53, 0.77, { labelled: true, group: "Whiskey" }),
      point("R15", "Northwind Outfitters", 0.76, 0.74, { labelled: true, group: "Outdoor" }),
      point("R13", "Ironwood Trucks", 0.87, 0.68, { labelled: true, group: "Trucks" }),
      point("R14", "Saddlebrook Boots", 0.66, 0.63, { labelled: true, group: "Boots & apparel" }),
      point("R16", "Voltline", 0.94, 0.45, { labelled: true, group: "Energy drink" }),
    ],
    omitted: [
      { label: "Brand Kappa", ref: null, reason: "quality_gate" },
      { label: "Brand Lambda", ref: null, reason: "dropped" },
    ],
    belts: [],
    inset: null,
    caption: SLATE_CAPTION,
  },
};

// Scorecard · priors (A05 conviction) -------------------------------------------------------------------

export const priorsScorecard: DatasetOf<"Scorecard"> = {
  id: "D12",
  kind: "Scorecard",
  title: "Hypothesis scorecard",
  evidenceIds: ["E1", "E5", "E3", "E8"],
  formulaIds: [],
  payload: {
    rows: [
      {
        hypothesisId: "H1",
        statement: "competes with Brand Alpha and Brand Beta.",
        expectation: "Both rivals rank in its three nearest audiences.",
        testTool: "peer_landscape",
        verdict: "REFUTED",
        metricIds: ["M1", "M2"],
        evidenceIds: ["E1"],
        note: "the nearest audience is Kettle Ridge Tonic at {{M1}}; Brand Beta reaches {{M2}}, sixth.[E1]",
      },
      {
        hypothesisId: "H2",
        statement: "skews younger than its category.",
        expectation: "Youth tilt above the category median.",
        testTool: "audience_dna",
        verdict: "CONFIRMED",
        metricIds: ["M3"],
        evidenceIds: ["E5"],
        note: "youth tilt {{M3}} vs the category median.[E5]",
      },
      {
        hypothesisId: "H3",
        statement: "its cultural home is indie folk.",
        expectation: "Folk tags lead the music neighbourhood.",
        testTool: "cross_domain",
        verdict: "REFUTED",
        metricIds: ["M4"],
        evidenceIds: ["E3"],
        note: "dream pop and alt-country lead; folk holds {{M4}} of the top ten.[E3]",
      },
      {
        hypothesisId: "H4",
        statement: "momentum rising through the year.",
        expectation: "A rising trend in the trending window.",
        testTool: "momentum",
        verdict: "INCONCLUSIVE",
        metricIds: ["M5"],
        evidenceIds: ["E8"],
        note: "momentum reads {{M5}} across {{WINDOW}}; no signal after the window.[E8]",
      },
    ],
  },
};

// Optional contract fields: codes, comparison rows and a payload that says how to draw itself ---------

/** The similarity map with its own short codes (AxisItem.code), which MatrixGrid prints instead of derived ones. */
export const codedSimilarityMap: DatasetOf<"Matrix"> = {
  ...similarityMap,
  id: "D22",
  payload: {
    ...similarityMap.payload,
    rows: similarityMap.payload.rows.map((r, i) => ({ ...r, code: ["JNP", "ALF", "BET", "SLT", "KRT", "GHA"][i] })),
    cols: similarityMap.payload.cols.map((c, i) => ({ ...c, code: ["JNP", "ALF", "BET", "SLT", "KRT", "GHA"][i] })),
  },
};

/** Nearest audiences with the expected rivals marked in the payload (RankedRow.comparison), not by the caller. */
export const nearestWithRivals: DatasetOf<"Ranked"> = {
  ...nearestAudiences,
  id: "D23",
  payload: {
    ...nearestAudiences.payload,
    groups: nearestAudiences.payload.groups.map((g) => ({
      ...g,
      rows: g.rows.map((r) => ((EXPECTED_RIVALS as readonly string[]).includes(r.key) ? { ...r, comparison: true } : r)),
    })),
  },
};

/** The metro split that names its own display, baseline and even band (BarsPayload.display, baseline, evenBand). */
export const metroSplitSelfDescribed: DatasetOf<"Bars"> = {
  ...metroSplit,
  id: "D24",
  payload: { ...metroSplit.payload, display: "split", baseline: 0.5, evenBand: 0.03 },
};

/** The age pair as a dumbbell around 0, said by the payload. */
export const ageDumbbellSelfDescribed: DatasetOf<"Bars"> = {
  ...ageIndexPair,
  id: "D25",
  payload: { ...ageIndexPair.payload, display: "dumbbell", baseline: 0 },
};

// Cultural neighbourhood of two seeds (S9 in P1), a Ranked payload ---------------------------------------

type DomainKey = "artist" | "podcast" | "tv_show" | "movie" | "brand";

/** The two seeds at the centre of the constellation, by the refs their edges name. */
export const NEIGHBOURHOOD_SEEDS = [
  { ref: "R1", label: "Juniper Cola" },
  { ref: "R5", label: "Kettle Ridge Tonic" },
] as const;

/** The S9 halo: top tags per domain, printed under each domain name. */
export const NEIGHBOURHOOD_HALO: Readonly<Record<string, readonly string[]>> = {
  artist: ["indie folk", "slowcore", "americana"],
  podcast: ["slow radio", "food culture"],
  tv_show: ["quiet drama", "coastal"],
  brand: ["outdoor", "clean beauty"],
};

/**
 * A result as S9 writes it: FIT, popularity and U = FIT − popularity, the two seeds' explainability
 * shares, and an edge to a seed whose share·K reaches 1.1 (K = 2, so a share of at least .55).
 */
const neighbour = (
  domain: DomainKey,
  rank: number,
  label: string,
  fit: number,
  popularity: number,
  shares: readonly [number, number],
  utr = false,
): RankedRowFixture => {
  const seedShares = NEIGHBOURHOOD_SEEDS.map((s, i) => ({ seedRef: s.ref, share: shares[i]! }));
  return rankedRow(`${domain}-${rank}`, rank, label, v(fit), {
    type: domain,
    cells: [v(fit), v(popularity), v(round2(fit - popularity))],
    flags: utr ? ["UTR"] : [],
    explain: seedShares.filter((s) => s.share * seedShares.length >= 1.1),
    shares: seedShares,
  });
};

const XDOM_COLUMNS: DatasetOf<"Ranked">["payload"]["columns"] = [
  { key: "fit", label: "Fit", unit: "pct", comparator: "WITHIN_CALL" },
  { key: "popularity", label: "Popularity", unit: "popularity", comparator: null },
  { key: "utr", label: "Under the radar (fit − popularity)", unit: "score", comparator: null },
];

export const neighbourhood: DatasetOf<"Ranked"> = {
  id: "D26",
  kind: "Ranked",
  title: "Cultural neighbourhood · Juniper Cola and Kettle Ridge Tonic",
  evidenceIds: ["E7"],
  formulaIds: ["xdom.under_the_radar", "xdom.edge"],
  payload: {
    columns: XDOM_COLUMNS,
    groups: [
      {
        key: "artist",
        label: "Music · artists",
        rows: [
          neighbour("artist", 1, "Low Orchard", 1, 0.62, [0.52, 0.48]),
          neighbour("artist", 2, "Marigold Static", 0.93, 0.41, [0.71, 0.29]),
          neighbour("artist", 3, "Saint Ferro", 0.86, 0.18, [0.36, 0.64], true),
          neighbour("artist", 4, "Harbor & Pine", 0.79, 0.55, [0.5, 0.5]),
          neighbour("artist", 5, "The Copper Wires", 0.71, 0.33, [0.58, 0.42]),
          neighbour("artist", 6, "Nadia Vell", 0.64, 0.12, [0.47, 0.53]),
          neighbour("artist", 7, "Glass Meridian", 0.57, 0.47, [0.61, 0.39]),
        ],
      },
      {
        key: "podcast",
        label: "Podcasts",
        rows: [
          neighbour("podcast", 1, "Field Notes Weekly", 1, 0.58, [0.56, 0.44]),
          neighbour("podcast", 2, "The Long Table", 0.93, 0.22, [0.44, 0.56], true),
          neighbour("podcast", 3, "Quiet Hours", 0.86, 0.47, [0.5, 0.5]),
          neighbour("podcast", 4, "Small Print Radio", 0.79, 0.31, [0.62, 0.38]),
          neighbour("podcast", 5, "Northbound", 0.71, 0.09, [0.48, 0.52]),
          neighbour("podcast", 6, "Tin Roof Talks", 0.64, 0.38, [0.39, 0.61]),
          neighbour("podcast", 7, "Ledger & Lamp", 0.57, 0.26, [0.53, 0.47]),
        ],
      },
      {
        key: "tv_show",
        label: "TV · series",
        rows: [
          neighbour("tv_show", 1, "Harbor Lights", 1, 0.71, [0.66, 0.34]),
          neighbour("tv_show", 2, "The Night Kitchen", 0.93, 0.64, [0.51, 0.49]),
          neighbour("tv_show", 3, "Westerly", 0.86, 0.66, [0.43, 0.57]),
          rankedRow("tv_show-4", null, "Paper Moons", none("quality_gate"), {
            type: "tv_show",
            cells: [none("quality_gate"), none("quality_gate"), none("quality_gate")],
          }),
          neighbour("tv_show", 5, "Slow Tide", 0.79, 0.44, [0.6, 0.4]),
          neighbour("tv_show", 6, "Coastline Diaries", 0.71, 0.52, [0.49, 0.51]),
          neighbour("tv_show", 7, "Ironwood", 0.64, 0.61, [0.5, 0.5]),
        ],
      },
      {
        key: "movie",
        label: "Movies",
        rows: [
          rankedRow("movie-gap", null, "Not measured", none("budget_truncated"), {
            type: "movie",
            sublabel: "call not made: run budget reached",
            cells: [none("budget_truncated"), none("budget_truncated"), none("budget_truncated")],
          }),
        ],
      },
      {
        key: "brand",
        label: "Brands",
        rows: [
          neighbour("brand", 1, "Northwind Outfitters", 1, 0.49, [0.7, 0.3]),
          neighbour("brand", 2, "Fernleaf Apothecary", 0.93, 0.27, [0.35, 0.65], true),
          neighbour("brand", 3, "Pale Harbor", 0.86, 0.52, [0.5, 0.5]),
          neighbour("brand", 4, "Stonecrop Goods", 0.79, 0.16, [0.57, 0.43]),
          neighbour("brand", 5, "Driftline", 0.71, 0.38, [0.46, 0.54]),
          neighbour("brand", 6, "Thistle & Sons", 0.64, 0.08, [0.52, 0.48]),
          neighbour("brand", 7, "Copperline Coffee", 0.57, 0.31, [0.4, 0.6]),
        ],
      },
    ],
    caption:
      "FIT is the within-call percentile in each domain; popularity capped at 0.75; under the radar = FIT − popularity, not price. Explainability is attribution inside Qloo's model, not causation.",
  },
};

/** Display text and footnotes for the scorecard prose. */
export const SCORECARD_BINDINGS: ProseBindings = {
  metrics: {
    M1: { display: "0.47" },
    M2: { display: "0.29" },
    M3: { display: "+0.19" },
    M4: { display: "2" },
    M5: { display: "flat" },
  },
  footnotes: { E1: 3, E5: 4, E3: 5, E8: 6 },
  window: "Mar–Aug 2026",
};

// TasteMap · Category Taste Map (classical MDS of the Substitution Map) ----------------------------------

const TASTE_POINT = (key: string, label: string, x: number, y: number, hub: number | null, target = false) =>
  ({ key, label, ref: key, x, y, hub, target }) as DatasetOf<"TasteMap">["payload"]["points"][number];

export const tasteMap: DatasetOf<"TasteMap"> = {
  id: "D30",
  kind: "TasteMap",
  title: "Category Taste Map · Juniper Cola",
  evidenceIds: ["E1"],
  formulaIds: ["taste_map_mds", "subs.similarity", "subs.hub"],
  payload: {
    source: "substitution_map",
    points: [
      TASTE_POINT("R1", "Juniper Cola", -0.21, 0.08, null, true),
      TASTE_POINT("R2", "Brand Alpha", -0.12, 0.11, 0.8),
      TASTE_POINT("R3", "Brand Beta", -0.09, -0.02, 0.65),
      TASTE_POINT("R4", "Saltmarsh Seltzer", 0.14, 0.12, 0.35),
      TASTE_POINT("R5", "Kettle Ridge Tonic", 0.1, -0.13, 0.5),
      TASTE_POINT("R6", "Granite Hollow Ale", 0.18, -0.16, 0.2),
    ],
    k: 6,
    stress: 0.07,
    explained: 0.82,
    imputedPairs: [["R4", "R6"]],
    omitted: [{ label: "Brand Kappa", ref: null, reason: "dropped" }],
    method:
      "Classical MDS of 1 − audience taste similarity over 6 entities; 1 unscored pair set to the largest scored distance. Nearby points share audience taste; the axes have no meaning.",
  },
};

/** Three entities: listed, never drawn as a map. */
export const tasteMapThree: DatasetOf<"TasteMap"> = {
  ...tasteMap,
  id: "D31",
  payload: {
    ...tasteMap.payload,
    source: "screener",
    points: tasteMap.payload.points.slice(0, 3).map((p) => ({ ...p, ref: null })),
    k: 3,
    stress: 0,
    explained: 1,
    imputedPairs: [],
    omitted: [],
    method: "Classical MDS of 1 − audience taste similarity over 3 entities. Nearby points share audience taste; the axes have no meaning.",
  },
};

/**
 * Invented source lines. The request ids are plainly synthetic counters ("0001…f001"), so no
 * abbreviation can match a Qloo request id or one shown in the design exports.
 */
export const FIXTURE_SOURCES: Readonly<Record<string, FigureSource>> = {
  insights: { text: "Source: Qloo /v2/insights · 8 requests", requestId: "0001aaaa0000f001", href: "#sources" },
  pairs: { text: "Source: Qloo · 15 pairs", requestId: "0002bbbb0000f002", href: "#sources" },
  computed: {
    text: "Source: Qloo /v2/insights · 8 requests · lead computed in code",
    requestId: "0003cccc0000f003",
    href: null,
  },
  demographics: {
    text: "Source: Qloo /v2/insights · demographics · 7 requests · computed in code",
    requestId: "0004dddd0000f004",
    href: null,
  },
  slate: { text: "Source: Qloo /v2/insights · 12 requests · fit computed in code", requestId: "0005eeee0000f005", href: null },
  scatter: {
    text: "Source: Qloo /v2/insights + entity popularity · 12 requests · computed in code",
    requestId: "0006ffff0000f006",
    href: null,
  },
  brands: { text: "Source: Qloo /v2/insights · brands · 1 request", requestId: "0007abab0000f007", href: null },
  heatmap: {
    text: "Source: Qloo /v2/insights · heatmap ← Austin · 2 maps + places sample · lift computed in code",
    requestId: "0008acac0000f008",
    href: null,
  },
  trending: { text: "Source: Qloo /v2/trending · 4 requests · trend computed in code", requestId: "0009bdbd0000f009", href: null },
  tenant: { text: "Source: Qloo /v2/insights · brands at the site and in the city · 2 requests · computed in code", requestId: "0001aaaa0000f001", href: null },
  position: { text: "Source: Culture Terminal analysis · five metrics from four exhibits", requestId: null, href: null },
  neighbourhood: {
    text: "Source: Qloo /v2/insights · 4 domains with explainability · 4 requests · edges computed in code",
    requestId: "0002abab0000f002",
    href: null,
  },
  priors: { text: "Source: the AI's expectations, recorded before any data", requestId: null, href: null },
  tasteMap: { text: "Source: Qloo /v2/insights · 5 requests · map computed in code", requestId: "0001aaaa0000f001", href: null },
};

/** Every fixture envelope, for schema tests. */
export const ALL_FIXTURES = [
  similarityMap,
  annotatedSimilarityMap,
  shareGrid,
  nearestAudiences,
  domainLists,
  marginBrands,
  areaBrandShifts,
  sponsorSlate,
  metroSplit,
  ageIndexPair,
  agePeers,
  blockDna,
  sponsorQuadrant,
  priorsScorecard,
  austinLiftMap,
  coarseLiftMap,
  tenantSlope,
  marketSlope,
  momentumStrip,
  tastePosition,
  tastePositionNoSignal,
  codedSimilarityMap,
  nearestWithRivals,
  metroSplitSelfDescribed,
  ageDumbbellSelfDescribed,
  neighbourhood,
  tasteMap,
  tasteMapThree,
  standingLiftMap,
  supplyAreas,
] as const;
