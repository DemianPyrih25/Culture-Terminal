// pnpm exec tsx tools/dev/brand-aliases.ts check [--yes] [--tag T]
//
// Checks every known alias in config/brand_aliases.json against Qloo the way the resolution gate applies
// it (Part 9 open issue 5, PLAN D20 alias exception): one brand /search for the alias text (the gate's own
// request, so a cached search costs nothing), then whether one of the alias's official `names` comes back
// with the alias's entity type. Each entry gets one status and is written back to the file:
//   verified    one of `names` came back for the alias: the gate may apply it;
//   unverified  none came back (or the search failed): the gate never applies it.
// An alias that already matches exactly needs no entry and is reported as "exact" (and left unverified).
// Prints the plan and calls only with --yes; at most one call per alias, under QLOO_TAG and its caps.
// Prints names only, never entity ids or Qloo values.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { QlooSearchEntity } from "@ct/contracts";
import { classifyMatches, normaliseName, searchParams } from "@ct/quant";
import { consoleIo } from "./cli/io";
import { openCliQloo, stderrLogger } from "./cli/qloo-setup";
import { terminalSafe } from "./cli/table";

const CONFIG = fileURLToPath(new URL("../../config/brand_aliases.json", import.meta.url));
const TOOL_CALL = "cli-brand-aliases";

export interface AliasEntry {
  alias: string;
  names: string[];
  type: "brand";
  status: "verified" | "unverified";
  verified_by: string | null;
}

export interface AliasConfigFile {
  $comment?: string;
  aliases: AliasEntry[];
}

export type AliasOutcome =
  | { status: "verified"; name: string }
  | { status: "unverified"; why: "exact" | "absent" | "failed" };

/**
 * What one alias search shows: "exact" when the alias already resolves exactly (the gate needs no alias),
 * "verified" with the official name that came back, "absent" when none of `names` did.
 */
export function aliasOutcome(entry: Pick<AliasEntry, "alias" | "names" | "type">, results: readonly QlooSearchEntity[]): AliasOutcome {
  const exact = classifyMatches({ text: entry.alias, type: entry.type }, results);
  if (exact.matchClass === "exact") return { status: "unverified", why: "exact" };
  const names = new Set(entry.names.map(normaliseName));
  const hit = results.find((r) => names.has(normaliseName(r.name)));
  return hit === undefined ? { status: "unverified", why: "absent" } : { status: "verified", name: hit.name };
}

/** The entry as the check leaves it: status and a dated verified_by line naming what came back. */
export function checkedEntry(entry: AliasEntry, outcome: AliasOutcome, day: string): AliasEntry {
  if (outcome.status === "verified") {
    return { ...entry, status: "verified", verified_by: `brand-aliases.ts ${day}: the brand search for '${entry.alias}' returned '${outcome.name}'` };
  }
  const why = { exact: "the alias already resolves exactly, so no alias is needed", absent: "none of the names came back", failed: "the search failed" }[outcome.why];
  return { ...entry, status: "unverified", verified_by: `brand-aliases.ts ${day}: ${why}` };
}

/** The file text with each entry on one line, as the repo keeps it. */
export function formatConfig(config: AliasConfigFile): string {
  const lines = config.aliases.map((a) => `    ${JSON.stringify(a).replace(/":/g, '": ').replace(/,"/g, ', "').replace(/^\{/, "{ ").replace(/\}$/, " }")}`);
  const head = config.$comment === undefined ? "" : `  "$comment": ${JSON.stringify(config.$comment)},\n`;
  return `{\n${head}  "aliases": [\n${lines.join(",\n")}\n  ]\n}\n`;
}

async function main(argv: string[]): Promise<number> {
  if (argv[0] !== "check") {
    consoleIo.err("usage: pnpm exec tsx tools/dev/brand-aliases.ts check [--yes] [--tag T]");
    return 2;
  }
  const rootEnv = fileURLToPath(new URL("../../.env", import.meta.url));
  if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);
  const yes = argv.includes("--yes");
  const tagAt = argv.indexOf("--tag");
  const tag = tagAt >= 0 ? (argv[tagAt + 1] ?? null) : null;
  const config = JSON.parse(readFileSync(CONFIG, "utf8")) as AliasConfigFile;

  const qloo = await openCliQloo({ env: process.env, mock: false, tag, store: "pg", logger: stderrLogger((l) => consoleIo.err(l)) });
  try {
    const scope = qloo.client.standalone();
    const tool = scope.forTool(TOOL_CALL);
    let uncached = 0;
    for (const a of config.aliases) {
      const params = searchParams({ text: a.alias, type: a.type, metro: null });
      if (params !== null && !(await tool.has("/search", params))) uncached += 1;
    }
    consoleIo.out(`${config.aliases.length} aliases, ${uncached} search(es) not cached (tag ${qloo.tag}, cap ${qloo.tagCap ?? "none"}, ${qloo.storeLabel})`);
    if (!yes) {
      consoleIo.out("Pass --yes to run the searches and rewrite config/brand_aliases.json.");
      return 0;
    }
    const day = new Date().toISOString().slice(0, 10);
    const checked: AliasEntry[] = [];
    for (const a of config.aliases) {
      const params = searchParams({ text: a.alias, type: a.type, metro: null });
      let outcome: AliasOutcome;
      try {
        outcome = params === null ? { status: "unverified", why: "failed" } : aliasOutcome(a, (await tool.search(params)).data.results);
      } catch {
        outcome = { status: "unverified", why: "failed" };
      }
      checked.push(checkedEntry(a, outcome, day));
      const shown = outcome.status === "verified" ? `-> ${outcome.name}` : `(${outcome.why})`;
      consoleIo.out(terminalSafe(`${outcome.status.padEnd(10)} ${a.alias} ${shown}`));
    }
    writeFileSync(CONFIG, formatConfig({ ...config, aliases: checked }));
    const verified = checked.filter((a) => a.status === "verified").length;
    consoleIo.out(`${checked.length} aliases: ${verified} verified, ${checked.length - verified} unverified; network calls ${scope.networkUsed()}`);
    return 0;
  } finally {
    await qloo.close();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      consoleIo.err(terminalSafe(err instanceof Error ? (err.stack ?? err.message) : String(err)));
      process.exitCode = 1;
    },
  );
}
