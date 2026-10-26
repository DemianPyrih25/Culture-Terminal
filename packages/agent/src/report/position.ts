import type { DatasetOf, EntityRegistry, Job, QlooCallMeta, RegisteredEntity } from "@ct/contracts";
import { sanitizeQlooName } from "@ct/qloo";
import { addSkillMetric, buildPosition } from "@ct/quant";
import { MIN_OK_EVIDENCE } from "../checker";
import type { RunLedger } from "../ledger";

/**
 * The Taste Position card for the investment desk (SPEC §5.4, §7.2): ASSEMBLE shows it right after
 * the Scorecard for brand_health and head_to_head. QUANT reads its five axes off the ledger
 * (buildPosition); this records the card as a dataset, so it streams as `dataset.ready` and has a D#.
 */

export const POSITION_JOBS: ReadonlySet<Job> = new Set(["brand_health", "head_to_head"]);

/** The limitation a note carries when its card could not be built: ASSEMBLE ships the note without it. */
export const POSITION_FAILED = "The Taste Position card could not be built";

const NAME_MAX = 80;

export interface PositionContext {
  job: Job;
  ledger: RunLedger;
  registry: EntityRegistry;
  /** The question's primary target, the card's subject; null when the gate resolved none. */
  subject: RegisteredEntity | null;
  /** The gate calls that resolved the subject (GateResolved.primaryCalls). */
  resolution: readonly QlooCallMeta[];
  /** Metric ids the accepted draft cites (draftCitedMetrics): an axis shows the cited figure first. */
  cited?: readonly string[];
}

/**
 * Reach is the subject's popularity from resolution (§5.4). The gate's /search is not evidence of
 * its own, so when no skill recorded the subject's popularity the card cites that call as one
 * resolve_entities bundle, the bundle a wave-1 resolve_entities would have made. It is added only to
 * a note that already stands on MIN_OK_EVIDENCE ok bundles, so it never decides the V7 count, and
 * only after the CHECKER, so no id the ANALYST saw moves.
 */
function recordReach(ctx: PositionContext, subject: RegisteredEntity): void {
  const snapshot = ctx.ledger.snapshot();
  const measured = snapshot.metrics.some((m) => m.key === "popularity" && m.subjectRefs.length === 1 && m.subjectRefs[0] === subject.ref);
  const ok = snapshot.evidence.filter((e) => e.status === "ok").length;
  if (measured || subject.popularity === null || ctx.resolution.length === 0 || ok < MIN_OK_EVIDENCE) return;
  const name = sanitizeQlooName(subject.name, NAME_MAX);
  const evidence = ctx.ledger.addEvidence({
    skill: "resolve_entities",
    purpose: `Resolution gate: /search for '${name}' as ${subject.type}`,
    calls: ctx.resolution,
    status: "ok",
    summary: `'${name}' (${subject.type}): exact match; its popularity is the Taste Position card's reach.`,
    flags: [],
  });
  addSkillMetric(ctx.ledger, {
    key: "popularity",
    label: `popularity ${name}`,
    subjectRefs: [subject.ref],
    value: subject.popularity,
    reason: "not_measured",
    display: subject.popularity.toFixed(2),
    unit: "popularity",
    badge: "MEASURED",
    formulaId: "popularity",
    evidenceIds: [evidence.id],
    n: null,
    comparator: null,
  });
}

/**
 * Records the card for a brand_health or head_to_head run. Null for other jobs, without a subject,
 * or when no axis has a value (buildPosition). Call it after recordScorecard and before assembling.
 */
export function recordPosition(ctx: PositionContext): DatasetOf<"Position"> | null {
  const { subject } = ctx;
  if (!POSITION_JOBS.has(ctx.job) || subject === null) return null;
  recordReach(ctx, subject);
  const snapshot = ctx.ledger.snapshot();
  const card = buildPosition({
    subject: { ref: subject.ref, label: subject.name, popularity: subject.popularity },
    metrics: snapshot.metrics,
    datasets: snapshot.datasets,
    cited: ctx.cited ?? [],
    entity: (ref) => {
      const e = ctx.registry.entity(ref as RegisteredEntity["ref"]);
      return e === null ? null : { ref: e.ref, label: e.name, popularity: e.popularity };
    },
  });
  if (card === null) return null;
  return ctx.ledger.addDataset({ kind: "Position", ...card }) as DatasetOf<"Position">;
}
