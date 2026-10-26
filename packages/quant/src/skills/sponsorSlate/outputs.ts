import type {
  DatasetId,
  DatasetInput,
  DigestRow,
  EvidenceId,
  Finding,
  FindingSuggestion,
  Flag,
  Metric,
  MetricId,
  NoValueReason,
  QuadrantPayload,
  RegisteredEntity,
  SkillCtx,
  SlateEntry,
  SlopePayload,
  SponsorCategory,
} from "@ct/contracts";
import { droppedCandidatesFinding, emptyResultFinding, weakCategoryFitFinding, type FindingDraft } from "../../findings";
import type { FormulaId } from "../../formulas";
import { addSkillMetric, registerEntity, type EntityDraft } from "../common";
import { fixed2, rankText, safeFullName, safeName } from "../format";
import { SPONSOR_CATEGORIES } from "./categories";
import {
  bestMarket,
  MIN_MARKET_SCORED,
  topMarkets,
  type CallCell,
  type Candidate,
  type CategoryRow,
  type MarketColumn,
  type ScoredSlate,
} from "./slate";

/**
 * What one sponsor_slate run writes: a bounded metric set (each category's best fit, the
 * UNDER-THE-RADAR count, each best fit's strongest market, the shortlist's FIT), the Slate, Quadrant
 * and market Slope datasets, findings and digest rows. Taste fit only: no fee, availability,
 * exclusivity or ROI, and one brand per category is a slate rule, not a contract.
 */

/** Everything a run accumulates for its ledger output and digest. */
export interface SlateRun {
  ctx: SkillCtx;
  flags: Set<Flag>;
  evidenceIds: EvidenceId[];
  metrics: Metric[];
  findings: Finding[];
  datasetIds: DatasetId[];
  registered: RegisteredEntity[];
  notices: string[];
}

/** The scored slate with everything the outputs read. Candidate arrays are aligned by index. */
export interface SlateState {
  seed: RegisteredEntity;
  candidates: readonly Candidate[];
  refs: readonly RegisteredEntity[];
  slate: ScoredSlate;
  rows: readonly CategoryRow[];
  /** Candidate indices of the market slate, aligned with every column's cells. */
  members: readonly number[];
  /** Market calls made (answered or not), in input order. */
  columns: readonly MarketColumn[];
  /** National FIT re-ranked over the market slate, aligned with `members`: the Slope's first axis. */
  nationalOverSlate: readonly CallCell[];
  /** Requested categories whose filter tag comes from a /v2/tags lookup, not the config. */
  lookedUp: ReadonlySet<SponsorCategory>;
  /** Per category: usable discovery results that are no candidate, in affinity order. */
  pool: ReadonlyMap<SponsorCategory, readonly EntityDraft[]>;
  evidence: { tags: EvidenceId | null; discovery: EvidenceId | null; scoring: EvidenceId | null; markets: EvidenceId | null };
}

export const SLATE_CAPTION = "Taste fit only; no fee, availability or ROI data.";

export const SLATE_QUADRANT_LABELS: QuadrantPayload["quadrantLabels"] = {
  HEARTLAND: "High fit · well known",
  HIDDEN_POCKET: "UNDER-THE-RADAR FIT · no pricing data",
  MASS: "Well known · weaker fit",
  COLD: "Weaker fit · niche",
};

const SHORTLIST_GROUP = "Shortlist";
const LABELLED_POINTS = 8;
/**
 * The run's metric cap, so the worst case (6 categories, 4 markets, 10 shortlist brands, 40-character
 * names) still fits the digest with every category row: digests never drop metrics. Category metrics
 * come first; shortlist FIT metrics take what is left.
 */
export const MAX_SLATE_METRICS = 15;

export function categoryLabel(category: SponsorCategory): string {
  return SPONSOR_CATEGORIES[category].label;
}

/** "Beer", "Beer and Auto", "Beer, Auto and Telecom". */
export function listLabels(labels: readonly string[]): string {
  if (labels.length <= 1) return labels[0] ?? "";
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

function nameOf(state: SlateState, j: number): string {
  return safeName(state.refs[j]?.name ?? "");
}

function ids(...evidence: (EvidenceId | null)[]): EvidenceId[] {
  return evidence.filter((e): e is EvidenceId => e !== null);
}

function signed(x: number): string {
  const shown = fixed2(Math.abs(x));
  return Number(shown) === 0 ? shown : `${x > 0 ? "+" : "−"}${shown}`;
}

export function addSlateFinding(run: SlateRun, draft: FindingDraft, metricIds: readonly MetricId[]): void {
  run.findings.push(run.ctx.ledger.addFinding({ ...draft, metricIds: [...metricIds] }));
}

export interface SlateMetrics {
  /** By candidate index: its FIT metric (best fits and shortlist brands). */
  fit: Map<number, Metric>;
  /** By category: the best-fit metric, UNAVAILABLE when the category has none. */
  bestFit: Map<SponsorCategory, Metric>;
  utrCount: Metric | null;
  /** By candidate index: a best fit's strongest market. */
  market: Map<number, Metric>;
  /** Shortlist brands (not best fits) the metric cap left without a FIT metric; their FIT is in the datasets. */
  uncited: number[];
}

/** Evidence behind a category's best fit: its tag lookup when the tag was looked up, then discovery and scoring. */
function categoryEvidence(state: SlateState, category: SponsorCategory): EvidenceId[] {
  return ids(state.lookedUp.has(category) ? state.evidence.tags : null, state.evidence.discovery, state.evidence.scoring);
}

/**
 * The S10 metric set, sized for the digest: per category the best fit's FIT (slate.best_fit; the
 * label says when it is under the radar), or an UNAVAILABLE metric with the reason, and its
 * strongest market Δ when markets ran; then the UTR count over the best fits and, up to
 * MAX_SLATE_METRICS, the FIT of shortlist brands that are not best fits (highest FIT first, then the
 * unscored), so a brand the model named has a number it can cite. Popularity and the per-brand flag
 * live in the Slate and the Quadrant.
 */
export function addSlateMetrics(run: SlateRun, state: SlateState): SlateMetrics {
  const ledger = run.ctx.ledger;
  const { slate, seed } = state;
  const push = (m: Metric) => {
    run.metrics.push(m);
    return m;
  };
  const fitMetric = (j: number, label: string, formulaId: FormulaId, evidenceIds: EvidenceId[]): Metric => {
    const cell = slate.fit[j]!;
    return push(
      addSkillMetric(ledger, {
        key: "slate.fit",
        label,
        subjectRefs: [state.refs[j]!.ref, seed.ref],
        value: cell.value,
        reason: cell.reason ?? "not_scored",
        display: cell.value === null ? "" : `${fixed2(cell.value)}${cell.rank === null ? "" : ` · ${rankText(cell.rank, slate.scored)}`}`,
        unit: "pct",
        badge: "DERIVED",
        formulaId,
        evidenceIds,
        n: slate.scored,
        comparator: "WITHIN_CALL",
      }),
    );
  };

  const fit = new Map<number, Metric>();
  const bestFit = new Map<SponsorCategory, Metric>();
  for (const row of state.rows) {
    const label = `${categoryLabel(row.category)} best fit`;
    const evidenceIds = categoryEvidence(state, row.category);
    if (row.best !== null) {
      const flag = slate.utr[row.best] ? ", under the radar" : "";
      const m = fitMetric(row.best, `FIT · ${nameOf(state, row.best)} · ${label}${flag}`, "slate.best_fit", evidenceIds);
      fit.set(row.best, m);
      bestFit.set(row.category, m);
      continue;
    }
    bestFit.set(
      row.category,
      push(
        addSkillMetric(ledger, {
          key: "slate.fit",
          label: `FIT · ${label}`,
          subjectRefs: [seed.ref],
          value: null,
          reason: row.reason ?? "not_measured",
          display: "",
          unit: "pct",
          badge: "DERIVED",
          formulaId: "slate.best_fit",
          evidenceIds,
          n: null,
          comparator: "WITHIN_CALL",
        }),
      ),
    );
  }

  // UNDER-THE-RADAR over the best fits placed on the quadrant (fit and popularity known).
  const bestPlaced = state.rows.flatMap((r) => (r.best !== null && slate.quadrant[r.best] !== null ? [r.best] : []));
  const flagged = bestPlaced.filter((j) => slate.utr[j]);
  const utrCount =
    bestPlaced.length === 0
      ? null
      : push(
          addSkillMetric(ledger, {
            key: "slate.utr_count",
            label: "best fits under the radar",
            subjectRefs: [seed.ref],
            value: flagged.length,
            reason: "not_scored",
            display: `${flagged.length} of ${bestPlaced.length}`,
            unit: "count",
            badge: "DERIVED",
            formulaId: "slate.under_the_radar",
            evidenceIds: ids(state.evidence.scoring),
            n: bestPlaced.length,
            comparator: "WITHIN_CALL",
          }),
        );

  const market = new Map<number, Metric>();
  if (state.columns.length > 0) {
    for (const row of state.rows) {
      const j = row.best;
      const k = j === null ? -1 : state.members.indexOf(j);
      if (j === null || k < 0) continue;
      const best = bestMarket(state.columns, k);
      const present = "delta" in best;
      market.set(
        j,
        push(
          addSkillMetric(ledger, {
            key: "slate.market_alignment",
            label: `${nameOf(state, j)} · strongest market`,
            subjectRefs: present ? [state.refs[j]!.ref, best.column.market] : [state.refs[j]!.ref],
            value: present ? best.delta : null,
            reason: present ? "not_scored" : best.reason,
            display: present ? `${signed(best.delta)} in ${safeName(best.column.label)}` : "",
            unit: "delta",
            badge: "DERIVED",
            formulaId: "slate.market_alignment",
            evidenceIds: ids(state.evidence.scoring, state.evidence.markets),
            // The brands both percentiles rank: the members that market scored.
            n: present ? best.column.scored : null,
            comparator: "BASELINE",
          }),
        ),
      );
    }
  }

  // Shortlist brands that are not a best fit: their FIT, or the reason they have none, while the cap allows.
  const shortlist = state.candidates
    .flatMap((c, j) => (c.shortlisted && !fit.has(j) ? [j] : []))
    .sort((a, b) => (slate.fit[b]!.value ?? -1) - (slate.fit[a]!.value ?? -1) || a - b);
  const room = Math.max(0, MAX_SLATE_METRICS - run.metrics.length);
  for (const j of shortlist.slice(0, room)) {
    fit.set(j, fitMetric(j, `FIT · ${nameOf(state, j)} · shortlist`, "pct.within_call", ids(state.evidence.scoring)));
  }

  return { fit, bestFit, utrCount, market, uncited: shortlist.slice(room) };
}

/** Discovery results offered per category whose picks the scoring call all dropped. */
export const SUBSTITUTES_PER_CATEGORY = 2;
/** The shortlist cap of the tool input: the substitutes go beside the shortlist the call already had. */
const SHORTLIST_MAX = 10;

/**
 * The substitution behind the scoring call's DROPPED_CANDIDATES (SPEC §4.4, "substitute from the
 * discovery pool"): each category whose every pick the call dropped gets its next usable discovery
 * results, registered so the model can add them to the shortlist of the same slate. With the same
 * categories each brand keeps its category, the substitutes join theirs (discovery found them there)
 * and discovery is cached, so the follow-up costs the scoring call. Only drops (G2) count: a pick tied
 * at the floor has no measured fit, and a pool brand of lower discovery affinity cannot have one
 * either. Market drops get none: the market slate takes each category's best fit and runner-up, so a
 * substitute reaches a market call only by out-scoring them nationally, and the dropped brand's own
 * market call would only repeat. Null when no category lost every pick, its pool is empty or the
 * shortlist is full.
 */
function substitution(run: SlateRun, state: SlateState): FindingSuggestion | null {
  const room = SHORTLIST_MAX - state.candidates.filter((c) => c.shortlisted).length;
  const picks: { category: SponsorCategory; entity: RegisteredEntity }[] = [];
  for (const row of state.rows) {
    const members = state.candidates.flatMap((c, j) => (c.category === row.category ? [j] : []));
    if (row.best !== null || members.length === 0 || !members.every((j) => state.slate.fit[j]?.reason === "dropped")) continue;
    for (const draft of (state.pool.get(row.category) ?? []).slice(0, SUBSTITUTES_PER_CATEGORY)) {
      if (picks.length >= room || picks.some((p) => p.entity.entityId === draft.entityId)) continue;
      const reg = registerEntity(run.ctx.registry, draft);
      if (reg.isNew) run.registered.push(reg.entity);
      picks.push({ category: row.category, entity: reg.entity });
    }
  }
  if (picks.length === 0) return null;
  const labels = listLabels([...new Set(picks.map((p) => p.category))].map(categoryLabel));
  return {
    tool: "sponsor_slate",
    reason:
      `Score ${listLabels(picks.map((p) => safeName(p.entity.name)))} from the ${labels} discovery results instead: ` +
      `run sponsor_slate again with the same categories and ${picks.map((p) => p.entity.ref).join(", ")} added to the shortlist.`,
  };
}

/**
 * EMPTY_RESULT for categories whose discovery gave nothing usable (or found no tag), EMPTY_RESULT
 * for a scoring call that scored nothing, DROPPED_CANDIDATES for the scoring call (with the
 * substitution when a category lost every pick) and for the market calls: a brand a call did not
 * score is "not scored there", never a rank. Then WEAK_CATEGORY_FIT for the weakest best fit, one
 * finding at most, so the slate's digest keeps its room.
 */
export function addSlateFindings(run: SlateRun, state: SlateState, metrics: SlateMetrics): void {
  const empty = state.rows.filter((r) => r.reason === "not_measured" || r.reason === "quality_gate" || r.reason === "unavailable");
  if (empty.length > 0) {
    const labels = listLabels(empty.map((r) => categoryLabel(r.category)));
    addSlateFinding(
      run,
      emptyResultFinding({
        what: `Sponsor discovery for ${labels}`,
        suggestion: { tool: "resolve_entities", reason: `Resolve brands you expect in ${labels}, then pass them as the shortlist.` },
      }),
      empty.flatMap((r) => {
        const m = metrics.bestFit.get(r.category);
        return m === undefined ? [] : [m.id];
      }),
    );
  }

  const { slate } = state;
  const answered = state.evidence.scoring !== null && !slate.fit.some((c) => c.reason === "budget_truncated" || c.reason === "error");
  if (answered && state.candidates.length > 0 && slate.scored === 0) {
    addSlateFinding(run, emptyResultFinding({ what: "The one-scale scoring call", suggestion: null }), []);
  }
  if (answered) {
    const lost = state.candidates.flatMap((_, j) => (slate.fit[j]!.value === null ? [j] : []));
    const draft = droppedCandidatesFinding({
      names: lost.map((j) => nameOf(state, j)),
      context: "the one-scale scoring call",
      suggestion: lost.length === 0 ? null : substitution(run, state),
    });
    if (draft !== null) {
      addSlateFinding(run, draft, lost.flatMap((j) => (metrics.fit.has(j) ? [metrics.fit.get(j)!.id] : [])));
    }
  }

  const called = state.columns.filter((c) => c.gap === null);
  if (called.length > 0) {
    const lost = state.members.flatMap((j, k) => (called.some((c) => c.cells[k]?.value === null) ? [j] : []));
    const context = `the ${listLabels(called.map((c) => safeName(c.label)))} market ${called.length === 1 ? "call" : "calls"}`;
    const draft = droppedCandidatesFinding({ names: lost.map((j) => nameOf(state, j)), context });
    if (draft !== null) {
      addSlateFinding(run, draft, lost.flatMap((j) => (metrics.market.has(j) ? [metrics.market.get(j)!.id] : [])));
    }
  }

  const weakest = state.rows
    .flatMap((row) => (row.best === null || slate.fit[row.best]!.value === null ? [] : [{ row, cell: slate.fit[row.best]! }]))
    .sort((a, b) => a.cell.value! - b.cell.value!)[0];
  if (weakest !== undefined && weakest.row.best !== null) {
    const draft = weakCategoryFitFinding({
      categoryLabel: categoryLabel(weakest.row.category),
      bestName: nameOf(state, weakest.row.best),
      fitPct: weakest.cell.value,
      rank: weakest.cell.rank,
      scored: slate.scored,
    });
    const metric = metrics.bestFit.get(weakest.row.category);
    if (draft !== null && metric !== undefined) addSlateFinding(run, draft, [metric.id]);
  }
}

function slateEntry(state: SlateState, j: number): SlateEntry {
  const cell = state.slate.fit[j]!;
  const k = state.members.indexOf(j);
  return {
    ref: state.refs[j]!.ref,
    label: safeFullName(state.refs[j]!.name),
    fit: { value: cell.value, reason: cell.value === null ? (cell.reason ?? "not_scored") : null },
    popularity: state.slate.popularity[j] ?? null,
    utr: state.slate.utr[j] ?? false,
    topMarkets:
      k < 0
        ? []
        : topMarkets(state.columns, k).map(({ column, delta }) => ({
            market: column.market,
            label: safeFullName(column.label),
            delta,
          })),
  };
}

function addDataset(run: SlateRun, dataset: DatasetInput): DatasetId {
  const id = run.ctx.ledger.addDataset(dataset).id;
  run.datasetIds.push(id);
  return id;
}

/**
 * A market point on the Slope: pct_jm, or why there is none. A market that scored fewer than
 * MIN_MARKET_SCORED members draws no points, since a two-brand percentile is all 1s and 0s.
 */
function marketPoint(column: MarketColumn, k: number): CallCell {
  const cell = column.cells[k] ?? { value: null, reason: column.gap ?? "not_scored", rank: null };
  return cell.value !== null && column.scored < MIN_MARKET_SCORED ? { value: null, reason: "insufficient_n", rank: null } : cell;
}

/**
 * The Slate (RankedTable), the fit-against-popularity Quadrant and, when markets answered, the market
 * Slope. Returns the Quadrant's id (every candidate, placed or omitted), or null when nothing was placed.
 */
export function addSlateDatasets(run: SlateRun, state: SlateState): DatasetId | null {
  const { slate, seed } = state;
  const seedLabel = safeFullName(seed.name);
  // The tag lookup defines the looked-up categories, so the Slate cites it with the calls.
  const evidenceIds = ids(state.lookedUp.size > 0 ? state.evidence.tags : null, state.evidence.discovery, state.evidence.scoring, state.evidence.markets);
  const answered = state.columns.filter((c) => c.gap === null);

  addDataset(run, {
    kind: "Slate",
    title: `Sponsor slate · ${safeName(seed.name)}`,
    evidenceIds,
    formulaIds: ["slate.best_fit", "pct.within_call", "slate.under_the_radar", ...(answered.length > 0 ? (["slate.market_alignment"] as const) : []), "quality_gate"],
    payload: {
      seed: { ref: seed.ref, label: seedLabel },
      rows: state.rows.map((row) => ({
        category: row.category,
        label: categoryLabel(row.category),
        best: row.best === null ? null : slateEntry(state, row.best),
        runnerUp: row.runnerUp === null ? null : slateEntry(state, row.runnerUp),
        reason: row.best === null ? (row.reason ?? "not_measured") : null,
      })),
      markets: answered.map((c) => ({ id: c.market, label: safeFullName(c.label) })),
      caption: SLATE_CAPTION,
    },
  });

  let quadrant: DatasetId | null = null;
  if (slate.placed.length > 0 && slate.medianFit !== null && slate.medianPopularity !== null) {
    const bests = state.rows.flatMap((r) => (r.best === null ? [] : [r.best]));
    const others = slate.placed.filter((j) => !bests.includes(j) && slate.utr[j]).sort((a, b) => slate.fit[b]!.value! - slate.fit[a]!.value! || a - b);
    const labelled = new Set([...bests.filter((j) => slate.placed.includes(j)), ...others].slice(0, LABELLED_POINTS));
    quadrant = addDataset(run, {
      kind: "Quadrant",
      title: `Sponsor fit against popularity · ${safeName(seed.name)}`,
      evidenceIds: ids(state.evidence.scoring),
      formulaIds: ["slate.under_the_radar", "pct.within_call", "popularity"],
      payload: {
        xLabel: "Popularity",
        yLabel: "FIT (within-call percentile)",
        xUnit: "popularity",
        yUnit: "pct",
        xSplit: slate.medianPopularity,
        ySplit: slate.medianFit,
        quadrantLabels: SLATE_QUADRANT_LABELS,
        points: slate.placed.map((j) => {
          const c = state.candidates[j]!;
          return {
            key: state.refs[j]!.ref,
            label: safeFullName(state.refs[j]!.name),
            ref: state.refs[j]!.ref,
            x: slate.popularity[j]!,
            y: slate.fit[j]!.value!,
            quadrant: slate.quadrant[j]!,
            score: null,
            labelled: labelled.has(j),
            group: c.category === null ? SHORTLIST_GROUP : categoryLabel(c.category),
            utr: slate.utr[j] ?? false,
            geo: null,
          };
        }),
        omitted: state.candidates.flatMap((_, j) => {
          if (slate.placed.includes(j)) return [];
          const reason: NoValueReason = slate.fit[j]!.reason ?? "not_measured";
          return [{ label: safeFullName(state.refs[j]!.name), ref: state.refs[j]!.ref, reason }];
        }),
        belts: [],
        inset: null,
        caption: SLATE_CAPTION,
      },
    });
  }

  if (answered.length > 0) {
    const payload: SlopePayload = {
      axes: [{ key: "national", label: "National" }, ...state.columns.map((c) => ({ key: c.market, label: safeFullName(c.label) }))],
      scale: "pct",
      comparator: "BASELINE",
      valueLabel: "FIT (within-call percentile)",
      scoreLabel: null,
      lines: state.members.map((j, k) => {
        // National is re-ranked over the market slate, so both axes rank (at most) the same brands.
        const national = state.nationalOverSlate[k] ?? slate.fit[j]!;
        const cells: CallCell[] = [national, ...state.columns.map((c) => marketPoint(c, k))];
        const points = cells.map((p) => ({
          value: p.value,
          reason: p.value === null ? (p.reason ?? "not_scored") : null,
          rank: p.value === null ? null : p.rank,
        }));
        const first = points[0]?.value ?? null;
        const last = points[points.length - 1]?.value ?? null;
        return {
          key: state.refs[j]!.ref,
          label: safeFullName(state.refs[j]!.name),
          ref: state.refs[j]!.ref,
          points,
          delta: first === null || last === null ? null : last - first,
          highlight: topMarkets(state.columns, k).length > 0,
          score: null,
        };
      }),
    };
    addDataset(run, {
      kind: "Slope",
      title: `Sponsor market alignment · ${safeName(seed.name)}`,
      evidenceIds: ids(state.evidence.scoring, state.evidence.markets),
      formulaIds: ["slate.market_alignment", "pct.within_call"],
      payload,
    });
  }
  return quadrant;
}

/**
 * One row per category in input order, named by the category: the best fit's ref and the runner-up's
 * (names are in the metric labels and the registered list), or the reason there is none. Then
 * shortlist brands outside every category. Rows name the metrics instead of repeating their values:
 * the best-fit label carries the UNDER-THE-RADAR flag and the market display the strongest market.
 */
export function slateDigestRows(state: SlateState, metrics: SlateMetrics): DigestRow[] {
  const rows: DigestRow[] = state.rows.map((row): DigestRow => {
    const name = categoryLabel(row.category);
    const best_fit_metric = metrics.bestFit.get(row.category)?.id ?? null;
    if (row.best === null) return { ref: null, name, values: { best_fit_metric, unscored: row.reason ?? "not_measured" } };
    const j = row.best;
    return {
      ref: state.refs[j]!.ref,
      name,
      values: {
        best_fit_metric,
        runner_up: row.runnerUp === null ? null : state.refs[row.runnerUp]!.ref,
        market_metric: metrics.market.get(j)?.id ?? null,
      },
    };
  });
  state.candidates.forEach((c, j) => {
    if (c.category !== null || !c.shortlisted) return;
    const cell = state.slate.fit[j]!;
    rows.push({
      ref: state.refs[j]!.ref,
      name: nameOf(state, j),
      values: {
        category: "none (shortlist)",
        fit_metric: metrics.fit.get(j)?.id ?? null,
        under_the_radar: state.slate.utr[j] ? "yes" : "no",
        ...(cell.value === null ? { unscored: cell.reason ?? "not_scored" } : {}),
      },
    });
  });
  return rows;
}
