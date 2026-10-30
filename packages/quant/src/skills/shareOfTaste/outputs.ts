import {
  AGE_BUCKET_LABEL,
  AgeBucket,
  type BarsPayload,
  type DigestRow,
  type EntityType,
  type EvidenceId,
  type MatrixPayload,
  type Metric,
  type NoValueReason,
} from "@ct/contracts";
import { isAboutLevelTilt, THIN_SAMPLE, type FormulaId } from "../../formulas";
import { emptyResultFinding, generationalSplitFinding, metroOutlierFinding } from "../../findings";
import { addSkillEvidence, addSkillMetric } from "../common";
import { fixed2, rankText, safeFullName, safeName } from "../format";
import type { ContextGroup } from "../rankCandidates/contexts";
import { callsOf, cellSummary, type GridRow, type ScoreGrid } from "../rankCandidates/scoring";
import {
  addDroppedFinding,
  addFindingDraft,
  count,
  pushMetric,
  rowFlags,
  signed2,
  unscoredText,
  type RankRun,
} from "../rankCandidates/shared";
import {
  bestAndWorst,
  medianTilt,
  metroOutliers,
  metroWins,
  pairSplit,
  youthTilts,
  type MetroOutlier,
  type MetroWins,
  type YouthTilts,
} from "./measures";

/**
 * What one share_of_taste call writes (SPEC §5.3 S2): an evidence bundle per context group, a
 * bounded metric set, the Share-of-Taste Matrix, the who-wins-where split for a pair, findings and
 * the digest rows. The first entity of the set is the subject: its best and worst contexts, metro
 * outliers and generational split are reported. Ranks hold within the set and context only.
 */

/** The subject's index in the set. */
export const SUBJECT = 0;

export type ShareGroup = Extract<ContextGroup, "AGE" | "GENDER" | "AUDIENCE" | "METRO">;
export const SHARE_GROUPS: readonly ShareGroup[] = ["AGE", "GENDER", "AUDIENCE", "METRO"];

const GROUP_WORD: Readonly<Record<ShareGroup, string>> = { AGE: "age", GENDER: "gender", AUDIENCE: "audience", METRO: "metro" };
const GROUP_LABEL: Readonly<Record<ShareGroup, string>> = { AGE: "Age", GENDER: "Gender", AUDIENCE: "Audience", METRO: "Metro" };

/** The who-wins-where split is drawn around an even split; this band reads as even (design A04). */
export const SPLIT_EVEN_BAND = 0.02;
/** Formula of the who-wins-where split for a pair. */
export const PAIR_SPLIT_FORMULA: FormulaId = "share.pair_split";

export type GroupEvidence = Readonly<Record<ShareGroup, EvidenceId | null>>;

const groupOf = (row: GridRow): ShareGroup => row.spec.group as ShareGroup;
const evidenceFor = (evidence: GroupEvidence, group: ShareGroup): EvidenceId[] => {
  const id = evidence[group];
  return id === null ? [] : [id];
};

/** One evidence bundle per context group that made a call, so each metric cites exactly the calls behind it. */
export function recordGroupEvidence(run: RankRun, grid: ScoreGrid, type: EntityType): GroupEvidence {
  const n = grid.candidates.length;
  const out: Record<ShareGroup, EvidenceId | null> = { AGE: null, GENDER: null, AUDIENCE: null, METRO: null };
  for (const group of SHARE_GROUPS) {
    const rows = grid.rows.filter((r) => r.spec.group === group);
    const calls = callsOf(rows);
    const word = GROUP_WORD[group];
    const evidence = addSkillEvidence(run.ctx.ledger, {
      skill: "share_of_taste",
      purpose: `Share-of-Taste by ${word} for ${count(n, type)}`,
      calls,
      status: rows.some((r) => r.gap !== null) ? "partial" : rows.every((r) => r.scored === 0) ? "empty" : "ok",
      summary: `${count(calls.length, `${word} context call`)} over ${count(n, type)}; ${cellSummary(rows)}.`,
      flags: rowFlags(rows),
    });
    if (evidence !== null) {
      out[group] = evidence.id;
      run.evidenceIds.push(evidence.id);
    }
  }
  return out;
}

export interface ShareMeasures {
  tilts: YouthTilts | null;
  wins: MetroWins | null;
  /** The subject's METRO_OUTLIER metros, better first. */
  outliers: MetroOutlier[];
  best: number | null;
  worst: number | null;
}

export function shareMeasures(grid: ScoreGrid): ShareMeasures {
  return { tilts: youthTilts(grid), wins: metroWins(grid), outliers: metroOutliers(grid, SUBJECT), ...bestAndWorst(grid, SUBJECT) };
}

/**
 * The subject's percentile gets a metric in at most this many contexts: all of them up to the cap,
 * else its best and worst halves of the cap among the scored ones. The Matrix holds every cell.
 */
export const SUBJECT_PCT_MAX = 10;

export interface ShareMetrics {
  /** The subject's percentile metric by grid row index; undefined for a row past the cap. */
  subjectPct: (Metric | undefined)[];
  /** Youth tilt per candidate; null when no tilt was computable for the call. */
  tilt: (Metric | null)[];
  /** Metros won per candidate; null without metro contexts. */
  metrosWon: (Metric | null)[];
}

function bucketLabels(rows: readonly GridRow[]): string {
  return rows.map((r) => AGE_BUCKET_LABEL[AgeBucket.parse(r.spec.subject)]).join(", ");
}

/**
 * The grid rows the subject gets a percentile metric for, best first: every row (unscored ones last,
 * explained) up to SUBJECT_PCT_MAX, else its scored rows within the cap. Past the cap the rows a
 * finding cites (`reserved`, the METRO_OUTLIER metros) are kept first, then the best and worst
 * scored rows fill the cap alternately, so every cited number has its metric.
 */
export function subjectPctRows(grid: ScoreGrid, reserved: readonly number[] = []): number[] {
  const scored = grid.rows
    .map((row, index) => ({ index, pct: row.cells[SUBJECT]?.pct ?? null, rank: row.cells[SUBJECT]?.rank ?? Number.POSITIVE_INFINITY }))
    .filter((r): r is { index: number; pct: number; rank: number } => r.pct !== null)
    .sort((a, b) => b.pct - a.pct || a.rank - b.rank || a.index - b.index)
    .map((r) => r.index);
  const unscored = grid.rows.map((_, index) => index).filter((index) => !scored.includes(index));
  const all = [...scored, ...unscored];
  if (all.length <= SUBJECT_PCT_MAX) return all;
  if (scored.length <= SUBJECT_PCT_MAX) return scored;
  const keep = new Set(reserved.filter((index) => scored.includes(index)).slice(0, SUBJECT_PCT_MAX));
  for (let lo = 0, hi = scored.length - 1; keep.size < SUBJECT_PCT_MAX && lo <= hi; lo++, hi--) {
    keep.add(scored[lo]!);
    if (keep.size < SUBJECT_PCT_MAX) keep.add(scored[hi]!);
  }
  return scored.filter((index) => keep.has(index));
}

/**
 * The S2 metric set. The subject gets its percentile per context, best first, so a KPI strip that
 * reads the first share.pct metrics shows its top contexts; then its youth tilt and metros won; then
 * every other member's tilt and metros won, so a pair compares like with like. At most
 * SUBJECT_PCT_MAX + 2·8 = 26 metrics, which keeps the largest input's digest within budget.
 */
export function addShareMetrics(run: RankRun, grid: ScoreGrid, m: ShareMeasures, evidence: GroupEvidence): ShareMetrics {
  const ledger = run.ctx.ledger;
  const subject = grid.candidates[SUBJECT]!;
  const subjectName = safeName(subject.name);

  const subjectPct: (Metric | undefined)[] = grid.rows.map(() => undefined);
  for (const index of subjectPctRows(grid, m.outliers.map((o) => grid.rows.indexOf(o.row)))) {
    const row = grid.rows[index]!;
    const cell = row.cells[SUBJECT];
    const tag = index === m.best ? " (best context)" : index === m.worst ? " (worst context)" : "";
    const group = groupOf(row);
    subjectPct[index] = pushMetric(
      run,
      addSkillMetric(ledger, {
        key: "share.pct",
        label: `Share-of-Taste percentile of ${subjectName}, ${GROUP_WORD[group]} ${row.spec.label}${tag}`,
        subjectRefs: [subject.ref, ...(row.spec.subject === null ? [] : [row.spec.subject])],
        value: cell?.pct ?? null,
        reason: cell?.reason ?? "not_scored",
        display: cell?.pct === null || cell?.pct === undefined ? "" : `${fixed2(cell.pct)} · ${rankText(cell.rank ?? 0, row.scored)}`,
        unit: "pct",
        badge: "DERIVED",
        formulaId: "share.pct",
        evidenceIds: evidenceFor(evidence, group),
        n: row.scored,
        comparator: "WITHIN_CALL",
        // R1: a share percentile from a 2-entity set is a thin sample.
        thin: row.scored <= THIN_SAMPLE.pairEntities,
      }),
    );
  }

  const tilt: (Metric | null)[] = grid.candidates.map(() => null);
  const metrosWon: (Metric | null)[] = grid.candidates.map(() => null);
  const tiltRanked = m.tilts?.values.filter((v) => v !== null).length ?? 0;
  const addTilt = (j: number, t: YouthTilts) => {
    const c = grid.candidates[j]!;
    const value = t.values[j] ?? null;
    const rank = t.ranks[j] ?? null;
    tilt[j] = pushMetric(
      run,
      addSkillMetric(ledger, {
        key: "share.youth_tilt",
        label: `youth tilt of ${safeName(c.name)} (${bucketLabels(t.young)} minus ${bucketLabels(t.old)})`,
        subjectRefs: [c.ref, ...[...t.young, ...t.old].flatMap((r) => (r.spec.subject === null ? [] : [r.spec.subject]))],
        value,
        reason: t.reasons[j] ?? "not_scored",
        display: value === null ? "" : `${signed2(value)}${isAboutLevelTilt(value) ? " · about level" : ""} · rank ${rank === null ? "–" : rankText(rank, tiltRanked)}`,
        unit: "delta",
        badge: "DERIVED",
        formulaId: "share.youth_tilt",
        evidenceIds: evidenceFor(evidence, "AGE"),
        n: t.young.length + t.old.length,
        comparator: "PEERS",
        aboutLevel: isAboutLevelTilt(value),
      }),
    );
  };
  const addWins = (j: number, w: MetroWins) => {
    const c = grid.candidates[j]!;
    const of = w.ranked.length;
    const rankedIn = w.rankedIn[j] ?? 0;
    const won = w.won[j] ?? 0;
    const unranked = of - rankedIn;
    metrosWon[j] = pushMetric(
      run,
      addSkillMetric(ledger, {
        key: "share.metros_won",
        label: `metros won by ${safeName(c.name)} (first in the set)`,
        subjectRefs: [c.ref, ...grid.rows.flatMap((r) => (r.spec.kind === "metro" && r.spec.subject !== null ? [r.spec.subject] : []))],
        value: rankedIn > 0 ? won : null,
        reason: w.reasons[j] ?? "not_scored",
        display: `wins ${won} of ${of} · top half in ${w.topHalf[j] ?? 0} of ${of}${unranked > 0 ? ` · not scored in ${unranked}` : ""}`,
        unit: "count",
        badge: "DERIVED",
        formulaId: "share.metros_won",
        evidenceIds: evidenceFor(evidence, "METRO"),
        n: rankedIn,
        comparator: "PEERS",
      }),
    );
  };
  grid.candidates.forEach((_, j) => {
    if (m.tilts !== null) addTilt(j, m.tilts);
    if (m.wins !== null) addWins(j, m.wins);
  });
  return { subjectPct, tilt, metrosWon };
}

/** The age buckets no row of the grid read, youngest first: where a generational split can be followed up. */
export function unreadAges(grid: ScoreGrid): AgeBucket[] {
  const read = new Set(grid.rows.flatMap((r) => (r.spec.kind === "age" && r.spec.subject !== null ? [r.spec.subject] : [])));
  return AgeBucket.options.filter((b) => !read.has(b));
}

/**
 * GENERATIONAL_SPLIT, METRO_OUTLIER (the strongest metro each way), DROPPED_CANDIDATES, and
 * EMPTY_RESULT when the calls ranked nothing (`metrics` is then null). Returns whether the
 * generational split fired, for the grid's annotation.
 */
export function addShareFindings(
  run: RankRun,
  grid: ScoreGrid,
  m: ShareMeasures,
  metrics: ShareMetrics | null,
  type: EntityType,
  emptyCall: boolean,
): boolean {
  const subjectName = safeName(grid.candidates[SUBJECT]!.name);
  let generational = false;
  const tiltMetric = metrics?.tilt[SUBJECT] ?? null;
  if (m.tilts !== null && tiltMetric !== null) {
    const draft = generationalSplitFinding({
      targetName: subjectName,
      targetTilt: m.tilts.values[SUBJECT] ?? null,
      setMedianTilt: medianTilt(m.tilts),
      unreadAges: unreadAges(grid),
    });
    if (draft !== null) {
      addFindingDraft(run, draft, [tiltMetric.id]);
      generational = true;
    }
  }

  // subjectPctRows keeps these metros inside its cap, so each finding cites the subject's percentile there.
  for (const outlier of metrics === null ? [] : m.outliers) {
    const metric = metrics?.subjectPct[grid.rows.indexOf(outlier.row)];
    const draft = metroOutlierFinding({
      targetName: subjectName,
      marketLabel: outlier.row.spec.label,
      metroRank: outlier.rank,
      medianRank: outlier.median,
      setSize: outlier.row.scored,
    });
    if (draft !== null && metric !== undefined) addFindingDraft(run, draft, [metric.id]);
  }

  addDroppedFinding(run, grid);

  if (emptyCall) {
    const noAges = !grid.rows.some((r) => r.spec.kind === "age");
    addFindingDraft(
      run,
      emptyResultFinding({
        what: `Share of Taste for ${subjectName} and its set`,
        suggestion:
          type === "brand" && noAges
            ? { tool: "share_of_taste", reason: "Rank the same set by age: age contexts scored every brand in the probe, metro contexts drop many." }
            : null,
      }),
      [],
    );
  }
  return generational;
}

function cellOf(pct: number | null, reason: NoValueReason | null): { value: number | null; reason: NoValueReason | null } {
  return pct === null ? { value: null, reason: reason ?? "not_scored" } : { value: pct, reason: null };
}

function annotationsFor(grid: ScoreGrid, m: ShareMeasures, generational: boolean): MatrixPayload["annotations"] {
  const subject = grid.candidates[SUBJECT]!;
  const name = safeName(subject.name);
  const out: MatrixPayload["annotations"] = [];
  if (m.wins !== null && (m.wins.rankedIn[SUBJECT] ?? 0) > 0) {
    out.push({ text: `${name} wins ${m.wins.won[SUBJECT] ?? 0} of ${m.wins.ranked.length} metros`, rowKey: null, colKey: subject.ref });
  }
  if (generational) out.push({ text: `${name} skews younger than the set`, rowKey: null, colKey: subject.ref });
  const best = m.best === null ? undefined : grid.rows[m.best];
  if (best !== undefined && out.length < 2) {
    const worst = m.worst === null ? undefined : grid.rows[m.worst];
    const rank = best.cells[SUBJECT]?.rank ?? 0;
    out.push({
      text: `Best: ${best.spec.label} (${rankText(rank, best.scored)})${worst === undefined ? "" : `; worst: ${worst.spec.label}`}`,
      rowKey: best.spec.key,
      colKey: subject.ref,
    });
  }
  return out.slice(0, 2);
}

/** The "Share of Taste" Matrix: contexts × entities, colour = within-call percentile, glyph = rank in the context. */
export function addShareMatrix(run: RankRun, grid: ScoreGrid, m: ShareMeasures, generational: boolean): void {
  const subject = grid.candidates[SUBJECT]!;
  const formulaIds: FormulaId[] = ["share.pct"];
  if (m.tilts !== null) formulaIds.push("share.youth_tilt");
  if (m.wins !== null) formulaIds.push("share.metros_won");
  const { tilts, wins } = m;
  const margin: MatrixPayload["margin"] =
    tilts !== null
      ? { label: "Youth tilt", values: tilts.values.map((v, j) => cellOf(v, tilts.reasons[j] ?? null)) }
      : wins !== null
        ? { label: "Metros won", values: wins.won.map((w, j) => cellOf((wins.rankedIn[j] ?? 0) > 0 ? w : null, wins.reasons[j] ?? null)) }
        : null;
  const dataset = run.ctx.ledger.addDataset({
    kind: "Matrix",
    title: `Share of Taste · ${safeName(subject.name)}`,
    evidenceIds: [...run.evidenceIds],
    formulaIds,
    payload: {
      mode: "share",
      valueLabel: "Share-of-Taste percentile (within call)",
      unit: "pct",
      comparator: "WITHIN_CALL",
      rows: grid.rows.map((r) => ({ key: r.spec.key, label: r.spec.label, ref: null, group: r.spec.group })),
      cols: grid.candidates.map((c) => ({ key: c.ref, label: safeFullName(c.name), ref: c.ref, group: null })),
      cells: grid.rows.map((r) => r.cells.map((c) => ({ ...cellOf(c.pct, c.reason), rank: c.pct === null ? null : c.rank }))),
      margin,
      targetKey: subject.ref,
      annotations: annotationsFor(grid, m, generational),
    },
  });
  run.datasetIds.push(dataset.id);
}

/** Why a pair has no split in a row: the call's gap, else the first unscored cell's reason. */
function splitReason(row: GridRow): NoValueReason {
  return row.gap ?? row.cells.find((c) => c.reason !== null)?.reason ?? "not_scored";
}

/**
 * The who-wins-where split for a pair (design A04): per context, each entity's share of the pair's
 * two affinities in that one call (the two sum to 1), drawn as the first one's lead over an even
 * split. Only for a set of two.
 */
export function pairSplitPayload(grid: ScoreGrid): BarsPayload | null {
  const [a, b] = grid.candidates;
  if (grid.candidates.length !== 2 || a === undefined || b === undefined) return null;
  const groups = SHARE_GROUPS.flatMap((g) => {
    const rows = grid.rows.filter((r) => r.spec.group === g);
    if (rows.length === 0) return [];
    return [
      {
        key: g.toLowerCase(),
        label: GROUP_LABEL[g],
        family: null,
        bars: rows.map((r) => {
          const split = pairSplit(r);
          return {
            key: r.spec.key,
            label: r.spec.label,
            tagRef: null,
            values:
              split === null
                ? [{ value: null, reason: splitReason(r) }, { value: null, reason: splitReason(r) }]
                : [
                    { value: split, reason: null },
                    { value: 1 - split, reason: null },
                  ],
            isNew: false,
            ranks: null,
          };
        }),
      },
    ];
  });
  if (!groups.some((g) => g.bars.some((bar) => bar.values[0]?.value !== null))) return null;
  return {
    mode: "butterfly",
    display: "split",
    baseline: 0.5,
    evenBand: SPLIT_EVEN_BAND,
    comparator: "WITHIN_CALL",
    valueLabel: `Share of taste within the pair: ${safeName(a.name)} vs ${safeName(b.name)}`,
    unit: "ratio",
    series: [a, b].map((c) => ({ key: c.ref, label: safeFullName(c.name), ref: c.ref, group: null })),
    groups,
    method: null,
    domain: null,
    caption: `Each context is one call; the pair's two shares sum to 1, and a lead within ±${SPLIT_EVEN_BAND} of an even split reads as even. Metro scores are compressed, so metro splits sit near even.`,
  };
}

export function addPairSplit(run: RankRun, grid: ScoreGrid): void {
  const payload = pairSplitPayload(grid);
  if (payload === null) return;
  const [a, b] = grid.candidates;
  const dataset = run.ctx.ledger.addDataset({
    kind: "Bars",
    title: `Who wins where · ${safeName(a?.name ?? "")} vs ${safeName(b?.name ?? "")}`,
    evidenceIds: [...run.evidenceIds],
    formulaIds: [PAIR_SPLIT_FORMULA, "share.pct"],
    payload,
  });
  run.datasetIds.push(dataset.id);
}

function placeText(row: GridRow | undefined, j: number): string | null {
  const rank = row?.cells[j]?.rank ?? null;
  return row === undefined || rank === null ? null : `${row.spec.label} (${rankText(rank, row.scored)})`;
}

/**
 * One row per member, the subject first. A row names where the member does best and worst and the
 * metrics that hold its tilt and metros won; the subject's row also names its best and worst
 * context metrics. Values are words, whole ranks and metric ids: a bare decimal is one the model
 * cannot cite.
 */
export function shareDigestRows(grid: ScoreGrid, m: ShareMeasures, metrics: ShareMetrics | null): DigestRow[] {
  const ranked = grid.rows.filter((r) => r.scored > 0).length;
  return grid.candidates.map((c, j) => {
    const bw = j === SUBJECT ? { best: m.best, worst: m.worst } : bestAndWorst(grid, j);
    const best = bw.best === null ? undefined : grid.rows[bw.best];
    const worst = bw.worst === null ? undefined : grid.rows[bw.worst];
    const values: DigestRow["values"] = {
      role: j === SUBJECT ? "subject" : "set",
      ranked_in: `${grid.rows.filter((r) => (r.cells[j]?.rank ?? null) !== null).length} of ${ranked} ranked contexts`,
      best: placeText(best, j),
      worst: placeText(worst, j),
    };
    if (metrics !== null) {
      if (j === SUBJECT) {
        values.best_metric = bw.best === null ? null : (metrics.subjectPct[bw.best]?.id ?? null);
        values.worst_metric = bw.worst === null ? null : (metrics.subjectPct[bw.worst]?.id ?? null);
      }
      if (m.tilts !== null) values.tilt_metric = metrics.tilt[j]?.id ?? null;
      if (m.wins !== null) values.metros_won_metric = metrics.metrosWon[j]?.id ?? null;
    }
    const unscored = unscoredText(grid, j);
    if (unscored !== null) values.unscored = unscored;
    return { ref: c.ref, name: safeName(c.name), values };
  });
}
