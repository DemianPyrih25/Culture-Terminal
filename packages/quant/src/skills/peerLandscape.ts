import {
  ANALYST_TOOLS,
  type CacheProbe,
  type DigestRow,
  type EntityRegistry,
  type Evidence,
  type Flag,
  type QlooCallMeta,
  type QlooEntity,
  type QlooEntityInsightsResponse,
  type QlooParams,
  type QlooResult,
  type RegisteredEntity,
  type SkillCtx,
  type SkillFor,
  type SkillResult,
  type SkillStatus,
  type ToolInput,
} from "@ct/contracts";
import { emptyResultFinding } from "../findings";
import { SKILL_LIMITATIONS } from "../limitations";
import { computeSubstitution } from "../subs";
import {
  addSkillEvidence,
  attemptAll,
  attemptAllKeepingFailures,
  countUncached,
  registerEntity,
  type Attempt,
  type EntityDraft,
} from "./common";
import { skillErrorResult, skillResult, type DigestTarget } from "./digest";
import { safeName } from "./format";
import { categoryTagOf, selectPeers, type PeerSelection } from "./peerSelection";
import {
  addFindingDraft,
  addMapFindings,
  addOutsideFinding,
  addSubsMetrics,
  addSubstitutionMap,
  discoveryNeighbourQualifies,
  findOutsideNeighbour,
  subsDigestRows,
  type MapMembers,
  type OutsideNeighbour,
  type SubsRun,
} from "./subsOutputs";
import { fillMatrix, isComplete, similarityOf, triangularCalls, type ScoredMatrix } from "./substitutionMap";

/**
 * S1 peer_landscape, the Substitution Map (SPEC §5.3 S1; PLAN §5.3): discovery (D1 same category,
 * D2 cross-category), the deterministic peer rule, k−1 triangular scoring calls, then QUANT math
 * from computeSubstitution. Brand targets only: filter.results.entities with an interest signal is
 * verified for brands (G1).
 */

type PeerInput = ToolInput<"peer_landscape">;

const BRAND = "urn:entity:brand";
export const DISCOVERY_TAKE = 20;
/** A discovery call with fewer rows than this is a thin result (§6.4). */
const THIN_ROWS = 5;
/** The map needs the target and at least two peers: with one peer there is nothing to rank. */
const MIN_MEMBERS = 3;

/** D1 when a category tag is given, D2 without it. The target is the signal and is excluded from results. */
export function discoveryParams(targetEntityId: string, categoryTagId: string | null): QlooParams {
  return {
    "signal.interests.entities": [targetEntityId],
    ...(categoryTagId === null ? {} : { "filter.tags": [categoryTagId] }),
    "filter.exclude.entities": [targetEntityId],
    take: DISCOVERY_TAKE,
  };
}

/** The probe sees insights requests with their filter.type, since has() takes no separate filter type. */
function probeParams(params: QlooParams | null): QlooParams | null {
  return params === null ? null : { "filter.type": BRAND, ...params };
}

/**
 * Network calls a peer_landscape input would cost now. With the registry the discovery calls are
 * probed, and so is the matrix whenever its members are known before discovery (no discovery, or
 * named peers fill every slot); otherwise the matrix counts k−1 calls. Without the registry it is
 * the upper bound.
 */
export async function estimatePeerLandscapeCalls(
  input: PeerInput,
  probe: CacheProbe,
  registry: EntityRegistry | null,
): Promise<number> {
  const slots = input.k - 1;
  if (registry === null) return input.discover ? 2 + slots : Math.min(input.peers.length, slots);

  const target = registry.entity(input.target);
  if (target === null || target.type !== "brand") return 0;
  const named = usableNamed(input, registry).peers;
  const category = categoryTagOf(target);
  const discovery = input.discover
    ? [category === null ? null : discoveryParams(target.entityId, category.tagId), discoveryParams(target.entityId, null)]
    : [];
  const matrixKnown = !input.discover || named.length >= slots;
  const members = [target, ...named];
  const matrix = matrixKnown && members.length >= MIN_MEMBERS ? triangularCalls(members.map((m) => m.entityId)) : [];
  const probed = await countUncached(probe, "/v2/insights", [...discovery, ...matrix.map((c) => c.params)].map(probeParams));
  return probed + (matrixKnown ? 0 : slots);
}

/** Named peers that are registered brands, capped at k−1, with a notice for each one left out. */
function usableNamed(input: PeerInput, registry: EntityRegistry): { peers: RegisteredEntity[]; notices: string[] } {
  const peers: RegisteredEntity[] = [];
  const notices: string[] = [];
  for (const ref of input.peers) {
    const e = registry.entity(ref);
    if (e === null) notices.push(`${ref} is not in the registry; left out of the map.`);
    else if (e.type !== "brand") notices.push(`${ref} (${safeName(e.name)}) is a ${e.type}, not a brand; left out of the map.`);
    else peers.push(e);
  }
  const slots = input.k - 1;
  if (peers.length > slots) {
    const cut = peers.splice(slots);
    notices.push(`k=${input.k} leaves room for ${slots} peers; left out: ${cut.map((e) => e.ref).join(", ")}.`);
  }
  return { peers, notices };
}

interface Discovery {
  sameCategory: QlooEntity[];
  crossCategory: QlooEntity[];
  calls: QlooCallMeta[];
  truncated: boolean;
  thin: boolean;
}

const NO_DISCOVERY: Discovery = { sameCategory: [], crossCategory: [], calls: [], truncated: false, thin: false };

type InsightsAttempt = Attempt<QlooResult<QlooEntityInsightsResponse>>;

function entitiesOf(attempt: InsightsAttempt | undefined): QlooEntity[] {
  return attempt?.kind === "ok" ? attempt.value.data.results.entities : [];
}

function metasOf(attempts: readonly InsightsAttempt[]): QlooCallMeta[] {
  return attempts.flatMap((a) => (a.kind === "ok" ? [a.value.meta] : []));
}

async function discover(ctx: SkillCtx, target: RegisteredEntity, categoryTagId: string | null): Promise<Discovery> {
  const requests = [categoryTagId === null ? null : discoveryParams(target.entityId, categoryTagId), discoveryParams(target.entityId, null)];
  const attempts = await attemptAll(requests.map((p) => (p === null ? null : () => ctx.qloo.insights(BRAND, p))));
  return {
    sameCategory: entitiesOf(attempts[0]),
    crossCategory: entitiesOf(attempts[1]),
    calls: metasOf(attempts),
    truncated: attempts.some((a) => a.kind === "truncated"),
    thin: attempts.some((a) => a.kind === "ok" && entitiesOf(a).length < THIN_ROWS),
  };
}

function recordDiscovery(run: SubsRun, target: RegisteredEntity, discovery: Discovery, selection: PeerSelection): void {
  const flags: Flag[] = [];
  if (selection.gateDropped.length > 0) flags.push("QUALITY_GATE_DROPPED");
  if (discovery.thin) flags.push("THIN_RESULT");
  if (discovery.truncated) flags.push("BUDGET_TRUNCATED");
  for (const f of flags) run.flags.add(f);
  if (selection.gateDropped.length > 0) {
    const n = selection.gateDropped.length;
    run.notices.push(`${count(n, "discovery result")} below the popularity quality gate ${n === 1 ? "was" : "were"} skipped.`);
  }

  const taken = selection.peers.filter((p) => p.source !== "named").length;
  const gate = selection.gateDropped.length > 0 ? `, ${selection.gateDropped.length} skipped by the quality gate` : "";
  const evidence = addSkillEvidence(run.ctx.ledger, {
    skill: "peer_landscape",
    purpose: `Same- and cross-category peer discovery for ${safeName(target.name)}`,
    calls: discovery.calls,
    status: discovery.truncated ? "partial" : selection.usable === 0 ? "empty" : "ok",
    summary:
      `${discovery.sameCategory.length} same-category and ${discovery.crossCategory.length} cross-category results; ` +
      `${count(taken, "peer")} taken from discovery${gate}.`,
    flags,
    qualityGateDrops: selection.gateDropped.length,
  });
  if (evidence !== null) run.evidenceIds.push(evidence.id);
}

/** Registers an entity this call found; named peers are already known and are not listed as new. */
function register(run: SubsRun, draft: EntityDraft): RegisteredEntity {
  const reg = registerEntity(run.ctx.registry, draft);
  if (reg.isNew) run.registered.push(reg.entity);
  return reg.entity;
}

function mapMembers(run: SubsRun, target: RegisteredEntity, selection: PeerSelection, categoryTagId: string | null): MapMembers {
  return {
    entities: [target, ...selection.peers.map((p) => register(run, p.entity))],
    sources: [null, ...selection.peers.map((p) => p.source)],
    categoryTagId,
  };
}

/**
 * The top cross-category result when it qualifies as OUTSIDE_CATEGORY_NEIGHBOUR on discovery
 * evidence, registered so the model holds a ref to pivot on even when it got no slot in the map.
 */
function discoveredNeighbourOf(
  run: SubsRun,
  target: RegisteredEntity,
  selection: PeerSelection,
  discovery: Discovery,
): RegisteredEntity | null {
  const neighbour = selection.outsideNeighbour;
  if (neighbour === null) return null;
  return discoveryNeighbourQualifies(neighbour, target.entityId, discovery.sameCategory, discovery.crossCategory)
    ? register(run, neighbour)
    : null;
}

interface Scoring {
  matrix: ScoredMatrix;
  calls: QlooCallMeta[];
  truncated: boolean;
  /** Scoring calls the Qloo client failed, in plan order. */
  failed: { code: string; error: unknown }[];
}

/**
 * The k−1 triangular calls. Discovery evidence may already be in the ledger, so a call the Qloo
 * client fails becomes a gap in the map, like one the budget refused, rather than a failure of the
 * whole skill that would leave that evidence behind without a result to cite it from.
 */
async function scoreMatrix(ctx: SkillCtx, members: MapMembers): Promise<Scoring> {
  const ids = members.entities.map((e) => e.entityId);
  const plan = triangularCalls(ids);
  const attempts = await attemptAllKeepingFailures(
    plan.map((call) => () => ctx.qloo.insights(BRAND, call.params)),
    ctx.signal,
  );
  return {
    matrix: fillMatrix(
      ids,
      plan,
      attempts.map((a) => (a.kind === "ok" ? entitiesOf(a) : a.kind === "failed" ? "error" : "budget_truncated")),
    ),
    calls: metasOf(attempts),
    truncated: attempts.some((a) => a.kind === "truncated"),
    failed: attempts.flatMap((a) => (a.kind === "failed" ? [{ code: a.code, error: a.error }] : [])),
  };
}

/** "2 of 5 scoring calls failed (qloo_unavailable); the pairs they score are not measured." */
function failedCallsNotice(scoring: Scoring, planned: number): string {
  const codes = [...new Set(scoring.failed.map((f) => f.code))].join(", ");
  return `${scoring.failed.length} of ${planned} scoring calls failed (${codes}); the pairs they score are not measured.`;
}

/** "1 peer", "5 peers": counts in evidence summaries a reader sees. */
function count(n: number, noun: string): string {
  return `${n} ${n === 1 ? noun : `${noun}s`}`;
}

function recordScoring(run: SubsRun, members: MapMembers, scoring: Scoring): Evidence | null {
  const { pairs } = scoring.matrix;
  const flags: Flag[] = [];
  if (pairs.dropped > 0 || pairs.notScored > 0 || pairs.failed > 0) flags.push("CANDIDATES_UNSCORED");
  if (scoring.truncated) flags.push("BUDGET_TRUNCATED");
  if (pairs.dropped > 0) flags.push("DROPPED_CANDIDATES");
  if (pairs.notScored > 0) flags.push("NOT_SCORED");
  for (const f of flags) run.flags.add(f);

  const unscored = [
    pairs.notScored > 0 ? `${pairs.notScored} tied at the floor, not scored` : null,
    pairs.dropped > 0 ? `${pairs.dropped} dropped by Qloo` : null,
    pairs.truncated > 0 ? `${pairs.truncated} not called (budget)` : null,
    pairs.failed > 0 ? `${pairs.failed} lost to failed calls` : null,
  ].filter((s) => s !== null);
  const evidence = addSkillEvidence(run.ctx.ledger, {
    skill: "peer_landscape",
    purpose: "Triangular similarity scoring for the Substitution Map",
    calls: scoring.calls,
    status: scoring.truncated || scoring.failed.length > 0 ? "partial" : pairs.scored === 0 ? "empty" : "ok",
    summary:
      `${count(scoring.calls.length, "scoring call")} over ${members.entities.length} brands; ` +
      `${pairs.scored} of ${pairs.total} pairs scored${unscored.length > 0 ? ` (${unscored.join(", ")})` : ""}.`,
    flags,
  });
  if (evidence !== null) run.evidenceIds.push(evidence.id);
  return evidence;
}

function addEmptyFinding(run: SubsRun, what: string, suggestNamingPeers: boolean): void {
  addFindingDraft(
    run,
    emptyResultFinding({
      what,
      suggestion: suggestNamingPeers
        ? { tool: "peer_landscape", reason: "Name three or more peers from the registry and set discover to false." }
        : null,
    }),
    [],
  );
}

function finish(run: SubsRun, target: DigestTarget, status: SkillStatus, rows: readonly DigestRow[]): SkillResult {
  return skillResult(
    {
      status,
      evidenceIds: run.evidenceIds,
      datasetIds: run.datasetIds,
      metrics: run.metrics,
      rows,
      findings: run.findings,
      flags: run.flags,
      registered: run.registered,
      notices: run.notices,
    },
    target,
  );
}

/** The outside-category neighbour gets its own digest row only when it has no slot in the map. */
function outsideMapRow(neighbour: OutsideNeighbour | null): RegisteredEntity | null {
  return neighbour !== null && neighbour.index === null ? neighbour.entity : null;
}

async function runPeerLandscape(input: PeerInput, ctx: SkillCtx): Promise<SkillResult> {
  const out: DigestTarget = { tool: "peer_landscape", step: input.step_id };
  const target = ctx.registry.entity(input.target);
  if (target === null) return skillErrorResult(out, `${input.target} is not in the registry; resolve the brand first.`);
  if (target.type !== "brand") {
    return skillErrorResult(
      out,
      `peer_landscape maps brands only: ${input.target} (${safeName(target.name)}) is a ${target.type}. ` +
        "Use cross_domain or audience_dna for it instead.",
    );
  }

  const named = usableNamed(input, ctx.registry);
  if (!input.discover && named.peers.length < MIN_MEMBERS - 1) {
    return skillErrorResult(
      out,
      [...named.notices, `Without discovery the map needs at least 2 brand peers; ${named.peers.length} usable.`].join(" "),
    );
  }

  const run: SubsRun = {
    ctx,
    flags: new Set(),
    evidenceIds: [],
    metrics: [],
    findings: [],
    datasetIds: [],
    registered: [],
    notices: [...named.notices],
  };
  const categoryTagId = categoryTagOf(target)?.tagId ?? null;
  if (input.discover && categoryTagId === null) {
    run.notices.push(`${safeName(target.name)} has no genre:brand tag: peers come from cross-category discovery, with no category check.`);
  }

  // Discovery and the peer rule.
  const discovery = input.discover ? await discover(ctx, target, categoryTagId) : NO_DISCOVERY;
  const selection = selectPeers({
    target,
    categoryTagId,
    named: named.peers,
    slots: input.k - 1,
    sameCategory: discovery.sameCategory,
    crossCategory: discovery.crossCategory,
  });
  const members = mapMembers(run, target, selection, categoryTagId);
  const discoveredNeighbour = discoveredNeighbourOf(run, target, selection, discovery);
  if (input.discover) recordDiscovery(run, target, discovery, selection);

  // Without a map, discovery can still name an outside-category neighbour worth a pivot.
  const finishWithoutMap = (truncated: boolean): SkillResult => {
    const neighbour = findOutsideNeighbour(members, null, discoveredNeighbour);
    if (neighbour !== null) addOutsideFinding(run, members, neighbour, []);
    return finish(run, out, truncated ? "partial" : "empty", subsDigestRows(members, null, outsideMapRow(neighbour)));
  };

  if (members.entities.length < MIN_MEMBERS) {
    run.notices.push("A Substitution Map needs the target and at least 2 peers; name more peers to build it.");
    // EMPTY_RESULT says discovery gave nothing usable; results too few for a map are only the notice.
    if (input.discover && !discovery.truncated && selection.usable === 0) {
      addEmptyFinding(run, `Peer discovery for ${safeName(target.name)}`, true);
    }
    return finishWithoutMap(discovery.truncated);
  }

  // Triangular scoring.
  const scoring = await scoreMatrix(ctx, members);
  const firstFailure = scoring.failed[0];
  // With nothing in the ledger there is no evidence to keep: the error goes to the caller as before.
  if (firstFailure !== undefined && scoring.calls.length === 0 && run.evidenceIds.length === 0) throw firstFailure.error;
  if (firstFailure !== undefined) run.notices.push(failedCallsNotice(scoring, members.entities.length - 1));
  const matrixEvidence = recordScoring(run, members, scoring);
  const partial = discovery.truncated || scoring.truncated || firstFailure !== undefined;
  if (matrixEvidence === null || scoring.matrix.pairs.scored === 0) {
    if (!scoring.truncated && firstFailure === undefined) addEmptyFinding(run, "Substitution Map scoring", false);
    return finishWithoutMap(partial);
  }

  // QUANT math and ledger output.
  const { truncated: notCalled, failed: lost, total } = scoring.matrix.pairs;
  if (!isComplete(scoring.matrix)) {
    const cause = notCalled > 0 ? (lost > 0 ? "The call budget and failed calls" : "The call budget") : "Failed calls";
    const missing = [notCalled > 0 ? `${notCalled} of ${total} pairs not called` : null, lost > 0 ? `${lost} of ${total} pairs lost to failed calls` : null];
    run.notices.push(
      `${cause} cut the map short (${missing.filter((m) => m !== null).join(", ")}): ` +
        "hub, distinctiveness rank, taste island and near-substitutes need every row and are not measured.",
    );
  }
  const stats = computeSubstitution({
    refs: members.entities.map((e) => e.ref),
    targetIndex: 0,
    sim: similarityOf(scoring.matrix),
  });
  const neighbour = findOutsideNeighbour(members, scoring.matrix, discoveredNeighbour);
  const metrics = addSubsMetrics(run, members, scoring.matrix, stats, [matrixEvidence.id], neighbour?.index ?? null);
  addMapFindings(run, members, scoring.matrix, stats, metrics);
  if (neighbour !== null) {
    const metric = neighbour.index === null ? null : neighbour.index === stats.targetNearest ? metrics.nearest : metrics.outside;
    addOutsideFinding(run, members, neighbour, metric === null ? [] : [metric.id]);
  }
  addSubstitutionMap(run, members, scoring.matrix, stats, run.evidenceIds);

  const rows = subsDigestRows(members, { matrix: scoring.matrix, metrics }, outsideMapRow(neighbour));
  return finish(run, out, partial ? "partial" : "ok", rows);
}

export const peerLandscapeSkill: SkillFor<"peer_landscape"> = {
  id: "peer_landscape",
  mnemonic: "SUBS",
  kitWorkflows: ANALYST_TOOLS.peer_landscape.kitWorkflows,
  input: ANALYST_TOOLS.peer_landscape.input,
  estimateCalls: (input, probe, registry) => estimatePeerLandscapeCalls(input, probe, registry),
  run: runPeerLandscape,
  // The method bullets only: buildLimitations writes each raised flag's sentence from FLAG_TEXT.
  limitations: () => [...SKILL_LIMITATIONS.peer_landscape],
};
