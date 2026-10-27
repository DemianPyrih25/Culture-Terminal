// `pnpm exec tsx tools/dev/audiences.ts list|pin`: the audience catalogue (D21), pinned in kv for the
// ANALYST's AUDIENCES list (a run reads it at start, QlooClient.audienceCatalogue). One /v2/audiences
// per allowed family through @ct/qloo and the shared cache; each answer is pinned in the cache (D25)
// and its public keys and display names are written to kv. Qloo's entity ids are never stored or printed.
import {
  AUDIENCE_CATALOGUE_FAMILIES,
  audienceCatalogueKvKey,
  audienceCatalogueParams,
  audienceFamilySegments,
  readAudienceCatalogue,
  storedAudienceCatalogue,
  type AudienceFamilyRead,
  type QlooStore,
} from "@ct/qloo";
import { isBudgetError } from "@ct/quant";
import { parseCli, UsageError } from "./cli/args";
import { formatCount, NONE } from "./cli/format";
import { stubGeo } from "./cli/geo";
import { EXIT, heading, safeIo, type CliIo } from "./cli/io";
import { CliError, openCliQloo, stderrLogger, type CliQloo } from "./cli/qloo-setup";
import { createSkillSession, renderUsage, type SkillSession } from "./cli/skill-cli";
import { renderTable } from "./cli/table";

const COMMAND = "pnpm exec tsx tools/dev/audiences.ts";
const PATH = "/v2/audiences";

export const AUDIENCES_USAGE = [
  `usage: ${COMMAND} list [common options]`,
  `       ${COMMAND} pin [--yes] [common options]`,
  "  list             the pinned catalogue per family and whether each family's /v2/audiences is cached (no Qloo calls)",
  `  pin              reads the ${AUDIENCE_CATALOGUE_FAMILIES.length} allowed families (one /v2/audiences each, take 100), pins each answer`,
  "                   in the cache and writes the catalogue (audience keys and names, no entity ids) to kv",
  "  --yes            make the calls and write kv; without it, pin prints the plan and the calls it would make",
  "common options:",
  "  --mock           synthetic Qloo data (QLOO_MOCK=1): no key, no network; the catalogue goes to kv audience_catalogue.mock",
  "  --tag T          QLOO_TAG for the call log and the per-tag network cap",
  "  --memory         cache and kv in memory (nothing persists; with --mock only)",
  "  -h, --help       this text",
  "Live catalogues go to kv audience_catalogue. Denied families and audiences (D21) are never written.",
  "exit codes: 0 done, 1 failed (nothing written), 2 bad arguments, 3 pin needs --yes",
].join("\n");

const OPTIONS = {
  yes: { type: "boolean" },
  mock: { type: "boolean" },
  tag: { type: "string" },
  memory: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

const TOOL_CALL = "cli-audiences";

export interface AudiencesArgs {
  command: "list" | "pin";
  yes: boolean;
  mock: boolean;
  tag: string | null;
  memory: boolean;
}

/** The parsed command, or null for --help. Throws UsageError. */
export function parseAudiencesArgs(argv: readonly string[]): AudiencesArgs | null {
  const { positionals, options } = parseCli(argv, OPTIONS);
  if (options.help) return null;
  const [command, ...rest] = positionals;
  if (command === undefined) throw new UsageError("name a command: list or pin");
  if (command !== "list" && command !== "pin") throw new UsageError(`unknown command "${command}"; the commands are list and pin`);
  if (rest.length > 0) throw new UsageError(`${command} takes no arguments; it reads every allowed family`);
  if (command === "list" && options.yes !== undefined) throw new UsageError("--yes applies to pin only");
  const tag = options.tag?.trim() ?? null;
  if (tag === "") throw new UsageError("--tag needs a non-empty value");
  return { command, yes: options.yes === true, mock: options.mock === true, tag, memory: options.memory === true };
}

export interface AudiencesCliDeps {
  env: NodeJS.ProcessEnv;
  io: CliIo;
  /** Replaces the Postgres or memory Qloo store, which also holds kv (tests). */
  store?: QlooStore;
  /** Replaces the live transport's fetch (tests). */
  fetch?: typeof fetch;
  now?: () => Date;
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const print = (io: CliIo, lines: readonly string[]): void => {
  for (const line of lines) io.out(line);
};

interface Planned {
  family: string;
  cached: boolean;
}

async function plan(session: SkillSession): Promise<Planned[]> {
  const probe = session.scope.forTool(null);
  return Promise.all(AUDIENCE_CATALOGUE_FAMILIES.map(async (family) => ({ family, cached: await probe.has(PATH, audienceCatalogueParams(family)) })));
}

/** Segments per family in the stored value, or the state when nothing usable is stored. */
async function storedCounts(store: QlooStore, kvKey: string): Promise<{ state: string; counts: Map<string, number>; fetchedAt: string | null }> {
  const read = readAudienceCatalogue(await store.getKv(kvKey));
  const counts = new Map<string, number>();
  for (const s of read.segments) {
    const family = s.key.split(":")[2] ?? "";
    counts.set(family, (counts.get(family) ?? 0) + 1);
  }
  return { state: read.state, counts, fetchedAt: read.fetchedAt };
}

async function runList(session: SkillSession, qloo: CliQloo, kvKey: string, io: CliIo): Promise<number> {
  const planned = await plan(session);
  const stored = await storedCounts(qloo.store, kvKey);
  io.out(heading(`AUDIENCE CATALOGUE · kv ${kvKey} · ${stored.state}${stored.fetchedAt === null ? "" : ` (fetched ${stored.fetchedAt})`}`));
  print(
    io,
    renderTable(
      [{ header: "family" }, { header: "pinned segments" }, { header: "request" }],
      planned.map(({ family, cached }) => [family, stored.counts.has(family) ? formatCount(stored.counts.get(family) ?? 0) : NONE, cached ? "cached" : "not cached"]),
      { indent: "  " },
    ),
  );
  const total = [...stored.counts.values()].reduce((a, b) => a + b, 0);
  const network = planned.filter((p) => !p.cached).length;
  io.out("");
  io.out(`  ${formatCount(total)} segments pinned · pin would make ${formatCount(network)} network calls to Qloo ${qloo.client.env} under tag ${qloo.tag}`);
  return stored.state === "malformed" ? EXIT.failed : EXIT.ok;
}

type Outcome = { family: string; read: AudienceFamilyRead } | { family: string; error: string };

async function runPin(args: AudiencesArgs, session: SkillSession, qloo: CliQloo, kvKey: string, io: CliIo, now: Date): Promise<number> {
  const planned = await plan(session);
  const network = planned.filter((p) => !p.cached).length;
  io.out(heading(`PLAN (${planned.length} families · ${formatCount(planned.length - network)} cached · ${formatCount(network)} network calls)`));
  print(
    io,
    renderTable(
      [{ header: "family" }, { header: "request" }],
      planned.map(({ family, cached }) => [family, cached ? "cached" : "network"]),
      { indent: "  " },
    ),
  );
  if (!args.yes) {
    io.out(
      `\npin would make ${formatCount(network)} network calls to Qloo ${qloo.client.env} under tag ${qloo.tag}, pin the ` +
        `${planned.length} answers in the cache and write kv ${kvKey}. Run it again with --yes.`,
    );
    return EXIT.needsInput;
  }

  // One family at a time: the limiter paces live calls anyway, and the table keeps allowlist order.
  const api = session.scope.forTool(TOOL_CALL);
  const outcomes: Outcome[] = [];
  for (const { family } of planned) {
    const params = audienceCatalogueParams(family);
    try {
      const answer = await api.audiences(params);
      // The answer is cached now; pinning keeps it from expiring (D25: the audience catalogue is pinned).
      await qloo.client.pin(PATH, params);
      outcomes.push({ family, read: audienceFamilySegments(family, answer.data.results.audiences) });
    } catch (err) {
      outcomes.push({ family, error: isBudgetError(err) ? "a Qloo budget gate refused the call" : errorText(err) });
    }
  }

  io.out(heading("RESULT"));
  print(
    io,
    renderTable(
      [{ header: "family" }, { header: "rows" }, { header: "kept" }, { header: "denied (D21)" }, { header: "dropped" }, { header: "error", max: 80 }],
      outcomes.map((o) =>
        "read" in o
          ? [o.family, formatCount(o.read.rows), formatCount(o.read.segments.length), formatCount(o.read.denied), formatCount(o.read.dropped), NONE]
          : [o.family, NONE, NONE, NONE, NONE, o.error],
      ),
      { indent: "  " },
    ),
  );

  const reads = outcomes.flatMap((o) => ("read" in o ? [o.read] : []));
  if (reads.length < outcomes.length) {
    io.err(`\nkv ${kvKey}: nothing written, since ${outcomes.length - reads.length} of ${outcomes.length} families failed`);
    return EXIT.failed;
  }
  try {
    const value = storedAudienceCatalogue(reads, now);
    await qloo.store.setKv(kvKey, value);
    const total = reads.reduce((n, r) => n + r.segments.length, 0);
    io.out(`\nkv ${kvKey}: wrote ${formatCount(total)} segments in ${reads.length} families`);
  } catch (err) {
    io.err(`could not write kv ${kvKey}: ${errorText(err)}`);
    return EXIT.failed;
  }
  return EXIT.ok;
}

export async function runAudiencesCommand(argv: readonly string[], deps: AudiencesCliDeps): Promise<number> {
  const io = safeIo(deps.io);
  let args: AudiencesArgs | null;
  try {
    args = parseAudiencesArgs(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    io.err(err.message);
    io.err(AUDIENCES_USAGE);
    return EXIT.usage;
  }
  if (args === null) {
    io.out(AUDIENCES_USAGE);
    return EXIT.ok;
  }

  let qloo: CliQloo;
  try {
    const store = deps.store ?? (args.memory ? "memory" : "pg");
    qloo = await openCliQloo({ env: deps.env, mock: args.mock, tag: args.tag, store, logger: stderrLogger(io.err), fetch: deps.fetch });
  } catch (err) {
    if (!(err instanceof CliError)) throw err;
    io.err(err.message);
    return EXIT.failed;
  }

  const now = deps.now?.() ?? new Date();
  const kvKey = audienceCatalogueKvKey(qloo.client.env);
  const session = createSkillSession(qloo.client, stubGeo(), now);
  io.out(`audiences ${args.command} · Qloo ${qloo.client.env} · tag ${qloo.tag} · cache ${qloo.storeLabel} · kv ${kvKey} · run ${session.runId}`);

  let code: number;
  try {
    code = args.command === "list" ? await runList(session, qloo, kvKey, io) : await runPin(args, session, qloo, kvKey, io, now);
  } catch (err) {
    io.err(`audiences ${args.command} failed: ${errorText(err)}`);
    code = EXIT.failed;
  }
  try {
    if (session.calls.length > 0) await renderUsage(session, qloo, io);
  } catch (err) {
    io.err(`could not report Qloo usage: ${errorText(err)}`);
  } finally {
    await qloo.close();
  }
  return code;
}
