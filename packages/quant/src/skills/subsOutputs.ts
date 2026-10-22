import type {
  DatasetId,
  DigestRow,
  EvidenceId,
  Finding,
  Flag,
  Metric,
  MetricId,
  NoValueReason,
  QlooEntity,
  RegisteredEntity,
  SkillCtx,
} from "@ct/contracts";
import {
  droppedCandidatesFinding,
  isOutsideCategoryNeighbour,
  nearSubstitutesFinding,
  outsideCategoryNeighbourFinding,
  tasteIslandFinding,
  type FindingDraft,
} from "../findings";
import type { FormulaId } from "../formulas";
import type { SubsStats } from "../subs";
import { addSkillMetric } from "./common";
import { displayRanks, fixed2, rankText, safeFullName, safeName } from "./format";
import { categoryTagOf, isOutsideCategory, passesQualityGate, type PeerSource } from "./peerSelection";
import {
  hubGap,
  isComplete,
  mapGap,
  rowRanks,
  scoredInRow,
  substitutionMapPayload,
  type ScoredMatrix,
} from "./substitutionMap";

/**
 * What one peer_landscape run writes: a bounded metric set, the Substitution Map dataset, findings
 * and the digest rows. Vocabulary follows D13: near-substitutes, taste island, hub vs niche; the
 * similarity is symmetric, so nothing here claims switching or a one-way pull.
 */

/** Everything a run accumulates for its ledger output and digest. */
export interface SubsRun {
  ctx: SkillCtx;
  flags: Set<Flag>;
  evidenceIds: EvidenceId[];
  metrics: Metric[];
  findings: Finding[];
  datasetIds: DatasetId[];
  registered: RegisteredEntity[];
  notices: string[];
}

/** The matrix members in matrix order: index 0 is the target. */
export interface MapMembers {
  entities: readonly RegisteredEntity[];
  /** How each member got its slot; index 0 (the target) is null. */
  sources: readonly (PeerSource | null)[];
  categoryTagId: string | null;
}

export const SUBS_FORMULA_IDS: readonly FormulaId[] = [
  "subs.similarity",
  "subs.rank_in_row",
  "subs.hub",
  "subs.distinctiveness",
  "subs.near_substitutes",
  "subs.taste_island",
];

const TARGET = 0;

export function addFindingDraft(run: SubsRun, draft: FindingDraft, metricIds: readonly MetricId[]): Finding {
  const finding = run.ctx.ledger.addFinding({ ...draft, metricIds: [...metricIds] });
  run.findings.push(finding);
  return finding;
}

function nameOf(members: MapMembers, i: number): string {
  return safeName(members.entities[i]?.name ?? "");
}

function refOf(members: MapMembers, i: number): string {
  return members.entities[i]?.ref ?? "";
}

/** A present value's display; an absent one is replaced by "not measured" in addSkillMetric. */
function shown(value: number | null | undefined): string {
  return value === null || value === undefined ? "" : fixed2(value);
}

export interface SubsMetrics {
  distinctiveness: Metric;
  hub: Metric;
  nearest: Metric;
  tasteIsland: Metric;
  /** One per reported near-substitute pair, aligned with stats.nearSubstitutes. */
  pairs: Metric[];
  /** Similarity to the outside-category neighbour when it sits in the map and is not the nearest. */
  outside: Metric | null;
  /**
   * By member index: each scored member's similarity to the target, `nearest` and `outside`
   * included; null for the target and for unscored cells.
   */
  similarity: (Metric | null)[];
  /** By member index: each member's hub score, the target's being `hub`; null for a peer with no hub. */
  hubs: (Metric | null)[];
}

/**
 * Map members in digest order: the target first, then peers by rank to the target with unscored
 * peers last, ties by index.
 */
function digestOrder(members: MapMembers, matrix: ScoredMatrix | null): number[] {
  const targetRanks = matrix === null ? [] : rowRanks(matrix, TARGET);
  const rank = (j: number) => targetRanks[j] ?? Number.POSITIVE_INFINITY;
  return members.entities
    .map((_, j) => j)
    .sort((a, b) => {
      if (a === TARGET || b === TARGET) return a === TARGET ? -1 : 1;
      return rank(a) - rank(b) || a - b;
    });
}

/**
 * The S1 metric set, all cited to the matrix evidence: the target's distinctiveness, hub and
 * taste-island test, up to two near-substitute pairs, and for every member the digest lists its
 * similarity to the target and its hub score, so any peer the model names (a user-named one, or
 * the run's primary inside another brand's map) has a number it can cite. At most 3 + 2 + 2(k − 1),
 * 17 at k = 7. Results that compare rows (hub, distinctiveness rank, taste island,
 * near-substitutes) need every row: on a map missing a call they are recorded as not measured with
 * that gap's reason instead of read off rows with one or two scored cells. The target's own
 * similarities come from one call and stay measured.
 */
export function addSubsMetrics(
  run: SubsRun,
  members: MapMembers,
  matrix: ScoredMatrix,
  stats: SubsStats,
  evidenceIds: readonly EvidenceId[],
  outsideIndex: number | null,
): SubsMetrics {
  const ledger = run.ctx.ledger;
  const k = members.entities.length;
  const targetName = nameOf(members, TARGET);
  const targetRef = refOf(members, TARGET);
  const targetRowScored = scoredInRow(matrix, TARGET);
  const complete = isComplete(matrix);
  const acrossRows: NoValueReason = mapGap(matrix) ?? "not_scored";
  const hubRanks = displayRanks(stats.hub);
  const hubRanked = stats.hub.filter((h) => h !== null).length;
  const hubDisplay = (value: number, rank: number | null) =>
    `${fixed2(value)} · rank ${rank === null ? "–" : rankText(rank, hubRanked)}`;
  const push = (m: Metric) => {
    run.metrics.push(m);
    return m;
  };

  const dValue = stats.distinctiveness[TARGET] ?? null;
  const dRank = stats.distinctivenessRank[TARGET] ?? null;
  const dRanked = stats.distinctivenessRank.filter((r) => r !== null).length;
  const distinctiveness = push(
    addSkillMetric(ledger, {
      key: "subs.distinctiveness",
      label: `distinctiveness rank of ${targetName} among ${k} brands (1 = most distinctive)`,
      subjectRefs: [targetRef],
      value: complete ? dValue : null,
      reason: acrossRows,
      display: dRank === null ? (dValue === null ? "" : fixed2(dValue)) : rankText(dRank, dRanked),
      unit: "score",
      badge: "DERIVED",
      formulaId: "subs.distinctiveness",
      evidenceIds,
      n: dRanked,
      comparator: "PEERS",
    }),
  );

  const hubValue = stats.hub[TARGET] ?? null;
  const hubRank = hubRanks[TARGET] ?? null;
  const hub = push(
    addSkillMetric(ledger, {
      key: "subs.hub",
      label: `hub score of ${targetName} (mean within-row percentile; high = hub, low = niche)`,
      subjectRefs: [targetRef],
      value: complete ? hubValue : null,
      reason: complete ? hubGap(matrix, TARGET) : acrossRows,
      display: hubValue === null ? "" : hubDisplay(hubValue, hubRank),
      unit: "pct",
      badge: "DERIVED",
      formulaId: "subs.hub",
      evidenceIds,
      n: targetRowScored,
      comparator: "PEERS",
    }),
  );

  const similarityMetric = (j: number, label: string): Metric => {
    const cell = matrix.cells[TARGET]?.[j];
    return addSkillMetric(ledger, {
      key: "subs.similarity",
      label,
      subjectRefs: [targetRef, refOf(members, j)],
      value: cell?.value ?? null,
      reason: cell?.reason ?? "not_scored",
      display: shown(cell?.value),
      unit: "similarity",
      badge: "MEASURED",
      formulaId: "subs.similarity",
      evidenceIds,
      n: targetRowScored,
      comparator: null,
    });
  };

  const nearestIndex = stats.targetNearest;
  const targetRow = matrix.cells[TARGET] ?? [];
  const targetRowGap: NoValueReason =
    (["budget_truncated", "error"] as const).find((gap) => targetRow.some((c) => c.reason === gap)) ?? "not_scored";
  const nearest = push(
    nearestIndex === null
      ? addSkillMetric(ledger, {
          key: "subs.similarity",
          label: `similarity of ${targetName} to its nearest peer`,
          subjectRefs: [targetRef],
          value: null,
          reason: targetRowGap,
          display: "",
          unit: "similarity",
          badge: "MEASURED",
          formulaId: "subs.similarity",
          evidenceIds,
          n: targetRowScored,
          comparator: null,
        })
      : similarityMetric(nearestIndex, `similarity ${targetName}–${nameOf(members, nearestIndex)} (nearest peer)`),
  );

  const scoredRows = stats.targetScoredRows;
  const tasteIsland = push(
    addSkillMetric(ledger, {
      key: "subs.taste_island",
      label: `taste-island test for ${targetName} (share of peer rows where it ranks last)`,
      subjectRefs: [targetRef],
      value: complete && scoredRows > 0 ? stats.targetLastInRows / scoredRows : null,
      reason: acrossRows,
      display: `last in ${stats.targetLastInRows} of ${scoredRows} rows${stats.tasteIsland ? " · taste island" : ""}`,
      unit: "ratio",
      badge: "DERIVED",
      formulaId: "subs.taste_island",
      evidenceIds,
      n: scoredRows,
      comparator: "PEERS",
    }),
  );

  const pairs = (complete ? stats.nearSubstitutes.slice(0, 2) : []).map(([a, b]) => {
    const cell = matrix.cells[a]?.[b];
    return push(
      addSkillMetric(ledger, {
        key: "subs.near_substitutes",
        label: `near-substitutes ${nameOf(members, a)}–${nameOf(members, b)} (similarity)`,
        subjectRefs: [refOf(members, a), refOf(members, b)],
        value: cell?.value ?? null,
        reason: cell?.reason ?? "not_scored",
        display: shown(cell?.value),
        unit: "similarity",
        badge: "MEASURED",
        formulaId: "subs.near_substitutes",
        evidenceIds,
        n: matrix.pairs.scored,
        comparator: null,
      }),
    );
  });

  const outside =
    outsideIndex !== null && outsideIndex !== nearestIndex
      ? push(
          similarityMetric(
            outsideIndex,
            `similarity ${targetName}–${nameOf(members, outsideIndex)} (outside the category)`,
          ),
        )
      : null;

  const similarity: (Metric | null)[] = members.entities.map(() => null);
  if (nearestIndex !== null) similarity[nearestIndex] = nearest;
  if (outside !== null && outsideIndex !== null) similarity[outsideIndex] = outside;
  const hubs: (Metric | null)[] = members.entities.map((_, j) => (j === TARGET ? hub : null));

  // Every other member in digest order: its similarity to the target, then its hub score. The most
  // central brand, when it is not the target, is labelled as the hub the niche brands orbit.
  const topHub = complete ? hubRanks.findIndex((r) => r === 1) : -1;
  for (const j of digestOrder(members, matrix)) {
    if (j === TARGET) continue;
    const name = nameOf(members, j);
    if (similarity[j] === null && (targetRow[j]?.value ?? null) !== null) {
      similarity[j] = push(similarityMetric(j, `similarity ${targetName}–${name}`));
    }
    const value = complete ? (stats.hub[j] ?? null) : null;
    if (value === null) continue;
    hubs[j] = push(
      addSkillMetric(ledger, {
        key: "subs.hub",
        label: j === topHub ? `hub score of ${name} (most central brand in the map)` : `hub score of ${name}`,
        subjectRefs: [refOf(members, j)],
        value,
        reason: "not_scored",
        display: hubDisplay(value, hubRanks[j] ?? null),
        unit: "pct",
        badge: "DERIVED",
        formulaId: "subs.hub",
        evidenceIds,
        n: scoredInRow(matrix, j),
        comparator: "PEERS",
      }),
    );
  }

  return { distinctiveness, hub, nearest, tasteIsland, pairs, outside, similarity, hubs };
}

function maxOrNull(values: readonly (number | null | undefined)[]): number | null {
  const scored = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  return scored.length > 0 ? Math.max(...scored) : null;
}

/** An OUTSIDE_CATEGORY_NEIGHBOUR subject; `index` is its slot in the map members, null when it has none. */
export interface OutsideNeighbour {
  entity: RegisteredEntity;
  index: number | null;
}

/**
 * Whether the top cross-category result is an OUTSIDE_CATEGORY_NEIGHBOUR on discovery evidence:
 * its D2 score is at least the best same-category D1 score. Both calls take the target as their
 * signal, so the two scores sit on one scale (G1).
 */
export function discoveryNeighbourQualifies(
  neighbour: { entityId: string },
  targetEntityId: string,
  sameCategory: readonly QlooEntity[],
  crossCategory: readonly QlooEntity[],
): boolean {
  const score = crossCategory.find((r) => r.entity_id === neighbour.entityId)?.query?.affinity ?? null;
  const best = maxOrNull(
    sameCategory.filter((r) => r.entity_id !== targetEntityId && passesQualityGate(r)).map((r) => r.query?.affinity),
  );
  return isOutsideCategoryNeighbour({ neighbourInCategory: false, neighbourScore: score, bestInCategoryScore: best });
}

/**
 * The OUTSIDE_CATEGORY_NEIGHBOUR subject (SPEC §4.4). With a map: the member outside the target's
 * category whose similarity to the target is at least every same-category member's, so it is one
 * of the target's nearest. Otherwise, or when it has no slot in the map, the top cross-category
 * discovery result that qualified on discovery evidence (`discovered`).
 */
export function findOutsideNeighbour(
  members: MapMembers,
  matrix: ScoredMatrix | null,
  discovered: RegisteredEntity | null,
): OutsideNeighbour | null {
  const category = members.categoryTagId;
  if (category === null) return null;
  const discoveredIndex = discovered === null ? -1 : members.entities.findIndex((e) => e.entityId === discovered.entityId);

  if (matrix !== null) {
    const row = matrix.cells[TARGET] ?? [];
    const peers = members.entities
      .map((entity, index) => ({ entity, index, score: row[index]?.value ?? null }))
      .filter((p) => p.index !== TARGET);
    const bestInCategory = maxOrNull(peers.filter((p) => !isOutsideCategory(p.entity, category)).map((p) => p.score));
    const close = peers
      .filter(
        (p) =>
          isOutsideCategory(p.entity, category) &&
          isOutsideCategoryNeighbour({ neighbourInCategory: false, neighbourScore: p.score, bestInCategoryScore: bestInCategory }),
      )
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.index - b.index)[0];
    if (close !== undefined) return { entity: close.entity, index: close.index };
    // A map member is judged on the map's own scores; discovery speaks only for a neighbour left out.
    return discovered !== null && discoveredIndex < 0 ? { entity: discovered, index: null } : null;
  }
  if (discovered === null) return null;
  return { entity: discovered, index: discoveredIndex >= 0 ? discoveredIndex : null };
}

/**
 * OUTSIDE_CATEGORY_NEIGHBOUR with its ANALYST PIVOT. A neighbour that holds a slot in the map (the
 * peer rule reserves one for it) cannot be added again, so the builder suggests its own map instead.
 */
export function addOutsideFinding(
  run: SubsRun,
  members: MapMembers,
  neighbour: OutsideNeighbour,
  metricIds: readonly MetricId[],
): void {
  // The category tag name is Qloo text too, and it reaches the model inside the finding.
  const category = safeName(categoryTagOf(neighbour.entity)?.name ?? "");
  const draft = outsideCategoryNeighbourFinding({
    targetName: nameOf(members, TARGET),
    neighbourName: safeName(neighbour.entity.name),
    neighbourCategory: category === "" ? null : category,
    neighbourInMap: neighbour.index !== null,
  });
  addFindingDraft(run, draft, metricIds);
}

/**
 * TASTE_ISLAND, NEAR_SUBSTITUTES and DROPPED_CANDIDATES from the scored map. A map cut short by the
 * budget has rows with one or two scored cells, where every cell ranks first or last; the rank
 * findings would be artifacts of the missing calls, so only DROPPED_CANDIDATES is reported then.
 */
export function addMapFindings(
  run: SubsRun,
  members: MapMembers,
  matrix: ScoredMatrix,
  stats: SubsStats,
  metrics: SubsMetrics,
): void {
  const complete = isComplete(matrix);
  if (complete && stats.tasteIsland) {
    const draft = tasteIslandFinding({
      targetName: nameOf(members, TARGET),
      lastInRows: stats.targetLastInRows,
      scoredRows: stats.targetScoredRows,
      nearestName: stats.targetNearest === null ? null : nameOf(members, stats.targetNearest),
    });
    if (draft !== null) addFindingDraft(run, draft, [metrics.tasteIsland.id, metrics.distinctiveness.id]);
  }
  (complete ? stats.nearSubstitutes.slice(0, 2) : []).forEach(([a, b], n) => {
    const metric = metrics.pairs[n];
    addFindingDraft(
      run,
      nearSubstitutesFinding({ aName: nameOf(members, a), bName: nameOf(members, b) }),
      metric === undefined ? [] : [metric.id],
    );
  });
  if (matrix.droppedMembers.length > 0) {
    const draft = droppedCandidatesFinding({
      names: matrix.droppedMembers.map((i) => nameOf(members, i)),
      context: "the Substitution Map scoring calls",
    });
    if (draft !== null) addFindingDraft(run, draft, []);
  }
}

/** The "Substitution Map" Matrix dataset. */
export function addSubstitutionMap(
  run: SubsRun,
  members: MapMembers,
  matrix: ScoredMatrix,
  stats: SubsStats,
  evidenceIds: readonly EvidenceId[],
): void {
  const annotations: { text: string; rowKey: string | null; colKey: string | null }[] = [];
  const complete = isComplete(matrix);
  if (complete && stats.tasteIsland) {
    annotations.push({
      text: `Taste island: last in ${stats.targetLastInRows}/${stats.targetScoredRows} rows`,
      rowKey: null,
      colKey: refOf(members, TARGET),
    });
  }
  const pair = complete ? stats.nearSubstitutes[0] : undefined;
  if (pair !== undefined) {
    annotations.push({
      text: `Near-substitutes: ${nameOf(members, pair[0])} and ${nameOf(members, pair[1])}`,
      rowKey: refOf(members, pair[0]),
      colKey: refOf(members, pair[1]),
    });
  }
  const dataset = run.ctx.ledger.addDataset({
    kind: "Matrix",
    title: "Substitution Map",
    evidenceIds: [...evidenceIds],
    formulaIds: [...SUBS_FORMULA_IDS],
    payload: substitutionMapPayload({
      // The reader's grid keeps names whole, but still without hidden or reordering characters.
      members: members.entities.map((e) => ({ ref: e.ref, name: safeFullName(e.name) })),
      matrix,
      stats,
      targetIndex: TARGET,
      annotations,
    }),
  });
  run.datasetIds.push(dataset.id);
}

function categoryLabel(members: MapMembers, i: number): string {
  const entity = members.entities[i];
  if (members.categoryTagId === null || entity === undefined) return "unknown";
  if (i === TARGET) return "yes";
  if (isOutsideCategory(entity, members.categoryTagId)) return "no";
  return entity.tags.length === 0 ? "unknown" : "yes";
}

/**
 * One row per map member: the target first, then peers by similarity rank to the target. Plus a
 * row for an outside-category neighbour that did not get a slot, so the model has its ref to pivot.
 * A row names the metrics that hold its similarity and hub score instead of repeating the values:
 * the model reads them there and cites the token, since a bare decimal is one it cannot write.
 */
export function subsDigestRows(
  members: MapMembers,
  scored: { matrix: ScoredMatrix; metrics: SubsMetrics } | null,
  neighbourOutsideMap: RegisteredEntity | null,
): DigestRow[] {
  // Hub compares rows, so a map missing a call shows none rather than a made-up centrality.
  const withHub = scored !== null && isComplete(scored.matrix);
  const targetRanks = scored === null ? [] : rowRanks(scored.matrix, TARGET);

  const rows: DigestRow[] = digestOrder(members, scored?.matrix ?? null).map((j) => {
    const values: DigestRow["values"] = { role: members.sources[j] ?? "target", in_category: categoryLabel(members, j) };
    if (scored !== null) {
      if (j !== TARGET) {
        const cell = scored.matrix.cells[TARGET]?.[j];
        values.rank_to_target = targetRanks[j] ?? null;
        values.similarity_metric = scored.metrics.similarity[j]?.id ?? null;
        if (cell !== undefined && cell.value === null) values.unscored = cell.reason;
      }
      if (withHub) values.hub_metric = scored.metrics.hubs[j]?.id ?? null;
    }
    return { ref: members.entities[j]?.ref ?? null, name: nameOf(members, j), values };
  });

  if (neighbourOutsideMap !== null) {
    rows.push({
      ref: neighbourOutsideMap.ref,
      name: safeName(neighbourOutsideMap.name),
      values: { role: "outside_category_neighbour", in_map: "no", in_category: "no" },
    });
  }
  return rows;
}
