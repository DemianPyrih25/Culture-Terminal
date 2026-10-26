import {
  ANALYST_TOOLS,
  type CacheProbe,
  type EntityRegistry,
  type EntityType,
  type EstimateEnv,
  type SkillCtx,
  type SkillFor,
  type SkillResult,
  type ToolInput,
} from "@ct/contracts";
import { SKILL_LIMITATIONS } from "../limitations";
import { skillErrorResult, type DigestTarget } from "./digest";
import { contextEnvOf, estimateEnvOf, shareContexts } from "./rankCandidates/contexts";
import { callsOf, estimateRankCalls, MIN_RANKED, scoreContexts, type Candidate } from "./rankCandidates/scoring";
import { addGridFlags, finish, gapNotices, gridStatus, newRun, nothingRanked, usableEntities } from "./rankCandidates/shared";
import {
  addPairSplit,
  addShareFindings,
  addShareMatrix,
  addShareMetrics,
  recordGroupEvidence,
  shareDigestRows,
  shareMeasures,
} from "./shareOfTaste/outputs";

/**
 * S2 share_of_taste, the Share-of-Taste Grid (SPEC §5.3 S2; PLAN §5.3): one rank call per context
 * over the set (age G4, audience G1, metro locality G2), then QUANT reads within-call percentiles,
 * ranks k of n, youth tilt, metros won and the subject's best and worst contexts. The first entity
 * of the set is the subject.
 */

type ShareInput = ToolInput<"share_of_taste">;

/** What the frozen allowlist can share: brands under every context, persons by age (P5) and metro (G3). */
const SHARE_RULES: Partial<Readonly<Record<EntityType, { ages: boolean; audiences: boolean; metros: boolean }>>> = {
  brand: { ages: true, audiences: true, metros: true },
  person: { ages: true, audiences: false, metros: true },
};

/** Why this input cannot be shared at all, or null. */
function refusal(input: ShareInput): string | null {
  const rule = SHARE_RULES[input.type];
  if (rule === undefined) return `share_of_taste takes brand or person sets; a ${input.type} set cannot be shared.`;
  if (!rule.audiences && input.audiences.length > 0) return `${input.type} sets take no audience contexts (not verified for that type).`;
  if (!rule.ages && input.ages.length > 0) return `${input.type} sets take no age contexts.`;
  return null;
}

/** The usable members, subject first, or why the set cannot be shared: too few, or the subject (the first ref) left out. */
function membersOf(input: ShareInput, registry: EntityRegistry): { entities: Candidate[]; notices: string[]; refused: string | null } {
  const { entities, notices } = usableEntities(input.set, input.type, registry, "set");
  const subject = input.set[0];
  if (subject !== undefined && entities[0]?.ref !== subject) {
    return { entities, notices, refused: `${subject} (the subject) is not a usable ${input.type}; put the target first.` };
  }
  if (entities.length < MIN_RANKED) {
    return { entities, notices, refused: `A Share-of-Taste grid needs at least 2 ${input.type}s; ${entities.length} usable.` };
  }
  return { entities, notices, refused: null };
}

/**
 * Network calls a share_of_taste input would cost now: one per context, cached ones free. Metro
 * contexts are probed when the caller passes the locality pins, else each counts as one call.
 */
export async function estimateShareCalls(input: ShareInput, probe: CacheProbe, registry: EntityRegistry, env?: EstimateEnv): Promise<number> {
  if (refusal(input) !== null) return 0;
  const { entities, refused } = membersOf(input, registry);
  if (refused !== null) return 0;
  const specs = await shareContexts(input, estimateEnvOf(env));
  return estimateRankCalls(probe, input.type, entities.map((e) => e.entityId), specs);
}

const TILT_NOTICE =
  "Youth tilt needs a young bucket (≤24 or 25–29) and an old one (45–54 or 55+) among the ages; it is not computed for these.";

async function runShareOfTaste(input: ShareInput, ctx: SkillCtx): Promise<SkillResult> {
  const out: DigestTarget = { tool: "share_of_taste", step: input.step_id };
  const refused = refusal(input);
  if (refused !== null) return skillErrorResult(out, refused);

  const { entities, notices, refused: unusable } = membersOf(input, ctx.registry);
  if (unusable !== null) return skillErrorResult(out, [...notices, unusable].join(" "));
  const specs = await shareContexts(input, contextEnvOf(ctx));
  if (specs.every((s) => s.signal === null)) {
    return skillErrorResult(out, [...notices, ...specs.flatMap((s) => (s.gap === null ? [] : [s.gap.notice]))].join(" "));
  }

  const grid = await scoreContexts(ctx, input.type, entities, specs);
  const failure = grid.rows.find((r) => r.gap === "error")?.failure ?? null;
  // With nothing returned there is no evidence to keep: the error goes to the caller, as in S1.
  if (failure !== null && callsOf(grid.rows).length === 0) throw failure.error;

  const run = newRun(ctx, notices);
  run.notices.push(...gapNotices(grid, input.type));
  addGridFlags(run, grid);
  const evidence = recordGroupEvidence(run, grid, input.type);
  const status = gridStatus(grid);
  const m = shareMeasures(grid);
  if (input.ages.length > 0 && m.tilts === null) run.notices.push(TILT_NOTICE);
  if (run.evidenceIds.length === 0) return finish(run, out, status, []);

  if (nothingRanked(grid)) {
    addShareFindings(run, grid, m, null, input.type, status === "empty");
    return finish(run, out, status, shareDigestRows(grid, m, null));
  }

  const metrics = addShareMetrics(run, grid, m, evidence);
  const generational = addShareFindings(run, grid, m, metrics, input.type, false);
  addShareMatrix(run, grid, m, generational);
  addPairSplit(run, grid);
  return finish(run, out, status, shareDigestRows(grid, m, metrics));
}

export const shareOfTasteSkill: SkillFor<"share_of_taste"> = {
  id: "share_of_taste",
  mnemonic: "SHARE",
  kitWorkflows: ANALYST_TOOLS.share_of_taste.kitWorkflows,
  input: ANALYST_TOOLS.share_of_taste.input,
  // Without the locality pins in `env`, metros count as calls.
  estimateCalls: (input, probe, registry, env) => estimateShareCalls(input, probe, registry, env),
  run: runShareOfTaste,
  // The method bullets only: buildLimitations writes each raised flag's sentence from FLAG_TEXT.
  limitations: () => [...SKILL_LIMITATIONS.share_of_taste],
};
