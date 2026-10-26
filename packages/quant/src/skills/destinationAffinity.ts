import {
  ANALYST_TOOLS,
  type CacheProbe,
  type DatasetId,
  type DigestRow,
  type EntityRegistry,
  type EvidenceId,
  type Finding,
  type Flag,
  type Metric,
  type QlooCallMeta,
  type QlooParams,
  type QuadrantName,
  type QuadrantPayload,
  type RegisteredEntity,
  type SkillCtx,
  type SkillFor,
  type SkillResult,
  type SkillStatus,
  type ToolInput,
} from "@ct/contracts";
import { emptyResultFinding, hiddenPocketFinding, MAX_NAMES_IN_TEXT, type FindingDraft } from "../findings";
import { SKILL_LIMITATIONS } from "../limitations";
import { addSkillEvidence, addSkillMetric, attemptAll, countUncached, insightTags, registerEntity } from "./common";
import { computeTravelQuadrant, labelledRows, US_COUNTRY_CODE, type TravelQuadrant } from "./destinationAffinity/quadrant";
import { skillErrorResult, skillResult, type DigestTarget } from "./digest";
import { fixed2, rankText, safeFullName, safeName } from "./format";

/**
 * S5 destination_affinity, the travel-taste quadrant (SPEC §5.3 S5; PLAN §5.3 TRVL): one call for
 * Qloo's top 50 US destinations for the seeds' audience (G5), then QUANT places each by FIT and
 * popularity, split at the medians (D17), with hidden-pocket scores and state belts. Seeds only:
 * a destination tag signal is rank-inert (P5), so the request carries no tags.
 */

type TravelInput = ToolInput<"destination_affinity">;

const DESTINATION = "urn:entity:destination";
/** Qloo's top 50 (G5: take=50 returns 50). Page 2 is verified too, but the quadrant reads the top 50 only. */
export const DESTINATION_TAKE = 50;
/** A call with fewer rows than this is a thin result (§6.4). */
const THIN_ROWS = 5;
/** FIT metrics go to the labelled points only, so the digest holds one citable number per name it shows. */
const MAX_HIDDEN_POCKET_METRICS = MAX_NAMES_IN_TEXT;
/**
 * State belts named in the notice. FORMULAS has no state-belt entry (change request: "trvl.state_belt"),
 * so a belt is never a metric: the values stay in the Quadrant payload and the notice names regions only.
 */
const BELTS_IN_NOTICE = 3;

export const TRAVEL_CAPTION =
  "Among Qloo's top-50 US destinations for this audience · travel & leisure taste · not residence, sales or ticket demand";

export const TRAVEL_QUADRANT_LABELS: QuadrantPayload["quadrantLabels"] = {
  HEARTLAND: "Heartland",
  HIDDEN_POCKET: "Hidden pocket",
  MASS: "Mass",
  COLD: "Cold",
};

const QUADRANT_WORDS: Readonly<Record<QuadrantName, string>> = {
  HEARTLAND: "heartland",
  HIDDEN_POCKET: "hidden pocket",
  MASS: "mass",
  COLD: "cold",
};

/** The G5 request: seed entities, US destinations only, the top 50. */
export function destinationParams(seedEntityIds: readonly string[]): QlooParams {
  return {
    "signal.interests.entities": [...seedEntityIds],
    "filter.geocode.country_code": US_COUNTRY_CODE,
    take: DESTINATION_TAKE,
  };
}

/** The probe sees insights requests with their filter.type, since has() takes no separate filter type. */
function probeParams(params: QlooParams): QlooParams {
  return { "filter.type": DESTINATION, ...params };
}

/** The seeds as registered entities, or the refs the registry does not know. */
function seedsOf(input: TravelInput, registry: EntityRegistry): { seeds: RegisteredEntity[] } | { unknown: string[] } {
  const seeds: RegisteredEntity[] = [];
  const unknown: string[] = [];
  for (const ref of input.seeds) {
    const e = registry.entity(ref);
    if (e === null) unknown.push(ref);
    else seeds.push(e);
  }
  return unknown.length > 0 ? { unknown } : { seeds };
}

/** One call, free when cached; 0 when a seed is not registered, since the skill then makes none. */
export async function estimateDestinationCalls(input: TravelInput, probe: CacheProbe, registry: EntityRegistry): Promise<number> {
  const found = seedsOf(input, registry);
  if ("unknown" in found) return 0;
  return countUncached(probe, "/v2/insights", [probeParams(destinationParams(found.seeds.map((s) => s.entityId)))]);
}

/** "Artist Nova", "Artist Nova and Brand Alpha", "A, B and C": the audience in labels and findings. */
function seedLabelOf(seeds: readonly RegisteredEntity[]): string {
  const names = seeds.map((s) => safeName(s.name));
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function count(n: number, noun: string): string {
  return `${n} ${n === 1 ? noun : `${noun}s`}`;
}

interface TravelRun {
  ctx: SkillCtx;
  flags: Set<Flag>;
  evidenceIds: EvidenceId[];
  metrics: Metric[];
  findings: Finding[];
  datasetIds: DatasetId[];
  registered: RegisteredEntity[];
  notices: string[];
}

function addFinding(run: TravelRun, draft: FindingDraft, metricIds: readonly Metric["id"][]): void {
  run.findings.push(run.ctx.ledger.addFinding({ ...draft, metricIds: [...metricIds] }));
}

function recordCall(run: TravelRun, seedLabel: string, q: TravelQuadrant, returned: number, meta: QlooCallMeta): EvidenceId | null {
  const unscored = q.rows.length - q.scored;
  const floorTies = q.floor === null ? 0 : q.rows.filter((r) => r.affinity === q.floor).length;
  const flags: Flag[] = [];
  if (unscored > 0) flags.push("CANDIDATES_UNSCORED");
  if (q.gateDropped.length > 0) flags.push("QUALITY_GATE_DROPPED");
  if (floorTies > 0) flags.push("NOT_SCORED");
  if (returned < THIN_ROWS) flags.push("THIN_RESULT");
  for (const f of flags) run.flags.add(f);

  const notes = [
    q.gateDropped.length > 0 ? `${q.gateDropped.length} skipped by the quality gate` : null,
    q.outsideUs > 0 ? `${q.outsideUs} outside the US left out` : null,
    unscored > 0 ? `${unscored} not scored` : null,
  ].filter((s) => s !== null);
  const evidence = addSkillEvidence(run.ctx.ledger, {
    skill: "destination_affinity",
    purpose: `Top ${DESTINATION_TAKE} US destinations for the ${seedLabel} audience (travel taste)`,
    calls: [meta],
    status: q.placed.length === 0 ? "empty" : "ok",
    summary:
      `${count(returned, "destination")} returned; ${q.placed.length} placed on the quadrant` +
      `${notes.length > 0 ? ` (${notes.join(", ")})` : ""}.`,
    flags,
    qualityGateDrops: q.gateDropped.length,
  });
  if (evidence === null) return null;
  run.evidenceIds.push(evidence.id);
  return evidence.id;
}

function register(run: TravelRun, q: TravelQuadrant, i: number): RegisteredEntity {
  const row = q.rows[i]!;
  const reg = registerEntity(run.ctx.registry, {
    entityId: row.result.entity_id,
    name: row.name,
    type: "destination",
    popularity: row.popularity,
    disambiguation: row.result.disambiguation ?? null,
    tags: insightTags(row.result.tags),
  });
  if (reg.isNew) run.registered.push(reg.entity);
  return reg.entity;
}

interface TravelMetrics {
  /** By row: the FIT metric of a labelled destination. */
  fit: Map<number, Metric>;
  /** By row: the hidden-pocket score of a destination the HIDDEN_POCKET rule picked. */
  pocket: Map<number, Metric>;
}

/**
 * At most 8 FIT metrics (the labelled points) and 3 hidden-pocket scores, all cited to the one call.
 * FIT reads "k of n" among the scored destinations.
 */
function addTravelMetrics(
  run: TravelRun,
  q: TravelQuadrant,
  labelled: readonly number[],
  refs: ReadonlyMap<number, RegisteredEntity>,
  evidenceId: EvidenceId,
): TravelMetrics {
  const ledger = run.ctx.ledger;
  const evidenceIds = [evidenceId];
  const push = (m: Metric) => {
    run.metrics.push(m);
    return m;
  };

  const fit = new Map<number, Metric>();
  for (const i of labelled) {
    const ref = refs.get(i);
    const value = q.fit[i] ?? null;
    const rank = q.rank[i] ?? null;
    const quadrant = q.quadrant[i] ?? null;
    if (ref === undefined || value === null) continue;
    fit.set(
      i,
      push(
        addSkillMetric(ledger, {
          key: "trvl.fit",
          label: `travel-taste FIT of ${safeName(ref.name)}${quadrant === null ? "" : ` (${QUADRANT_WORDS[quadrant]})`}`,
          subjectRefs: [ref.ref],
          value,
          reason: "not_scored",
          display: `${fixed2(value)}${rank === null ? "" : ` · ${rankText(rank, q.scored)}`}`,
          unit: "pct",
          badge: "DERIVED",
          formulaId: "trvl.quadrant",
          evidenceIds,
          n: q.scored,
          comparator: "WITHIN_CALL",
        }),
      ),
    );
  }

  const pocket = new Map<number, Metric>();
  const medianPopularity = q.medianPopularity;
  for (const i of q.hiddenPockets.slice(0, MAX_HIDDEN_POCKET_METRICS)) {
    const ref = refs.get(i);
    const z = q.score[i] ?? null;
    const popularity = q.rows[i]?.popularity ?? null;
    if (ref === undefined || z === null || popularity === null || medianPopularity === null) continue;
    pocket.set(
      i,
      push(
        addSkillMetric(ledger, {
          key: "trvl.hidden_pocket",
          label: `hidden-pocket score of ${safeName(ref.name)} (taste above what popularity predicts)`,
          subjectRefs: [ref.ref],
          value: z,
          reason: "insufficient_n",
          display: `${fixed2(z)} · popularity ${fixed2(popularity)}, median ${fixed2(medianPopularity)}`,
          unit: "stat",
          badge: "ESTIMATED",
          formulaId: "trvl.hidden_pocket",
          evidenceIds,
          n: q.placed.length,
          comparator: "WITHIN_CALL",
        }),
      ),
    );
  }

  return { fit, pocket };
}

/** The Quadrant dataset: every placed destination, the labelled ones with refs, the rest omitted with a reason. */
function addTravelQuadrant(
  run: TravelRun,
  q: TravelQuadrant,
  labelled: readonly number[],
  refs: ReadonlyMap<number, RegisteredEntity>,
  seedLabel: string,
  evidenceId: EvidenceId,
): void {
  const isLabelled = new Set(labelled);
  const payload: QuadrantPayload = {
    xLabel: "Popularity",
    yLabel: "Travel-taste FIT (within-call percentile)",
    xUnit: "popularity",
    yUnit: "pct",
    xSplit: q.medianPopularity ?? 0,
    ySplit: q.medianFit ?? 0,
    quadrantLabels: TRAVEL_QUADRANT_LABELS,
    points: q.placed.map((i) => {
      const row = q.rows[i]!;
      const quadrant = q.quadrant[i]!;
      const region = row.region === null ? null : safeName(row.region);
      return {
        // Unregistered destinations get a row key, never their Qloo id.
        key: refs.get(i)?.ref ?? `dest-${i + 1}`,
        label: safeFullName(row.name),
        ref: refs.get(i)?.ref ?? null,
        x: row.popularity!,
        y: q.fit[i]!,
        quadrant,
        score: q.score[i] ?? null,
        labelled: isLabelled.has(i),
        group: region,
        utr: quadrant === "HIDDEN_POCKET",
        geo: row.geo === null ? null : { ...row.geo, region },
      };
    }),
    omitted: q.rows.flatMap((row, i) => {
      const reason = q.reasons[i] ?? null;
      return reason === null ? [] : [{ label: safeFullName(row.name), ref: refs.get(i)?.ref ?? null, reason }];
    }),
    belts: q.belts.map((b) => ({ region: safeName(b.region), value: b.value })),
    inset: "us_dots",
    caption: TRAVEL_CAPTION,
  };
  const dataset = run.ctx.ledger.addDataset({
    kind: "Quadrant",
    title: `Travel taste · ${seedLabel}`,
    evidenceIds: [evidenceId],
    formulaIds: ["trvl.quadrant", "trvl.hidden_pocket", "popularity", "quality_gate"],
    payload,
  });
  run.datasetIds.push(dataset.id);
}

/**
 * One row per labelled destination, hidden pockets first. Values name the metrics instead of
 * repeating them: the FIT metric reads "k of n", so the row carries no bare rank to copy.
 */
function travelDigestRows(q: TravelQuadrant, labelled: readonly number[], refs: ReadonlyMap<number, RegisteredEntity>, metrics: TravelMetrics): DigestRow[] {
  return labelled.map((i) => {
    const row = q.rows[i]!;
    const quadrant = q.quadrant[i] ?? null;
    return {
      ref: refs.get(i)?.ref ?? null,
      name: safeName(row.name),
      values: {
        quadrant: quadrant === null ? null : QUADRANT_WORDS[quadrant],
        state: row.region === null ? null : safeName(row.region),
        fit_metric: metrics.fit.get(i)?.id ?? null,
        hidden_pocket_metric: metrics.pocket.get(i)?.id ?? null,
      },
    };
  });
}

function finish(run: TravelRun, target: DigestTarget, status: SkillStatus, rows: readonly DigestRow[]): SkillResult {
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

async function runDestinationAffinity(input: TravelInput, ctx: SkillCtx): Promise<SkillResult> {
  const out: DigestTarget = { tool: "destination_affinity", step: input.step_id };
  const found = seedsOf(input, ctx.registry);
  if ("unknown" in found) {
    return skillErrorResult(out, `${found.unknown.join(", ")} ${found.unknown.length === 1 ? "is" : "are"} not in the registry; resolve the seeds first.`);
  }
  const seeds = found.seeds;
  const seedLabel = seedLabelOf(seeds);
  const run: TravelRun = { ctx, flags: new Set(), evidenceIds: [], metrics: [], findings: [], datasetIds: [], registered: [], notices: [] };

  const params = destinationParams(seeds.map((s) => s.entityId));
  const [attempt] = await attemptAll([() => ctx.qloo.insights(DESTINATION, params)]);
  if (attempt?.kind !== "ok") {
    run.flags.add("BUDGET_TRUNCATED");
    run.notices.push("The call budget refused the destination call, so travel taste was not measured.");
    return finish(run, out, "partial", []);
  }

  const results = attempt.value.data.results.entities;
  const q = computeTravelQuadrant(results);
  const evidenceId = recordCall(run, seedLabel, q, results.length, attempt.value.meta);
  if (q.gateDropped.length > 0) {
    run.notices.push(`${count(q.gateDropped.length, "destination")} below the popularity quality gate ${q.gateDropped.length === 1 ? "was" : "were"} skipped.`);
  }
  if (q.outsideUs > 0) run.notices.push(`${count(q.outsideUs, "result")} outside the US ${q.outsideUs === 1 ? "was" : "were"} left out.`);
  const unplaced = q.rows.length - q.placed.length;
  if (unplaced > 0) run.notices.push(`${count(unplaced, "destination")} without a score or a popularity ${unplaced === 1 ? "is" : "are"} not placed on the quadrant.`);

  if (evidenceId === null || q.placed.length === 0) {
    addFinding(
      run,
      emptyResultFinding({
        what: `The travel-taste call for the ${seedLabel} audience`,
        suggestion: { tool: "destination_affinity", reason: "Add one or two related seeds to widen the audience signal." },
      }),
      [],
    );
    return finish(run, out, "empty", []);
  }

  const labelled = labelledRows(q);
  const refs = new Map(labelled.map((i) => [i, register(run, q, i)] as const));
  const metrics = addTravelMetrics(run, q, labelled, refs, evidenceId);

  if (q.medianPopularity !== null) {
    const draft = hiddenPocketFinding({
      seedLabel,
      destinations: q.hiddenPockets.map((i) => ({ name: safeName(q.rows[i]!.name), residualZ: q.score[i] ?? null, popularity: q.rows[i]!.popularity })),
      medianPopularity: q.medianPopularity,
    });
    if (draft !== null) addFinding(run, draft, [...metrics.pocket.values()].map((m) => m.id));
  }
  addTravelQuadrant(run, q, labelled, refs, seedLabel, evidenceId);

  if (q.belts.length > 0) {
    const named = q.belts.slice(0, BELTS_IN_NOTICE).map((b) => safeName(b.region));
    run.notices.push(`Top state belts (taste above the popularity line): ${named.join(", ")}; the values are in ${run.datasetIds.join(", ")}.`);
  }
  return finish(run, out, "ok", travelDigestRows(q, labelled, refs, metrics));
}

export const destinationAffinitySkill: SkillFor<"destination_affinity"> = {
  id: "destination_affinity",
  mnemonic: "TRVL",
  kitWorkflows: ANALYST_TOOLS.destination_affinity.kitWorkflows,
  input: ANALYST_TOOLS.destination_affinity.input,
  estimateCalls: (input, probe, registry) => estimateDestinationCalls(input, probe, registry),
  run: runDestinationAffinity,
  // The method bullets only: buildLimitations writes each raised flag's sentence from FLAG_TEXT.
  limitations: () => [...SKILL_LIMITATIONS.destination_affinity],
};
