import {
  ANALYST_TOOLS,
  entityTypeUrn,
  isTaxonomyTag,
  type CacheProbe,
  type DigestRow,
  type EntityRegistry,
  type EntityType,
  type EvidenceId,
  type Flag,
  type Metric,
  type QlooEntity,
  type QlooEntityInsightsResponse,
  type QlooParams,
  type QlooResult,
  type RankedRow,
  type RegisteredEntity,
  type RegisteredTag,
  type SkillCtx,
  type SkillFor,
  type SkillResult,
  type ToolInput,
} from "@ct/contracts";
import { analogVetoedFinding, emptyResultFinding } from "../findings";
import { SKILL_LIMITATIONS } from "../limitations";
import { THIN_SAMPLE } from "../formulas";
import { addSkillEvidence, addSkillMetric, attemptAllKeepingFailures, conceptReadOf, countUncached, insightTags, registerEntity, type Attempt } from "./common";
import { skillErrorResult, type DigestTarget } from "./digest";
import { addFindingDraft, finishBlockRun, type BlockRun } from "./blockDna/outputs";
import { safeFullName, safeName } from "./format";
import { rankParams } from "./rankCandidates/scoring";
import {
  addsOf,
  analogPrecision,
  judgeAnalogs,
  OPEN_TAKE,
  openFloor,
  readOpenCall,
  type AnalogVerdict,
  type OpenRead,
} from "./conceptVector/scoring";

/**
 * S12 concept_vector, Concept Vector (PLAN §4.3, SPEC S12): tests the analogs a concept is expected
 * to resemble against the concept's own taste. One open call ranks the type for the concept tags;
 * its 50th scored result is the anchor (s50). One scoring call holds the analogs, the anchor and the
 * top result under the same tags, so each KEEP or VETO compares scores inside that call (CHECKER V6).
 * The open call's best results the analogs missed are the ADD list. Types are the ones the allowlist
 * scores from tags with filter.results.entities (brand, artist, podcast, tv_show, movie).
 */

type ConceptInput = ToolInput<"concept_vector">;

/** A call with fewer rows than this is a thin result (§6.4). */
const THIN_ROWS = 5;

interface Resolved {
  tags: RegisteredTag[];
  analogs: RegisteredEntity[];
  notices: string[];
}

function resolve(input: ConceptInput, registry: EntityRegistry): Resolved {
  const notices: string[] = [];
  const tags: RegisteredTag[] = [];
  for (const ref of input.concept_tags) {
    const tag = registry.tag(ref);
    if (tag === null) notices.push(`${ref} is not in the registry; left out.`);
    else if (!isTaxonomyTag(tag.tagId)) notices.push(`${ref} (${safeName(tag.name)}) is a descriptive tag, which gives no taste signal; left out.`);
    else if (tag.conceptMatch === "proxy")
      notices.push(`${ref} (${safeName(tag.name)}) is a look-alike tag for the question's concept, which the data does not hold; left out (no verdict comes from a look-alike).`);
    else tags.push(tag);
  }
  const analogs: RegisteredEntity[] = [];
  for (const ref of input.analogs) {
    const e = registry.entity(ref);
    if (e === null) notices.push(`${ref} is not in the registry; left out.`);
    else if (e.type !== input.type) notices.push(`${ref} (${safeName(e.name)}) is a ${e.type}, not a ${input.type}; left out.`);
    else analogs.push(e);
  }
  return { tags, analogs, notices };
}

const signalOf = (tags: readonly RegisteredTag[]): QlooParams => ({ "signal.interests.tags": tags.map((t) => t.tagId) });
const openParams = (tags: readonly RegisteredTag[]): QlooParams => ({ ...signalOf(tags), take: OPEN_TAKE });

/** The open call is probed; the scoring call names the anchor, unknown before the open call, so it counts. */
export async function estimateConceptVectorCalls(input: ConceptInput, probe: CacheProbe, registry: EntityRegistry): Promise<number> {
  const { tags, analogs } = resolve(input, registry);
  if (tags.length === 0) return 0;
  const open = await countUncached(probe, "/v2/insights", [{ "filter.type": entityTypeUrn(input.type), ...openParams(tags) }]);
  return open + (analogs.length > 0 ? 1 : 0);
}

type EntityAttempt = Attempt<QlooResult<QlooEntityInsightsResponse>>;

function draftOf(e: QlooEntity, type: EntityType): Omit<RegisteredEntity, "ref"> {
  return {
    entityId: e.entity_id,
    name: e.name,
    type,
    popularity: e.popularity ?? null,
    disambiguation: e.disambiguation ?? null,
    tags: insightTags(e.tags),
  };
}

/** "1st", "2nd", "3rd", "11th", "48th". */
function ordinal(n: number): string {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `${n}${suffix}`;
}

/**
 * The anchor as every label names it: "the 50th result", or with fewer results ranked "the 48th result
 * (the last ranked)", so no label claims a 50th result the call did not return.
 */
export function anchorText(ranked: number): string {
  const position = Math.min(OPEN_TAKE, ranked);
  return position < OPEN_TAKE ? `the ${ordinal(position)} result (the last ranked)` : `the ${ordinal(OPEN_TAKE)} result`;
}

function verdictText(verdict: AnalogVerdict["verdict"], anchor: string): string {
  if (verdict === "KEEP") return `kept: scores at or above the concept's ${anchor.replace(/^the /u, "")}`;
  if (verdict === "VETO") return `vetoed: scores below the concept's ${anchor.replace(/^the /u, "")}`;
  return "not scored";
}

async function runConceptVector(input: ConceptInput, ctx: SkillCtx): Promise<SkillResult> {
  const out: DigestTarget = { tool: "concept_vector", step: input.step_id };
  const { tags, analogs, notices } = resolve(input, ctx.registry);
  if (tags.length === 0) {
    const proxyOnly = input.concept_tags.some((ref) => ctx.registry.tag(ref)?.conceptMatch === "proxy");
    const why = proxyOnly
      ? "The concept is not in the data: the only tags given are look-alikes, so nothing was tested and no keep or veto is given. Use its broader category (a category-level read) or say the concept is not in the data."
      : "No taxonomy concept tag is left to signal with; look one up with find_tags.";
    return skillErrorResult(out, [...notices, why].join(" "));
  }
  const filterType = entityTypeUrn(input.type);
  const label = tags.map((t) => safeName(t.name)).join(" + ");
  // R2 (D48): concept tags that are only the concept's broader category give a category-level read: the
  // analogs are scored against the category, with no keep, veto or ADD list.
  const conceptRead = conceptReadOf(tags.map((t) => t.ref), ctx.registry);
  const categoryLevel = conceptRead === "category";
  const conceptName = ctx.concepts.length > 0 ? ctx.concepts.map((c) => safeName(c)).join(" + ") : label;
  const noun = input.type.replace("_", " ");

  const [openA] = (await attemptAllKeepingFailures([() => ctx.qloo.insights(filterType, openParams(tags))], ctx.signal)) as [EntityAttempt | undefined];
  if (openA?.kind === "failed") throw openA.error;
  const run: BlockRun = { ctx, flags: new Set(), evidenceIds: [], metrics: [], findings: [], datasetIds: [], registered: [], notices };
  if (openA === undefined || openA.kind !== "ok") {
    run.flags.add("BUDGET_TRUNCATED");
    run.notices.push("The call budget ran out before the open concept call; nothing was measured.");
    return finishBlockRun(run, out, "partial", []);
  }
  const open: OpenRead = readOpenCall(openA.value.data.results.entities);
  const openFlags: Flag[] = [];
  if (open.rows < THIN_ROWS) openFlags.push("THIN_RESULT");
  if (open.unscored > 0) openFlags.push("NOT_SCORED");
  if (open.gateDropped > 0) openFlags.push("QUALITY_GATE_DROPPED");
  if (openA.value.meta.stale) openFlags.push("STALE_CACHE");
  for (const f of openFlags) run.flags.add(f);
  const openE = addSkillEvidence(ctx.ledger, {
    skill: "concept_vector",
    purpose: `Open concept call: the top ${OPEN_TAKE} ${noun}s for ${label}`,
    calls: [openA.value.meta],
    status: open.ranked.length === 0 ? "empty" : "ok",
    summary: `${open.ranked.length} of ${open.rows} results ranked${open.unscored > 0 ? `, ${open.unscored} without a measurable score` : ""}${open.gateDropped > 0 ? `, ${open.gateDropped} below the popularity quality gate` : ""}.`,
    flags: openFlags,
    qualityGateDrops: open.gateDropped,
  });
  if (openE !== null) run.evidenceIds.push(openE.id);

  if (open.anchor === null) {
    addFindingDraft(run, emptyResultFinding({ what: `the open ${noun} call for ${label}`, suggestion: { tool: "find_tags", reason: "Look up a broader taxonomy tag for the concept." } }), []);
    return finishBlockRun(run, out, "empty", []);
  }
  if (open.ranked.length < OPEN_TAKE) {
    run.notices.push(`Only ${open.ranked.length} ${noun}s were ranked for the concept, so the anchor is the last of them, not the 50th: the bar is lower than usual.`);
  }
  const anchor = anchorText(open.ranked.length);

  // The scoring call: analogs, the anchor and the top result, under the same tags.
  const anchorId = open.anchor.entity.entity_id;
  const topId = open.top?.entity.entity_id ?? null;
  let verdicts: AnalogVerdict[] = [];
  let scoringE: EvidenceId | null = null;
  let truncated = false;
  // The scoring call did not run, failed, or could not judge anything (no anchor score, order not reproduced).
  let unjudged = false;
  if (analogs.length > 0) {
    const ids = [...new Set([...analogs.map((a) => a.entityId), anchorId, ...(topId === null ? [] : [topId])])];
    const [scoreA] = (await attemptAllKeepingFailures([() => ctx.qloo.insights(filterType, rankParams(signalOf(tags), ids))], ctx.signal)) as [EntityAttempt | undefined];
    if (scoreA?.kind === "ok") {
      const read = judgeAnalogs(
        analogs.map((a) => a.entityId),
        anchorId,
        topId,
        scoreA.value.data.results.entities,
        openFloor(openA.value.data.results.entities),
      );
      verdicts = read.verdicts;
      if (read.blocked !== null) {
        unjudged = true;
        run.notices.push(`No analog was judged: ${read.blocked}.`);
      }
      const flags: Flag[] = [];
      if (verdicts.some((v) => v.verdict === "NOT_SCORED")) flags.push("NOT_SCORED");
      if (scoreA.value.meta.stale) flags.push("STALE_CACHE");
      for (const f of flags) run.flags.add(f);
      const e = addSkillEvidence(ctx.ledger, {
        skill: "concept_vector",
        purpose: `Scoring call: ${analogs.length} analog${analogs.length === 1 ? "" : "s"} beside the concept's anchor (${anchor}) and top result`,
        calls: [scoreA.value.meta],
        status: read.blocked === null ? "ok" : "partial",
        summary: `${verdicts.filter((v) => v.verdict !== "NOT_SCORED").length} of ${analogs.length} analogs judged against the anchor in one call.`,
        flags,
      });
      if (e !== null) {
        scoringE = e.id;
        run.evidenceIds.push(e.id);
      }
    } else {
      truncated = scoreA?.kind === "truncated";
      unjudged = true;
      const why = truncated ? "the call budget ran out" : `the scoring call failed (${scoreA?.kind === "failed" ? scoreA.code : "not made"})`;
      if (truncated) run.flags.add("BUDGET_TRUNCATED");
      verdicts = analogs.map((a) => ({ entityId: a.entityId, verdict: "NOT_SCORED" as const, margin: null, why }));
      run.notices.push(`No analog was judged: ${why}.`);
    }
  }

  // ADD: the concept's own picks, registered so a follow-up can rank them.
  const analogIds = new Set(analogs.map((a) => a.entityId));
  const adds = (categoryLevel ? [] : addsOf(open, analogIds)).map((row) => {
    const reg = registerEntity(ctx.registry, draftOf(row.entity, input.type));
    if (reg.isNew) run.registered.push(reg.entity);
    return { row, entity: reg.entity };
  });

  // Metrics.
  const verdictEvidence = [openE?.id, scoringE].filter((e): e is EvidenceId => e !== undefined && e !== null);
  const verdictMetrics = new Map<string, Metric>();
  analogs.forEach((a, i) => {
    const v = verdicts[i] as AnalogVerdict;
    const m = addSkillMetric(ctx.ledger, {
      key: "cnpt.verdict",
      label: `${safeName(a.name)} against ${anchor} for ${label}, a ${noun} (same Qloo call)`,
      subjectRefs: [a.ref, ...tags.map((t) => t.ref)],
      value: v.margin,
      reason: truncated ? "budget_truncated" : "not_scored",
      display:
        v.verdict === "NOT_SCORED"
          ? ""
          : categoryLevel
            ? `${v.verdict === "KEEP" ? "at or above" : "below"} ${anchor} of the category (category-level read)`
            : v.verdict === "KEEP"
              ? `KEEP: at or above ${anchor}`
              : `VETO: below ${anchor}`,
      unit: "delta",
      badge: "DERIVED",
      formulaId: "cnpt.verdict",
      evidenceIds: verdictEvidence,
      n: null,
      comparator: "WITHIN_CALL",
      conceptRead,
    });
    run.metrics.push(m);
    verdictMetrics.set(a.entityId, m);
  });
  const { keep, veto, precision } = analogPrecision(verdicts);
  const precisionMetric =
    analogs.length === 0
      ? null
      : addSkillMetric(ctx.ledger, {
          key: "cnpt.precision",
          label: `share of your ${noun} analogs the concept's taste keeps (${label})`,
          subjectRefs: tags.map((t) => t.ref),
          value: precision,
          reason: truncated ? "budget_truncated" : "not_scored",
          display:
            precision === null
              ? ""
              : categoryLevel
                ? `${keep} of ${keep + veto} ${noun} analogs at or above the category's anchor (${Math.round(precision * 100)}%, category-level read)`
                : `${keep} of ${keep + veto} ${noun} analogs kept (${Math.round(precision * 100)}%)`,
          unit: "pct",
          badge: "DERIVED",
          formulaId: "cnpt.precision",
          evidenceIds: verdictEvidence,
          n: keep + veto,
          comparator: "WITHIN_CALL",
          conceptRead,
          thin: keep + veto < THIN_SAMPLE.conceptAnalogs,
        });
  if (precisionMetric !== null) run.metrics.push(precisionMetric);

  // Finding.
  const vetoed = analogs.filter((_, i) => verdicts[i]?.verdict === "VETO");
  // A category-level read vetoes nothing (R2): no ANALOG_VETOED.
  const draft = categoryLevel ? null : analogVetoedFinding({
    conceptLabel: label,
    anchor,
    vetoed: vetoed.map((a) => safeName(a.name)),
    scored: keep + veto,
    adds: adds.map((a) => ({ name: safeName(a.entity.name), ref: a.entity.ref })),
  });
  if (draft !== null) {
    const cited = vetoed.flatMap((a) => {
      const m = verdictMetrics.get(a.entityId);
      return m === undefined ? [] : [m.id];
    });
    addFindingDraft(run, draft, [...cited, ...(precisionMetric === null ? [] : [precisionMetric.id])]);
  }

  // Dataset: your analogs with their verdicts, then what Qloo adds.
  const openRank = new Map(open.ranked.map((r) => [r.entity.entity_id, r.rank]));
  const rankCell = (id: string) => {
    const r = openRank.get(id);
    return r === undefined ? { value: null, reason: "not_measured" as const } : { value: r, reason: null };
  };
  const popCell = (p: number | null) => (p === null ? { value: null, reason: "not_measured" as const } : { value: p, reason: null });
  const analogRows: RankedRow[] = analogs.map((a, i) => {
    const v = verdicts[i] as AnalogVerdict;
    return {
      key: `analog-${i + 1}`,
      rank: null,
      label: safeFullName(a.name),
      sublabel:
        v.verdict === "NOT_SCORED"
          ? `not scored: ${v.why ?? "no score"}`
          : categoryLevel
            ? `${v.verdict === "KEEP" ? "at or above" : "below"} the category's ${anchor.replace(/^the /u, "")} (category-level read)`
            : verdictText(v.verdict, anchor),
      ref: a.ref,
      tagRef: null,
      type: input.type,
      cells: [rankCell(a.entityId), popCell(a.popularity)],
      flags: categoryLevel ? (v.verdict === "NOT_SCORED" ? [] : ["CATEGORY"]) : v.verdict === "KEEP" ? ["KEEP"] : v.verdict === "VETO" ? ["VETO"] : [],
      explain: [],
    };
  });
  const addRows: RankedRow[] = adds.map((a, i) => ({
    key: `add-${i + 1}`,
    rank: a.row.rank,
    label: safeFullName(a.entity.name),
    sublabel: `added: #${a.row.rank} for the concept, not among your analogs`,
    ref: a.entity.ref,
    tagRef: null,
    type: input.type,
    cells: [{ value: a.row.rank, reason: null }, popCell(a.entity.popularity)],
    flags: ["ADD"],
    explain: [],
  }));
  if (analogRows.length + addRows.length > 0) {
    const dataset = ctx.ledger.addDataset({
      kind: "Ranked",
      title: `Concept check · ${label}`,
      evidenceIds: [...run.evidenceIds],
      formulaIds: ["cnpt.s50", "cnpt.verdict", "cnpt.precision", "popularity"],
      payload: {
        columns: [
          { key: "open_rank", label: `Rank in the concept's top ${OPEN_TAKE}`, unit: "rank", comparator: null },
          { key: "popularity", label: "Popularity", unit: "popularity", comparator: null },
        ],
        groups: [
          ...(analogRows.length > 0 ? [{ key: "analogs", label: "Your analogs", rows: analogRows }] : []),
          ...(addRows.length > 0 ? [{ key: "adds", label: "What Qloo adds for the concept", rows: addRows }] : []),
        ],
        caption: categoryLevel
          ? `Category-level read: analogs scored against '${label}', since the data has no tag for '${conceptName}'. No keep or veto is given. Taste signals, not sales.`
          : `KEEP: the concept's taste scores the analog at least as high as ${anchor.replace(/^the /u, "its ")}, in the same Qloo call; VETO: lower. ` +
            "A VETO means the concept's taste points elsewhere, not that the analog is a weak business. Not scored is never a VETO. " +
            "Taste signals, not sales.",
      },
    });
    run.datasetIds.push(dataset.id);
  }

  // Notices.
  if (categoryLevel) {
    run.flags.add("CATEGORY_LEVEL_READ");
    run.notices.unshift(
      `Category-level read: '${label}' is the broader category, since the data has no tag for '${conceptName}'. Describe the category's fit only: no winner, keep or veto for the concept itself.`,
    );
  }
  if (analogs.length === 0) run.notices.push(categoryLevel ? "No analogs were given; a category-level read has no ADD list." : "No analogs were given, so only the ADD list is returned.");
  run.notices.push(`Anchor: the ${noun} ranked #${open.anchor.rank} for the concept; it is scored again beside the analogs, so no score is compared across calls.`);

  const rows: DigestRow[] = [
    ...analogs.map((a, i) => ({
      ref: a.ref,
      name: safeName(a.name),
      values: {
        verdict: categoryLevel ? (verdicts[i]?.verdict === "NOT_SCORED" ? "NOT_SCORED" : "CATEGORY") : (verdicts[i]?.verdict ?? "NOT_SCORED"),
        metric: verdictMetrics.get(a.entityId)?.id ?? null,
      },
    })),
    ...adds.map((a) => ({ ref: a.entity.ref, name: safeName(a.entity.name), values: { verdict: "ADD", concept_rank: a.row.rank } })),
  ];
  return finishBlockRun(run, out, unjudged ? "partial" : "ok", rows);
}

export const conceptVectorSkill: SkillFor<"concept_vector"> = {
  id: "concept_vector",
  mnemonic: "CNPT",
  kitWorkflows: ANALYST_TOOLS.concept_vector.kitWorkflows,
  input: ANALYST_TOOLS.concept_vector.input,
  estimateCalls: (input, probe, registry) => estimateConceptVectorCalls(input, probe, registry),
  run: runConceptVector,
  limitations: () => [...SKILL_LIMITATIONS.concept_vector],
};
