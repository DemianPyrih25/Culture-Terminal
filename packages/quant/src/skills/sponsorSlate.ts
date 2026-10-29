import {
  ANALYST_TOOLS,
  type CacheProbe,
  type DigestRow,
  type EntityRegistry,
  type EvidenceId,
  type Flag,
  type MarketId,
  type MarketLocality,
  type NoValueReason,
  type QlooCallMeta,
  type QlooParams,
  type RegisteredEntity,
  type SkillCtx,
  type SkillFor,
  type SkillResult,
  type SkillStatus,
  type SponsorCategory,
  type ToolInput,
} from "@ct/contracts";
import { SKILL_LIMITATIONS } from "../limitations";
import { detectFloor } from "../stats";
import { addSkillEvidence, attemptAllKeepingFailures, countUncached, registerEntity, type Attempt } from "./common";
import { skillErrorResult, skillResult, type DigestTarget } from "./digest";
import { safeName, safeText } from "./format";
import { pickCategoryTag, SPONSOR_CATEGORIES, tagLookupParams, tagsOverlap } from "./sponsorSlate/categories";
import { marketLabel } from "./metros";
import {
  addSlateDatasets,
  addSlateFindings,
  addSlateMetrics,
  categoryLabel,
  listLabels,
  slateDigestRows,
  type SlateRun,
  type SlateState,
} from "./sponsorSlate/outputs";
import {
  categoryRows,
  cellsOf,
  marketColumn,
  marketSlate,
  MIN_MARKET_SCORED,
  pooledAffinities,
  scoreSlate,
  selectCandidates,
  type CallCell,
  type CallGap,
  type CandidateSelection,
  type CategoryDiscovery,
  type MarketColumn,
  type ScoredSlate,
} from "./sponsorSlate/slate";

/**
 * S10 sponsor_slate, the Sponsor Slate (SPEC §5.3 S10; PLAN §5.3): per category, discovery with the
 * seed as the signal and one category tag in filter.tags (several tags would combine as a union,
 * P5); one-scale scoring of the top two per category plus the shortlist (≤30) against the seed;
 * then, per market, the seed plus the market's locality over the slate (≤12). FIT is the
 * within-call percentile of the scoring call; a brand a market call drops is not scored there, and
 * a market's Δ compares it with the national ranking of the same brands the market scored.
 * GHOST picks are not part of the tool input, so the candidates are discovery and the shortlist.
 */

type SlateInput = ToolInput<"sponsor_slate">;

const BRAND = "urn:entity:brand";
/** Per-category discovery size (SPEC: take=10). */
export const DISCOVERY_TAKE = 10;
/** A call with fewer rows than this is a thin result (§6.4). */
const THIN_ROWS = 5;
/** Tag names in the semantic-search notice; taxonomy names are short, so this only bounds the digest. */
const TAG_NAME_MAX = 24;

/** Category discovery: the seed's taste, restricted to brands carrying the one category tag. */
export function discoveryParams(seedEntityId: string, tagId: string): QlooParams {
  return { "signal.interests.entities": [seedEntityId], "filter.tags": [tagId], take: DISCOVERY_TAKE };
}

/** The one-scale call: every candidate scored against the seed in one call (G1 candidate-set invariance). */
export function scoringParams(seedEntityId: string, candidateIds: readonly string[]): QlooParams {
  return { "signal.interests.entities": [seedEntityId], "filter.results.entities": [...candidateIds], take: candidateIds.length };
}

/** A market call: the seed plus the market's locality over the slate; both signals apply (P5). */
export function marketParams(seedEntityId: string, localityId: string, slateIds: readonly string[]): QlooParams {
  return {
    "signal.interests.entities": [seedEntityId],
    "signal.location": localityId,
    "filter.results.entities": [...slateIds],
    take: slateIds.length,
  };
}

/** The probe sees insights requests with their filter.type, since has() takes no separate filter type. */
function probeParams(params: QlooParams | null): QlooParams | null {
  return params === null ? null : { "filter.type": BRAND, ...params };
}

/**
 * Network calls a sponsor_slate input would cost now. Tag lookups and the discovery of categories
 * with a verified tag are probed; a category whose tag comes from a lookup counts its discovery as
 * one call, and the scoring call and each market call count one, since their candidates are only
 * known after discovery.
 */
export async function estimateSponsorSlateCalls(input: SlateInput, probe: CacheProbe, registry: EntityRegistry): Promise<number> {
  const seed = registry.entity(input.seed);
  if (seed === null) return 0;
  const specs = input.categories.map((c) => SPONSOR_CATEGORIES[c]);
  const lookups = specs.map((s) => (s.tag === null ? tagLookupParams(s) : null));
  const known = specs.map((s) => (s.tag === null ? null : probeParams(discoveryParams(seed.entityId, s.tag))));
  const [tagCalls, discoveryCalls] = await Promise.all([
    countUncached(probe, "/v2/tags", lookups),
    countUncached(probe, "/v2/insights", known),
  ]);
  const searched = lookups.filter((p) => p !== null).length;
  return tagCalls + discoveryCalls + searched + 1 + input.markets.length;
}

function count(n: number, noun: string): string {
  return `${n} ${n === 1 ? noun : `${noun}s`}`;
}

function gapOf(attempt: Attempt<unknown> | undefined): CallGap | null {
  if (attempt === undefined || attempt.kind === "skipped") return null;
  return attempt.kind === "truncated" ? "budget_truncated" : attempt.kind === "failed" ? "error" : null;
}

/** Shortlist refs that are registered brands, with a notice for each one left out. */
function usableShortlist(input: SlateInput, registry: EntityRegistry, seed: RegisteredEntity): { brands: RegisteredEntity[]; notices: string[] } {
  const brands: RegisteredEntity[] = [];
  const notices: string[] = [];
  for (const ref of input.shortlist) {
    const e = registry.entity(ref);
    if (e === null) notices.push(`${ref} is not in the registry; left out of the slate.`);
    else if (e.entityId === seed.entityId) notices.push(`${ref} is the seed; left out of the slate.`);
    else if (e.type !== "brand") notices.push(`${ref} (${safeName(e.name)}) is a ${e.type}, not a brand; left out of the slate.`);
    else brands.push(e);
  }
  return { brands, notices };
}

/** Tracks the run's outcome across phases: what the budget refused, the first failed call and failed locality lookups. */
interface Progress {
  truncated: boolean;
  failure: { code: string; error: unknown } | null;
  localityFailed: boolean;
}

function track<T>(progress: Progress, attempts: readonly Attempt<T>[]): void {
  for (const a of attempts) {
    if (a.kind === "truncated") progress.truncated = true;
    if (a.kind === "failed" && progress.failure === null) progress.failure = { code: a.code, error: a.error };
  }
}

function metasOf<T>(attempts: readonly Attempt<{ meta: QlooCallMeta; data: T }>[]): QlooCallMeta[] {
  return attempts.flatMap((a) => (a.kind === "ok" ? [a.value.meta] : []));
}

interface CategoryTag {
  category: SponsorCategory;
  tagId: string | null;
  /** Why the category has no tag: unavailable (the lookup found none, or one an earlier category holds), budget_truncated or error. */
  gap: NoValueReason | null;
}

/**
 * Each category's filter tag: the verified one from the config, else the first genre:brand tag of a
 * lookup. A looked-up tag that equals or nests with a tag already assigned (configured ones first,
 * then lookups in input order) is not used: the category would re-read another category's list.
 */
async function categoryTags(
  run: SlateRun,
  progress: Progress,
  categories: readonly SponsorCategory[],
): Promise<{ tags: CategoryTag[]; evidenceId: EvidenceId | null }> {
  const specs = categories.map((c) => SPONSOR_CATEGORIES[c]);
  const attempts = await attemptAllKeepingFailures(
    specs.map((s) => (s.tag === null ? () => run.ctx.qloo.tags(tagLookupParams(s)) : null)),
    run.ctx.signal,
  );
  track(progress, attempts);

  const assigned = new Map<string, SponsorCategory>();
  specs.forEach((s, i) => {
    if (s.tag !== null && !assigned.has(s.tag)) assigned.set(s.tag, categories[i]!);
  });
  const found: string[] = [];
  const missing: string[] = [];
  const shared: string[] = [];
  const tags = categories.map((category, i): CategoryTag => {
    const configured = specs[i]!.tag;
    if (configured !== null) return { category, tagId: configured, gap: null };
    const attempt = attempts[i];
    if (attempt?.kind !== "ok") return { category, tagId: null, gap: gapOf(attempt) ?? "error" };
    const tag = pickCategoryTag(attempt.value.data.results.tags);
    if (tag === null) {
      missing.push(categoryLabel(category));
      return { category, tagId: null, gap: "unavailable" };
    }
    const held = [...assigned.entries()].find(([id]) => tagsOverlap(id, tag.id));
    if (held !== undefined) {
      const how = held[0] === tag.id ? "the same tag as" : "a tag nested with that of";
      shared.push(`${categoryLabel(category)} resolved to ${how} ${categoryLabel(held[1])}`);
      return { category, tagId: null, gap: "unavailable" };
    }
    assigned.set(tag.id, category);
    found.push(`${categoryLabel(category)} (${safeText(tag.name, TAG_NAME_MAX)})`);
    return { category, tagId: tag.id, gap: null };
  });

  const calls = metasOf(attempts);
  const looked = attempts.filter((a) => a.kind !== "skipped").length;
  const gaps = attempts.filter((a) => a.kind === "truncated" || a.kind === "failed").length;
  const evidence = addSkillEvidence(run.ctx.ledger, {
    skill: "sponsor_slate",
    purpose: "Category tag lookups for sponsor categories without a probe-verified tag",
    calls,
    status: gaps > 0 ? "partial" : found.length === 0 ? "empty" : "ok",
    summary:
      `${count(looked, "lookup")}; genre:brand tag found for ${found.length > 0 ? listLabels(found) : "no category"}` +
      `${missing.length > 0 ? `, none for ${listLabels(missing)}` : ""}` +
      `${shared.length > 0 ? `; ${shared.length === 1 ? "1 category" : `${shared.length} categories`} shared an earlier category's tag` : ""}` +
      `${gaps > 0 ? `; ${gaps} not answered` : ""}.`,
    flags: progress.truncated ? ["BUDGET_TRUNCATED"] : [],
  });
  if (evidence !== null) run.evidenceIds.push(evidence.id);
  if (found.length > 0) {
    run.notices.push(`Category tags found by semantic search, not probe-verified: ${listLabels(found)}.`);
  }
  for (const s of shared) run.notices.push(`${s}; not measured separately.`);
  return { tags, evidenceId: evidence?.id ?? null };
}

/** Per-category discovery: one call per category with a tag, each sending that one tag. */
async function discover(
  run: SlateRun,
  progress: Progress,
  seed: RegisteredEntity,
  tags: readonly CategoryTag[],
): Promise<{ discoveries: CategoryDiscovery[]; calls: QlooCallMeta[]; thin: boolean }> {
  const attempts = await attemptAllKeepingFailures(
    tags.map((t) => (t.tagId === null ? null : () => run.ctx.qloo.insights(BRAND, discoveryParams(seed.entityId, t.tagId!)))),
    run.ctx.signal,
  );
  track(progress, attempts);
  const discoveries = tags.map((t, i): CategoryDiscovery => {
    const attempt = attempts[i];
    if (attempt?.kind === "ok") return { category: t.category, tagId: t.tagId, results: attempt.value.data.results.entities, gap: null };
    return { category: t.category, tagId: t.tagId, results: null, gap: t.gap ?? gapOf(attempt) ?? "error" };
  });
  const thin = discoveries.some((d) => d.results !== null && d.results.length < THIN_ROWS);
  return { discoveries, calls: metasOf(attempts), thin };
}

/**
 * One notice per category whose discovery carried brands from another line (ANSWER_QUALITY §9): who
 * was skipped and where their main line lies, and plainly when no brand that fits the category is left.
 */
function offCategoryNotices(discoveries: readonly CategoryDiscovery[], selection: CandidateSelection): string[] {
  return discoveries.flatMap((d) => {
    const skipped = selection.offCategory.filter((o) => o.category === d.category);
    if (skipped.length === 0) return [];
    const label = categoryLabel(d.category);
    const names = skipped.slice(0, 4).map((o) => `${safeName(o.name)} (${o.branch.replace(/_/g, " ")})`).join(", ");
    const more = skipped.length > 4 ? ` and ${skipped.length - 4} more` : "";
    const none = (selection.usable.get(d.category) ?? 0) === 0 ? ` No brand that fits ${label} is left, so the slate has no ${label} pick.` : "";
    return [`${label}: ${count(skipped.length, "discovery result")} carried the category tag only beside a main line elsewhere and ${skipped.length === 1 ? "was" : "were"} skipped: ${names}${more}.${none}`];
  });
}

function recordDiscovery(
  run: SlateRun,
  seed: RegisteredEntity,
  discoveries: readonly CategoryDiscovery[],
  selection: CandidateSelection,
  thin: boolean,
  calls: readonly QlooCallMeta[],
): EvidenceId | null {
  const { usable, gateDropped, offCategory } = selection;
  const flags: Flag[] = [];
  const truncated = discoveries.some((d) => d.tagId !== null && d.gap === "budget_truncated");
  const failed = discoveries.some((d) => d.tagId !== null && d.gap === "error");
  if (gateDropped.length > 0) flags.push("QUALITY_GATE_DROPPED");
  if (thin) flags.push("THIN_RESULT");
  if (truncated) flags.push("BUDGET_TRUNCATED");
  for (const f of flags) run.flags.add(f);
  if (gateDropped.length > 0) {
    const n = gateDropped.length;
    run.notices.push(`${count(n, "discovery result")} below the popularity quality gate ${n === 1 ? "was" : "were"} skipped.`);
  }
  run.notices.push(...offCategoryNotices(discoveries, selection));

  const answered = discoveries.filter((d) => d.results !== null);
  const parts = answered.map((d) => `${categoryLabel(d.category)} ${usable.get(d.category) ?? 0}`);
  const totalUsable = answered.reduce((n, d) => n + (usable.get(d.category) ?? 0), 0);
  const evidence = addSkillEvidence(run.ctx.ledger, {
    skill: "sponsor_slate",
    purpose: `Sponsor category discovery for ${safeName(seed.name)}`,
    calls,
    status: truncated || failed ? "partial" : totalUsable === 0 ? "empty" : "ok",
    summary:
      `Usable results by category: ${parts.length > 0 ? parts.join(", ") : "none"}` +
      `${gateDropped.length > 0 ? `; ${gateDropped.length} skipped by the quality gate` : ""}` +
      `${offCategory.length > 0 ? `; ${offCategory.length} skipped as outside their category` : ""}.`,
    flags,
    qualityGateDrops: gateDropped.length,
  });
  if (evidence === null) return null;
  run.evidenceIds.push(evidence.id);
  return evidence.id;
}

function recordScoring(run: SlateRun, state: Pick<SlateState, "candidates" | "slate">, meta: QlooCallMeta | null): EvidenceId | null {
  const cells = state.slate.fit;
  const dropped = cells.filter((c) => c.reason === "dropped").length;
  const floorTied = cells.filter((c) => c.reason === "not_scored").length;
  const flags: Flag[] = [];
  if (dropped > 0 || floorTied > 0) flags.push("CANDIDATES_UNSCORED");
  if (dropped > 0) flags.push("DROPPED_CANDIDATES");
  if (floorTied > 0) flags.push("NOT_SCORED");
  for (const f of flags) run.flags.add(f);
  if (meta === null) return null;
  const unscored = [floorTied > 0 ? `${floorTied} tied at the floor, not scored` : null, dropped > 0 ? `${dropped} dropped by Qloo` : null].filter(
    (s) => s !== null,
  );
  const evidence = addSkillEvidence(run.ctx.ledger, {
    skill: "sponsor_slate",
    purpose: "One-scale FIT scoring of the sponsor candidates against the seed",
    calls: [meta],
    status: state.slate.scored === 0 ? "empty" : "ok",
    summary: `${state.slate.scored} of ${count(state.candidates.length, "candidate")} scored${unscored.length > 0 ? ` (${unscored.join(", ")})` : ""}.`,
    flags,
  });
  if (evidence === null) return null;
  run.evidenceIds.push(evidence.id);
  return evidence.id;
}

/**
 * The market localities, in input order. A market with no pinned locality, or whose lookup failed,
 * is skipped with its own notice; a failed lookup makes the run partial like a failed call.
 */
async function marketLocalities(
  run: SlateRun,
  progress: Progress,
  markets: readonly MarketId[],
): Promise<{ market: MarketId; locality: MarketLocality }[]> {
  if (markets.length === 0) return [];
  const api = run.ctx.localities;
  if (api === null) {
    run.notices.push("Market localities are not available in this build, so market alignment was not measured.");
    return [];
  }
  const found = await Promise.all(
    markets.map((m) =>
      api.market(m).then(
        (locality) => ({ locality }),
        (error: unknown) => ({ error }),
      ),
    ),
  );
  const missing = markets.filter((_, i) => {
    const f = found[i]!;
    return "locality" in f && f.locality === null;
  });
  const failed = markets.filter((_, i) => "error" in found[i]!);
  if (missing.length > 0) run.notices.push(`No pinned locality for ${listLabels(missing.map(marketLabel))}; market alignment was not measured there.`);
  if (failed.length > 0) {
    progress.localityFailed = true;
    run.notices.push(`Locality lookup failed for ${listLabels(failed.map(marketLabel))}; market alignment was not measured there.`);
  }
  return markets.flatMap((market, i) => {
    const f = found[i]!;
    return "locality" in f && f.locality !== null ? [{ market, locality: f.locality }] : [];
  });
}

/**
 * One call per market over the slate. Each column carries pct_jm and the national affinity re-ranked
 * over the members that market scored; `national` is the national affinity re-ranked over the whole
 * slate, the Slope's first axis.
 */
async function measureMarkets(
  run: SlateRun,
  progress: Progress,
  seed: RegisteredEntity,
  memberIds: readonly string[],
  nationalAffinity: readonly (number | null)[],
  markets: readonly { market: MarketId; locality: MarketLocality }[],
  pooled: readonly number[],
): Promise<{ columns: MarketColumn[]; national: CallCell[]; evidenceId: EvidenceId | null }> {
  if (markets.length === 0 || memberIds.length === 0) return { columns: [], national: [], evidenceId: null };
  const attempts = await attemptAllKeepingFailures(
    markets.map((m) => () => run.ctx.qloo.insights(BRAND, marketParams(seed.entityId, m.locality.entityId, memberIds))),
    run.ctx.signal,
  );
  track(progress, attempts);
  const responses = attempts.map((a) => (a.kind === "ok" ? a.value.data.results.entities : null));
  // The floor is the seed's "no relationship" score, shared across its calls: pool them all.
  const floor = detectFloor([...pooled, ...pooledAffinities(responses.map((rows, i) => ({ signal: markets[i]!.locality.entityId, rows })))]);
  const columns = markets.map((m, i): MarketColumn => {
    const rows = responses[i] ?? null;
    const response = rows ?? gapOf(attempts[i]) ?? "error";
    return marketColumn({ market: m.market, label: m.locality.label, slateIds: memberIds, nationalAffinity, response, floor });
  });

  const answered = columns.filter((c) => c.gap === null);
  const dropped = answered.some((c) => c.cells.some((x) => x.reason === "dropped"));
  const floorTied = answered.some((c) => c.cells.some((x) => x.reason === "not_scored"));
  const truncated = columns.some((c) => c.gap === "budget_truncated");
  const flags: Flag[] = [];
  if (dropped || floorTied) flags.push("CANDIDATES_UNSCORED");
  if (truncated) flags.push("BUDGET_TRUNCATED");
  if (dropped) flags.push("DROPPED_CANDIDATES");
  if (floorTied) flags.push("NOT_SCORED");
  for (const f of flags) run.flags.add(f);

  const thin = answered.filter((c) => c.scored > 0 && c.scored < MIN_MARKET_SCORED).map((c) => safeName(c.label));
  if (thin.length > 0) {
    run.notices.push(
      `${listLabels(thin)} scored fewer than ${MIN_MARKET_SCORED} slate brands, too few to compare with the national ranking; no market alignment there.`,
    );
  }
  const evidence = addSkillEvidence(run.ctx.ledger, {
    skill: "sponsor_slate",
    purpose: `Market alignment of the sponsor slate in ${listLabels(markets.map((m) => safeName(m.locality.label)))}`,
    calls: metasOf(attempts),
    status: columns.some((c) => c.gap !== null) ? "partial" : answered.every((c) => c.scored === 0) ? "empty" : "ok",
    summary: `${answered.map((c) => `${safeName(c.label)} scored ${c.scored} of ${memberIds.length}`).join(", ")}.`,
    flags,
  });
  if (evidence !== null) run.evidenceIds.push(evidence.id);
  return { columns, national: cellsOf(nationalAffinity, floor), evidenceId: evidence?.id ?? null };
}

/** The one-scale call's raw affinities for the market slate, aligned with it. */
function slateAffinity(slate: ScoredSlate, members: readonly number[]): (number | null)[] {
  return members.map((j) => slate.affinity[j] ?? null);
}

function finish(run: SlateRun, target: DigestTarget, status: SkillStatus, rows: readonly DigestRow[]): SkillResult {
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

async function runSponsorSlate(input: SlateInput, ctx: SkillCtx): Promise<SkillResult> {
  const out: DigestTarget = { tool: "sponsor_slate", step: input.step_id };
  const seed = ctx.registry.entity(input.seed);
  if (seed === null) return skillErrorResult(out, `${input.seed} is not in the registry; resolve the artist, person or brand first.`);

  const shortlist = usableShortlist(input, ctx.registry, seed);
  const run: SlateRun = {
    ctx,
    flags: new Set(),
    evidenceIds: [],
    metrics: [],
    findings: [],
    datasetIds: [],
    registered: [],
    notices: [...shortlist.notices],
  };
  const progress: Progress = { truncated: false, failure: null, localityFailed: false };

  // Category tags, then one discovery call per category.
  const { tags, evidenceId: tagEvidence } = await categoryTags(run, progress, input.categories);
  const found = await discover(run, progress, seed, tags);
  const selection = selectCandidates({ seedEntityId: seed.entityId, discoveries: found.discoveries, shortlist: shortlist.brands });
  if (selection.overCap.length > 0) run.notices.push(`The candidate cap left out ${listLabels(selection.overCap.map(safeName))}.`);
  const discoveryEvidence = recordDiscovery(run, seed, found.discoveries, selection, found.thin, found.calls);

  // Registration: discovered picks become refs; shortlist brands already are.
  const refs = selection.candidates.map((c) => {
    const reg = registerEntity(ctx.registry, c.entity);
    if (reg.isNew) run.registered.push(reg.entity);
    return reg.entity;
  });

  // One-scale scoring.
  const ids = selection.candidates.map((c) => c.entity.entityId);
  const [scoring] =
    ids.length === 0
      ? [undefined]
      : await attemptAllKeepingFailures([() => ctx.qloo.insights(BRAND, scoringParams(seed.entityId, ids))], ctx.signal);
  if (scoring !== undefined) track(progress, [scoring]);
  if (scoring?.kind === "truncated") run.flags.add("BUDGET_TRUNCATED");
  const scoringRows = scoring?.kind === "ok" ? scoring.value.data.results.entities : null;
  const pooled = pooledAffinities([...found.discoveries.map((d) => d.results), scoringRows].map((rows) => ({ signal: "seed", rows })));
  const slate = scoreSlate(selection.candidates, scoringRows ?? gapOf(scoring) ?? "error", detectFloor(pooled));
  const scoringEvidence =
    scoring === undefined ? null : recordScoring(run, { candidates: selection.candidates, slate }, scoring.kind === "ok" ? scoring.value.meta : null);
  const rows = categoryRows({ discoveries: found.discoveries, selection, slate });

  // Markets.
  const members = marketSlate(selection, rows, slate);
  if (input.markets.length > 0 && members.length === 0) run.notices.push("No brand was scored nationally, so no market call was made.");
  const markets = members.length === 0 ? [] : await marketLocalities(run, progress, input.markets);
  const measured = await measureMarkets(run, progress, seed, members.map((j) => ids[j]!), slateAffinity(slate, members), markets, pooled);

  // A run that recorded nothing has no evidence to keep: a failed call goes to the caller as an error.
  if (run.evidenceIds.length === 0 && progress.failure !== null) throw progress.failure.error;
  if (progress.failure !== null) run.notices.push(`Some Qloo calls failed (${progress.failure.code}); what they cover is not measured.`);
  if (progress.truncated) run.flags.add("BUDGET_TRUNCATED");

  const state: SlateState = {
    seed,
    candidates: selection.candidates,
    refs,
    slate,
    rows,
    members,
    columns: measured.columns,
    nationalOverSlate: measured.national,
    lookedUp: new Set(input.categories.filter((c) => SPONSOR_CATEGORIES[c].tag === null)),
    pool: selection.pool,
    evidence: { tags: tagEvidence, discovery: discoveryEvidence, scoring: scoringEvidence, markets: measured.evidenceId },
  };
  const metrics = addSlateMetrics(run, state);
  addSlateFindings(run, state, metrics);
  const quadrant = addSlateDatasets(run, state);
  if (metrics.uncited.length > 0) {
    const n = metrics.uncited.length;
    const where = quadrant === null ? "" : `; ${n === 1 ? "its" : "their"} FIT is in ${quadrant}`;
    run.notices.push(`${count(n, "more shortlist brand")} ${n === 1 ? "has" : "have"} no FIT metric, to fit this result${where}.`);
  }

  const anyBest = rows.some((r) => r.best !== null);
  const partial =
    progress.truncated || progress.failure !== null || progress.localityFailed || (anyBest && rows.some((r) => r.best === null));
  const status: SkillStatus = partial ? "partial" : anyBest ? "ok" : "empty";
  return finish(run, out, status, slateDigestRows(state, metrics));
}

export const sponsorSlateSkill: SkillFor<"sponsor_slate"> = {
  id: "sponsor_slate",
  mnemonic: "SLATE",
  kitWorkflows: ANALYST_TOOLS.sponsor_slate.kitWorkflows,
  input: ANALYST_TOOLS.sponsor_slate.input,
  estimateCalls: (input, probe, registry) => estimateSponsorSlateCalls(input, probe, registry),
  run: runSponsorSlate,
  // The method bullets only: buildLimitations writes each raised flag's sentence from FLAG_TEXT.
  limitations: () => [...SKILL_LIMITATIONS.sponsor_slate],
};
