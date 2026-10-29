import {
  MODEL_DIGEST_MAX_ROWS,
  SponsorCategory,
  type DatasetId,
  type DigestRow,
  type Domain,
  type EvidenceId,
  type Finding,
  type Flag,
  type Metric,
  type MetricId,
  type NoValueReason,
  type QlooCallMeta,
  type RankedPayload,
  type RankedRow,
  type RegisteredEntity,
  type SkillCtx,
  type ValueCell,
} from "@ct/contracts";
import { emptyResultFinding, partnersOneCategoryFinding, popularityDominanceFinding, type FindingDraft } from "../../findings";
import type { FormulaId } from "../../formulas";
import { addSkillEvidence, addSkillMetric, insightTags, registerEntity } from "../common";
import { fixed2, safeFullName, safeName, safeText } from "../format";
import type { DomainNeighbourhood, Edge, NeighbourRow } from "./neighbourhood";
import { SPONSOR_CATEGORIES, tagsOverlap } from "../sponsorSlate/categories";
import { categoryBranchOf, DOMAIN_ITEM, DOMAIN_LABEL, DOMAIN_NOUN, type CrossDomainPlan } from "./requests";

/**
 * What one cross_domain run writes: an evidence bundle per domain call, a bounded metric set (per
 * domain the top FIT and the UNDER-THE-RADAR pick's score, plus one edge count), POPULARITY_DOMINANCE
 * and EMPTY_RESULT findings, the "Cultural neighbourhood" Ranked dataset with one group per domain
 * (the A08 lists, brands last for the margin figure) and the digest rows. Seed tags are described as
 * taste context next to the seeds, never as a genre filter or steer (P5: their direction depends on
 * the tag).
 */

/** Everything a run accumulates for its ledger output and digest. */
export interface XdomRun {
  ctx: SkillCtx;
  plan: CrossDomainPlan;
  /** The seeds' names for texts, e.g. "Brand Alpha and Artist Nova". */
  seedLabel: string;
  flags: Set<Flag>;
  evidenceIds: EvidenceId[];
  metrics: Metric[];
  findings: Finding[];
  datasetIds: DatasetId[];
  registered: RegisteredEntity[];
  notices: string[];
}

/** Why a domain has no answer: the budget refused its call, or the Qloo client failed it. */
export type DomainGap = Extract<NoValueReason, "budget_truncated" | "error">;

export type DomainOutcome =
  | { kind: "answered"; domain: Domain; meta: QlooCallMeta; hood: DomainNeighbourhood }
  | { kind: "gap"; domain: Domain; reason: DomainGap; code: string | null };

/** The metrics behind one answered domain; null where the domain has nothing to cite. */
export interface DomainMetrics {
  fit: Metric | null;
  utr: Metric | null;
}

export const XDOM_FORMULA_IDS: readonly FormulaId[] = ["pct.within_call", "popularity", "xdom.under_the_radar", "xdom.edge"];

/** A call with fewer rows than this is a thin result (§6.4). */
const THIN_ROWS = 5;

/** "1 artist", "15 artists". */
function count(n: number, noun: string): string {
  return `${n} ${n === 1 ? noun : `${noun}s`}`;
}

/** "A", "A and B", "A, B and C". */
export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function addFindingDraft(run: XdomRun, draft: FindingDraft, metricIds: readonly MetricId[]): Finding {
  const finding = run.ctx.ledger.addFinding({ ...draft, metricIds: [...metricIds] });
  run.findings.push(finding);
  return finding;
}

function capText(plan: CrossDomainPlan): string {
  return fixed2(plan.popularityMax);
}

function tagContext(plan: CrossDomainPlan): string {
  return plan.tags.length === 0 ? "" : `, with ${count(plan.tags.length, "seed tag")} as taste context`;
}

// Evidence ----------------------------------------------------------------------------------------------

/** One bundle per answered domain call, with its quality-gate drops, halo and edge count in the summary. */
export function recordDomainEvidence(run: XdomRun, meta: QlooCallMeta, hood: DomainNeighbourhood): EvidenceId | null {
  const flags: Flag[] = [];
  if (hood.gateDropped > 0) flags.push("QUALITY_GATE_DROPPED");
  if (hood.returned < THIN_ROWS) flags.push("THIN_RESULT");
  if (hood.notScored > 0) flags.push("NOT_SCORED");
  for (const f of flags) run.flags.add(f);

  const parts = [
    `${hood.scored} scored`,
    hood.notScored > 0 ? `${hood.notScored} not scored` : null,
    hood.gateDropped > 0 ? `${hood.gateDropped} dropped by the quality gate` : null,
  ].filter((p) => p !== null);
  const halo = hood.halo.length > 0 ? `; most often tagged ${hood.halo.map((h) => `${safeName(h.name)} (${h.count})`).join(", ")}` : "";
  const edges = run.plan.seeds.length >= 2 ? `; ${hood.withEdges} of ${hood.explained} explained results lean on one seed` : "";
  const bar =
    hood.medianFit === null || hood.medianPopularity === null
      ? null
      : `median FIT ${fixed2(hood.medianFit)}, median popularity ${fixed2(hood.medianPopularity)}`;
  const utr =
    bar === null
      ? ""
      : hood.pick === null
        ? `; no under-the-radar pick (${bar})`
        : `; under-the-radar pick ${safeName(hood.pick.entity.name)} (${bar})`;
  const evidence = addSkillEvidence(run.ctx.ledger, {
    skill: "cross_domain",
    purpose: `Cultural neighbourhood in ${DOMAIN_ITEM[hood.domain]}s for ${run.seedLabel}`,
    calls: [meta],
    status: hood.scored > 0 ? "ok" : "empty",
    summary:
      `${count(hood.returned, DOMAIN_ITEM[hood.domain])} under a popularity cap of ` +
      `${capText(run.plan)}${tagContext(run.plan)}: ${parts.join(", ")}${halo}${utr}${edges}.`,
    flags,
    qualityGateDrops: hood.gateDropped,
  });
  if (evidence !== null) run.evidenceIds.push(evidence.id);
  return evidence?.id ?? null;
}

// Registry ----------------------------------------------------------------------------------------------

/** One digest row: a shown result of a domain, or the status of a domain without scored results. */
export type DigestSlot =
  | { kind: "row"; hood: DomainNeighbourhood; row: NeighbourRow }
  | { kind: "status"; domain: Domain; status: DomainGap | "empty" };

/**
 * The 12 digest rows in priority order: every domain's top row (or its status row), then every
 * domain's UTR pick, then further rows by FIT, one per domain in turn. fitSkillDigest trims rows
 * from the end, so a tight budget drops the extra rows first and every domain keeps its top row.
 */
export function selectShown(outcomes: readonly DomainOutcome[]): DigestSlot[] {
  const slots: DigestSlot[] = [];
  const taken = new Set<NeighbourRow>();
  const add = (hood: DomainNeighbourhood, row: NeighbourRow | null | undefined): void => {
    if (row === null || row === undefined || taken.has(row) || slots.length >= MODEL_DIGEST_MAX_ROWS) return;
    taken.add(row);
    slots.push({ kind: "row", hood, row });
  };
  const hoods: DomainNeighbourhood[] = [];
  for (const o of outcomes) {
    if (o.kind === "gap") slots.push({ kind: "status", domain: o.domain, status: o.reason });
    else if (o.hood.scored === 0) slots.push({ kind: "status", domain: o.domain, status: "empty" });
    else {
      hoods.push(o.hood);
      add(o.hood, o.hood.top);
    }
  }
  for (const h of hoods) add(h, h.pick);
  const scored = new Map(hoods.map((h) => [h, h.rows.filter((r) => r.fit !== null)]));
  for (let depth = 1; slots.length < MODEL_DIGEST_MAX_ROWS && hoods.some((h) => depth < (scored.get(h)?.length ?? 0)); depth++) {
    for (const h of hoods) add(h, scored.get(h)?.[depth]);
  }
  return slots;
}

/**
 * Registers the entities the digest shows, in digest order, so the model holds a ref for each one it
 * may name or pivot on. The other results stay in the dataset only, which keeps the digest within
 * budget.
 */
export function registerShown(run: XdomRun, slots: readonly DigestSlot[]): void {
  for (const slot of slots) {
    if (slot.kind !== "row") continue;
    const { row } = slot;
    const reg = registerEntity(run.ctx.registry, {
      entityId: row.entity.entity_id,
      name: row.entity.name,
      type: slot.hood.domain,
      popularity: row.popularity,
      disambiguation: row.entity.disambiguation ?? null,
      tags: insightTags(row.entity.tags),
    });
    if (reg.isNew) run.registered.push(reg.entity);
  }
}

/** Seed entity id → seed ref, for explainability edges. */
function seedRefsOf(run: XdomRun): Map<string, RegisteredEntity["ref"]> {
  return new Map(run.plan.seeds.map((s) => [s.entityId, s.ref]));
}

/** Seed shares keyed by seed ref instead of Qloo id; a seed the plan does not hold is left out. */
export function refShares(
  list: readonly Edge[],
  seedRefs: ReadonlyMap<string, RegisteredEntity["ref"]>,
): { seedRef: RegisteredEntity["ref"]; share: number }[] {
  return list.flatMap((e) => {
    const seedRef = seedRefs.get(e.seedEntityId);
    return seedRef === undefined ? [] : [{ seedRef, share: e.share }];
  });
}

function refOf(run: XdomRun, entityId: string): RegisteredEntity["ref"] | null {
  return run.ctx.registry.byEntityId(entityId)?.ref ?? null;
}

/** A row's metric subject: its ref, which registerShown gave every row a metric names. */
function subjectOf(run: XdomRun, row: NeighbourRow): string[] {
  const ref = refOf(run, row.entity.entity_id);
  return ref === null ? [] : [ref];
}

/** "0.45 · fit 0.86 − popularity 0.41": U with the two values it subtracts. */
function utrDisplay(row: NeighbourRow): string {
  if (row.utr === null || row.fit === null || row.popularity === null) return "";
  return `${fixed2(row.utr)} · fit ${fixed2(row.fit)} − popularity ${fixed2(row.popularity)}`;
}

// Metrics -----------------------------------------------------------------------------------------------

/**
 * Per answered domain: the top result's FIT (shown as its rank) and the UNDER-THE-RADAR pick's score,
 * both cited to the domain's call. Labels leave the entity's name to the subject ref and the digest
 * row. A domain whose results all lack a popularity records U as not measured; a domain where no
 * result clears the pick bar records no U, and its top row says so. At most 2 per domain, 10 for
 * five domains.
 */
export function addDomainMetrics(run: XdomRun, hood: DomainNeighbourhood, evidenceId: EvidenceId): DomainMetrics {
  const top = hood.top;
  if (top === null) return { fit: null, utr: null };
  const noun = DOMAIN_NOUN[hood.domain];
  const push = (m: Metric) => {
    run.metrics.push(m);
    return m;
  };

  const fit = push(
    addSkillMetric(run.ctx.ledger, {
      key: "xdom.fit",
      label: `${noun} · FIT of the top result`,
      subjectRefs: subjectOf(run, top),
      value: top.fit,
      reason: "not_scored",
      display: `rank ${top.rank ?? 1} of ${hood.scored}`,
      unit: "pct",
      badge: "DERIVED",
      formulaId: "pct.within_call",
      evidenceIds: [evidenceId],
      n: hood.scored,
      comparator: "WITHIN_CALL",
    }),
  );

  const pick = hood.pick;
  const measured = hood.scored - hood.missingPopularity;
  if (pick === null && measured > 0) return { fit, utr: null };
  const utr = push(
    addSkillMetric(run.ctx.ledger, {
      key: "xdom.under_the_radar",
      label: pick === null ? `${noun} · under-the-radar score` : `${noun} · under-the-radar pick`,
      subjectRefs: pick === null ? run.plan.seeds.map((s) => s.ref) : subjectOf(run, pick),
      value: pick?.utr ?? null,
      reason: "not_measured",
      display: pick === null ? "" : utrDisplay(pick),
      unit: "score",
      badge: "DERIVED",
      formulaId: "xdom.under_the_radar",
      evidenceIds: [evidenceId],
      n: measured,
      comparator: "WITHIN_CALL",
    }),
  );
  return { fit, utr };
}

/**
 * Results whose explainability leans on one seed (share·K ≥ 1.1, G15), over every answered domain.
 * Only with two or more seeds: with one, every result is explained by it alone.
 */
export function addEdgeMetric(run: XdomRun, hoods: readonly DomainNeighbourhood[], evidenceIds: readonly EvidenceId[]): Metric | null {
  // With nothing scored there is no result to explain; EMPTY_RESULT already says so.
  if (run.plan.seeds.length < 2 || evidenceIds.length === 0 || hoods.every((h) => h.scored === 0)) return null;
  const explained = hoods.reduce((n, h) => n + h.explained, 0);
  const withEdges = hoods.reduce((n, h) => n + h.withEdges, 0);
  const metric = addSkillMetric(run.ctx.ledger, {
    key: "xdom.edge",
    label: "results leaning on one seed (share·K ≥ 1.1)",
    subjectRefs: run.plan.seeds.map((s) => s.ref),
    value: explained > 0 ? withEdges : null,
    reason: "not_measured",
    display: `${withEdges} of ${explained} results`,
    unit: "count",
    badge: "DERIVED",
    formulaId: "xdom.edge",
    evidenceIds,
    n: explained,
    comparator: null,
  });
  run.metrics.push(metric);
  return metric;
}

// Findings ----------------------------------------------------------------------------------------------

/** How to broaden an empty domain: a higher cap, then fewer seed tags; null when neither applies. */
function broadenReason(plan: CrossDomainPlan, domain: Domain): string | null {
  const noun = DOMAIN_NOUN[domain];
  const ways = [
    plan.popularityMax < 1 ? "a higher popularity_max" : null,
    plan.tags.length > 0 ? "without seed_tags" : null,
  ].filter((w) => w !== null);
  return ways.length === 0 ? null : `Re-run the ${noun} domain with ${ways.join(" or ")}.`;
}

/** EMPTY_RESULT for a domain with nothing scored. */
export function addEmptyFinding(run: XdomRun, hood: DomainNeighbourhood): void {
  if (hood.scored > 0) return;
  const reason = broadenReason(run.plan, hood.domain);
  addFindingDraft(
    run,
    emptyResultFinding({
      what: `the ${DOMAIN_NOUN[hood.domain]} call for ${run.seedLabel}`,
      suggestion: reason === null ? null : { tool: "cross_domain", reason },
    }),
    [],
  );
}

/** The results POPULARITY_DOMINANCE judges: every row but the quality-gate drops, in result order. */
function dominanceResults(hood: DomainNeighbourhood): { fit: number | null; popularity: number | null }[] {
  return hood.rows.filter((r) => r.reason !== "quality_gate").map((r) => ({ fit: r.fit, popularity: r.popularity }));
}

/**
 * POPULARITY_DOMINANCE: the builder judges each scored domain on its own results, and the domains
 * it flags share one finding per wording, citing each one's metrics. The cap it suggests lowering is
 * one value for the whole call, so five findings would repeat one re-run (and crowd the digest rows).
 */
export function addPopularityFindings(
  run: XdomRun,
  hoods: readonly DomainNeighbourhood[],
  metrics: ReadonlyMap<Domain, DomainMetrics>,
): void {
  const popularityMax = run.plan.popularityMax;
  // A neutral context makes the wording the only difference, so the drafts group by text.
  const byWording = new Map<string, DomainNeighbourhood[]>();
  for (const hood of hoods) {
    if (hood.scored === 0) continue;
    const probe = popularityDominanceFinding({ context: "these results", results: dominanceResults(hood), popularityMax });
    if (probe === null) continue;
    byWording.set(probe.text, [...(byWording.get(probe.text) ?? []), hood]);
  }
  for (const group of byWording.values()) {
    const [first] = group;
    if (first === undefined) continue;
    const draft = popularityDominanceFinding({
      context: `the ${joinNames(group.map((h) => DOMAIN_NOUN[h.domain]))} results`,
      results: dominanceResults(first),
      popularityMax,
    });
    if (draft === null) continue;
    const ids = group.flatMap((h) => [metrics.get(h.domain)?.fit?.id, metrics.get(h.domain)?.utr?.id]);
    addFindingDraft(run, draft, ids.filter((id): id is MetricId => id !== undefined));
  }
}

/** "urn:tag:genre:brand:food_and_beverage" → "food and beverage", for a branch no row names. */
function branchWords(branchId: string): string {
  return branchId.slice(branchId.lastIndexOf(":") + 1).replace(/_/g, " ");
}

/** A row tag sits in a sponsor category when it is the category's tag or a leaf under it. */
const inCategoryTag = (rowTag: string, categoryTag: string): boolean => rowTag === categoryTag || rowTag.startsWith(`${categoryTag}:`);

/**
 * PARTNERS_ONE_CATEGORY for the brand domain when a seed is a brand (brand_collab, CR 3): the scored
 * brand rows outside the seeds' own categories, grouped by their top-level genre:brand branch. The
 * suggestion's categories are the sponsor categories with a verified tag that no scored partner sits
 * in and that are not the seeds' own; a category whose tag is found only at run time is left out,
 * since the partners' coverage of it cannot be told.
 */
export function addPartnersCategoryFinding(run: XdomRun, hoods: readonly DomainNeighbourhood[], metrics: ReadonlyMap<Domain, DomainMetrics>): void {
  const subject = run.plan.seeds.find((s) => s.type === "brand");
  const hood = hoods.find((h) => h.domain === "brand");
  if (subject === undefined || hood === undefined || hood.scored === 0) return;
  const own = run.plan.excludeTags.map((t) => t.tagId);
  const isOwn = (tagId: string): boolean => own.some((o) => tagsOverlap(tagId, o));
  const partners = hood.rows.filter((r) => r.fit !== null).filter((r) => {
    const branch = categoryBranchOf(r)?.tagId ?? null;
    return branch === null || !isOwn(branch);
  });
  const counts = new Map<string, number>();
  for (const r of partners) {
    const branch = categoryBranchOf(r)?.tagId ?? null;
    if (branch !== null) counts.set(branch, (counts.get(branch) ?? 0) + 1);
  }
  const [top] = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  if (top === undefined) return;
  const [branchId, inCategory] = top;
  const named = partners.flatMap((r) => r.tags).find((t) => t.tagId === branchId);
  const rowTags = partners.flatMap((r) => r.tags.map((t) => t.tagId));
  const otherCategories = SponsorCategory.options.filter((c) => {
    const tag = SPONSOR_CATEGORIES[c].tag;
    return tag !== null && !isOwn(tag) && !rowTags.some((t) => inCategoryTag(t, tag));
  });
  const draft = partnersOneCategoryFinding({
    subjectName: safeName(subject.name),
    subjectRef: subject.ref,
    categoryLabel: named === undefined ? branchWords(branchId) : safeName(named.name),
    inCategory,
    scored: partners.length,
    otherCategories,
  });
  if (draft === null) return;
  const m = metrics.get("brand");
  addFindingDraft(run, draft, [m?.fit?.id, m?.utr?.id].filter((id): id is MetricId => id !== undefined));
}

// Dataset -----------------------------------------------------------------------------------------------

const COLUMNS: RankedPayload["columns"] = [
  { key: "fit", label: "Fit", unit: "pct", comparator: "WITHIN_CALL" },
  { key: "popularity", label: "Popularity", unit: "popularity", comparator: null },
  { key: "utr", label: "Under the radar (fit − popularity)", unit: "score", comparator: null },
];

const cell = (value: number | null, reason: NoValueReason): ValueCell =>
  value === null ? { value: null, reason } : { value, reason: null };

/** U is missing because the row is unscored or dropped, else because Qloo sent no popularity. */
function utrReason(row: NeighbourRow): NoValueReason {
  return row.reason ?? "not_measured";
}

function rankedRow(run: XdomRun, hood: DomainNeighbourhood, row: NeighbourRow, seedRefs: ReadonlyMap<string, RegisteredEntity["ref"]>): RankedRow {
  const gated = row.reason === "quality_gate";
  return {
    key: `${hood.domain}-${row.position}`,
    rank: row.rank,
    label: safeFullName(row.entity.name),
    sublabel: row.genre === null ? null : safeName(row.genre.name),
    ref: refOf(run, row.entity.entity_id),
    tagRef: null,
    type: hood.domain,
    cells: [cell(row.fit, row.reason ?? "not_scored"), cell(row.popularity, "not_measured"), cell(row.utr, utrReason(row))],
    // The pick already passed the bar (neighbourhood.isUnderTheRadar), so a flag is never just FIT 1.
    flags: row === hood.pick ? ["UTR"] : [],
    explain: gated ? [] : refShares(row.edges, seedRefs),
    ...(gated || row.shares.length === 0 ? {} : { shares: refShares(row.shares, seedRefs) }),
  };
}

const GAP_TEXT: Readonly<Record<DomainGap | "empty", string>> = {
  budget_truncated: "call not made: run budget reached",
  error: "call failed",
  empty: "no results under this popularity cap",
};

/** A domain without rows keeps its group with one explained row, so it never reads as an empty list. */
function gapRow(domain: Domain, why: DomainGap | "empty"): RankedRow {
  const reason: NoValueReason = why === "empty" ? "not_measured" : why;
  return {
    key: `${domain}-gap`,
    rank: null,
    label: "Not measured",
    sublabel: GAP_TEXT[why],
    ref: null,
    tagRef: null,
    type: domain,
    cells: COLUMNS.map(() => ({ value: null, reason })),
    flags: [],
    explain: [],
  };
}

function caption(plan: CrossDomainPlan): string {
  const tags = plan.tags.length > 0 ? " Seed tags are taste context next to the seeds, not a genre filter." : "";
  return (
    `FIT is the within-call percentile in each domain; popularity capped at ${capText(plan)}; ` +
    `under the radar = FIT − popularity, not price; UTR marks the highest one with FIT at or above the domain's median ` +
    `and popularity below its median. Explainability is attribution inside Qloo's model, not causation.${tags}`
  );
}

/** The "Cultural neighbourhood" Ranked dataset: one group per requested domain, in DOMAIN_ORDER. */
export function addNeighbourhoodDataset(run: XdomRun, outcomes: readonly DomainOutcome[]): void {
  const gateDrops = outcomes.some((o) => o.kind === "answered" && o.hood.gateDropped > 0);
  const seedRefs = seedRefsOf(run);
  const groups = outcomes.map((o) => {
    const rows =
      o.kind === "gap"
        ? [gapRow(o.domain, o.reason)]
        : o.hood.rows.length === 0
          ? [gapRow(o.domain, "empty")]
          : o.hood.rows.map((r) => rankedRow(run, o.hood, r, seedRefs));
    return { key: o.domain, label: DOMAIN_LABEL[o.domain], rows };
  });
  const dataset = run.ctx.ledger.addDataset({
    kind: "Ranked",
    // Named after its seeds: a run that asks twice holds two neighbourhoods.
    title: `Cultural neighbourhood · ${run.seedLabel}`,
    evidenceIds: [...run.evidenceIds],
    formulaIds: [
      ...XDOM_FORMULA_IDS.filter((id) => id !== "xdom.edge" || run.plan.seeds.length >= 2),
      ...(gateDrops ? (["quality_gate"] as const) : []),
    ],
    payload: { columns: COLUMNS, groups, caption: caption(run.plan) },
  });
  run.datasetIds.push(dataset.id);
}

// Digest rows --------------------------------------------------------------------------------------------

/** Tag names in digest rows are cut here (the dataset keeps them whole), so ten rows fit the worst case. */
const GENRE_CHARS = 30;
const HALO_TAG_CHARS = 24;

/**
 * The digest rows in selectShown's priority order, each with its domain; a row names the metric that
 * holds its numbers instead of repeating them, since a bare decimal is one the model cannot write. A
 * domain without scored results gets one status row, so the model sees every requested domain, and
 * a domain without a pick says so on its top row.
 */
export function xdomDigestRows(run: XdomRun, slots: readonly DigestSlot[], metrics: ReadonlyMap<Domain, DomainMetrics>): DigestRow[] {
  const seeds = seedRefsOf(run);
  return slots.map((slot): DigestRow => {
    if (slot.kind === "status") return { ref: null, name: DOMAIN_LABEL[slot.domain], values: { domain: slot.domain, status: slot.status } };
    const { hood, row } = slot;
    const m = metrics.get(hood.domain);
    const values: DigestRow["values"] = { domain: hood.domain, rank: row.rank, genre: row.genre === null ? null : safeText(row.genre.name, GENRE_CHARS) };
    if (row === hood.top) {
      values.fit_metric = m?.fit?.id ?? null;
      if (hood.halo.length > 0) values.domain_tags = hood.halo.map((h) => safeText(h.name, HALO_TAG_CHARS)).join(", ");
      if (hood.pick === null) {
        // No popularity at all points to the UNAVAILABLE metric; otherwise no result cleared the bar.
        const unmeasured = hood.missingPopularity === hood.scored;
        values.under_the_radar = unmeasured ? "not measured" : "none";
        if (unmeasured) values.utr_metric = m?.utr?.id ?? null;
      }
    }
    if (row === hood.pick) {
      values.utr_metric = m?.utr?.id ?? null;
      values.under_the_radar = "pick";
    }
    if (row.popularity === null) values.popularity = "not measured";
    if (row.edges.length > 0) values.leans_on = refShares(row.edges, seeds).map((e) => e.seedRef).join(", ");
    return { ref: refOf(run, row.entity.entity_id), name: safeName(row.entity.name), values };
  });
}
