// pnpm exec tsx --env-file=.env tools/llm-bench/smoke.ts
//
// The combined smoke test (PLAN §11.2), live and cheap (expected spend well under $0.10; hard cap
// LLM_SMOKE_USD_CAP, default $0.30, which covers the worst case of every request it sends):
//   (a) the beta accepts thinking display "updates", and progress updates come back as text when
//       the model writes them (it may write none);
//   (b) the strict submit tools produce schema-valid input;
//   (c) cache_read_input_tokens > 0 on the second request sharing the first request's prefix;
//   (d) the CLERK path parses a valid Intent on Haiku 5.5 (structured outputs, effort low, thinking
//       off, stop_reason checked before content);
//   (e) refusal handling: stop_reason "refusal" becomes a refusal result (offline; see stop.test.ts).
// The checks live in smoke-checks.ts and the fixed requests in smoke-plan.ts.
import { performance } from "node:perf_hooks";
import { BudgetGuard, readUsdCap } from "./budget";
import { createClient, sdkStreamer } from "./client";
import { SDK_VERSION } from "./deps";
import { fileStamp, writeResult } from "./output";
import { formatUsd } from "./pricing";
import { analystChecks, clerkCheck, refusalCheck, type ClerkCreate } from "./smoke-checks";
import { SMOKE_DEFAULT_CAP_USD, smokeWorstCaseUsd } from "./smoke-plan";
import { thinkingSummary, toolUses } from "./stop";

async function main(): Promise<number> {
  const capUsd = readUsdCap(process.env, "LLM_SMOKE_USD_CAP", SMOKE_DEFAULT_CAP_USD);
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    console.error("ANTHROPIC_API_KEY is not set. Run with: pnpm exec tsx --env-file=.env tools/llm-bench/smoke.ts");
    return 2;
  }
  const worst = smokeWorstCaseUsd();
  console.log(`Smoke test (SDK ${SDK_VERSION}): worst case ${formatUsd(worst.total)} if every request maxes out; cap ${formatUsd(capUsd)} (LLM_SMOKE_USD_CAP)`);
  if (capUsd < worst.total) console.log("  warning: the cap is below the worst case, so the budget guard may skip a later check");

  const guard = new BudgetGuard(capUsd);
  const client = createClient();
  const startedAt = new Date();
  const now = (): number => performance.now();

  const analyst = await analystChecks(sdkStreamer(client), guard, now);
  const create: ClerkCreate = (params) => client.messages.create(params);
  const clerkZod = await clerkCheck(create, guard, "zodOutputFormat");
  const clerkStrict = await clerkCheck(create, guard, "structuredOutputSchema");
  const checks = [...analyst.checks, clerkZod.check, clerkStrict.check, refusalCheck()];

  const width = Math.max(...checks.map((c) => c.label.length)) + 2;
  for (const c of checks) console.log(`(${c.id}) ${c.label.padEnd(width)}${c.pass ? "PASS" : "FAIL"}  ${c.detail}`);
  const shortfalls = analyst.calls.filter((call) => call.estimateShortfallTokens > 0).length;
  if (shortfalls > 0) console.log(`warning: ${shortfalls} request(s) had a larger prompt than the budget estimate assumed (ESTIMATE_CHARS_PER_TOKEN)`);
  const file = writeResult(`smoke-${fileStamp(startedAt)}.json`, {
    kind: "llm-smoke",
    startedAt: startedAt.toISOString(),
    sdkVersion: SDK_VERSION,
    capUsd,
    worstCaseUsd: worst,
    spentUsd: guard.spentUsd,
    checks,
    analystCalls: analyst.calls.map((call) => ({
      latencyMs: call.latencyMs,
      firstDeltaMs: call.firstDeltaMs,
      stopReason: call.message.stop_reason,
      usage: call.message.usage,
      usd: call.usd,
      estimateUsd: call.estimateUsd,
      estimateShortfallTokens: call.estimateShortfallTokens,
      thinkingUpdates: thinkingSummary(call.message).texts,
      tools: toolUses(call.message).map((u) => ({ name: u.name, input: u.input })),
    })),
  });
  console.log(`Spent ${formatUsd(guard.spentUsd)} of the ${formatUsd(capUsd)} cap. Raw results: ${file}`);
  return checks.every((c) => c.pass) ? 0 : 1;
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
