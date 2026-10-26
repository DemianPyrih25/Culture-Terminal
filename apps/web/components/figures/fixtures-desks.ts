import type { DatasetOf, MomentumPoint, SlopeLine, SlopePoint } from "@ct/contracts";

/**
 * Invented fixtures for the Part 5 families (D29): the tenant slope and a market-alignment slope
 * (SlopeChart), a momentum strip (MomentumStrip) and a Taste Position card (PositionCard). Every
 * brand, venue and number is made up; the arithmetic follows the formulas each one cites, so the
 * fixtures read like real output. Each parses with the DatasetEnvelope schema of @ct/contracts.
 */

// Slope · tenant fit, city → site (S8) ---------------------------------------------------------------

/** Within-call percentile of rank k among n: 1 at rank 1, 0 at rank n. */
const pctOfRank = (rank: number, n: number) => (n - rank) / (n - 1);
const point = (rank: number, n: number): SlopePoint => ({ value: pctOfRank(rank, n), reason: null, rank });
const tenantFit = (site: number, shift: number) => Math.round(100 * (0.6 * site + 0.4 * Math.min(1, Math.max(0, shift + 0.5))) * 10) / 10;

/** [ref, name, rank in the city, rank at the site], 9 ranked in both. */
type Ref = `R${number}`;
const TENANTS: readonly [Ref, string, number, number][] = [
  ["R21", "Night Heron Wine Bar", 4, 1],
  ["R22", "Low Tide Records", 7, 2],
  ["R23", "Copper Kettle Coffee", 5, 3],
  ["R24", "Fern & Vine Bakery", 1, 4],
  ["R25", "Quiet Hours Books", 8, 5],
  ["R26", "Tin Lantern Taqueria", 6, 6],
  ["R27", "Ember Oven Pizza", 9, 7],
  ["R28", "Halcyon Burgers", 3, 8],
  ["R29", "Granite Outfitters", 2, 9],
];
const CLIMBERS: ReadonlySet<string> = new Set(["R22", "R21", "R25"]);

const tenantLines: SlopeLine[] = [
  ...TENANTS.map(([ref, label, city, site]): SlopeLine => {
    const c = pctOfRank(city, 9);
    const s = pctOfRank(site, 9);
    return {
      key: ref,
      label,
      ref,
      points: [point(city, 9), point(site, 9)],
      delta: s - c,
      highlight: CLIMBERS.has(ref),
      score: tenantFit(s, s - c),
    };
  }),
  {
    key: "R30",
    label: "Saltmarsh Seltzer Bar",
    ref: "R30",
    points: [
      { value: null, reason: "not_scored", rank: null },
      { value: null, reason: "not_scored", rank: null },
    ],
    delta: null,
    highlight: false,
    score: null,
  },
];

export const tenantSlope: DatasetOf<"Slope"> = {
  id: "D17",
  kind: "Slope",
  title: "Tenant fit · East Cesar Chavez vs Austin",
  evidenceIds: ["E12"],
  formulaIds: ["tenant.fit", "tenant.rank_shift", "pct.within_call"],
  payload: {
    axes: [
      { key: "city", label: "Austin" },
      { key: "site", label: "East Cesar Chavez" },
    ],
    scale: "pct",
    comparator: "CITY",
    valueLabel: "FIT among the 9 brands ranked at both the site and the city",
    scoreLabel: "Tenant fit (0–100)",
    lines: tenantLines,
  },
};

// Slope · sponsor market alignment, national → two metros ------------------------------------------

/** [ref, name, national rank of 6, Nashville rank of 6, Austin rank of 5 or null when dropped]. */
const MARKETS: readonly [Ref, string, number, number, number | null][] = [
  ["R6", "Granite Hollow Ale", 1, 2, 3],
  ["R5", "Kettle Ridge Tonic", 2, 1, 2],
  ["R4", "Saltmarsh Seltzer", 3, 5, 4],
  ["R8", "Tidewell Water", 4, 6, 5],
  ["R9", "Ember Root Beer", 5, 4, null],
  ["R7", "Larkspur Kombucha", 6, 3, 1],
];

export const marketSlope: DatasetOf<"Slope"> = {
  id: "D18",
  kind: "Slope",
  title: "Sponsor market alignment · The Velvet Lanterns",
  evidenceIds: ["E4"],
  formulaIds: ["slate.market_alignment", "pct.within_call"],
  payload: {
    axes: [
      { key: "national", label: "National" },
      { key: "nashville", label: "Nashville" },
      { key: "austin", label: "Austin" },
    ],
    scale: "pct",
    comparator: "WITHIN_CALL",
    valueLabel: "FIT within each market's call, re-ranked over the slate",
    scoreLabel: null,
    lines: MARKETS.map(([ref, label, national, nashville, austin]): SlopeLine => {
      const first = pctOfRank(national, 6);
      const last = austin === null ? null : pctOfRank(austin, 5);
      return {
        key: ref,
        label,
        ref,
        points: [point(national, 6), point(nashville, 6), austin === null ? { value: null, reason: "dropped", rank: null } : point(austin, 5)],
        delta: last === null ? null : last - first,
        // Climbers only: a gain of more than .30 from national to Austin (Larkspur Kombucha).
        highlight: last !== null && last - first > 0.3,
        score: null,
      };
    }),
  },
};

// Momentum · weekly percentiles over the trending window (S4) ----------------------------------------

export const MOMENTUM_WINDOW = { start: "2026-03-02", end: "2026-08-30" } as const;

/** The ISO-week start dates of the window: 26 Mondays from 2 March 2026. */
const WEEKS: readonly string[] = Array.from({ length: 26 }, (_, i) => {
  const d = new Date(Date.UTC(2026, 2, 2 + 7 * i));
  return d.toISOString().slice(0, 10);
});

/** A step-shaped series: each [weeks, value] holds for that many weeks. */
function steps(plan: readonly (readonly [number, number])[], from = 0, clippedAt: readonly number[] = []): MomentumPoint[] {
  const values = plan.flatMap(([n, value]) => Array.from({ length: n }, () => value));
  return values.map((pct, i) => ({ date: WEEKS[from + i]!, pct, clipped: clippedAt.includes(i) }));
}

export const momentumStrip: DatasetOf<"Momentum"> = {
  id: "D19",
  kind: "Momentum",
  title: "Momentum · Juniper Cola and peers",
  evidenceIds: ["E8"],
  formulaIds: ["mom.delta_26w", "mom.mann_kendall", "mom.label", "mom.freshness"],
  payload: {
    window: MOMENTUM_WINDOW,
    badgeText: `HISTORICAL · QLOO TRENDING · ${MOMENTUM_WINDOW.start}..${MOMENTUM_WINDOW.end}`,
    badge: "STALE",
    series: [
      {
        ref: "R1",
        label: "Juniper Cola",
        type: "brand",
        state: "ok",
        reason: null,
        trend: "rising",
        points: steps(
          [
            [3, 0.62],
            [2, 0.64],
            [3, 0.66],
            [2, 0.65],
            [2, 0.69],
            [1, 0.88],
            [3, 0.72],
            [2, 0.74],
            [3, 0.77],
            [2, 0.79],
            [3, 0.81],
          ],
          0,
          [12],
        ),
        delta26w: 0.17,
        tau: 0.58,
        p: 0.001,
        peerRank: { rank: 1, of: 3 },
        scaleBreak: false,
      },
      {
        ref: "R2",
        label: "Brand Alpha",
        type: "brand",
        state: "ok",
        reason: null,
        trend: "flat",
        points: steps([
          [4, 0.74],
          [3, 0.75],
          [3, 0.73],
          [4, 0.74],
          [3, 0.76],
          [3, 0.74],
          [3, 0.73],
          [3, 0.75],
        ]),
        delta26w: 0.01,
        tau: 0.08,
        p: 0.61,
        peerRank: { rank: 2, of: 3 },
        scaleBreak: false,
      },
      {
        ref: "R3",
        label: "Brand Beta",
        type: "brand",
        state: "ok",
        reason: null,
        trend: "declining",
        // After a scale break only the latest segment is kept: the series starts in week 9.
        points: steps(
          [
            [3, 0.69],
            [2, 0.67],
            [3, 0.64],
            [2, 0.62],
            [3, 0.59],
            [2, 0.57],
            [3, 0.55],
          ],
          8,
        ),
        delta26w: -0.12,
        tau: -0.49,
        p: 0.004,
        peerRank: { rank: 3, of: 3 },
        scaleBreak: true,
      },
      {
        ref: "R4",
        label: "Saltmarsh Seltzer",
        type: "brand",
        state: "no_signal",
        reason: "no_signal",
        trend: null,
        // A flat placeholder: drawn as NO SIGNAL, never as a flat line.
        points: steps([[26, 0.5]]),
        delta26w: null,
        tau: null,
        p: null,
        peerRank: null,
        scaleBreak: false,
      },
      {
        ref: "R11",
        label: "The Velvet Lanterns",
        type: "artist",
        state: "unavailable",
        reason: "unavailable",
        trend: null,
        points: [],
        delta26w: null,
        tau: null,
        p: null,
        peerRank: null,
        scaleBreak: false,
      },
    ],
  },
};

// Position · the Taste Position card (§5.4) ------------------------------------------------------------

export const tastePosition: DatasetOf<"Position"> = {
  id: "D20",
  kind: "Position",
  title: "Taste Position · Juniper Cola",
  evidenceIds: ["E1", "E2", "E5", "E8"],
  formulaIds: ["subs.distinctiveness", "share.youth_tilt", "share.metros_won", "mom.label"],
  payload: {
    subject: { ref: "R1", label: "Juniper Cola" },
    peerCount: 6,
    axes: [
      {
        axis: "distinctiveness",
        label: "Distinctiveness",
        display: "2 of 7",
        value: 0.53,
        reason: null,
        badge: "MEASURED",
        peerRank: { rank: 2, of: 7 },
        note: "nearest: Kettle Ridge Tonic",
        metricId: "M6",
        datasetId: "D1",
      },
      {
        axis: "reach",
        label: "Reach",
        display: "4 of 7",
        value: 0.71,
        reason: null,
        badge: "MEASURED",
        peerRank: { rank: 4, of: 7 },
        note: null,
        metricId: "M7",
        datasetId: null,
      },
      {
        axis: "next_gen_tilt",
        label: "Next-gen tilt",
        display: "1 of 7",
        value: 0.19,
        reason: null,
        badge: "DERIVED",
        peerRank: { rank: 1, of: 7 },
        note: "under-30 tilt +0.19 vs the category median",
        metricId: "M3",
        datasetId: "D8",
      },
      {
        axis: "metro_breadth",
        label: "Metro breadth",
        display: "wins 3 of 6",
        value: 3,
        reason: null,
        badge: "DERIVED",
        peerRank: null,
        note: "head-to-head metros against Brand Alpha",
        metricId: "M8",
        datasetId: "D7",
      },
      {
        axis: "momentum",
        label: "Momentum",
        display: "Rising",
        value: 0.17,
        reason: null,
        badge: "STALE",
        peerRank: { rank: 1, of: 3 },
        note: "Mar–Aug 2026; no signal after the window",
        metricId: "M5",
        datasetId: "D19",
      },
    ],
  },
};

/** The same card with momentum missing: no signal, badged UNAVAILABLE, never a score. */
export const tastePositionNoSignal: DatasetOf<"Position"> = {
  ...tastePosition,
  id: "D21",
  payload: {
    ...tastePosition.payload,
    axes: tastePosition.payload.axes.map((a) =>
      a.axis === "momentum"
        ? { ...a, display: "No signal", value: null, reason: "no_signal", badge: "UNAVAILABLE", peerRank: null, note: "too few weeks in the window" }
        : a,
    ),
  },
};
