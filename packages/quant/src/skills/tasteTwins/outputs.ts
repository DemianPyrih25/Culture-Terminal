import {
  METRO_LABEL,
  type Bar,
  type BarGroup,
  type DigestRow,
  type EvidenceId,
  type Metric,
  type MetroId,
  type Neighbourhood,
  type NoValueReason,
  type RankedRow,
  type ValueCell,
} from "@ct/contracts";
import { rhoWords, twinFoundFinding, type TwinCandidate } from "../../findings";
import { LIST_FAMILIES } from "../blockDna/calls";
import { TAG_TAKE, type Compared } from "../blockDna/fingerprint";
import { addFindingDraft, FAMILY_GROUP_LABEL, type BlockRun } from "../blockDna/outputs";
import { addSkillMetric } from "../common";
import { fixed2, rankText, safeFullName, safeName, safeText } from "../format";
import { twinBars, type TwinScore } from "./twins";

/**
 * What one taste_twins run writes: a resemblance metric per area checked (and the shared NEW count of
 * the closest few), the twins RankedTable, the source-vs-closest-area butterfly, TWIN_FOUND and the
 * digest rows. Every value reads against the areas checked, never the whole target city.
 */

/** How the target areas were chosen, in a reader's words. */
export type TwinPick = "named" | "concept" | "largest";

export interface TwinArea {
  area: Neighbourhood;
  /** The concept lift that picked the area; null unless the concept picked it. */
  lift: number | null;
  /** The area's tags against its own city; null when not measured. */
  compared: Compared[] | null;
  score: TwinScore | null;
  /** Why the area has no ρ; null when it has one. */
  gap: NoValueReason | null;
  /** The plain reason behind `gap`, for the table. */
  why: string | null;
}

export interface TwinFrame {
  source: { id: string; name: string; metro: MetroId };
  /** The source area against its own city. */
  sourceCompared: Compared[];
  target: MetroId;
  /** Every area of the target city, for "N of M checked". */
  targetAreaCount: number;
  pick: TwinPick;
  conceptLabel: string | null;
  evidenceIds: EvidenceId[];
}

/** Areas that get a shared-NEW metric: the closest few, so the model can name what they share. */
export const SHARED_NEW_METRICS = 3;

const PICK_TEXT: Readonly<Record<TwinPick, string>> = {
  named: "the areas named in the question",
  concept: "the areas with the highest concept lift",
  largest: "the largest areas by land area",
};

/** Measured areas by ρ (best first), then the unmeasured ones by name. */
export function byResemblance(areas: readonly TwinArea[]): TwinArea[] {
  return [...areas].sort((a, b) => {
    const ra = a.score?.rho ?? null;
    const rb = b.score?.rho ?? null;
    if (ra !== null && rb !== null) return rb - ra || (a.area.id < b.area.id ? -1 : 1);
    if (ra !== null) return -1;
    if (rb !== null) return 1;
    return a.area.name.localeCompare(b.area.name);
  });
}

export interface TwinMetrics {
  rho: Map<string, Metric>;
  sharedNew: Map<string, Metric>;
  /** The concept lift that picked each of the closest few areas (concept pick only). */
  lift: Map<string, Metric>;
}

export function addTwinMetrics(run: BlockRun, frame: TwinFrame, ordered: readonly TwinArea[]): TwinMetrics {
  const out: TwinMetrics = { rho: new Map(), sharedNew: new Map(), lift: new Map() };
  const src = safeName(frame.source.name);
  const srcCity = METRO_LABEL[frame.source.metro];
  const tgtCity = METRO_LABEL[frame.target];
  const measured = ordered.filter((a) => a.score?.rho !== null && a.score !== null);
  ordered.forEach((a) => {
    const rho = a.score?.rho ?? null;
    const rank = measured.indexOf(a) + 1;
    const metric = addSkillMetric(run.ctx.ledger, {
      key: "twin.rho",
      label: `taste resemblance of ${safeName(a.area.name)} (${tgtCity}) to ${src} (${srcCity}), each against its own city`,
      subjectRefs: [a.area.id, frame.target, frame.source.id, frame.source.metro],
      value: rho,
      reason: a.gap ?? "not_measured",
      display: rho === null ? "" : `${fixed2(rho)} · ${rhoWords(rho)} · rank ${rankText(rank, measured.length)} among the areas checked`,
      unit: "similarity",
      badge: "DERIVED",
      formulaId: "twin.rho",
      evidenceIds: frame.evidenceIds,
      n: a.score?.shared ?? null,
      comparator: "CITY",
    });
    run.metrics.push(metric);
    out.rho.set(a.area.id, metric);
  });
  for (const a of measured.slice(0, SHARED_NEW_METRICS)) {
    const score = a.score as TwinScore;
    const names = score.sharedNew.map((id) => nameOf(a, frame, id));
    const metric = addSkillMetric(run.ctx.ledger, {
      key: "twin.shared_new",
      label: `NEW tags ${src} and ${safeName(a.area.name)} share (in each area's top 20, absent from its own city's top ${TAG_TAKE})`,
      subjectRefs: [a.area.id, frame.target, frame.source.id, frame.source.metro],
      value: score.sharedNew.length,
      reason: "not_measured",
      display: names.length === 0 ? "0" : safeText(`${names.length}: ${names.join(", ")}`, 60),
      unit: "count",
      badge: "DERIVED",
      formulaId: "twin.shared_new",
      evidenceIds: frame.evidenceIds,
      n: score.union,
      comparator: "CITY",
    });
    run.metrics.push(metric);
    out.sharedNew.set(a.area.id, metric);
    // The concept lift that picked the area is measured, so the answer can cite it (and never say
    // the concept was not measured where the twins sit).
    if (frame.pick === "concept" && frame.conceptLabel !== null && a.lift !== null) {
      const lift = addSkillMetric(run.ctx.ledger, {
        key: "lift.area",
        label: `lift of ${safeName(a.area.name)} for ${safeName(frame.conceptLabel)} vs the restaurant baseline (how the area was picked)`,
        subjectRefs: [a.area.id, frame.target],
        value: a.lift,
        reason: "not_measured",
        display: `${fixed2(a.lift)}×`,
        unit: "lift",
        badge: "ESTIMATED",
        formulaId: "lift.area",
        evidenceIds: frame.evidenceIds,
        n: null,
        comparator: "BASELINE",
      });
      run.metrics.push(lift);
      out.lift.set(a.area.id, lift);
    }
  }
  return out;
}

function nameOf(a: TwinArea, frame: TwinFrame, id: string): string {
  const c = a.compared?.find((x) => x.item.id === id) ?? frame.sourceCompared.find((x) => x.item.id === id);
  return safeName(c?.item.name ?? id);
}

/** TWIN_FOUND for the twins among the areas checked, citing their resemblance metrics. */
export function addTwinFinding(run: BlockRun, frame: TwinFrame, ordered: readonly TwinArea[], metrics: TwinMetrics): void {
  const candidates: TwinCandidate[] = ordered.map((a) => ({ id: a.area.id, name: safeName(a.area.name), rho: a.score?.rho ?? null }));
  const draft = twinFoundFinding({ sourceName: safeName(frame.source.name), targetCity: METRO_LABEL[frame.target], areas: candidates });
  if (draft === null) return;
  const cited = ordered.flatMap((a) => {
    const m = metrics.rho.get(a.area.id);
    return m !== undefined && m.value !== null ? [m.id] : [];
  });
  addFindingDraft(run, draft, cited.slice(0, 3));
}

const cell = (value: number | null, reason: NoValueReason | null): ValueCell => (value === null ? { value: null, reason: reason ?? "not_measured" } : { value, reason: null });

/** The twins RankedTable: every area checked, measured ones ranked by ρ. */
export function addTwinTable(run: BlockRun, frame: TwinFrame, ordered: readonly TwinArea[]): void {
  if (ordered.length === 0) return;
  const src = safeFullName(frame.source.name);
  const srcCity = METRO_LABEL[frame.source.metro];
  const tgtCity = METRO_LABEL[frame.target];
  const withLift = frame.pick === "concept";
  let rank = 0;
  const rows: RankedRow[] = ordered.map((a) => {
    const rho = a.score?.rho ?? null;
    if (rho !== null) rank += 1;
    const sublabel =
      rho === null
        ? `not measured: ${a.why ?? "no ranked taste tags"}`
        : `${rhoWords(rho)} · ${a.score?.shared ?? 0} tags in both areas' top lists`;
    return {
      key: a.area.id,
      rank: rho === null ? null : rank,
      label: safeFullName(a.area.name),
      sublabel,
      ref: null,
      tagRef: null,
      type: null,
      cells: [
        cell(rho, a.gap),
        cell(a.score === null || rho === null ? null : a.score.sharedNew.length, a.gap),
        cell(a.score === null || rho === null ? null : a.score.shared, a.gap),
        ...(withLift ? [cell(a.lift, "not_measured")] : []),
      ],
      flags: [],
      explain: [],
    };
  });
  const checked = ordered.length;
  const dataset = run.ctx.ledger.addDataset({
    kind: "Ranked",
    title: `Taste twins · ${tgtCity} areas most like ${src}`,
    evidenceIds: [...frame.evidenceIds],
    formulaIds: withLift ? ["twin.rho", "twin.shared_new", "lift.area"] : ["twin.rho", "twin.shared_new"],
    payload: {
      columns: [
        { key: "rho", label: `Resemblance to ${src} (ρ)`, unit: "similarity", comparator: "CITY" },
        { key: "shared_new", label: "Shared NEW tags", unit: "count", comparator: null },
        { key: "shared", label: "Tags in both top lists", unit: "count", comparator: null },
        ...(withLift ? [{ key: "lift", label: "Concept lift (how it was picked)", unit: "lift" as const, comparator: "BASELINE" as const }] : []),
      ],
      groups: [{ key: "twins", label: `${checked} of ${frame.targetAreaCount} ${tgtCity} areas checked`, rows }],
      caption:
        `ρ compares how each area differs from its own city, tag by tag, with how ${src} differs from ${srcCity}: 1 = the same tags over- and under-index, ` +
        `0 = no relation, below 0 = opposite. ${checked} of ${frame.targetAreaCount} ${tgtCity} areas were checked (${PICK_TEXT[frame.pick]}); the others are not ranked. ` +
        "Venue-goer taste signals, not residents, sales or rents.",
    },
  });
  run.datasetIds.push(dataset.id);
}

/** The butterfly of the source against the closest area checked: its tag gains next to the source's. */
export function addTwinBars(run: BlockRun, frame: TwinFrame, closest: TwinArea | undefined): void {
  if (closest === undefined || closest.compared === null || (closest.score?.rho ?? null) === null) return;
  const bars = twinBars(frame.sourceCompared, closest.compared, LIST_FAMILIES);
  const groups: BarGroup[] = LIST_FAMILIES.flatMap((family) => {
    const own = bars.filter((b) => b.family === family);
    if (own.length === 0) return [];
    const drawn: Bar[] = own.map((b) => ({
      key: b.id,
      label: safeFullName(b.name),
      tagRef: null,
      values: [
        { value: b.source, reason: null },
        { value: b.twin, reason: null },
      ],
      isNew: b.sharedNew,
      ranks: null,
    }));
    return [{ key: family, label: FAMILY_GROUP_LABEL[family], family, bars: drawn }];
  });
  if (groups.length === 0) return;
  const src = safeFullName(frame.source.name);
  const twin = safeFullName(closest.area.name);
  const srcCity = METRO_LABEL[frame.source.metro];
  const tgtCity = METRO_LABEL[frame.target];
  const dataset = run.ctx.ledger.addDataset({
    kind: "Bars",
    title: `Taste twins · ${src} vs ${twin}`,
    evidenceIds: [...frame.evidenceIds],
    formulaIds: ["block.rank_delta", "twin.rho"],
    payload: {
      mode: "butterfly",
      comparator: "CITY",
      valueLabel: "Tag rank gain vs its own city",
      unit: "delta",
      series: [
        { key: frame.source.id, label: `${src} (vs ${srcCity})`, ref: null, group: null },
        { key: closest.area.id, label: `${twin} (vs ${tgtCity})`, ref: null, group: null },
      ],
      groups,
      method: null,
      domain: null,
      caption:
        `Each bar is a tag's rank gain in the area over its own city's top-${TAG_TAKE} list (a missing rank counts as ${TAG_TAKE + 1}): ` +
        "first the tags both areas over-index on, then where they differ most. NEW: in both areas' top 20, absent from both cities' lists. " +
        "Venue-goer taste signals, not residents or sales.",
    },
  });
  run.datasetIds.push(dataset.id);
}

/** One row per area checked, closest first; each names the metric that holds its ρ. */
export function twinDigestRows(ordered: readonly TwinArea[], metrics: TwinMetrics): DigestRow[] {
  return ordered.map((a) => ({
    ref: null,
    name: safeName(a.area.name),
    values: {
      area: a.area.id,
      rho_metric: metrics.rho.get(a.area.id)?.id ?? null,
      shared_new_metric: metrics.sharedNew.get(a.area.id)?.id ?? null,
      lift_metric: metrics.lift.get(a.area.id)?.id ?? null,
    },
  }));
}

export function pickNotice(frame: TwinFrame, checked: number): string {
  const tgtCity = METRO_LABEL[frame.target];
  const how =
    frame.pick === "concept" && frame.conceptLabel !== null
      ? `the ${tgtCity} areas with the highest lift for ${frame.conceptLabel}`
      : frame.pick === "largest"
        ? `the largest ${tgtCity} areas by land area (no concept to pick by fit), so a better twin may sit among the areas not checked`
        : "the areas named";
  return `Checked ${checked} of ${frame.targetAreaCount} ${tgtCity} areas: ${how}. Say "of the ${checked} areas checked", never "in ${tgtCity}".`;
}
