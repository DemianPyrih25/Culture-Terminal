// `pnpm run-skill <skill> <name…>`: one QUANT skill end to end through the real Qloo client, run
// ledger and registry, with no agent and no web server (PLAN Part 2). Names resolve exactly first
// (D20): a name without a single exact match of the right type prints its candidates, with their
// entity ids for run-agent --pins, and stops.
import { createEntityRegistry, createRunBudget, createRunLedger, type RunLedger, type RunRegistry } from "@ct/agent";
import {
  DEFAULT_RUN_LIMITS,
  EntityType,
  MetroId,
  SkillId,
  type EntityRef,
  type EventInput,
  type GeoApi,
  type ResolvedMention,
  type SkillCtx,
  type SkillResult,
} from "@ct/contracts";
import { isNetworkCacheStatus, type QlooCallRecord, type QlooClient, type QlooStore, type RunQloo } from "@ct/qloo";
import { classifyMatches, normaliseName, searchParams, SKILLS } from "@ct/quant";
import { choiceOption, intOption, listOption, nameArg, parseCli, UsageError } from "./args";
import { formatFixed2, NONE } from "./format";
import { loadGeo } from "./geo";
import { EXIT, heading, safeIo, type CliIo } from "./io";
import { callNumbers, evidenceByCall, renderCalls, renderEvidence, renderFindings, renderMetrics, renderQuota } from "./ledger-view";
import { renderSubstitutionMap } from "./matrix";
import { CliError, openCliQloo, stderrLogger, type CliQloo } from "./qloo-setup";
import { renderTable, truncate } from "./table";

export const RUN_SKILL_USAGE = [
  "usage: pnpm run-skill peer_landscape <brand> [--k N] [--peers \"A,B\"] [--no-discover] [common options]",
  "       pnpm run-skill resolve_entities <name> [<name>…] [--type T] [--metro M] [common options]",
  "  --k N            Substitution Map size including the target, 4–7 (default 6)",
  "  --peers \"A,B\"    peers to put in the map, resolved exactly like the target (at most 6)",
  "  --no-discover    skip the two discovery calls (needs at least 3 --peers)",
  "  --type T         entity type for resolve_entities (default brand): " + EntityType.options.join(", "),
  "  --metro M        metro to search in, for --type place: " + MetroId.options.join(", "),
  "common options:",
  "  --mock           synthetic Qloo data (QLOO_MOCK=1): no key, no network",
  "  --tag T          QLOO_TAG for the call log and the per-tag network cap",
  "  --memory         cache in memory instead of the shared Postgres cache (nothing persists; with --mock only)",
  "  -h, --help       this text",
  "A name without an exact match prints its candidates with their entity ids, for run-agent --pins.",
  "exit codes: 0 done, 1 failed (or a budget gate refused a search), 2 bad arguments, 3 a name needs a choice (not an exact match)",
].join("\n");

const SUPPORTED = ["peer_landscape", "resolve_entities"] as const;
type SupportedSkill = (typeof SUPPORTED)[number];

const OPTIONS = {
  type: { type: "string" },
  metro: { type: "string" },
  k: { type: "string" },
  peers: { type: "string" },
  discover: { type: "boolean" },
  mock: { type: "boolean" },
  tag: { type: "string" },
  memory: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

const MAX_MENTIONS = 8;
const MAX_PEERS = 6;
const RESOLVE_TOOL_CALL = "cli-resolve";
const MAP_TOOL_CALL = "cli-map";
const CANDIDATES_TOOL_CALL = "cli-candidates";

export interface SkillArgs {
  skill: SupportedSkill;
  names: string[];
  type: EntityType;
  metro: MetroId | null;
  k: number;
  peers: string[];
  discover: boolean;
  mock: boolean;
  tag: string | null;
  memory: boolean;
}

/** The parsed command, or null for --help. Throws UsageError. */
export function parseSkillArgs(argv: readonly string[]): SkillArgs | null {
  const { positionals, options } = parseCli(argv, OPTIONS);
  if (options.help) return null;
  const [skillArg, ...names] = positionals;
  if (skillArg === undefined) throw new UsageError("name a skill: peer_landscape or resolve_entities");
  if (!SUPPORTED.includes(skillArg as SupportedSkill)) {
    if (SkillId.safeParse(skillArg).success) {
      throw new UsageError(`${skillArg} is not available in run-skill in this build; it runs ${SUPPORTED.join(" and ")}`);
    }
    throw new UsageError(`unknown skill "${skillArg}"; run-skill runs ${SUPPORTED.join(" and ")}`);
  }
  const skill = skillArg as SupportedSkill;
  if (names.length === 0) throw new UsageError(`${skill} needs a name`);
  const cleaned = names.map((n) => nameArg(n, "a name"));
  const type = choiceOption(options.type, "--type", EntityType.options, "brand");
  const metro = options.metro === undefined ? null : choiceOption(options.metro, "--metro", MetroId.options, "nashville");
  if (metro !== null && type !== "place") throw new UsageError("--metro applies to --type place only");
  if (type === "place" && metro === null) throw new UsageError(`--type place needs --metro (${MetroId.options.join(", ")})`);
  const tag = options.tag?.trim() ?? null;
  if (tag === "") throw new UsageError("--tag needs a non-empty value");
  const common = { mock: options.mock === true, tag, memory: options.memory === true, type, metro };

  if (skill === "resolve_entities") {
    for (const flag of ["k", "peers", "discover"] as const) {
      if (options[flag] !== undefined) throw new UsageError(`--${flag === "discover" ? "no-discover" : flag} applies to peer_landscape only`);
    }
    if (cleaned.length > MAX_MENTIONS) throw new UsageError(`resolve_entities takes at most ${MAX_MENTIONS} names`);
    return { skill, names: cleaned, k: 0, peers: [], discover: false, ...common };
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
  return { skill, names: [target], k, peers, discover, ...common };
}

export interface SkillCliDeps {
  env: NodeJS.ProcessEnv;
  io: CliIo;
  /** Replaces the Postgres or memory store (tests). */
  store?: QlooStore;
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
  events: EventInput[];
  calls: QlooCallRecord[];
  ctx(toolCallId: string): SkillCtx;
}

/** "cli-20261022T031522123Z": a synthetic run id for the ledger and the events. */
export function cliRunId(now: Date): string {
  return `cli-${now.toISOString().replace(/[-:.]/g, "")}`;
}

export function createSkillSession(client: QlooClient, geo: GeoApi, now: Date): SkillSession {
  const runId = cliRunId(now);
  const calls: QlooCallRecord[] = [];
  const events: EventInput[] = [];
  // Standalone rather than forRun: a cached answer then carries no origin run, so a repeated command
  // shows HIT (forRun would call it REUSED, fetched by an earlier run), and no run cap applies.
  const scope = client.standalone({ onCall: (record) => calls.push(record) });
  const emit = (event: EventInput): void => {
    events.push(event);
  };
  const registry = createEntityRegistry();
  const ledger = createRunLedger({ emit, provenanceOf: (id) => scope.provenance(id) });
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
    events,
    calls,
    ctx: (toolCallId) => ({
      qloo: scope.forTool(toolCallId),
      ledger: ledger.forToolCall(toolCallId),
      geo,
      registry,
      emit,
      budget,
      signal,
      runId,
      pillar: "investment",
      phase: "wave1",
      toolCallId,
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
  result: SkillResult;
}

async function resolveNames(session: SkillSession, args: SkillArgs, names: readonly string[], io: CliIo): Promise<Resolution> {
  const input = SKILLS.resolve_entities.input.parse({
    mentions: names.map((text) => ({ text, type: args.type, metro: args.type === "place" ? args.metro : null })),
    trigger_finding_id: null,
    step_id: null,
  });
  const estimate = await SKILLS.resolve_entities.estimateCalls(input, session.scope.forTool(RESOLVE_TOOL_CALL), session.registry);
  io.out(`resolve_entities: ${names.length} name(s) as ${args.type}, estimated ${estimate} network call(s)`);
  const result = await SKILLS.resolve_entities.run(input, session.ctx(RESOLVE_TOOL_CALL));
  const resolved = session.events.flatMap((e) => (e.type === "resolve" ? e.entities : []));
  return { result, mentions: names.map((name) => resolved.find((m) => m.mention === name) ?? null) };
}

function renderResolution(names: readonly string[], resolution: Resolution, io: CliIo): void {
  io.out(heading("RESOLVE (D20: exact normalised name and type only)"));
  const rows = names.map((name, i) => {
    const m = resolution.mentions[i] ?? null;
    if (m === null) return [name, NONE, "not searched", NONE, NONE, NONE, NONE];
    const others = m.alternatives.length === 0 ? NONE : m.match === "exact" ? `${m.alternatives.length} other result(s)` : `${m.alternatives.length} candidate(s)`;
    return [name, m.entityType, m.match, m.ref ?? NONE, m.name ?? NONE, formatFixed2(m.popularity), others];
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
async function candidateIds(session: SkillSession, args: SkillArgs, name: string): Promise<string[] | null> {
  const params = searchParams({ text: name, type: args.type, metro: args.type === "place" ? args.metro : null });
  if (params === null) return null;
  const qloo = session.scope.forTool(CANDIDATES_TOOL_CALL);
  try {
    if (!(await qloo.has("/search", params))) return null;
    const search = await qloo.search(params);
    return classifyMatches({ text: name, type: args.type }, search.data.results).alternatives.map((a) => a.result.entity_id);
  } catch {
    return null;
  }
}

/**
 * Prints every name resolve_entities did not search (a budget gate refused its call, or it had no
 * search to send); true when there were any. Such a name has no candidates to choose from, so the
 * command fails (exit 1) rather than asking for a choice (exit 3).
 */
function reportUnsearched(names: readonly string[], resolution: Resolution, io: CliIo): boolean {
  const unsearched = names.filter((_, i) => (resolution.mentions[i] ?? null) === null);
  if (unsearched.length === 0) return false;
  const { flags, forModel } = resolution.result;
  const reason = flags.includes("BUDGET_TRUNCATED")
    ? "a Qloo budget gate refused the call; the [qloo warn] line says which"
    : forModel.notices.join(" ") || "no search was sent";
  io.out(heading("NOT SEARCHED (nothing was substituted)"));
  for (const name of unsearched) io.out(`  '${name}': not searched (${reason})`);
  return true;
}

/** Prints the candidates of every searched name that did not resolve exactly; true when there were any. */
async function reportUnresolved(session: SkillSession, args: SkillArgs, names: readonly string[], resolution: Resolution, io: CliIo): Promise<boolean> {
  const open = names.flatMap((name, i) => {
    const mention = resolution.mentions[i] ?? null;
    return mention === null || mention.match === "exact" ? [] : [{ name, mention }];
  });
  if (open.length === 0) return false;
  io.out(heading("NEEDS A CHOICE (nothing was substituted)"));
  for (const { name, mention } of open) {
    io.out(`  '${name}' (${mention.entityType}): ${mention.match.replace("_", " ")}; candidates:`);
    if (mention.alternatives.length === 0) {
      io.out("     (none)");
      continue;
    }
    const ids = await candidateIds(session, args, name);
    mention.alternatives.forEach((a, i) => {
      const id = ids?.[i];
      io.out(`     ${i + 1}. ${truncate(candidateText(a), 90)}${id === undefined ? "" : `  id ${id}`}`);
    });
    const key = normaliseName(name);
    if (ids !== null && ids.length > 0 && key !== "") io.out(`     to use one in run-agent: --pins "${key}=<id>"`);
  }
  return true;
}

function renderOutcome(skill: SupportedSkill, result: SkillResult, io: CliIo): void {
  io.out(heading(`${skill.toUpperCase()} · status ${result.status} · flags ${result.flags.length === 0 ? "none" : result.flags.join(", ")}`));
  for (const notice of result.forModel.notices) io.out(`  notice: ${notice}`);
}

function renderLedger(session: SkillSession, skill: SupportedSkill, result: SkillResult, io: CliIo): void {
  const snapshot = session.ledger.snapshot();
  for (const d of snapshot.datasets) {
    if (d.kind !== "Matrix") continue;
    io.out(heading(`${d.title.toUpperCase()} · ${d.id} · ${d.payload.valueLabel}`));
    io.out("  cell = similarity and rank in row (① most similar) · — not scored · ▸ target");
    print(io, renderSubstitutionMap(d.payload, { indent: "  " }));
  }
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

async function runPeerLandscape(args: SkillArgs, session: SkillSession, io: CliIo): Promise<number> {
  const names = [...args.names, ...args.peers];
  const resolution = await resolveNames(session, args, names, io);
  renderResolution(names, resolution, io);
  const unsearched = reportUnsearched(names, resolution, io);
  const open = await reportUnresolved(session, args, names, resolution, io);
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

async function runResolve(args: SkillArgs, session: SkillSession, io: CliIo): Promise<number> {
  const resolution = await resolveNames(session, args, args.names, io);
  renderResolution(args.names, resolution, io);
  renderOutcome("resolve_entities", resolution.result, io);
  renderLedger(session, "resolve_entities", resolution.result, io);
  const unsearched = reportUnsearched(args.names, resolution, io);
  const open = await reportUnresolved(session, args, args.names, resolution, io);
  return unsearched ? EXIT.failed : open ? EXIT.needsInput : EXIT.ok;
}

/**
 * Every call with its receipt and the evidence that cites it, then the quota meter (after the call
 * log is written, so the tag count includes this run). `kitCalls`: live calls the kit CLI made.
 */
export async function renderUsage(session: SkillSession, qloo: CliQloo, io: CliIo, kitCalls: number | null = null): Promise<void> {
  io.out(heading(`QLOO CALLS (${session.calls.length})`));
  print(io, renderCalls(session.calls, evidenceByCall(session.ledger.snapshot().evidence)));
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

export async function runSkillCommand(argv: readonly string[], deps: SkillCliDeps): Promise<number> {
  const io = safeIo(deps.io);
  let args: SkillArgs | null;
  try {
    args = parseSkillArgs(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    io.err(err.message);
    io.err(RUN_SKILL_USAGE);
    return EXIT.usage;
  }
  if (args === null) {
    io.out(RUN_SKILL_USAGE);
    return EXIT.ok;
  }

  let qloo: CliQloo;
  try {
    qloo = await openCliQloo({
      env: deps.env,
      mock: args.mock,
      tag: args.tag,
      store: deps.store ?? (args.memory ? "memory" : "pg"),
      logger: stderrLogger(io.err),
      fetch: deps.fetch,
    });
  } catch (err) {
    if (!(err instanceof CliError)) throw err;
    io.err(err.message);
    return EXIT.failed;
  }

  const geo = deps.geo === undefined ? await loadGeo() : { geo: deps.geo, source: "provided" };
  const session = createSkillSession(qloo.client, geo.geo, deps.now?.() ?? new Date());
  io.out(
    `run-skill ${args.skill} · Qloo ${qloo.client.env} · tag ${qloo.tag} · cache ${qloo.storeLabel} · geo ${geo.source} · run ${session.runId}`,
  );
  let code: number;
  try {
    code = await (args.skill === "peer_landscape" ? runPeerLandscape(args, session, io) : runResolve(args, session, io));
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
