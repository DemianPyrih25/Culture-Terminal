// Kit parity (D30, dev only): for each name, our resolve_entities (one /search through @ct/qloo, the
// shared cache and the D20 exact-match rule) against the Qloo kit CLI sending the same /search
// (query, type, take), judged by the same rule. A name passes when both sides pick the same exact
// entity with the same type and popularity, or when neither side picks one (both would ask). Qloo
// ids are compared, never printed; the kit's raw output goes to .private/kit-parity/ (gitignored).
// The kit calls live Qloo outside @ct/qloo, so it runs only while the dev floor and the QLOO_TAG cap
// leave room, and its calls are logged under the tag like ours. Our side always uses the shared
// Postgres cache (no --memory), so the tag count that gate reads includes every earlier run.
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EntityType, entityTypeUrn, type GeoApi, type QlooSearchEntity } from "@ct/contracts";
import { canonicalize, type QlooCallLogRow, type QlooEnv, type QlooStore } from "@ct/qloo";
import { classifyMatches, normaliseName, SEARCH_TAKE, searchParams, SKILLS } from "@ct/quant";
import { choiceOption, nameArg, parseCli, UsageError } from "../dev/cli/args";
import { formatCount, formatFixed2, NONE } from "../dev/cli/format";
import { stubGeo } from "../dev/cli/geo";
import { EXIT, heading, safeIo, type CliIo } from "../dev/cli/io";
import { CliError, openCliQloo, stderrLogger, type CliQloo } from "../dev/cli/qloo-setup";
import { createSkillSession, renderUsage, type SkillSession } from "../dev/cli/skill-cli";
import { renderTable } from "../dev/cli/table";
import { displayCommand, spawnKitRunner, type KitRun, type KitRunner, type KitSearch } from "./kit";

export const RAW_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.private/kit-parity");

/** Both sides send the same /search, so popularity should agree to rounding. */
export const POPULARITY_TOLERANCE = 0.01;

const PARITY_TYPES = EntityType.options.filter((t) => t !== "place");
type ParityType = (typeof PARITY_TYPES)[number];
const MAX_NAMES = 8;
const TOOL_CALL = "cli-parity";

export const KIT_PARITY_USAGE = [
  "usage: pnpm kit-parity <name> [<name>…] [--type T] [--live-kit] [options]",
  "  --live-kit       run both sides: our /search through @ct/qloo and the kit's",
  `                   \`qloo api search --query <name> --type <urn> --take ${SEARCH_TAKE} --json\` (the same request)`,
  "                   (without it, print what would be compared and call nothing)",
  "  --type T         entity type of every name (default brand): " + PARITY_TYPES.join(", "),
  "  --kit-bin B      the kit CLI binary (default qloo)",
  "  --tag T          QLOO_TAG for our calls and the kit's (the kit counts against its cap)",
  "  -h, --help       this text",
  "The kit always calls live Qloo, so --live-kit needs our side live too (QLOO_MOCK off). It does not run",
  "when its calls would take the month below the dev floor or the tag past QLOO_TAG_CAP.",
  "exit codes: 0 every name at parity (or a dry run), 1 a mismatch, an unverified row or a failure, 2 bad arguments",
].join("\n");

const OPTIONS = {
  "live-kit": { type: "boolean" },
  type: { type: "string" },
  "kit-bin": { type: "string" },
  tag: { type: "string" },
  help: { type: "boolean", short: "h" },
} as const;

export interface ParityArgs {
  names: string[];
  type: ParityType;
  liveKit: boolean;
  kitBin: string;
  tag: string | null;
}

/** Each normalised name once, every one within resolve_entities' limits. */
function distinctNames(raw: readonly string[]): string[] {
  const seen = new Set<string>();
  return raw
    .filter((n) => n.trim() !== "")
    .map((n) => nameArg(n, "a name"))
    .filter((n) => {
      const key = normaliseName(n);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export function parseParityArgs(argv: readonly string[]): ParityArgs | null {
  const { positionals, options } = parseCli(argv, OPTIONS);
  if (options.help) return null;
  const names = distinctNames(positionals);
  if (names.length === 0) throw new UsageError("name at least one public entity, e.g. pnpm kit-parity \"Liquid Death\"");
  if (names.length > MAX_NAMES) throw new UsageError(`kit-parity compares at most ${MAX_NAMES} names per run`);
  const kitBin = options["kit-bin"]?.trim() ?? "qloo";
  if (kitBin === "") throw new UsageError("--kit-bin needs a value");
  const tag = options.tag?.trim() ?? null;
  if (tag === "") throw new UsageError("--tag needs a non-empty value");
  return {
    names,
    type: choiceOption(options.type, "--type", PARITY_TYPES, "brand"),
    liveKit: options["live-kit"] === true,
    kitBin,
    tag,
  };
}

/** The kit's request for a name: resolve_entities' /search (searchParams) for a non-place type. */
export function kitSearchFor(name: string, type: ParityType): KitSearch {
  return { query: name.trim(), types: entityTypeUrn(type), take: SEARCH_TAKE };
}

// The kit's output ----------------------------------------------------------------------------------

export class KitOutputError extends Error {
  override readonly name = "KitOutputError";
}

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const isText = (x: unknown): x is string => typeof x === "string" && x !== "";

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Some CLIs print a status line before the JSON.
    const at = text.search(/[[{]/);
    if (at > 0) {
      try {
        return JSON.parse(text.slice(at));
      } catch {
        // Fall through to the error below.
      }
    }
    throw new KitOutputError("the kit output is not JSON");
  }
}

function resultList(json: unknown, depth = 0): unknown[] | null {
  if (Array.isArray(json)) return json;
  if (!isRecord(json) || depth > 3) return null;
  for (const key of ["results", "entities", "data"]) {
    const found = key in json ? resultList(json[key], depth + 1) : null;
    if (found !== null) return found;
  }
  return null;
}

function toSearchEntity(item: unknown): QlooSearchEntity[] {
  if (!isRecord(item)) return [];
  const entityId = [item.entity_id, item.entityId, item.id].find(isText);
  if (entityId === undefined || !isText(item.name)) return [];
  const types = Array.isArray(item.types) ? item.types.filter(isText) : [item.type, item.subtype].filter(isText);
  return [
    {
      entity_id: entityId,
      name: item.name,
      types,
      popularity: typeof item.popularity === "number" ? item.popularity : undefined,
      disambiguation: isText(item.disambiguation) ? item.disambiguation : null,
    },
  ];
}

/**
 * The kit's search results in the /search entity shape. `qloo api search --json` prints the result
 * array; `results`, `entities` and `data` wrappers are read too, in case a kit version wraps it.
 */
export function parseKitSearch(stdout: string): QlooSearchEntity[] {
  const list = resultList(parseJson(stdout));
  if (list === null) throw new KitOutputError("the kit output has no result list");
  return list.flatMap(toSearchEntity);
}

// Comparison ---------------------------------------------------------------------------------------

/** One side's answer for a name: the D20 match class and, for an exact match, the entity. */
export interface SideMatch {
  match: "exact" | "ambiguous" | "inexact" | "not_found" | "error";
  /** Compared, never printed. */
  entityId: string | null;
  types: readonly string[];
  popularity: number | null;
  /** Results other than an applied match. */
  candidates: number;
  error: string | null;
}

export function errorSide(error: string): SideMatch {
  return { match: "error", entityId: null, types: [], popularity: null, candidates: 0, error };
}

/** The kit's results judged by our resolution rule (D30 adopts the kit's policy: exact match or ask). */
export function kitSide(name: string, type: ParityType, results: readonly QlooSearchEntity[]): SideMatch {
  const c = classifyMatches({ text: name, type }, results);
  const applied = c.matchClass === "exact" ? c.exact[0] : undefined;
  return {
    match: c.matchClass,
    entityId: applied?.entity_id ?? null,
    types: applied?.types ?? [],
    popularity: applied?.popularity ?? null,
    candidates: c.alternatives.length,
    error: null,
  };
}

/** UNVERIFIED: the same exact entity, but popularity could not be compared (missing on a side). */
export type ParityVerdict = "PASS" | "FAIL" | "UNVERIFIED";

export interface ParityRow {
  name: string;
  ours: SideMatch;
  kit: SideMatch;
  /** Null unless both sides matched exactly. */
  sameEntity: boolean | null;
  sameType: boolean | null;
  popularityDelta: number | null;
  verdict: ParityVerdict;
  note: string;
}

export function compareSides(name: string, type: ParityType, ours: SideMatch, kit: SideMatch): ParityRow {
  const base = { name, ours, kit, sameEntity: null, sameType: null, popularityDelta: null };
  if (ours.match === "error" || kit.match === "error") {
    return { ...base, verdict: "FAIL", note: `${ours.match === "error" ? "ours" : "kit"} failed: ${ours.error ?? kit.error ?? "unknown"}` };
  }
  const oursExact = ours.match === "exact";
  const kitExact = kit.match === "exact";
  if (!oursExact && !kitExact) return { ...base, verdict: "PASS", note: `both ask (ours ${ours.match}, kit ${kit.match})` };
  if (oursExact !== kitExact) return { ...base, verdict: "FAIL", note: `ours ${ours.match}, kit ${kit.match}` };

  const urn = entityTypeUrn(type);
  const sameEntity = ours.entityId !== null && ours.entityId === kit.entityId;
  const sameType = ours.types.includes(urn) && kit.types.includes(urn);
  const delta = ours.popularity !== null && kit.popularity !== null ? Math.abs(ours.popularity - kit.popularity) : null;
  const drifted = delta !== null && delta > POPULARITY_TOLERANCE;
  const problems = [
    sameEntity ? null : "different entities",
    sameType ? null : "different types",
    drifted ? "popularity differs" : null,
    delta === null ? `popularity missing on ${ours.popularity === null && kit.popularity === null ? "both sides" : ours.popularity === null ? "our side" : "the kit side"}` : null,
  ].filter((p) => p !== null);
  return {
    ...base,
    sameEntity,
    sameType,
    popularityDelta: delta,
    verdict: !sameEntity || !sameType || drifted ? "FAIL" : delta === null ? "UNVERIFIED" : "PASS",
    note: problems.join(", "),
  };
}

const sideText = (s: SideMatch): string =>
  s.match === "exact" ? `exact${s.popularity === null ? "" : ` · pop ${formatFixed2(s.popularity)}`}` : s.match === "error" ? "error" : `${s.match} (${s.candidates})`;

const check = (x: boolean | null): string => (x === null ? NONE : x ? "✓" : "✗");

/** The parity table. It shows match classes, checks and popularity, never an entity id. */
export function renderParity(rows: readonly ParityRow[], indent = "  "): string[] {
  return renderTable(
    [
      { header: "name", max: 36 },
      { header: "ours" },
      { header: "kit" },
      { header: "entity" },
      { header: "type" },
      { header: "Δ pop", align: "right" },
      { header: "verdict" },
      { header: "note", max: 60 },
    ],
    rows.map((r) => [
      r.name,
      sideText(r.ours),
      sideText(r.kit),
      r.sameEntity === null ? NONE : r.sameEntity ? "same" : "DIFFERENT",
      check(r.sameType),
      formatFixed2(r.popularityDelta),
      r.verdict,
      r.note,
    ]),
    { indent },
  );
}

// The kit's budget ---------------------------------------------------------------------------------

export interface KitBudget {
  /** Kit processes about to run, one live call each. */
  calls: number;
  monthRemaining: number | null;
  monthFloor: number;
  tag: string;
  tagCap: number | null;
  /** Network calls logged for the tag so far, or null when the count could not be read. */
  tagUsed: number | null;
}

/**
 * Why the kit must not run, or null when it may. Its calls skip @ct/qloo's gates, so they are held
 * to the same two: the month stays at or above the dev floor (D24) once they are made, and the tag
 * has room for all of them. An unknown month count passes, as it does in the client.
 */
export function kitRefusal(b: KitBudget): string | null {
  if (b.calls === 0) return null;
  if (b.monthRemaining !== null && b.monthRemaining - b.calls < b.monthFloor) {
    return `${formatCount(b.monthRemaining)} monthly Qloo calls remain and ${b.calls} kit call(s) would go below the ${formatCount(b.monthFloor)} floor`;
  }
  if (b.tagCap !== null) {
    if (b.tagUsed === null) return `the network call count for QLOO_TAG "${b.tag}" could not be read`;
    const left = Math.max(0, b.tagCap - b.tagUsed);
    if (left < b.calls) return `QLOO_TAG "${b.tag}" has ${left} of its ${b.tagCap} network calls left and the kit needs ${b.calls}`;
  }
  return null;
}

/** The call-log row for one live kit call, so the tag's network count (and its cap) includes it. */
export function kitCallRow(run: KitRun, search: KitSearch, at: { env: QlooEnv; tag: string; runId: string; ts: Date }): QlooCallLogRow {
  const request = canonicalize("/search", { query: search.query, types: search.types, take: search.take });
  return {
    id: `kit-${randomUUID()}`,
    ts: at.ts,
    env: at.env,
    tag: at.tag,
    runId: at.runId,
    path: "/search",
    filterType: request.filterType,
    params: request.query,
    // Prefixed: the kit's answer is not an entry in our cache.
    cacheKey: `kit:${request.key}`,
    cacheStatus: "miss",
    // The kit prints neither the HTTP status nor the x-qloo-request-id.
    httpStatus: null,
    ms: Math.round(run.ms),
    requestId: null,
    monthRemaining: null,
    error: run.error ?? (run.status === 0 ? null : `kit exit ${run.status ?? "unknown"}`),
  };
}

// The command --------------------------------------------------------------------------------------

/** The kit side: the runner, and whether it calls live Qloo (the real CLI) or answers locally (tests). */
export interface KitSide {
  run: KitRunner;
  live: boolean;
}

export interface KitParityDeps {
  env: NodeJS.ProcessEnv;
  io: CliIo;
  /** Replaces the shared Postgres store (tests). */
  store?: QlooStore;
  geo?: GeoApi;
  /** Replaces the kit CLI (tests). */
  kit?: KitSide;
  /** Where raw kit output goes; null writes nothing. */
  rawDir?: string | null;
  now?: () => Date;
}

function printPlan(args: ParityArgs, io: CliIo): void {
  io.out(`kit-parity (D30) · ${args.names.length} name(s) as ${args.type} · dry run`);
  args.names.forEach((name, i) => {
    const params = searchParams({ text: name, type: args.type, metro: null }) ?? {};
    const query = Object.entries(params)
      .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(",") : String(v)}`)
      .join(" ");
    io.out(`  ${i + 1}. ${name}`);
    io.out(`     ours: GET /search ${query} (through @ct/qloo; free when cached)`);
    io.out(`     kit:  ${displayCommand(args.kitBin, kitSearchFor(name, args.type))}`);
  });
  io.out(`  checks: same exact entity (D20 rule on both result lists), same type, popularity within ${POPULARITY_TOLERANCE}`);
  io.out(
    "Nothing was called. Add --live-kit to run both sides: our side spends live Qloo calls under QLOO_TAG unless cached, " +
      "and the kit one live call per name, logged under the same tag.",
  );
}

/** Our side: one resolve_entities call for every name, through the real client and ledger. */
async function ourSides(session: SkillSession, args: ParityArgs): Promise<SideMatch[]> {
  const input = SKILLS.resolve_entities.input.parse({
    mentions: args.names.map((text) => ({ text, type: args.type, metro: null })),
    trigger_finding_id: null,
    step_id: null,
  });
  await SKILLS.resolve_entities.run(input, session.ctx(TOOL_CALL));
  const resolved = session.events.flatMap((e) => (e.type === "resolve" ? e.entities : []));
  return args.names.map((name) => {
    const m = resolved.find((r) => r.mention === name);
    if (m === undefined) return errorSide("not searched (budget)");
    const entity = m.ref === null ? null : session.registry.entity(m.ref);
    return {
      match: m.match,
      entityId: entity?.entityId ?? null,
      types: entity === null ? [] : [entityTypeUrn(entity.type)],
      popularity: m.popularity,
      candidates: m.alternatives.length,
      error: null,
    };
  });
}

function writeRaw(dir: string, stamp: Date, args: ParityArgs, runs: readonly { name: string; run: KitRun }[]): string {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${stamp.toISOString().replace(/:/g, "-")}.json`);
  const body = {
    kind: "kit-parity",
    startedAt: stamp.toISOString(),
    type: args.type,
    runs: runs.map(({ name, run }) => {
      let output: unknown = run.stdout;
      try {
        output = JSON.parse(run.stdout);
      } catch {
        // Kept as text.
      }
      return { name, command: run.command, status: run.status, error: run.error, stderr: run.stderr, output };
    }),
  };
  writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  return file;
}

function kitSideOf(name: string, type: ParityType, run: KitRun): SideMatch {
  if (run.error !== null) return errorSide(run.error);
  if (run.status !== 0) return errorSide(`exit ${run.status}${run.stderr.trim() === "" ? "" : `: ${run.stderr.trim().split("\n")[0]}`}`);
  try {
    return kitSide(name, type, parseKitSearch(run.stdout));
  } catch (err) {
    return errorSide(err instanceof Error ? err.message : String(err));
  }
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The kit's gate for `calls` live calls, read after our side's call log is written. */
async function kitGate(qloo: CliQloo, calls: number): Promise<string | null> {
  await qloo.client.flush();
  const tagUsed = qloo.tagCap === null ? null : await qloo.store.countNetworkCalls({ env: qloo.client.env, tag: qloo.tag }).catch(() => null);
  return kitRefusal({
    calls,
    monthRemaining: qloo.client.quota().monthRemaining,
    monthFloor: qloo.client.monthFloor,
    tag: qloo.tag,
    tagCap: qloo.tagCap,
    tagUsed,
  });
}

export async function runKitParityCommand(argv: readonly string[], deps: KitParityDeps): Promise<number> {
  const io = safeIo(deps.io);
  let args: ParityArgs | null;
  try {
    args = parseParityArgs(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    io.err(err.message);
    io.err(KIT_PARITY_USAGE);
    return EXIT.usage;
  }
  if (args === null) {
    io.out(KIT_PARITY_USAGE);
    return EXIT.ok;
  }
  if (!args.liveKit) {
    printPlan(args, io);
    return EXIT.ok;
  }

  const kit = deps.kit ?? { run: spawnKitRunner(args.kitBin), live: true };
  let qloo: CliQloo;
  try {
    qloo = await openCliQloo({ env: deps.env, mock: false, tag: args.tag, store: deps.store ?? "pg", logger: stderrLogger(io.err) });
  } catch (err) {
    if (!(err instanceof CliError)) throw err;
    io.err(err.message);
    return EXIT.failed;
  }
  if (kit.live && qloo.client.env === "mock") {
    io.err(
      "kit-parity --live-kit needs our side on live Qloo: the kit always calls live Qloo, so with QLOO_MOCK=1 the entities " +
        "cannot match and the kit's calls would skip the dev floor check. Unset QLOO_MOCK.",
    );
    await qloo.close();
    return EXIT.failed;
  }
  const started = deps.now?.() ?? new Date();
  const session = createSkillSession(qloo.client, deps.geo ?? stubGeo(), started);
  io.out(`kit-parity (D30) · ${args.names.length} name(s) as ${args.type} · Qloo ${qloo.client.env} · tag ${qloo.tag} · cache ${qloo.storeLabel}`);

  let code: number = EXIT.failed;
  let kitCalls: number | null = null;
  try {
    const ours = await ourSides(session, args);
    // A name our side did not search fails anyway; the kit is not spent on it.
    const wanted = args.names.flatMap((name, i) => (ours[i]?.match === "error" ? [] : [{ name, i, search: kitSearchFor(name, args.type) }]));
    const refusal = kit.live && wanted.length > 0 ? await kitGate(qloo, wanted.length) : null;
    if (refusal !== null) io.err(`not running the kit: ${refusal}`);

    const runs: { name: string; i: number; search: KitSearch; run: KitRun }[] = [];
    // One at a time: the kit shares the account's Qloo rate limit.
    if (refusal === null) for (const w of wanted) runs.push({ ...w, run: await kit.run(w.search) });
    if (kit.live) {
      const ts = deps.now?.() ?? new Date();
      const rows = runs.filter((r) => r.run.spawned).map((r) => kitCallRow(r.run, r.search, { env: qloo.client.env, tag: qloo.tag, runId: session.runId, ts }));
      kitCalls = rows.length;
      if (rows.length > 0) await qloo.store.logCalls(rows).catch((err: unknown) => io.err(`could not log the kit's calls under the tag: ${errorText(err)}`));
    }
    const rawDir = deps.rawDir === undefined ? RAW_DIR : deps.rawDir;
    if (rawDir !== null && runs.length > 0) io.out(`raw kit output: ${writeRaw(rawDir, started, args, runs)}`);

    const type = args.type;
    const rows = args.names.map((name, i) => {
      const run = runs.find((r) => r.i === i)?.run;
      const theirs =
        run !== undefined ? kitSideOf(name, type, run) : errorSide(refusal === null ? "not run: our side was not searched" : `not run: ${refusal}`);
      return compareSides(name, type, ours[i] ?? errorSide("missing"), theirs);
    });
    io.out(heading("PARITY"));
    for (const line of renderParity(rows)) io.out(line);
    const count = (v: ParityVerdict): number => rows.filter((r) => r.verdict === v).length;
    const passed = count("PASS");
    const others = [
      count("FAIL") > 0 ? `${count("FAIL")} FAIL` : null,
      count("UNVERIFIED") > 0 ? `${count("UNVERIFIED")} UNVERIFIED (popularity not compared)` : null,
    ].filter((p) => p !== null);
    io.out(`\n${passed} of ${rows.length} at parity${others.length === 0 ? "" : ` · ${others.join(" · ")}`}`);
    code = passed === rows.length ? EXIT.ok : EXIT.failed;
  } catch (err) {
    io.err(`kit-parity failed: ${errorText(err)}`);
  }
  try {
    await renderUsage(session, qloo, io, kitCalls);
  } catch (err) {
    io.err(`could not report Qloo usage: ${errorText(err)}`);
  } finally {
    await qloo.close();
  }
  return code;
}
