// `pnpm run-skill <skill> …`: one QUANT skill end to end through the real Qloo client, run ledger
// and registry, with no agent and no web server (PLAN Part 2). peer_landscape and resolve_entities
// take names as arguments; any skill runs from its tool input (--input), with --names resolved to R#
// refs and --tags registered as T# refs first. Names resolve exactly first (D20): a name without a
// single exact match of the right type prints its candidates, with their entity ids for run-agent
// --pins, and stops.
import { createEntityRegistry, createRunBudget, createRunLedger, type RunLedger, type RunRegistry } from "@ct/agent";
import {
  DEFAULT_RUN_LIMITS,
  EntityType,
  MetroId,
  NO_RUN_CANDIDATES,
  SkillId,
  type EntityRef,
  type EventInput,
  type GeoApi,
  type LocalityApi,
  type ResolvedMention,
  type Skill,
  type SkillCtx,
  type SkillResult,
  type TagRef,
} from "@ct/contracts";
import { getDb } from "@ct/db";
import { isNetworkCacheStatus, type QlooCallRecord, type QlooClient, type QlooStore, type RunQloo } from "@ct/qloo";
import type { PublicCallRecord, PublicDataClient, RunPublic } from "@ct/publicdata";
import { classifyMatches, normaliseName, searchParams, SKILLS } from "@ct/quant";
import { choiceOption, intOption, listOption, nameArg, parseCli, UsageError, type ParsedOptions } from "./args";
import { renderDatasets } from "./dataset-view";
import { formatFixed2, NONE, publicChip } from "./format";
import { ensureMetrosIn, loadGeo } from "./geo";
import { EXIT, heading, safeIo, type CliIo } from "./io";
import { callNumbers, evidenceByCall, renderCalls, renderEvidence, renderFindings, renderMetrics, renderQuota } from "./ledger-view";
import { kvLocalityApi, localitiesKvKey, MalformedPinsError, pgKv, readPins, type KvStore } from "./localities";
import { renderSubstitutionMap } from "./matrix";
import { CliError, describeDatabase, describePublicData, openCliQloo, stderrLogger, type CliQloo } from "./qloo-setup";
import {
  InputError,
  maxRefNumber,
  mentionArg,
  readInputOption,
  refsIn,
  registerTagUrn,
  registryRefs,
  renderDigest,
  renderRegistry,
  tagsOption,
  validateInput,
  withCallMeta,
  type NameMention,
} from "./skill-input";
import { renderTable, truncate } from "./table";

export const RUN_SKILL_USAGE = [
  "usage: pnpm run-skill peer_landscape <brand> [--k N] [--peers \"A,B\"] [--no-discover] [common options]",
  "       pnpm run-skill resolve_entities <name> [<name>…] [--type T] [--metro M] [common options]",
  "       pnpm run-skill <skill> --input '<json>' [--names \"A,B\"] [--type T] [--metro M] [--tags \"U,V\"] [common options]",
  "  --k N            Substitution Map size including the target, 4–7 (default 6)",
  "  --peers \"A,B\"    peers to put in the map, resolved exactly like the target (at most 6)",
  "  --no-discover    skip the two discovery calls (needs at least 3 --peers)",
  "  --type T         entity type of the names (default brand): " + EntityType.options.join(", "),
  "  --metro M        metro to search place names in: " + MetroId.options.join(", "),
  "any skill, from its tool input: " + SkillId.options.join(", "),
  "  --input JSON     the tool input as the ANALYST sends it, with R# and T# refs; @path reads it from a file;",
  "                   trigger_finding_id and step_id default to null",
  "  --names \"A,B\"    names resolved through resolve_entities first, registered as R1, R2… in order;",
  "                   \"type:Name\" gives one name its own type (artist:Artist Nova), --type the others",
  "  --tags \"U,V\"     tag URNs registered as T1, T2… in order, as find_tags registers them",
  "                   (run-skill find_tags --input '{\"concepts\":[…]}' prints a concept's tag URNs under REGISTERED BY FIND_TAGS)",
  "common options:",
  "  --mock           synthetic Qloo data (QLOO_MOCK=1): no key, no network",
  "  --tag T          QLOO_TAG for the call log and the per-tag network cap",
  "  --memory         cache in memory instead of the shared Postgres cache (nothing persists; with --mock only)",
  "  -h, --help       this text",
  "Over Postgres, metro, city and market contexts read the pinned localities in kv (tools/dev/localities.ts pin).",
  "A name without an exact match prints its candidates with their entity ids, for run-agent --pins.",
  "exit codes: 0 done, 1 failed (or a budget gate refused a search), 2 bad arguments, 3 a name needs a choice (not an exact match)",
].join("\n");

/** The skills that take names as arguments (PLAN Part 2); every skill takes --input. */
const NAMED = ["peer_landscape", "resolve_entities"] as const;
type NamedSkill = (typeof NAMED)[number];

const OPTIONS = {
  type: { type: "string" },
  metro: { type: "string" },
  k: { type: "string" },
  peers: { type: "string" },
  discover: { type: "boolean" },
  input: { type: "string" },
  names: { type: "string" },
  tags: { type: "string" },
  mock: { type: "boolean" },
  tag: { type: "string" },
  memory: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

const MAX_MENTIONS = 8;
const MAX_PEERS = 6;
/** rank_candidates takes up to 50 candidates and 3 seeds; resolution runs in calls of MAX_MENTIONS. */
const MAX_INPUT_NAMES = 56;
const RESOLVE_TOOL_CALL = "cli-resolve";
const MAP_TOOL_CALL = "cli-map";
const CANDIDATES_TOOL_CALL = "cli-candidates";

interface CommonArgs {
  mock: boolean;
  tag: string | null;
  memory: boolean;
}

/** peer_landscape or resolve_entities with names as arguments. */
export interface NamedSkillArgs extends CommonArgs {
  mode: "names";
  skill: NamedSkill;
  names: string[];
  type: EntityType;
  metro: MetroId | null;
  k: number;
  peers: string[];
  discover: boolean;
}

/** Any skill from its tool input, after the names and tags it refers to are registered. */
export interface InputSkillArgs extends CommonArgs {
  mode: "input";
  skill: SkillId;
  mentions: NameMention[];
  tags: string[];
  /** The tool input, already valid against the skill's schema. */
  input: unknown;
}

export type SkillArgs = NamedSkillArgs | InputSkillArgs;

function parseInputArgs(skill: SkillId, positionals: readonly string[], options: ParsedOptions<typeof OPTIONS>, common: CommonArgs): InputSkillArgs {
  if (positionals.length > 0) throw new UsageError("with --input, give names with --names, not as arguments");
  for (const flag of ["k", "peers", "discover"] as const) {
    if (options[flag] !== undefined) {
      throw new UsageError(`--${flag === "discover" ? "no-discover" : flag} does not go with --input; put it in the input`);
    }
  }
  const type = choiceOption(options.type, "--type", EntityType.options, "brand");
  const metro = options.metro === undefined ? null : choiceOption(options.metro, "--metro", MetroId.options, "nashville");
  const mentions = listOption(options.names).map((item) => mentionArg(item, type, metro));
  if (mentions.length > MAX_INPUT_NAMES) throw new UsageError(`--names takes at most ${MAX_INPUT_NAMES} names`);
  if (options.type !== undefined && mentions.length === 0) throw new UsageError("--type applies to --names");
  if (metro !== null && !mentions.some((m) => m.type === "place")) throw new UsageError("--metro applies to place names only");
  if (mentions.some((m) => m.type === "place" && m.metro === null)) throw new UsageError(`a place name needs --metro (${MetroId.options.join(", ")})`);
  const tags = tagsOption(options.tags);

  const input = validateInput(skill, withCallMeta(readInputOption(options.input ?? "")));
  // Refs are numbered in registration order, so the input cannot name more of them than are given.
  const refs = refsIn(input);
  const maxR = maxRefNumber(refs.entities);
  if (maxR > mentions.length) {
    throw new InputError(`--input uses R${maxR}, but --names gives ${mentions.length} name(s)${mentions.length > 0 ? ` (R1–R${mentions.length})` : ""}`);
  }
  const maxT = maxRefNumber(refs.tags);
  if (maxT > tags.length) {
    throw new InputError(`--input uses T${maxT}, but --tags gives ${tags.length} tag(s)${tags.length > 0 ? ` (T1–T${tags.length})` : ""}`);
  }
  return { mode: "input", skill, mentions, tags, input, ...common };
}

/** The parsed command, or null for --help. Throws UsageError. */
export function parseSkillArgs(argv: readonly string[]): SkillArgs | null {
  const { positionals, options } = parseCli(argv, OPTIONS);
  if (options.help) return null;
  const [skillArg, ...names] = positionals;
  if (skillArg === undefined) throw new UsageError(`name a skill: ${SkillId.options.join(", ")}`);
  if (!SkillId.safeParse(skillArg).success) throw new UsageError(`unknown skill "${skillArg}"; run-skill runs ${SkillId.options.join(", ")}`);
  const tag = options.tag?.trim() ?? null;
  if (tag === "") throw new UsageError("--tag needs a non-empty value");
  const common: CommonArgs = { mock: options.mock === true, tag, memory: options.memory === true };
  if (options.input !== undefined) return parseInputArgs(skillArg as SkillId, names, options, common);

  for (const flag of ["names", "tags"] as const) if (options[flag] !== undefined) throw new UsageError(`--${flag} goes with --input`);
  if (!NAMED.includes(skillArg as NamedSkill)) {
    throw new UsageError(`${skillArg} runs from its tool input: pnpm run-skill ${skillArg} --input '<json>' (see --help)`);
  }
  const skill = skillArg as NamedSkill;
  if (names.length === 0) throw new UsageError(`${skill} needs a name`);
  const cleaned = names.map((n) => nameArg(n, "a name"));
  const type = choiceOption(options.type, "--type", EntityType.options, "brand");
  const metro = options.metro === undefined ? null : choiceOption(options.metro, "--metro", MetroId.options, "nashville");
  if (metro !== null && type !== "place") throw new UsageError("--metro applies to --type place only");
  if (type === "place" && metro === null) throw new UsageError(`--type place needs --metro (${MetroId.options.join(", ")})`);
  const named = { mode: "names" as const, type, metro, ...common };

  if (skill === "resolve_entities") {
    for (const flag of ["k", "peers", "discover"] as const) {
      if (options[flag] !== undefined) throw new UsageError(`--${flag === "discover" ? "no-discover" : flag} applies to peer_landscape only`);
    }
    if (cleaned.length > MAX_MENTIONS) throw new UsageError(`resolve_entities takes at most ${MAX_MENTIONS} names`);
    return { skill, names: cleaned, k: 0, peers: [], discover: false, ...named };
  }

  if (cleaned.length !== 1) throw new UsageError("peer_landscape takes one brand; name peers with --peers");
  if (type !== "brand") throw new UsageError("peer_landscape maps brands only");
  const target = cleaned[0] as string;
  const peers = listOption(options.peers).map((p) => nameArg(p, "a --peers name"));
  if (peers.some((p) => normaliseName(p) === normaliseName(target))) throw new UsageError("--peers must not include the target");
  if (peers.length > MAX_PEERS) throw new UsageError(`--peers takes at most ${MAX_PEERS} brands`);
  const discover = options.discover !== false;
  if (!discover && peers.length < 3) throw new UsageError("--no-discover needs at least 3 --peers");
  const k = intOption(options.k, "--k", { min: 4, max: 7, fallback: 6 });
  return { skill, names: [target], k, peers, discover, ...named };
}

export interface SkillCliDeps {
  env: NodeJS.ProcessEnv;
  io: CliIo;
  /** Replaces the Postgres or memory store (tests). */
  store?: QlooStore;
  /** Replaces the database kv the pinned localities are read from (tests). */
  kv?: KvStore;
  /** Replaces the live transport's fetch (tests). */
  fetch?: typeof fetch;
  /** Replaces the gazetteer loaded from @ct/geo (tests). */
  geo?: GeoApi;
  now?: () => Date;
}

/** One CLI run: the Qloo scope, registry and ledger every skill call shares, and what they recorded. */
export interface SkillSession {
  runId: string;
  scope: RunQloo;
  registry: RunRegistry;
  ledger: RunLedger;
  geo: GeoApi;
  /** The pinned market localities skills read; null without kv (metro, city and market contexts unavailable). */
  localities: LocalityApi | null;
  events: EventInput[];
  calls: QlooCallRecord[];
  /** The SEC and Census scope (company_financials, area_economics); null when no client was opened. */
  publicScope: RunPublic | null;
  publicCalls: PublicCallRecord[];
  ctx(toolCallId: string): SkillCtx;
}

/** "cli-20261022T031522123Z": a synthetic run id for the ledger and the events. */
export function cliRunId(now: Date): string {
  return `cli-${now.toISOString().replace(/[-:.]/g, "")}`;
}

export function createSkillSession(
  client: QlooClient,
  geo: GeoApi,
  now: Date,
  localities: LocalityApi | null = null,
  publicdata: PublicDataClient | null = null,
): SkillSession {
  const runId = cliRunId(now);
  const calls: QlooCallRecord[] = [];
  const publicCalls: PublicCallRecord[] = [];
  const events: EventInput[] = [];
  // Standalone rather than forRun: a cached answer then carries no origin run, so a repeated command
  // shows HIT (forRun would call it REUSED, fetched by an earlier run), and no run cap applies.
  const scope = client.standalone({ onCall: (record) => calls.push(record) });
  const publicScope = publicdata?.standalone({ onCall: (record) => publicCalls.push(record) }) ?? null;
  const emit = (event: EventInput): void => {
    events.push(event);
  };
  const registry = createEntityRegistry();
  const ledger = createRunLedger({ emit, provenanceOf: (id) => scope.provenance(id) ?? publicScope?.provenance(id) ?? null });
  const budget = createRunBudget({
    limits: DEFAULT_RUN_LIMITS,
    qlooNetworkUsed: () => scope.networkUsed(),
    followupNetworkUsed: () => scope.followupNetworkUsed(),
    phase: () => "wave1",
    llmUsd: () => 0,
    startedAt: now.getTime(),
  });
  const signal = new AbortController().signal;
  return {
    runId,
    scope,
    registry,
    ledger,
    geo,
    localities,
    events,
    calls,
    publicScope,
    publicCalls,
    ctx: (toolCallId) => ({
      qloo: scope.forTool(toolCallId),
      publicdata: publicScope?.forTool(toolCallId) ?? null,
      ledger: ledger.forToolCall(toolCallId),
      geo,
      localities,
      registry,
      emit,
      budget,
      signal,
      runId,
      pillar: "investment",
      phase: "wave1",
      toolCallId,
      // A skill run outside a run: no question, so no concept parts and no candidates (R2, R3).
      concepts: [],
      candidates: NO_RUN_CANDIDATES,
    }),
  };
}

const print = (io: CliIo, lines: readonly string[]): void => {
  for (const line of lines) io.out(line);
};

function candidateText(a: ResolvedMention["alternatives"][number]): string {
  const parts = [a.disambiguation, a.popularity === null ? null : `pop ${formatFixed2(a.popularity)}`].filter((p) => p !== null);
  return parts.length === 0 ? a.name : `${a.name} (${parts.join(", ")})`;
}

interface Resolution {
  /** Per requested name, in order: its resolve entry, or null when it was not searched. */
  mentions: (ResolvedMention | null)[];
  /** One result per resolve_entities call (MAX_MENTIONS names each). */
  results: SkillResult[];
}

const namedMentions = (args: NamedSkillArgs, names: readonly string[]): NameMention[] =>
  names.map((text) => ({ text, type: args.type, metro: args.type === "place" ? args.metro : null }));

async function resolveMentions(session: SkillSession, mentions: readonly NameMention[], io: CliIo): Promise<Resolution> {
  const results: SkillResult[] = [];
  for (let at = 0; at < mentions.length; at += MAX_MENTIONS) {
    const chunk = mentions.slice(at, at + MAX_MENTIONS);
    const input = SKILLS.resolve_entities.input.parse({ mentions: chunk, trigger_finding_id: null, step_id: null });
    const estimate = await SKILLS.resolve_entities.estimateCalls(input, session.scope.forTool(RESOLVE_TOOL_CALL), session.registry);
    const types = [...new Set(chunk.map((m) => m.type))].join(", ");
    io.out(`resolve_entities: ${chunk.length} name(s) as ${types}, estimated ${estimate} network call(s)`);
    results.push(await SKILLS.resolve_entities.run(input, session.ctx(RESOLVE_TOOL_CALL)));
  }
  const resolved = session.events.flatMap((e) => (e.type === "resolve" ? e.entities : []));
  return { results, mentions: mentions.map((m) => resolved.find((r) => r.mention === m.text && r.entityType === m.type) ?? null) };
}

function renderResolution(mentions: readonly NameMention[], resolution: Resolution, io: CliIo): void {
  io.out(heading("RESOLVE (D20: exact normalised name and type only)"));
  const rows = mentions.map(({ text }, i) => {
    const m = resolution.mentions[i] ?? null;
    if (m === null) return [text, NONE, "not searched", NONE, NONE, NONE, NONE];
    const others = m.alternatives.length === 0 ? NONE : m.match === "exact" ? `${m.alternatives.length} other result(s)` : `${m.alternatives.length} candidate(s)`;
    return [text, m.entityType, m.match, m.ref ?? NONE, m.name ?? NONE, formatFixed2(m.popularity), others];
  });
  print(
    io,
    renderTable(
      [{ header: "name", max: 40 }, { header: "type" }, { header: "match" }, { header: "ref" }, { header: "matched", max: 40 }, { header: "pop", align: "right" }, { header: "other results" }],
      rows,
      { indent: "  " },
    ),
  );
}

/**
 * Each candidate's entity id, in the order resolve_entities listed them, read back through the
 * name's /search only when that answer is cached (a HIT, no network call). Terminal output only: it
 * is what run-agent --pins takes. Null when the answer is not cached or cannot be read.
 */
async function candidateIds(session: SkillSession, mention: NameMention): Promise<string[] | null> {
  const params = searchParams(mention);
  if (params === null) return null;
  const qloo = session.scope.forTool(CANDIDATES_TOOL_CALL);
  try {
    if (!(await qloo.has("/search", params))) return null;
    const search = await qloo.search(params);
    return classifyMatches(mention, search.data.results).alternatives.map((a) => a.result.entity_id);
  } catch {
    return null;
  }
}

/**
 * Prints every name resolve_entities did not search (a budget gate refused its call, or it had no
 * search to send); true when there were any. Such a name has no candidates to choose from, so the
 * command fails (exit 1) rather than asking for a choice (exit 3).
 */
function reportUnsearched(mentions: readonly NameMention[], resolution: Resolution, io: CliIo): boolean {
  const unsearched = mentions.filter((_, i) => (resolution.mentions[i] ?? null) === null);
  if (unsearched.length === 0) return false;
  const truncated = resolution.results.some((r) => r.flags.includes("BUDGET_TRUNCATED"));
  const reason = truncated
    ? "a Qloo budget gate refused the call; the [qloo warn] line says which"
    : resolution.results.flatMap((r) => r.forModel.notices).join(" ") || "no search was sent";
  io.out(heading("NOT SEARCHED (nothing was substituted)"));
  for (const { text } of unsearched) io.out(`  '${text}': not searched (${reason})`);
  return true;
}

/** Prints the candidates of every searched name that did not resolve exactly; true when there were any. */
async function reportUnresolved(session: SkillSession, mentions: readonly NameMention[], resolution: Resolution, io: CliIo): Promise<boolean> {
  const open = mentions.flatMap((mention, i) => {
    const resolved = resolution.mentions[i] ?? null;
    return resolved === null || resolved.match === "exact" ? [] : [{ mention, resolved }];
  });
  if (open.length === 0) return false;
  io.out(heading("NEEDS A CHOICE (nothing was substituted)"));
  for (const { mention, resolved } of open) {
    io.out(`  '${mention.text}' (${resolved.entityType}): ${resolved.match.replace("_", " ")}; candidates:`);
    if (resolved.alternatives.length === 0) {
      io.out("     (none)");
      continue;
    }
    const ids = await candidateIds(session, mention);
    resolved.alternatives.forEach((a, i) => {
      const id = ids?.[i];
      io.out(`     ${i + 1}. ${truncate(candidateText(a), 90)}${id === undefined ? "" : `  id ${id}`}`);
    });
    const key = normaliseName(mention.text);
    if (ids !== null && ids.length > 0 && key !== "") io.out(`     to use one in run-agent: --pins "${key}=<id>"`);
  }
  return true;
}

function renderOutcome(skill: SkillId, result: SkillResult, io: CliIo): void {
  io.out(heading(`${skill.toUpperCase()} · status ${result.status} · flags ${result.flags.length === 0 ? "none" : result.flags.join(", ")}`));
  for (const notice of result.forModel.notices) io.out(`  notice: ${notice}`);
}

function renderLedger(session: SkillSession, skill: SkillId, result: SkillResult, io: CliIo): void {
  const snapshot = session.ledger.snapshot();
  for (const d of snapshot.datasets) {
    if (d.kind !== "Matrix" || d.payload.mode !== "similarity") continue;
    io.out(heading(`${d.title.toUpperCase()} · ${d.id} · ${d.payload.valueLabel}`));
    io.out("  cell = similarity and rank in row (① most similar) · — not scored · ▸ target");
    print(io, renderSubstitutionMap(d.payload, { indent: "  " }));
  }
  io.out(heading(`DATASETS (${snapshot.datasets.length})`));
  print(io, renderDatasets(snapshot.datasets));
  io.out(heading(`METRICS (${snapshot.metrics.length})`));
  print(io, renderMetrics(snapshot.metrics));
  io.out(heading(`EVIDENCE (${snapshot.evidence.length}) · request ids by call # in QLOO CALLS`));
  print(io, renderEvidence(snapshot.evidence, callNumbers(session.calls)));
  io.out(heading(`FINDINGS (${snapshot.findings.length})`));
  print(io, renderFindings(snapshot.findings));
  const limitations = SKILLS[skill].limitations(result.flags);
  if (limitations.length > 0) {
    io.out(heading("LIMITATIONS"));
    for (const l of limitations) io.out(`  - ${l}`);
  }
}

async function runPeerLandscape(args: NamedSkillArgs, session: SkillSession, io: CliIo): Promise<number> {
  const mentions = namedMentions(args, [...args.names, ...args.peers]);
  const resolution = await resolveMentions(session, mentions, io);
  renderResolution(mentions, resolution, io);
  const unsearched = reportUnsearched(mentions, resolution, io);
  const open = await reportUnresolved(session, mentions, resolution, io);
  if (unsearched) return EXIT.failed;
  if (open) return EXIT.needsInput;

  const [target, ...peers] = resolution.mentions.map((m) => m?.ref as EntityRef);
  const input = SKILLS.peer_landscape.input.parse({
    target,
    peers,
    discover: args.discover,
    k: args.k,
    trigger_finding_id: null,
    step_id: null,
  });
  const estimate = await SKILLS.peer_landscape.estimateCalls(input, session.scope.forTool(MAP_TOOL_CALL), session.registry);
  io.out(`\npeer_landscape: k=${args.k}, discovery ${args.discover ? "on" : "off"}, estimated ${estimate} network call(s)`);
  const result = await SKILLS.peer_landscape.run(input, session.ctx(MAP_TOOL_CALL));
  renderOutcome("peer_landscape", result, io);
  renderLedger(session, "peer_landscape", result, io);
  return result.status === "error" ? EXIT.failed : EXIT.ok;
}

async function runResolve(args: NamedSkillArgs, session: SkillSession, io: CliIo): Promise<number> {
  const mentions = namedMentions(args, args.names);
  const resolution = await resolveMentions(session, mentions, io);
  const result = resolution.results[0] as SkillResult;
  renderResolution(mentions, resolution, io);
  renderOutcome("resolve_entities", result, io);
  renderLedger(session, "resolve_entities", result, io);
  const unsearched = reportUnsearched(mentions, resolution, io);
  const open = await reportUnresolved(session, mentions, resolution, io);
  return unsearched ? EXIT.failed : open ? EXIT.needsInput : EXIT.ok;
}

/**
 * The refs a skill run added to the registry, and those it reports registering that were there
 * already (a tag it found again), so a later run can take their tag URNs with --tags.
 */
function refsRegisteredBy(session: SkillSession, before: ReadonlySet<string>, result: SkillResult): Set<string> {
  const now = registryRefs(session.registry);
  const reported = result.forModel.registered.map((r) => r.ref).filter((ref) => now.has(ref));
  return new Set([...[...now].filter((ref) => !before.has(ref)), ...reported]);
}

/** Refs the input names that the registry does not hold, e.g. two names that resolved to one entity. */
function missingRefs(session: SkillSession, input: unknown): string[] {
  const refs = refsIn(input);
  return [
    ...refs.entities.filter((ref) => session.registry.entity(ref as EntityRef) === null),
    ...refs.tags.filter((ref) => session.registry.tag(ref as TagRef) === null),
  ];
}

async function runFromInput(args: InputSkillArgs, session: SkillSession, io: CliIo): Promise<number> {
  if (args.mentions.length > 0) {
    const resolution = await resolveMentions(session, args.mentions, io);
    renderResolution(args.mentions, resolution, io);
    const unsearched = reportUnsearched(args.mentions, resolution, io);
    const open = await reportUnresolved(session, args.mentions, resolution, io);
    if (unsearched) return EXIT.failed;
    if (open) return EXIT.needsInput;
  }
  for (const urn of args.tags) registerTagUrn(session.registry, urn);
  io.out(heading("REGISTRY (the refs the input can use)"));
  print(io, renderRegistry(session.registry));
  const missing = missingRefs(session, args.input);
  if (missing.length > 0) {
    io.err(`--input uses ${missing.join(", ")}, which the registry does not hold (did two names resolve to one entity?)`);
    return EXIT.usage;
  }

  const skill = SKILLS[args.skill] as unknown as Skill<unknown>;
  const toolCallId = `cli-${args.skill}`;
  await ensureMetrosIn(session.geo, args.input);
  const estimate = await skill.estimateCalls(args.input, session.scope.forTool(toolCallId), session.registry, {
    localities: session.localities,
    geo: session.geo,
  });
  io.out(`\n${args.skill}: ${truncate(JSON.stringify(args.input), 160)}`);
  io.out(`${args.skill}: estimated ${estimate} network call(s)`);
  const before = registryRefs(session.registry);
  const result = await skill.run(args.input, session.ctx(toolCallId));
  renderOutcome(args.skill, result, io);
  io.out(heading("DIGEST (what the model reads)"));
  print(io, renderDigest(args.skill, result));
  const registered = refsRegisteredBy(session, before, result);
  io.out(heading(`REGISTERED BY ${args.skill.toUpperCase()} (${registered.size}) · --tags takes the tag URNs`));
  print(io, renderRegistry(session.registry, { only: registered }));
  renderLedger(session, args.skill, result, io);
  return result.status === "error" ? EXIT.failed : EXIT.ok;
}

/**
 * Every call with its receipt and the evidence that cites it, then the quota meter (after the call
 * log is written, so the tag count includes this run). `kitCalls`: live calls the kit CLI made.
 */
export async function renderUsage(session: SkillSession, qloo: CliQloo, io: CliIo, kitCalls: number | null = null): Promise<void> {
  io.out(heading(`QLOO CALLS (${session.calls.length})`));
  print(io, renderCalls(session.calls, evidenceByCall(session.ledger.snapshot().evidence)));
  if (session.publicCalls.length > 0) {
    io.out(heading(`PUBLIC DATA CALLS (${session.publicCalls.length})`));
    print(io, session.publicCalls.map((c) => `${c.source.padEnd(6)} ${publicChip(c)}`));
  }
  await qloo.client.flush();
  const tagUsed =
    qloo.tagCap === null ? null : await qloo.store.countNetworkCalls({ env: qloo.client.env, tag: qloo.tag }).catch(() => null);
  io.out(heading("QUOTA"));
  print(
    io,
    renderQuota({
      network: session.scope.networkUsed(),
      cached: session.calls.filter((c) => !isNetworkCacheStatus(c.cache)).length,
      quota: qloo.client.quota(),
      monthFloor: qloo.client.monthFloor,
      env: qloo.client.env,
      tag: qloo.tag,
      tagCap: qloo.tagCap,
      tagUsed,
      kitCalls,
    }),
  );
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The header's localities part: how many markets kv pins for this Qloo environment. */
async function describePins(kv: KvStore | null, key: string): Promise<string> {
  if (kv === null) return "none (no kv: metro, city and market contexts unavailable)";
  try {
    return `kv ${key} (${Object.keys(await readPins(kv, key)).length} pinned)`;
  } catch (err) {
    return `kv ${key} (${err instanceof MalformedPinsError ? "malformed" : `unreadable: ${errorText(err)}`}; lookups fail)`;
  }
}

export async function runSkillCommand(argv: readonly string[], deps: SkillCliDeps): Promise<number> {
  const io = safeIo(deps.io);
  let args: SkillArgs | null;
  try {
    args = parseSkillArgs(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    io.err(err.message);
    io.err(err instanceof InputError ? "(pnpm run-skill --help lists the options)" : RUN_SKILL_USAGE);
    return EXIT.usage;
  }
  if (args === null) {
    io.out(RUN_SKILL_USAGE);
    return EXIT.ok;
  }

  const storeOption = deps.store ?? (args.memory ? "memory" : "pg");
  let qloo: CliQloo;
  try {
    qloo = await openCliQloo({
      env: deps.env,
      mock: args.mock,
      tag: args.tag,
      store: storeOption,
      logger: stderrLogger(io.err),
      fetch: deps.fetch,
    });
  } catch (err) {
    if (!(err instanceof CliError)) throw err;
    io.err(err.message);
    return EXIT.failed;
  }

  // Over Postgres the pins come from the kv table the web app reads; openCliQloo has reached it.
  const kv = deps.kv ?? (storeOption === "pg" ? pgKv(getDb(), `postgres ${describeDatabase(deps.env)}`) : null);
  const kvKey = localitiesKvKey(qloo.client.env);
  const geo = deps.geo === undefined ? await loadGeo() : { geo: deps.geo, source: "provided" };
  const session = createSkillSession(
    qloo.client,
    geo.geo,
    deps.now?.() ?? new Date(),
    kv === null ? null : kvLocalityApi(kv, kvKey),
    qloo.publicdata,
  );
  io.out(
    `run-skill ${args.skill} · Qloo ${qloo.client.env} · tag ${qloo.tag} · cache ${qloo.storeLabel} · geo ${geo.source} · ` +
      `localities ${await describePins(kv, kvKey)} · public data ${describePublicData(qloo.publicdata)} · run ${session.runId}`,
  );
  let code: number;
  try {
    code = await (args.mode === "input"
      ? runFromInput(args, session, io)
      : args.skill === "peer_landscape"
        ? runPeerLandscape(args, session, io)
        : runResolve(args, session, io));
  } catch (err) {
    io.err(`run-skill failed: ${errorText(err)}`);
    code = EXIT.failed;
  }
  try {
    await renderUsage(session, qloo, io);
  } catch (err) {
    io.err(`could not report Qloo usage: ${errorText(err)}`);
  } finally {
    await qloo.close();
  }
  return code;
}
