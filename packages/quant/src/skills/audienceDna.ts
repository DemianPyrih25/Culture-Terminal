import {
  ANALYST_TOOLS,
  type CacheProbe,
  type DigestRow,
  type EntityRegistry,
  type EvidenceId,
  type Flag,
  type FindingSuggestion,
  type NoValueReason,
  type QlooCallMeta,
  type QlooDemographicsBlock,
  type QlooEntitiesResponse,
  type QlooParams,
  type QlooResult,
  type RegisteredEntity,
  type SkillCtx,
  type SkillFor,
  type SkillResult,
  type SkillStatus,
  type ToolInput,
} from "@ct/contracts";
import { droppedCandidatesFinding, emptyResultFinding } from "../findings";
import { SKILL_LIMITATIONS } from "../limitations";
import { addSkillEvidence, attemptAllKeepingFailures, countUncached, searchTags, type Attempt } from "./common";
import { skillErrorResult, skillResult, type DigestTarget } from "./digest";
import { safeName } from "./format";
import { contrastTags, facetProfile, facetTags, type FacetTag } from "./audienceDna/facets";
import {
  addDnaBars,
  addFacetList,
  addFinding,
  addTagContrast,
  addYouthRanking,
  distinctiveMetric,
  peerAverageMetrics,
  peerAverageName,
  peerAverageRow,
  subjectMetrics,
  subjectRow,
  subjectYouthMetric,
  tagNames,
  youthRanks,
  type Counterpart,
  type DnaRun,
  type DnaSubject,
} from "./audienceDna/outputs";
import { averageIndices, profileOf, type DnaProfile } from "./audienceDna/profiles";

/**
 * S3 audience_dna (SPEC §5.3 S3, probe G12/G13): one urn:demographics batch (at most 30 ids, take
 * 50) gives age and gender affinity indices, −1..1 around the average audience; Y compares the two
 * youngest buckets with the two oldest. Facet tags are the entities' /search tags, fetched with one
 * /entities batch describe (the same row shape, verified S0) so every tag figure cites its own
 * request, and grouped by namespace. /v2/analysis/compare is not used (G13). Types may mix (P5).
 */

type DnaInput = ToolInput<"audience_dna">;

const DEMOGRAPHICS = "urn:demographics";
/** G12: a batch of 30 returned one block per id. */
export const DNA_BATCH_MAX = 30;
/** G12: the batch was verified with take=50. */
export const DNA_TAKE = 50;
/** Comma lists hold at most 50 ids (the client's list rule), so one describe call covers a whole set. */
export const DESCRIBE_BATCH_MAX = 50;
/** Client errors that are bugs in the request, not a gap to report: they always propagate. */
const CALLER_BUGS: ReadonlySet<string> = new Set(["qloo_param", "qloo_no_signal"]);

function chunks(ids: readonly string[], size: number): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

/** One demographics request per batch of at most 30 entity ids, in subject order. */
export function demographicsBatches(entityIds: readonly string[]): QlooParams[] {
  return chunks(entityIds, DNA_BATCH_MAX).map((batch) => ({ "signal.interests.entities": batch, take: DNA_TAKE }));
}

/** The /entities batches for the facet tags (QlooApi.entities sends each as entity_ids). */
export function describeBatches(entityIds: readonly string[]): string[][] {
  return chunks(entityIds, DESCRIBE_BATCH_MAX);
}

interface Plan {
  target: RegisteredEntity;
  compare: RegisteredEntity | null;
  /** The rest of the set, in input order; the compare entity stays here when it is a set member too. */
  setPeers: RegisteredEntity[];
  notices: string[];
}

/** Resolves the refs; null when the first entity of the set is not in the registry. */
function planOf(input: DnaInput, registry: EntityRegistry): Plan | null {
  const [first, ...rest] = input.set;
  const target = first === undefined ? null : registry.entity(first);
  if (target === null) return null;
  const notices: string[] = [];
  const setPeers: RegisteredEntity[] = [];
  for (const ref of rest) {
    const e = registry.entity(ref);
    if (e === null) notices.push(`${ref} is not in the registry; left out.`);
    else setPeers.push(e);
  }
  let compare: RegisteredEntity | null = null;
  if (input.compare_with === first) {
    notices.push(`compare_with ${first} is the first entity of the set; nothing to mirror.`);
  } else if (input.compare_with !== null) {
    compare = registry.entity(input.compare_with);
    if (compare === null) notices.push(`${input.compare_with} is not in the registry; no comparison drawn.`);
  }
  return { target, compare, setPeers, notices };
}

/** Every entity the calls ask about, once: the target, the compare subject, then the other set members. */
function subjectsOf(plan: Plan): { entity: RegisteredEntity; role: DnaSubject["role"] }[] {
  const seen = new Set<string>();
  const out: { entity: RegisteredEntity; role: DnaSubject["role"] }[] = [];
  const add = (entity: RegisteredEntity, role: DnaSubject["role"]) => {
    if (seen.has(entity.entityId)) return;
    seen.add(entity.entityId);
    out.push({ entity, role });
  };
  add(plan.target, "target");
  if (plan.compare !== null) add(plan.compare, "compare");
  for (const e of plan.setPeers) add(e, "peer");
  return out;
}

/** The probe sees insights requests with their filter.type, since has() takes no separate filter type. */
function probeParams(params: QlooParams): QlooParams {
  return { "filter.type": DEMOGRAPHICS, ...params };
}

/**
 * Network calls an audience_dna input would cost now: the demographics batch and the facet-tag
 * describe (one each for any set the tool accepts), cached ones free.
 */
export async function estimateAudienceDnaCalls(input: DnaInput, probe: CacheProbe, registry: EntityRegistry): Promise<number> {
  const plan = planOf(input, registry);
  if (plan === null) return 0;
  const ids = subjectsOf(plan).map((s) => s.entity.entityId);
  const [demographics, describe] = await Promise.all([
    countUncached(probe, "/v2/insights", demographicsBatches(ids).map(probeParams)),
    countUncached(probe, "/entities", describeBatches(ids).map((batch) => ({ entity_ids: batch }))),
  ]);
  return demographics + describe;
}

/**
 * The figure's second series: the compare subject when given (measured or not, since it was asked
 * for by name), else the one measured set peer, else the average of two or more measured peers.
 */
function counterpartOf(subjects: readonly DnaSubject[]): Counterpart {
  const compare = subjects.find((s) => s.role === "compare");
  if (compare !== undefined) return { kind: "subject", subject: compare };
  const measured = subjects.filter((s) => s.role === "peer" && s.profile.measured);
  if (measured.length === 1) return { kind: "subject", subject: measured[0]! };
  const indices = averageIndices(measured.flatMap((s) => (s.profile.measured ? [s.profile] : [])));
  return indices === null ? null : { kind: "peers", peers: measured, indices };
}

function demographicsStatus(subjects: readonly DnaSubject[], truncated: boolean, counterpart: Counterpart): SkillStatus {
  if (truncated) return "partial";
  if (!subjects.some((s) => s.profile.measured)) return "empty";
  const target = subjects[0];
  const pairMissing =
    !(target?.profile.measured ?? false) || (counterpart?.kind === "subject" && !counterpart.subject.profile.measured);
  return pairMissing ? "partial" : "ok";
}

// Facet tags ---------------------------------------------------------------------------------------------

type Describe = Attempt<QlooResult<QlooEntitiesResponse>>;

/** Facet tags per entity id from the describe calls, with their evidence, or why they are missing. */
interface Tags {
  byId: ReadonlyMap<string, FacetTag[]>;
  evidenceIds: EvidenceId[];
  /** Null when every describe call answered; otherwise the reason a missing tag list stands for. */
  gap: Extract<NoValueReason, "budget_truncated" | "error"> | null;
}

function recordTags(run: DnaRun, subjects: readonly DnaSubject[], attempts: readonly Describe[]): Tags {
  const byId = new Map<string, FacetTag[]>();
  const calls: QlooCallMeta[] = [];
  for (const a of attempts) {
    if (a.kind !== "ok") continue;
    calls.push(a.value.meta);
    for (const row of a.value.data.results) byId.set(row.entity_id, facetTags({ tags: searchTags(row.tags) }));
  }
  const gap = attempts.some((a) => a.kind === "failed") ? "error" : attempts.some((a) => a.kind === "truncated") ? "budget_truncated" : null;
  const tagged = subjects.filter((s) => (byId.get(s.entity.entityId)?.length ?? 0) > 0).length;
  const noun = subjects.length === 1 ? "entity" : "entities";
  const evidence = addSkillEvidence(run.ctx.ledger, {
    skill: "audience_dna",
    purpose: `Facet tags (/entities, the /search tag lists) for ${subjects.length} ${noun}`,
    calls,
    status: gap !== null ? "partial" : tagged === 0 ? "empty" : "ok",
    summary: `${tagged} of ${subjects.length} ${noun} carry tags, grouped by namespace.`,
    flags: gap === "budget_truncated" ? ["BUDGET_TRUNCATED"] : gap === "error" ? ["CANDIDATES_UNSCORED"] : [],
  });
  if (evidence !== null) run.evidenceIds.push(evidence.id);
  return { byId, evidenceIds: evidence === null ? [] : [evidence.id], gap };
}

/** The demographics decide the status; facet tags lost to the budget or a failure make an ok result partial. */
function statusOf(demographics: SkillStatus, tags: Tags): SkillStatus {
  return demographics === "ok" && tags.gap !== null ? "partial" : demographics;
}

// The skill --------------------------------------------------------------------------------------------------

async function runAudienceDna(input: DnaInput, ctx: SkillCtx): Promise<SkillResult> {
  const out: DigestTarget = { tool: "audience_dna", step: input.step_id };
  const plan = planOf(input, ctx.registry);
  if (plan === null) return skillErrorResult(out, `${input.set[0] ?? "The first entity"} is not in the registry; resolve it first.`);

  const planned = subjectsOf(plan);
  const ids = planned.map((s) => s.entity.entityId);
  // The indices are the point of the call, so they go first: with one network call left in the run
  // they take it, and their failure fails the skill before the describe is spent or anything recorded.
  const demoAttempts = await attemptAllKeepingFailures(
    demographicsBatches(ids).map((params) => () => ctx.qloo.insights(DEMOGRAPHICS, params)),
    ctx.signal,
  );
  const demoFailure = demoAttempts.find((a) => a.kind === "failed");
  if (demoFailure?.kind === "failed") throw demoFailure.error;
  const describeAttempts = await attemptAllKeepingFailures(
    describeBatches(ids).map((batch) => () => ctx.qloo.entities(batch)),
    ctx.signal,
  );
  const describeBug = describeAttempts.find((a) => a.kind === "failed" && CALLER_BUGS.has(a.code));
  if (describeBug?.kind === "failed") throw describeBug.error;

  const blocks = new Map<string, QlooDemographicsBlock>();
  const notCalled = new Set<string>();
  demoAttempts.forEach((a, i) => {
    if (a.kind === "ok") {
      for (const block of a.value.data.results.demographics) blocks.set(block.entity_id, block);
    } else {
      for (const id of ids.slice(i * DNA_BATCH_MAX, (i + 1) * DNA_BATCH_MAX)) notCalled.add(id);
    }
  });
  const subjects: DnaSubject[] = planned.map(({ entity, role }) => {
    const block = blocks.get(entity.entityId);
    const profile: DnaProfile =
      block !== undefined
        ? profileOf(block)
        : { measured: false, reason: notCalled.has(entity.entityId) ? "budget_truncated" : "not_measured" };
    return { entity, role, profile };
  });

  const run: DnaRun = { ctx, flags: new Set(), evidenceIds: [], metrics: [], findings: [], datasetIds: [], notices: [...plan.notices] };
  const truncated = demoAttempts.some((a) => a.kind === "truncated");
  const measured = subjects.filter((s) => s.profile.measured);
  const missing = subjects.filter((s) => !s.profile.measured && s.profile.reason === "not_measured");
  const counterpart = counterpartOf(subjects);

  // Evidence: the demographics batch, then the facet tags.
  const flags: Flag[] = [];
  if (measured.length > 0) flags.push("DEMOGRAPHICS_ARE_INDICES");
  if (missing.length > 0) flags.push("CANDIDATES_UNSCORED", "DROPPED_CANDIDATES");
  if (truncated) flags.push("BUDGET_TRUNCATED");
  for (const f of flags) run.flags.add(f);
  const missingText = missing.length > 0 ? `; no block (not measured): ${missing.map((s) => safeName(s.entity.name)).join(", ")}` : "";
  const evidence = addSkillEvidence(ctx.ledger, {
    skill: "audience_dna",
    purpose: `Age and gender affinity indices (urn:demographics) for ${subjects.length} ${subjects.length === 1 ? "entity" : "entities"}`,
    calls: demoAttempts.flatMap((a) => (a.kind === "ok" ? [a.value.meta] : [])),
    status: demographicsStatus(subjects, truncated, counterpart),
    summary:
      `${measured.length} of ${subjects.length} entities have a demographics block${missingText}` +
      `${truncated ? "; the budget refused the call" : ""}.`,
    flags,
  });
  if (evidence !== null) run.evidenceIds.push(evidence.id);
  const evidenceIds: EvidenceId[] = evidence === null ? [] : [evidence.id];
  const tags = recordTags(run, subjects, describeAttempts);
  if (tags.gap === "budget_truncated") run.flags.add("BUDGET_TRUNCATED");
  if (tags.gap === "error") {
    // As S1 and momentum do for a failed call: the report's limitations say what went missing.
    run.flags.add("CANDIDATES_UNSCORED");
    run.notices.push("The facet-tag call failed, so facet tags are not measured.");
  }
  const tagsOf = (s: DnaSubject): FacetTag[] => tags.byId.get(s.entity.entityId) ?? [];

  // Metrics: the full profile for the figure's subjects, Y for every other subject.
  const ranks = youthRanks(subjects);
  const rankOf = (s: DnaSubject) => ranks[subjects.indexOf(s)] ?? null;
  const target = subjects[0]!;
  const targetTags = tagsOf(target);
  const rows: DigestRow[] = [];
  const targetMetrics = subjectMetrics(run, target, rankOf(target), evidenceIds);
  rows.push(subjectRow(target, targetMetrics.youth, targetTags.length));
  if (counterpart?.kind === "subject") {
    const m = subjectMetrics(run, counterpart.subject, rankOf(counterpart.subject), evidenceIds);
    rows.push(subjectRow(counterpart.subject, m.youth, tagsOf(counterpart.subject).length));
  } else if (counterpart?.kind === "peers") {
    const m = peerAverageMetrics(run, counterpart.peers, counterpart.indices, evidenceIds);
    rows.push(peerAverageRow(counterpart.peers, counterpart.indices, m.youth));
  }
  const others = subjects.slice(1).filter((s) => counterpart?.kind !== "subject" || s !== counterpart.subject);
  const otherRows = others
    .map((s) => ({ s, youth: subjectYouthMetric(run, s, rankOf(s), evidenceIds) }))
    .sort((a, b) => (rankOf(a.s)?.rank ?? Infinity) - (rankOf(b.s)?.rank ?? Infinity))
    .map(({ s, youth }) => subjectRow(s, youth, tagsOf(s).length));

  // Facet tags: the target against the set members of its own type. Tags are type-specific (a
  // brand's genre:brand tags never sit on an artist), so another type's tags would make every tag
  // look distinctive.
  const sameTypeIds = new Set(plan.setPeers.filter((e) => e.type === target.entity.type).map((e) => e.entityId));
  const peerTagSets = subjects.filter((s) => sameTypeIds.has(s.entity.entityId)).map((s) => new Set(tagsOf(s).map((t) => t.tagId)));
  const facets = facetProfile(targetTags, peerTagSets);
  const distinctive = distinctiveMetric(run, target.entity, facets, tags.evidenceIds, tags.gap ?? "not_measured");
  rows.splice(Math.min(rows.length, 2), 0, {
    ref: null,
    name: `distinctive tags · ${safeName(target.entity.name)}`,
    values: { metric: distinctive.id, tags: tagNames(facets.distinctive) },
  });
  if (tags.gap === null && targetTags.length === 0) {
    run.notices.push(`${safeName(target.entity.name)} carries no tags in Qloo, so its facets are not measured.`);
  } else if (tags.gap === null && facets.total === 0) {
    run.notices.push(`${safeName(target.entity.name)} carries no tags in the core facets, so no tag is called distinctive.`);
  } else if (tags.gap === null && facets.peers === 0 && plan.setPeers.length > 0) {
    run.notices.push(`No set peer of the same type (${target.entity.type}) carries tags in Qloo, so no tag is called distinctive.`);
  }

  const compare = subjects.find((s) => s.role === "compare");
  const compareTags = compare === undefined ? [] : tagsOf(compare);
  const contrast = compare !== undefined && targetTags.length > 0 && compareTags.length > 0 ? contrastTags(targetTags, compareTags) : null;
  if (compare !== undefined && contrast !== null) {
    rows.splice(Math.min(rows.length, 3), 0, ...contrastRows(target, compare, contrast));
  }
  rows.push(...otherRows);

  // Findings.
  if (measured.length === 0 && !truncated) {
    const what = `The demographics batch for ${safeName(target.entity.name)}`;
    addFinding(run, emptyResultFinding({ what, suggestion: emptySuggestion(target, subjects) }), []);
  }
  if (missing.length > 0) {
    const draft = droppedCandidatesFinding({ names: missing.map((s) => safeName(s.entity.name)), context: "the demographics batch" });
    const missingRefs = new Set<string>(missing.map((s) => s.entity.ref));
    const unmeasured = run.metrics.filter((m) => m.key === "dna.youth_index" && missingRefs.has(m.subjectRefs[0] ?? ""));
    if (draft !== null) addFinding(run, draft, unmeasured.map((m) => m.id));
  }

  // Datasets.
  addDnaBars(run, target, counterpart, evidenceIds);
  if (subjects.length >= 3 && measured.length > 0) addYouthRanking(run, subjects, ranks, evidenceIds);
  if (targetTags.length > 0) addFacetList(run, target.entity, facets, tags.evidenceIds);
  if (compare !== undefined && contrast !== null) {
    const peerCount = (tagId: string) => (facets.peers === 0 ? null : peerTagSets.filter((set) => set.has(tagId)).length);
    addTagContrast(run, target.entity, compare.entity, contrast, { peerCount, peers: facets.peers, evidenceIds: tags.evidenceIds });
  }
  if (counterpart?.kind === "peers") {
    run.notices.push(`The DNA figure compares ${safeName(target.entity.name)} with ${peerAverageName(counterpart.peers.length)}.`);
  }

  return skillResult(
    {
      status: statusOf(demographicsStatus(subjects, truncated, counterpart), tags),
      evidenceIds: run.evidenceIds,
      datasetIds: run.datasetIds,
      metrics: run.metrics,
      rows,
      findings: run.findings,
      flags: run.flags,
      registered: [],
      notices: run.notices,
    },
    out,
  );
}

/** A brand target with brand peers can still be read by age through share_of_taste age contexts. */
function emptySuggestion(target: DnaSubject, subjects: readonly DnaSubject[]): FindingSuggestion | null {
  const brandPeers = subjects.filter((s) => s !== target && s.entity.type === "brand").length;
  if (target.entity.type !== "brand" || brandPeers === 0) return null;
  return { tool: "share_of_taste", reason: `Rank ${safeName(target.entity.name)} against its peers in age contexts instead.` };
}

function contrastRows(a: DnaSubject, b: DnaSubject, contrast: ReturnType<typeof contrastTags>): DigestRow[] {
  const row = (name: string, list: readonly FacetTag[]): DigestRow => ({
    ref: null,
    name,
    values: { tags: tagNames(list), presence: "qualitative" },
  });
  return [row(`tags only on ${safeName(a.entity.name)}`, contrast.aOnly), row(`tags only on ${safeName(b.entity.name)}`, contrast.bOnly)];
}

/** S3 audience_dna (DNA). */
export const audienceDnaSkill: SkillFor<"audience_dna"> = {
  id: "audience_dna",
  mnemonic: "DNA",
  kitWorkflows: ANALYST_TOOLS.audience_dna.kitWorkflows,
  input: ANALYST_TOOLS.audience_dna.input,
  estimateCalls: (input, probe, registry) => estimateAudienceDnaCalls(input, probe, registry),
  run: runAudienceDna,
  // The method bullets only: buildLimitations writes each raised flag's sentence from FLAG_TEXT.
  limitations: () => [...SKILL_LIMITATIONS.audience_dna],
};
