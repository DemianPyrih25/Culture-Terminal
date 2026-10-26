import {
  ANALYST_TOOLS,
  type CacheProbe,
  type EntityRegistry,
  type EntityType,
  type EstimateEnv,
  type QlooParams,
  type SkillCtx,
  type SkillFor,
  type SkillResult,
  type ToolInput,
} from "@ct/contracts";
import { emptyResultFinding } from "../findings";
import { SKILL_LIMITATIONS } from "../limitations";
import { skillErrorResult, type DigestTarget } from "./digest";
import { safeName } from "./format";
import {
  contextEnvOf,
  estimateEnvOf,
  rankContexts,
  type ContextEnv,
  type ContextKind,
  type ContextSpec,
} from "./rankCandidates/contexts";
import { addRankDataset, addRankMetrics, layoutOf, rankDigestRows, recordRankEvidence, tenantPair, type RankLayout } from "./rankCandidates/outputs";
import { callsOf, estimateRankCalls, MIN_RANKED, scoreContexts, type Candidate, type ScoreGrid } from "./rankCandidates/scoring";
import {
  addDroppedFinding,
  addFindingDraft,
  addGridFlags,
  finish,
  gapNotices,
  gridStatus,
  listLabels,
  newRun,
  nothingRanked,
  usableEntities,
} from "./rankCandidates/shared";

/**
 * S8 rank_candidates (RANK; SPEC §5.3 S8, PLAN §4.3): one rank call per context over an exact
 * candidate list. One context gives a Ranked table of FIT percentiles; two or three give a Slope of
 * rank shifts; a site and the city of its metro give tenant fit. What each type may take follows the
 * frozen allowlist and the probe (G1–G5, P5).
 */

type RankInput = ToolInput<"rank_candidates">;

interface RankRule {
  contexts: readonly ContextKind[];
  seeds: boolean;
  tags: boolean;
  /** Seeds only under a none context: a location and a seed together are not verified for the type. */
  seedsAlone: boolean;
}

/**
 * The allowlist per type. Brands take every context, with seeds and taxonomy tags riding along (G1,
 * G2, G4, P5). Persons rank by location and age with no interest signal (G3, P5). Artists rank from
 * seeds and tags (P5). Places rank by location (site vs city, P5) or from seeds, never both at once.
 * Destinations rank from seeds (G5). TV shows, movies and podcasts take no candidate list.
 */
export const RANK_RULES: Partial<Readonly<Record<EntityType, RankRule>>> = {
  brand: { contexts: ["none", "site", "city", "metro", "audience", "age"], seeds: true, tags: true, seedsAlone: false },
  person: { contexts: ["site", "city", "metro", "age"], seeds: false, tags: false, seedsAlone: false },
  artist: { contexts: ["none"], seeds: true, tags: true, seedsAlone: false },
  place: { contexts: ["none", "site", "city", "metro"], seeds: true, tags: false, seedsAlone: true },
  destination: { contexts: ["none"], seeds: true, tags: false, seedsAlone: false },
};

const LOCATION_KINDS: readonly ContextKind[] = ["site", "city", "metro"];

/** Why this input cannot be ranked at all, or null. */
function refusal(input: RankInput): string | null {
  const rule = RANK_RULES[input.type];
  if (rule === undefined) {
    return `rank_candidates cannot rank ${input.type}s: Qloo takes no candidate list for them. Rank brands, persons, artists, places or destinations.`;
  }
  const bad = [...new Set(input.contexts.map((c) => c.kind).filter((k) => !rule.contexts.includes(k)))];
  if (bad.length > 0) return `${input.type}s rank under ${rule.contexts.join(", ")} contexts only; not ${bad.join(", ")}.`;
  if (!rule.seeds && input.signal_entities.length > 0) return `${input.type}s take no signal_entities.`;
  if (!rule.tags && input.signal_tags.length > 0) return `${input.type}s take no signal_tags.`;
  if (rule.seedsAlone && input.signal_entities.length > 0 && input.contexts.some((c) => c.kind !== "none")) {
    return `${input.type}s take signal_entities under a none context only: a location and a seed together are not verified for them.`;
  }
  return null;
}

interface RankSignal {
  /** The interest signal every context carries (brands) or the none context alone carries. */
  params: QlooParams;
  label: string;
  seedIds: ReadonlySet<string>;
  notices: string[];
}

/** Registered seeds and signal-capable taxonomy tags; the rest is left out with a notice. */
function signalOf(input: RankInput, registry: EntityRegistry): RankSignal {
  const notices: string[] = [];
  const seeds = [...new Set(input.signal_entities)].flatMap((ref) => {
    const e = registry.entity(ref);
    if (e === null) notices.push(`Seed ${ref} is not in the registry; left out of the signal.`);
    return e === null ? [] : [e];
  });
  const tags = [...new Set(input.signal_tags)].flatMap((ref) => {
    const t = registry.tag(ref);
    if (t === null) notices.push(`Tag ${ref} is not in the registry; left out of the signal.`);
    else if (!t.signalCapable) notices.push(`Tag ${ref} (${safeName(t.name)}) is descriptive and gives no signal; left out.`);
    return t !== null && t.signalCapable ? [t] : [];
  });
  const params: QlooParams = {
    ...(seeds.length > 0 ? { "signal.interests.entities": seeds.map((s) => s.entityId) } : {}),
    ...(tags.length > 0 ? { "signal.interests.tags": tags.map((t) => t.tagId) } : {}),
  };
  const names = [...seeds.map((s) => safeName(s.name)), ...tags.map((t) => safeName(t.name))];
  return { params, label: names.length > 0 ? `${listLabels(names, 2)} taste` : "Seed taste", seedIds: new Set(seeds.map((s) => s.entityId)), notices };
}

/** Candidates of the input type, without the seeds: Qloo leaves a signal entity out of its own results. */
function candidatesOf(input: RankInput, registry: EntityRegistry, signal: RankSignal): { candidates: Candidate[]; notices: string[] } {
  const { entities, notices } = usableEntities(input.candidates, input.type, registry, "candidates");
  const seeds = entities.filter((e) => signal.seedIds.has(e.entityId));
  if (seeds.length > 0) notices.push(`${listLabels(seeds.map((e) => e.ref))} ${seeds.length === 1 ? "is a seed" : "are seeds"}, so not ranked against itself.`);
  return { candidates: entities.filter((e) => !signal.seedIds.has(e.entityId)), notices };
}

/** The input's contexts with the interest signal added where the type takes it. */
async function specsOf(input: RankInput, env: ContextEnv, signal: RankSignal): Promise<{ specs: ContextSpec[]; repeated: string[] }> {
  const { specs, repeated } = await rankContexts(input.contexts, env, signal.label);
  const hasSignal = Object.keys(signal.params).length > 0;
  return {
    repeated,
    specs: specs.map((spec) => {
      if (spec.signal === null) return spec;
      if (spec.kind === "none" && !hasSignal) {
        return { ...spec, signal: null, gap: { reason: "unavailable", notice: `${spec.label}: no usable seed entity or taxonomy tag, so it was not called.` } };
      }
      return { ...spec, signal: { ...spec.signal, ...signal.params } };
    }),
  };
}

/**
 * Network calls a rank_candidates input would cost now: one per context, cached ones free. Metro,
 * city and neighbourhood contexts are probed when the caller passes the locality pins and the
 * gazetteer, else each counts as one call.
 */
export async function estimateRankCandidatesCalls(
  input: RankInput,
  probe: CacheProbe,
  registry: EntityRegistry,
  env?: EstimateEnv,
): Promise<number> {
  if (refusal(input) !== null) return 0;
  const signal = signalOf(input, registry);
  const { candidates } = candidatesOf(input, registry, signal);
  if (candidates.length < MIN_RANKED) return 0;
  const { specs } = await specsOf(input, estimateEnvOf(env), signal);
  return estimateRankCalls(probe, input.type, candidates.map((c) => c.entityId), specs);
}

/** What the model reads when the call's shape asked for more than the result could show. */
function layoutNotices(grid: ScoreGrid, layout: RankLayout, specs: readonly ContextSpec[]): string[] {
  const pair = tenantPair(grid.rows);
  if (layout.kind === "ranked" && grid.rows.length > 1) {
    const silent = listLabels(grid.rows.filter((r) => r !== layout.row).map((r) => r.spec.label));
    const why = pair !== null ? "Tenant fit needs both the site and the city ranked" : "A slope needs two ranked contexts";
    return [`${why}, and ${silent} ranked nothing, so ${layout.row.spec.label} is shown alone as a Ranked table.`];
  }
  if (pair !== null && layout.kind === "slope") {
    return [
      `Tenant fit needs at least ${MIN_RANKED} candidates ranked at both the site and the city; fewer were, so this shows each context's FIT with no rank shift.`,
    ];
  }
  const siteAndCity = specs.some((s) => s.kind === "site") && specs.some((s) => s.kind === "city");
  if (siteAndCity && pair === null) {
    return ["Tenant fit needs exactly a site and the city of the same metro; this call shows a rank slope instead."];
  }
  return [];
}

async function runRankCandidates(input: RankInput, ctx: SkillCtx): Promise<SkillResult> {
  const out: DigestTarget = { tool: "rank_candidates", step: input.step_id };
  const refused = refusal(input);
  if (refused !== null) return skillErrorResult(out, refused);

  const signal = signalOf(input, ctx.registry);
  const { candidates, notices } = candidatesOf(input, ctx.registry, signal);
  notices.push(...signal.notices);
  if (candidates.length < MIN_RANKED) {
    return skillErrorResult(out, [...notices, `Ranking needs at least 2 ${input.type}s; ${candidates.length} usable.`].join(" "));
  }
  const { specs, repeated } = await specsOf(input, contextEnvOf(ctx), signal);
  if (repeated.length > 0) notices.push(`Repeated contexts were called once: ${listLabels(repeated)}.`);
  if (specs.every((s) => s.signal === null)) {
    return skillErrorResult(out, [...notices, ...specs.flatMap((s) => (s.gap === null ? [] : [s.gap.notice]))].join(" "));
  }

  const grid = await scoreContexts(ctx, input.type, candidates, specs);
  const failure = grid.rows.find((r) => r.gap === "error")?.failure ?? null;
  // With nothing returned there is no evidence to keep: the error goes to the caller, as in S1.
  if (failure !== null && callsOf(grid.rows).length === 0) throw failure.error;

  const run = newRun(ctx, notices);
  run.notices.push(...gapNotices(grid, input.type));
  const locationDrops = grid.rows.some((r) => LOCATION_KINDS.includes(r.spec.kind) && r.cells.some((c) => c.reason === "dropped"));
  if (input.type === "place" && locationDrops) {
    run.notices.push("A location signal scores only part of a place list (about half in the probe); a none context with a seed entity scores every place.");
  }
  addGridFlags(run, grid);
  const evidenceId = recordRankEvidence(run, grid, input.type);
  const status = gridStatus(grid);
  const layout = layoutOf(grid);
  if (evidenceId === null) return finish(run, out, status, []);

  if (nothingRanked(grid)) {
    addDroppedFinding(run, grid);
    if (status === "empty") {
      const placesByLocation = input.type === "place" && specs.some((s) => LOCATION_KINDS.includes(s.kind));
      const draft = emptyResultFinding({
        what: `Ranking ${grid.candidates.length} ${input.type}s under ${listLabels(specs.map((s) => s.label))}`,
        suggestion: placesByLocation
          ? { tool: "rank_candidates", reason: "Rank the places under a none context with a seed entity, which scores every candidate." }
          : null,
      });
      addFindingDraft(run, draft, []);
    }
    return finish(run, out, status, rankDigestRows(grid, layout, null));
  }

  run.notices.push(...layoutNotices(grid, layout, specs));
  const metrics = addRankMetrics(run, grid, layout, evidenceId);
  addDroppedFinding(run, grid);
  addRankDataset(run, grid, layout, input.type);
  return finish(run, out, status, rankDigestRows(grid, layout, metrics));
}

export const rankCandidatesSkill: SkillFor<"rank_candidates"> = {
  id: "rank_candidates",
  mnemonic: "RANK",
  kitWorkflows: ANALYST_TOOLS.rank_candidates.kitWorkflows,
  input: ANALYST_TOOLS.rank_candidates.input,
  // Without the locality pins and the gazetteer in `env`, metros and areas count as calls.
  estimateCalls: (input, probe, registry, env) => estimateRankCandidatesCalls(input, probe, registry, env),
  run: runRankCandidates,
  // The method bullets only: buildLimitations writes each raised flag's sentence from FLAG_TEXT.
  limitations: () => [...SKILL_LIMITATIONS.rank_candidates],
};
