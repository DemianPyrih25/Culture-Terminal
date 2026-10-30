// pnpm exec tsx tools/dev/listed-brands.ts [--yes] [--tag T]
//
// Checks every brand name in config/listed_companies.json against Qloo the way a run does: one brand
// /search per name (resolve_entities' own request and exact-match rule), then company_financials' own
// lookup (listedCompanyOf) on the name Qloo returns. Each name gets one status:
//   ok      it resolves exactly, and the name Qloo returns (each exact tie a person could pick) is a key;
//   FAIL    it resolves exactly to a name that is not a key: the brand is never found and
//           company_financials is silently skipped (add the returned name as a key);
//   pick?   no exact match: a run with it as the primary stops with a picker of these candidates, and
//           those marked [key] reach the company once picked (a person checks the right one is a key);
//   absent  no exact match and no candidate is a key: no Qloo entity reaches the company.
// Each line also shows the entry's relation (Part 9 open issue 6): "[parent: <company>]" for a brand inside a
// larger company, which runs never show figures for (NOT_SEPARATELY_REPORTED).
// Exit 3 when any name FAILs. Prints the plan and calls only with --yes; cached searches cost nothing.
// Prints names only, never entity ids or Qloo values.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { classifyMatches, listedCompanyOf, searchParams } from "@ct/quant";
import { consoleIo } from "./cli/io";
import { openCliQloo, stderrLogger } from "./cli/qloo-setup";
import { terminalSafe } from "./cli/table";

const rootEnv = fileURLToPath(new URL("../../.env", import.meta.url));
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const CONFIG = fileURLToPath(new URL("../../config/listed_companies.json", import.meta.url));
const TOOL_CALL = "cli-listed-brands";

interface Row {
  name: string;
  ticker: string;
  /** The parent company of a sub-brand (relation parent), else null. */
  parent: string | null;
  matchClass: string;
  /** The exact match applied, or each exact tie a person could pick. */
  resolved: { name: string; listed: boolean }[];
  /** With no exact match: the candidates offered, in Qloo's order. */
  candidates: { name: string; listed: boolean }[];
  status: "ok" | "FAIL" | "pick?" | "absent";
}

async function main(argv: string[]): Promise<number> {
  const yes = argv.includes("--yes");
  const tagAt = argv.indexOf("--tag");
  const tag = tagAt >= 0 ? (argv[tagAt + 1] ?? null) : null;
  const config = JSON.parse(readFileSync(CONFIG, "utf8")) as {
    brands: Record<string, { ticker: string; company: string; relation?: "self" | "parent"; parent_name?: string }>;
  };
  const names = Object.entries(config.brands).map(([name, c]) => ({
    name,
    ticker: c.ticker,
    parent: c.relation === "parent" ? (c.parent_name ?? c.company) : null,
  }));

  const qloo = await openCliQloo({ env: process.env, mock: false, tag, store: "pg", logger: stderrLogger((l) => consoleIo.err(l)) });
  try {
    const scope = qloo.client.standalone();
    const tool = scope.forTool(TOOL_CALL);
    const mentions = names.map((n) => ({ ...n, mention: { text: n.name, type: "brand" as const, metro: null } }));
    let uncached = 0;
    for (const m of mentions) {
      const params = searchParams(m.mention);
      if (params !== null && !(await tool.has("/search", params))) uncached += 1;
    }
    consoleIo.out(`${names.length} names, ${uncached} search(es) not cached (tag ${qloo.tag}, cap ${qloo.tagCap ?? "none"}, ${qloo.storeLabel})`);
    if (!yes) {
      consoleIo.out("Pass --yes to run the searches.");
      return 0;
    }

    const rows: Row[] = [];
    for (const m of mentions) {
      const params = searchParams(m.mention);
      if (params === null) continue;
      const search = await tool.search(params);
      const c = classifyMatches(m.mention, search.data.results);
      const named = (n: string) => ({ name: n, listed: listedCompanyOf(n) !== null });
      const resolved = c.exact.map((r) => named(r.name));
      const candidates = c.matchClass === "exact" ? [] : c.alternatives.map((a) => named(a.name));
      const status: Row["status"] =
        resolved.length > 0 ? (resolved.every((r) => r.listed) ? "ok" : "FAIL") : candidates.some((x) => x.listed) ? "pick?" : "absent";
      rows.push({ name: m.name, ticker: m.ticker, parent: m.parent, matchClass: c.matchClass, resolved, candidates, status });
    }
    for (const r of rows) {
      const got = r.resolved.map((x) => `${x.name}${x.listed ? "" : " [NOT A KEY]"}`).join(" | ");
      const offered = r.candidates.map((x) => `${x.name}${x.listed ? " [key]" : ""}`).join(" | ");
      const qloo = got === "" ? `${r.matchClass}; candidates: ${offered === "" ? "none" : offered}` : got;
      const relation = r.parent === null ? "" : ` [parent: ${r.parent}]`;
      consoleIo.out(terminalSafe(`${r.status.padEnd(6)} ${r.name} (${r.ticker})${relation} -> ${qloo}`));
    }
    const count = (s: Row["status"]): number => rows.filter((r) => r.status === s).length;
    const failed = count("FAIL");
    consoleIo.out(
      `${rows.length} names: ${count("ok")} ok, ${failed} FAIL, ${count("pick?")} pick?, ${count("absent")} absent; network calls ${scope.networkUsed()}`,
    );
    return failed === 0 ? 0 : 3;
  } finally {
    await qloo.close();
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    consoleIo.err(terminalSafe(err instanceof Error ? (err.stack ?? err.message) : String(err)));
    process.exitCode = 1;
  },
);
