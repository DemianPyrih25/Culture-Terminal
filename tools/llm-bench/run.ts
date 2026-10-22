// pnpm llm:bench  (tsx --env-file=.env tools/llm-bench/run.ts)
//
// The LLM bench (PLAN §4.2, D22, D23): a synthetic three-turn ANALYST run with the real 14 tools,
// on sonnet-medium, sonnet-low and haiku-medium. It spends real money, guarded by a hard cap
// (LLM_BENCH_USD_CAP, default $1.50), and writes raw results to .private/llm-bench/.
import { performance } from "node:perf_hooks";
import { analystPrefix, runAnalyst, type RunRecord } from "./analyst-run";
import { BudgetGuard, readUsdCap } from "./budget";
import { createClient, promptChars, sdkStreamer } from "./client";
import { ANALYST_MAX_TOKENS, BENCH_USAGE, parseBenchArgs, type BenchArgs } from "./config";
import { approxTokens, SDK_VERSION } from "./deps";
import { fileStamp, writeResult } from "./output";
import { estimateRequestUsd, formatUsd } from "./pricing";
import { buildScenario } from "./scenario";
import { decide, formatTable, summarize } from "./summary";

const DEFAULT_CAP_USD = 1.5;

function promptReport() {
  const scenario = buildScenario();
  const prefix = analystPrefix();
  const firstRequest = { system: prefix.system, tools: prefix.tools, messages: [{ role: "user", content: scenario.runContext }] };
  return {
    systemTokensApprox: approxTokens(JSON.stringify(prefix.system)),
    toolsTokensApprox: approxTokens(JSON.stringify(prefix.tools)),
    toolCount: prefix.tools.length,
    runContextTokensApprox: approxTokens(scenario.runContext),
    scanTokensApprox: approxTokens(scenario.scan.join("\n")),
    firstRequestChars: promptChars(firstRequest),
  };
}

function printPlan(args: BenchArgs, capUsd: number, prompt: ReturnType<typeof promptReport>): void {
  console.log(`LLM bench: ${args.runs} run(s) each of ${args.configs.map((c) => c.id).join(", ")}; SDK ${SDK_VERSION}`);
  console.log(
    `prefix ≈ ${prompt.toolsTokensApprox.toLocaleString("en-US")} tool tokens (${prompt.toolCount} tools) + ` +
      `${prompt.systemTokensApprox.toLocaleString("en-US")} system tokens; run context ≈ ${prompt.runContextTokensApprox} tokens; ` +
      `opening scan ≈ ${prompt.scanTokensApprox} tokens`,
  );
  for (const c of args.configs) {
    const worst = estimateRequestUsd(c.model, prompt.firstRequestChars, ANALYST_MAX_TOKENS);
    console.log(
      `  ${c.id}: ${c.model}, effort ${c.effort}, thinking display ${c.thinkingDisplay}, betas [${c.betas.join(", ")}]; ` +
        `worst case for the first request ${formatUsd(worst)}`,
    );
  }
  console.log(`hard cap ${formatUsd(capUsd)} (LLM_BENCH_USD_CAP); a request is skipped when its worst case could pass the cap`);
}

function runLine(r: RunRecord, spentUsd: number): string {
  const first = r.firstRequestCacheRead === null ? "n/a" : r.firstRequestCacheRead.toLocaleString("en-US");
  const estimated = r.estimatedChargesUsd > 0 ? ` (+ up to ${formatUsd(r.estimatedChargesUsd)} estimated for failed requests)` : "";
  return (
    `  ${r.outcome}${r.reason ? ` (${r.reason})` : ""}: ${(r.wallMs / 1000).toFixed(1)} s, ${formatUsd(r.usd)}${estimated}, ` +
    `${r.responses} responses, first-request cache read ${first}, plan ${r.plan.structural ? "valid" : "missing/invalid"}, ` +
    `report ${r.report.structural ? "valid" : "missing/invalid"}; bench total ${formatUsd(spentUsd)}`
  );
}

async function main(): Promise<number> {
  let args: BenchArgs;
  try {
    args = parseBenchArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
  if (args.help) {
    console.log(BENCH_USAGE);
    return 0;
  }
  const capUsd = readUsdCap(process.env, "LLM_BENCH_USD_CAP", DEFAULT_CAP_USD);
  const prompt = promptReport();
  printPlan(args, capUsd, prompt);
  if (args.dryRun) return 0;
  // Presence only: the key is read by the SDK and never touched or printed here.
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    console.error("ANTHROPIC_API_KEY is not set. Run through `pnpm llm:bench`, which loads .env.");
    return 2;
  }

  const guard = new BudgetGuard(capUsd);
  const streamer = sdkStreamer(createClient());
  const now = (): number => performance.now();
  const runs: RunRecord[] = [];
  const startedAt = new Date();
  let aborted: string | null = null;
  let crash: unknown = null;

  try {
    outer: for (const config of args.configs) {
      for (let run = 1; run <= args.runs; run++) {
        console.log(`[${config.id}] run ${run}/${args.runs}`);
        const record = await runAnalyst(config, run, { streamer, guard, now });
        runs.push(record);
        console.log(runLine(record, guard.spentUsd));
        if (record.error?.scope === "bench") {
          aborted = `stopped the bench: ${record.reason}`;
          break outer;
        }
        // A cheaper config may still fit under the cap, so only this config stops.
        if (record.outcome === "budget_stopped" || record.error?.scope === "config") {
          console.log(`  skipping the rest of ${config.id}`);
          break;
        }
      }
    }
  } catch (err) {
    crash = err;
    aborted = `crashed: ${err instanceof Error ? err.message : String(err)}`;
  }

  const summaries = args.configs.map((c) => summarize(c.id, runs));
  const decision = decide(summaries);
  const file = writeResult(`${fileStamp(startedAt)}.json`, {
    kind: "llm-bench",
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    sdkVersion: SDK_VERSION,
    capUsd,
    spentUsd: guard.spentUsd,
    args: { runs: args.runs, configs: args.configs },
    prompt,
    aborted,
    summaries,
    decision,
    runs,
  });

  console.log("");
  console.log(formatTable(summaries));
  console.log("");
  console.log(`Decision (PLAN §4.2): ${decision.pick}. ${decision.reason}.`);
  for (const w of decision.warnings) console.log(`  warning: ${w}`);
  if (aborted) console.log(`Bench ${aborted}`);
  console.log(`Spent ${formatUsd(guard.spentUsd)} of the ${formatUsd(capUsd)} cap. Raw results: ${file}`);
  if (crash) throw crash;
  return aborted || runs.every((r) => r.outcome !== "completed") ? 1 : 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  },
);
