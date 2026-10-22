// The smoke test's checks, apart from smoke.ts (which runs on import) so tests can drive them with
// a scripted streamer and a fake CLERK create.
import { BudgetStop, type BudgetGuard } from "./budget";
import { callModel, CallFailed, describeError, type AnalystStreamer, type CallOutcome } from "./client";
import { buildAnalystRequest } from "./config";
import { Intent, normalizeIntent, type Anthropic } from "./deps";
import { fakeMessage, fakeRefusalDetails } from "./fakes";
import { History, textBlock } from "./history";
import { formatUsd, HAIKU, usageToUsd } from "./pricing";
import { CLERK_SYSTEM_PROMPT } from "./prompts";
import { answerSkillCall, buildScenario, planAck } from "./scenario";
import {
  CLERK_MAX_TOKENS,
  clerkEstimateUsd,
  clerkMessages,
  clerkSchema,
  SMOKE_CONFIG,
  SMOKE_FINAL,
  SMOKE_MAX_TOKENS,
  smokeOpening,
  smokePrefix,
  type ClerkVariant,
} from "./smoke-plan";
import { classifyStop, thinkingSummary, toolUses, toRefusal } from "./stop";
import { checkPlan, checkReport } from "./validate";

export interface Check {
  id: string;
  label: string;
  pass: boolean;
  detail: string;
}

function pending(id: string, label: string): Check {
  return { id, label, pass: false, detail: "not reached" };
}

/** (a), (b) and (c): two Sonnet requests on one conversation, the second sharing the first's prefix. */
export async function analystChecks(streamer: AnalystStreamer, guard: BudgetGuard, now: () => number): Promise<{ checks: Check[]; calls: CallOutcome[] }> {
  const a = pending("a", 'thinking display "updates" (progress updates as text)');
  const b1 = pending("b", "submit_plan (strict) input is schema-valid");
  const b2 = pending("b", "submit_report (strict) input is schema-valid");
  const c = pending("c", "cache_read_input_tokens > 0 on the second request");
  const calls: CallOutcome[] = [];
  const scenario = buildScenario();
  const prefix = smokePrefix();
  const history = new History();
  history.push(smokeOpening(scenario));
  let failure: string | null = null;

  // pause_turn: push the content unchanged and send again, at most twice.
  const send = async (): Promise<CallOutcome> => {
    for (let i = 0; ; i++) {
      const call = await callModel(streamer, buildAnalystRequest(SMOKE_CONFIG, prefix, history.messages, SMOKE_MAX_TOKENS), guard, now);
      calls.push(call);
      if (call.message.stop_reason !== "pause_turn" || i >= 2) return call;
      history.pushAssistant(call.message);
    }
  };
  /** Stop-reason guards before content; returns a reason to stop, or null to go on. */
  const blocked = (call: CallOutcome): string | null => {
    const stop = classifyStop(call.message);
    if (stop.kind === "refusal") return `refused (${stop.refusal.category ?? "no category"})`;
    if (stop.kind === "max_tokens_pending_tool") return `max_tokens with a pending tool_use (${stop.pendingTools.join(", ")})`;
    if (stop.kind === "pause_turn") return "still paused after two continuations";
    return null;
  };

  try {
    const first = await send();
    const stop1 = blocked(first);
    if (stop1) {
      b1.detail = b2.detail = stop1;
    } else {
      history.pushAssistant(first.message);
      const uses = toolUses(first.message);
      const planUse = uses.find((u) => u.name === "submit_plan");
      const results: Anthropic.Beta.BetaContentBlockParam[] = [];
      if (planUse) {
        const plan = checkPlan(planUse.input);
        b1.pass = plan.structural;
        b1.detail = plan.structural
          ? `valid; server-side limits ${plan.limits ? "met" : `missed: ${plan.issues.join("; ")}`}`
          : "input does not match the schema";
        results.push(
          plan.plan
            ? { type: "tool_result", tool_use_id: planUse.id, content: planAck(plan.plan) }
            : { type: "tool_result", tool_use_id: planUse.id, is_error: true, content: "INVALID_PLAN" },
        );
      } else {
        b1.detail = `no submit_plan call (tools called: ${uses.map((u) => u.name).join(", ") || "none"})`;
      }
      for (const use of uses) if (use !== planUse) results.push(answerSkillCall(use, "wave1", scenario).result);
      history.push({ role: "user", content: results.length > 0 ? [...results, textBlock(SMOKE_FINAL)] : SMOKE_FINAL });

      const second = await send();
      const read = second.message.usage.cache_read_input_tokens ?? 0;
      c.pass = read > 0;
      c.detail = `${read.toLocaleString("en-US")} tokens read, ${(second.message.usage.cache_creation_input_tokens ?? 0).toLocaleString("en-US")} written`;
      const stop2 = blocked(second);
      if (stop2) {
        b2.detail = stop2;
      } else {
        const reportUse = toolUses(second.message).find((u) => u.name === "submit_report");
        if (reportUse) {
          const report = checkReport(reportUse.input);
          b2.pass = report.structural;
          b2.detail = report.structural
            ? `valid; server-side limits ${report.limits ? "met" : `missed: ${report.issues.join("; ")}`}`
            : "input does not match the schema";
        } else {
          b2.detail = `no submit_report call (stop_reason ${second.message.stop_reason})`;
        }
      }
    }
  } catch (err) {
    failure = err instanceof BudgetStop || err instanceof CallFailed ? err.message : `unexpected: ${String(err)}`;
    for (const check of [b1, b2, c]) if (check.detail === "not reached") check.detail = failure;
  }

  // Without the beta the API rejects display "updates", so any response shows the request shape
  // works. A response may carry zero progress updates (build for zero-or-more), so none is no failure.
  const blocks = calls.reduce((n, call) => n + thinkingSummary(call.message).blocks, 0);
  const updates = calls.reduce((n, call) => n + thinkingSummary(call.message).nonEmpty, 0);
  const chars = calls.reduce((n, call) => n + call.thinkingDeltaChars, 0);
  a.pass = calls.length > 0;
  a.detail =
    calls.length === 0
      ? `no response: ${failure ?? "not reached"}`
      : `request with display "updates" accepted (${blocks} thinking block(s) in ${calls.length} response(s)); ` +
        (updates > 0 || chars > 0
          ? `non-empty updates: ${updates}, ${chars.toLocaleString("en-US")} streamed thinking chars`
          : "no progress updates emitted (allowed)");
  return { checks: [a, b1, b2, c], calls };
}

/** Sends one CLERK request: client.messages.create in the smoke, a fake in tests. */
export type ClerkCreate = (params: Anthropic.MessageCreateParamsNonStreaming) => Promise<Anthropic.Message>;

/**
 * (d) The CLERK path on Haiku 5.5. It uses messages.create, not messages.parse: parse() runs the
 * format's parser on every text block before the caller sees stop_reason, so a refusal with partial
 * text or a max_tokens cut would surface as a parse error. Here stop_reason comes first, then the
 * text block is parsed with Intent; the Part 3 CLERK should follow the same order.
 */
export async function clerkCheck(create: ClerkCreate, guard: BudgetGuard, variant: ClerkVariant): Promise<{ check: Check; usd: number }> {
  const check = pending("d", `CLERK parses a valid Intent (${variant})`);
  const estimate = clerkEstimateUsd(variant);
  if (!guard.allows(estimate)) {
    check.detail = `skipped: up to ${formatUsd(estimate)} would pass the cap`;
    return { check, usd: 0 };
  }
  let message: Anthropic.Message;
  try {
    message = await create({
      model: HAIKU,
      max_tokens: CLERK_MAX_TOKENS,
      thinking: { type: "disabled" },
      output_config: { effort: "low", format: { type: "json_schema", schema: clerkSchema(variant) } },
      system: CLERK_SYSTEM_PROMPT,
      messages: clerkMessages(),
    });
  } catch (err) {
    const info = describeError(err);
    const charged = info.maybeBilled ? estimate : 0;
    guard.charge(charged);
    check.detail = `${info.kind}${info.status === null ? "" : ` (${info.status})`}: ${info.message.slice(0, 300)}`;
    return { check, usd: charged };
  }

  const usd = usageToUsd(HAIKU, message.usage);
  guard.charge(usd);
  const refusal = toRefusal(message);
  if (refusal) {
    check.detail = `refused (${refusal.category ?? "no category"})`;
    return { check, usd };
  }
  if (message.stop_reason === "max_tokens") {
    check.detail = "truncated at max_tokens";
    return { check, usd };
  }
  const text = message.content.find((b): b is Anthropic.TextBlock => b.type === "text")?.text;
  if (text === undefined) {
    check.detail = `no text block (stop_reason ${message.stop_reason})`;
    return { check, usd };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    check.detail = `the text block is not JSON: ${err instanceof Error ? err.message : String(err)}`;
    return { check, usd };
  }
  const parsed = Intent.safeParse(json);
  check.pass = parsed.success;
  check.detail = parsed.success
    ? `job ${parsed.data.job}, pillar ${normalizeIntent(parsed.data).pillar}, mnemonic "${normalizeIntent(parsed.data).mnemonic}"`
    : `not a valid Intent: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`;
  return { check, usd };
}

/** (e) Offline: the same function the bench and the CLERK use, on a fake refusal. */
export function refusalCheck(): Check {
  const message = fakeMessage({ stop_reason: "refusal", stop_details: fakeRefusalDetails({ category: "cyber" }), content: [] });
  const refusal = toRefusal(message);
  const stop = classifyStop(message);
  const pass = refusal?.kind === "refusal" && refusal.category === "cyber" && !refusal.partialOutput && stop.kind === "refusal";
  return {
    id: "e",
    label: "stop_reason refusal becomes a refusal result (offline)",
    pass,
    detail: pass ? "category cyber, no partial output; unit tests in tools/llm-bench/stop.test.ts" : "refusal handling broke",
  };
}
