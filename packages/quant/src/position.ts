import {
  PositionAxis,
  PositionPayload,
  type DatasetEnvelope,
  type DatasetId,
  type EntityRef,
  type EvidenceId,
  type Metric,
  type NoValueReason,
  type PeerRank,
  type PositionAxisRow,
  type TrendWindow,
} from "@ct/contracts";
import type { FormulaId } from "./formulas";
import { safeFullName } from "./skills/format";
import { competitionRanks } from "./stats";

/**
 * The Taste Position card (SPEC §5.4, D14): five axes read off the run's ledger for one subject,
 * each with its peer rank and a link to its exhibit, and never a total. An axis whose metric the
 * run did not compute, or computed without a value, is UNAVAILABLE with the reason: the card shows
 * what was measured and says what was not, so nothing on it is estimated or invented.
 *
 * - distinctiveness: S1 subs.distinctiveness, its rank among the map, and the nearest peer;
 * - reach: the subject's popularity metric, ranked against the map's members by popularity;
 * - next_gen_tilt: S2 share.youth_tilt, else S3 dna.youth_index, ranked within its own call;
 * - metro_breadth: S2 share.metros_won ("wins K of M"), ranked within its own call;
 * - momentum: S4 mom.label (STALE), ranked by mom.delta_26w across the run's frozen window.
 */

export interface PositionEntity {
  ref: EntityRef;
  label: string;
  /** Global popularity percentile from resolution or discovery; null when Qloo gave none. */
  popularity: number | null;
}

export interface PositionInput {
  subject: PositionEntity;
  metrics: readonly Metric[];
  datasets: readonly DatasetEnvelope[];
  /** The run registry's view of another entity (a peer's name and popularity), or null. */
  entity: (ref: string) => PositionEntity | null;
  /**
   * Metric ids the note cites, in citation order. An axis reads its key's cited metric first, then
   * the first in the ledger, as the KPI strip does, so a run with two maps shows one rank in both.
   */
  cited?: readonly string[];
}

/** A Position dataset ready for the ledger (DatasetInput without its kind). */
export interface PositionDataset {
  title: string;
  evidenceIds: EvidenceId[];
  formulaIds: FormulaId[];
  payload: PositionPayload;
}

export const POSITION_AXIS_LABEL: Readonly<Record<PositionAxis, string>> = {
  distinctiveness: "Distinctiveness",
  reach: "Reach",
  next_gen_tilt: "Next-gen tilt",
  metro_breadth: "Metro breadth",
  momentum: "Momentum",
};

const NO_VALUE_TEXT: Partial<Record<NoValueReason, string>> = {
  no_signal: "no signal",
  not_scored: "not scored",
  dropped: "not scored",
  unavailable: "not available",
  budget_truncated: "cut by the budget",
  error: "call failed",
};

/** What an axis lacks when its skill did not run: the card's note under "not measured". */
const NOT_RUN_NOTE: Readonly<Record<PositionAxis, string>> = {
  distinctiveness: "no Substitution Map run",
  reach: "no traced popularity",
  next_gen_tilt: "no age reading run",
  metro_breadth: "no market grid run",
  momentum: "no trending read run",
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** A trending window as the brief prints it: "Apr–Sep 2025", or "Nov 2024–Feb 2025" across a year. */
function monthSpan(window: TrendWindow): string {
  const at = (iso: string) => {
    const [year, month] = iso.split("-").map(Number);
    const name = month === undefined ? undefined : MONTHS[month - 1];
    return year === undefined || !Number.isInteger(year) || name === undefined ? null : { year, name };
  };
  const start = at(window.start);
  const end = at(window.end);
  if (start === null || end === null) return `${window.start}–${window.end}`;
  if (start.year !== end.year) return `${start.name} ${start.year}–${end.name} ${end.year}`;
  return start.name === end.name ? `${end.name} ${end.year}` : `${start.name}–${end.name} ${end.year}`;
}

const evidenceKey = (m: Metric) => [...m.evidenceIds].sort().join(",");
const shares = (a: readonly string[], b: readonly string[]) => a.some((x) => b.includes(x));

/**
 * The metric of this key about the subject: the first the note cites, else the first with a value
 * (the KPI strip's order), else the last one (a measured gap).
 */
function subjectMetric(input: PositionInput, key: string, only = false): Metric | null {
  const ref = input.subject.ref;
  const own = input.metrics.filter((m) => m.key === key && m.subjectRefs[0] === ref && (!only || m.subjectRefs.length === 1));
  const valued = own.filter((m) => m.value !== null);
  const cited = input.cited ?? [];
  const citedFirst = valued
    .filter((m) => cited.includes(m.id))
    .sort((a, b) => cited.indexOf(a.id) - cited.indexOf(b.id))[0];
  return citedFirst ?? valued[0] ?? own.at(-1) ?? null;
}

/** "2 of 7" at the start of a display; a tie shown as 2.5 shares the better whole rank. */
export function parsePeerRank(display: string): PeerRank | null {
  const m = /^(\d+(?:\.\d+)?) of (\d+)\b/.exec(display.trim());
  if (m === null) return null;
  const rank = Math.floor(Number(m[1]));
  const of = Number(m[2]);
  return rank >= 1 && of >= rank ? { rank, of } : null;
}

/** The subject's competition rank (1 = highest) among the values, or null with fewer than two. */
function rankAmong(subject: number, others: readonly number[]): PeerRank | null {
  if (others.length === 0) return null;
  const values = [subject, ...others];
  return { rank: competitionRanks(values, "desc")[0] ?? 1, of: values.length };
}

/** The subject's rank among metrics of the same key from the same call, one per subject. */
function rankWithinCall(metric: Metric, metrics: readonly Metric[]): PeerRank | null {
  if (metric.value === null) return null;
  const key = evidenceKey(metric);
  const peers = new Map<string, number>();
  for (const m of metrics) {
    if (m === metric || m.key !== metric.key || m.value === null || evidenceKey(m) !== key) continue;
    const ref = m.subjectRefs[0];
    if (ref !== undefined && ref !== metric.subjectRefs[0]) peers.set(ref, m.value);
  }
  return rankAmong(metric.value, [...peers.values()]);
}

function datasetFor(datasets: readonly DatasetEnvelope[], metric: Metric | null, accept: (d: DatasetEnvelope) => boolean): DatasetEnvelope | null {
  if (metric === null) return null;
  return datasets.find((d) => accept(d) && shares(d.evidenceIds, metric.evidenceIds)) ?? null;
}

interface AxisParts {
  metric: Metric | null;
  /** Shown when the axis has a value; defaults to the peer rank, else the metric's display. */
  display?: string;
  peerRank: PeerRank | null;
  note: string | null;
  dataset: DatasetEnvelope | null;
}

function axisRow(axis: PositionAxis, parts: AxisParts): PositionAxisRow {
  const { metric, peerRank, note, dataset } = parts;
  const base = { axis, label: POSITION_AXIS_LABEL[axis], metricId: metric?.id ?? null, datasetId: (dataset?.id ?? null) as DatasetId | null };
  if (metric === null || metric.value === null) {
    const reason: NoValueReason = metric?.reason ?? "not_measured";
    const why = metric === null ? NOT_RUN_NOTE[axis] : note;
    return { ...base, display: NO_VALUE_TEXT[reason] ?? "not measured", value: null, reason, badge: "UNAVAILABLE", peerRank: null, note: why };
  }
  const display = parts.display ?? (peerRank === null ? metric.display : `${peerRank.rank} of ${peerRank.of}`);
  return { ...base, display: display || metric.display, value: metric.value, reason: null, badge: metric.badge, peerRank, note };
}

/** The map members besides the subject, from the Substitution Map behind the distinctiveness metric. */
function mapPeers(map: DatasetEnvelope | null, subject: string): string[] {
  if (map === null || map.kind !== "Matrix") return [];
  return map.payload.rows.flatMap((r) => (r.ref !== null && r.ref !== subject ? [r.ref] : []));
}

const isSubsMap = (d: DatasetEnvelope) => d.kind === "Matrix" && d.payload.mode === "similarity";

function distinctivenessAxis(input: PositionInput, metric: Metric | null, map: DatasetEnvelope | null): PositionAxisRow {
  const { subject, metrics } = input;
  const nearest =
    metric === null
      ? undefined
      : metrics
          .filter(
            (m) =>
              m.key === "subs.similarity" &&
              m.value !== null &&
              m.subjectRefs.length === 2 &&
              m.subjectRefs[0] === subject.ref &&
              shares(m.evidenceIds, metric.evidenceIds),
          )
          .reduce<Metric | undefined>((best, m) => (best === undefined || (m.value ?? 0) > (best.value ?? 0) ? m : best), undefined);
  const peer = nearest === undefined ? null : input.entity(nearest.subjectRefs[1] ?? "");
  return axisRow("distinctiveness", {
    metric,
    peerRank: metric === null || metric.value === null ? null : parsePeerRank(metric.display),
    note: peer === null ? null : `nearest: ${safeFullName(peer.label)}`,
    dataset: map,
  });
}

function reachAxis(input: PositionInput, map: DatasetEnvelope | null): PositionAxisRow {
  const { subject } = input;
  const metric = subjectMetric(input, "popularity", true);
  const others = mapPeers(map, subject.ref).flatMap((ref) => {
    const p = input.entity(ref)?.popularity;
    return p === null || p === undefined ? [] : [p];
  });
  const peerRank = metric?.value === null || metric?.value === undefined ? null : rankAmong(metric.value, others);
  return axisRow("reach", {
    metric,
    peerRank,
    note: "popularity, not fit",
    dataset: peerRank === null ? null : map,
  });
}

function nextGenAxis(input: PositionInput): PositionAxisRow {
  const { metrics, datasets } = input;
  const tilt = subjectMetric(input, "share.youth_tilt");
  const youth = subjectMetric(input, "dna.youth_index", true);
  const valued = [tilt, youth].find((m) => m !== null && m.value !== null);
  const metric = valued ?? tilt ?? youth;
  const fromShare = metric !== null && metric === tilt;
  const peers = fromShare ? metrics : metrics.filter((m) => m.subjectRefs.length === 1);
  return axisRow("next_gen_tilt", {
    metric,
    // The signed tilt itself ("+0.31"), the head of its display; the peer rank rides beside it.
    display: metric?.display.split(" · ")[0],
    peerRank: metric === null ? null : rankWithinCall(metric, peers),
    note: metric === null ? null : fromShare ? "young minus old" : "0 = average",
    dataset: datasetFor(datasets, metric, (d) => (fromShare ? d.kind === "Matrix" && d.payload.mode === "share" : d.kind === "Bars")),
  });
}

function metroAxis(input: PositionInput): PositionAxisRow {
  const { metrics, datasets } = input;
  const metric = subjectMetric(input, "share.metros_won");
  const [won = "", ...rest] = (metric?.display ?? "").split(" · ");
  return axisRow("metro_breadth", {
    metric,
    display: won,
    peerRank: metric === null ? null : rankWithinCall(metric, metrics),
    note: rest.length > 0 ? rest.join(" · ") : null,
    dataset: datasetFor(datasets, metric, (d) => d.kind === "Matrix" && d.payload.mode === "share"),
  });
}

function momentumAxis(input: PositionInput): PositionAxisRow {
  const { subject, metrics, datasets } = input;
  const metric = subjectMetric(input, "mom.label", true);
  // Every momentum metric reads the same frozen window, so the run's series rank against each other.
  const deltas = new Map<string, number>();
  for (const m of metrics) {
    const ref = m.subjectRefs[0];
    if (m.key === "mom.delta_26w" && m.value !== null && m.subjectRefs.length === 1 && ref !== undefined) deltas.set(ref, m.value);
  }
  const own = deltas.get(subject.ref);
  deltas.delete(subject.ref);
  const window = metric?.window ?? null;
  return axisRow("momentum", {
    metric,
    display: metric?.display,
    peerRank: metric === null || metric.value === null || own === undefined ? null : rankAmong(own, [...deltas.values()]),
    note: window === null ? null : `${monthSpan(window)} only`,
    dataset: datasetFor(datasets, metric, (d) => d.kind === "Momentum"),
  });
}

/**
 * The card for the subject, or null when no axis has a value (a card of five gaps says nothing the
 * limitations do not). Peer count is the Substitution Map's peers, else the largest ranked set.
 */
export function buildPosition(input: PositionInput): PositionDataset | null {
  const { subject, metrics, datasets } = input;
  const distinctiveness = subjectMetric(input, "subs.distinctiveness");
  const map = datasetFor(datasets, distinctiveness, isSubsMap);
  const axes = [
    distinctivenessAxis(input, distinctiveness, map),
    reachAxis(input, map),
    nextGenAxis(input),
    metroAxis(input),
    momentumAxis(input),
  ];
  if (axes.every((a) => a.value === null)) return null;

  const cited = axes.flatMap((a) => (a.metricId === null ? [] : (metrics.find((m) => m.id === a.metricId) ?? [])));
  const peerCount = map !== null ? mapPeers(map, subject.ref).length : Math.max(0, ...axes.map((a) => (a.peerRank?.of ?? 1) - 1));
  const payload = PositionPayload.parse({
    subject: { ref: subject.ref, label: safeFullName(subject.label) },
    peerCount,
    axes,
  });
  return {
    title: `Taste Position of ${safeFullName(subject.label)}`,
    evidenceIds: [...new Set(cited.flatMap((m) => m.evidenceIds))],
    formulaIds: [...new Set(cited.map((m) => m.formulaId as FormulaId))],
    payload,
  };
}
