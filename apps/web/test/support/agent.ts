// Scripted stand-ins for runAgent and its clients, so run-manager tests never call a model or Qloo.
// Every entity and id is invented (D29); the completed run replays the synthetic test-run script.
import type { AgentRunOptions, AgentRunResult, AnthropicLike, LedgerSnapshot } from "@ct/agent";
import { DEFAULT_RUN_LIMITS, type EventInput, type EventInputOf, type Intent, type Mode } from "@ct/contracts";
import { createMemoryQlooStore, createQlooClient, qlooClientOptionsFromEnv, type QlooClient } from "@ct/qloo";
import { buildFakeScript } from "../../server/fake-script";
import type { AgentDeps, RunAgentFn } from "../../server/run-manager";

export const TEST_MODEL = "claude-sonnet-5-5";

export const EMPTY_LEDGER: LedgerSnapshot = { evidence: [], metrics: [], datasets: [], findings: [] };

/** A mock-transport Qloo client on a memory store: no key, no network, no database. */
export function mockQlooClient(): QlooClient {
  return createQlooClient(qlooClientOptionsFromEnv({ NODE_ENV: "test", QLOO_MOCK: "1" }, { store: createMemoryQlooStore() }));
}

/** The SDK surface, refusing every call: the scripted agent never reaches it. */
export const NO_MODEL_CALLS: AnthropicLike = {
  beta: {
    messages: {
      stream: () => {
        throw new Error("no model calls in web tests");
      },
    },
  },
  messages: {
    create: () => {
      throw new Error("no model calls in web tests");
    },
  },
};

export function agentDeps(overrides: Partial<AgentDeps> = {}, mode: Mode = "live"): AgentDeps {
  const qloo = mockQlooClient();
  return { qloo: () => qloo, anthropic: () => NO_MODEL_CALLS, mode: async () => mode, ...overrides };
}

export function agentResult(partial: Partial<AgentRunResult> = {}): AgentRunResult {
  return {
    status: "completed",
    report: null,
    ledger: EMPTY_LEDGER,
    intent: null,
    model: TEST_MODEL,
    usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    usd: 0,
    qloo: { network: 0, cached: 0, reused: 0 },
    validation: null,
    reason: null,
    elapsedMs: 0,
    ...partial,
  };
}

export interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

export function deferred(): Deferred {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/** run.created as runAgent emits it for these options. */
export function runCreated(o: AgentRunOptions): EventInputOf<"run.created"> {
  return {
    type: "run.created",
    question: o.question,
    mode: o.mode,
    lane: o.lane,
    limits: o.limits ?? DEFAULT_RUN_LIMITS,
    parentRunId: o.parent?.runId ?? null,
    model: TEST_MODEL,
  };
}

/** The ledger a script's events add up to: what the agent's run ledger would snapshot. */
export function ledgerOf(inputs: readonly EventInput[]): LedgerSnapshot {
  const ledger: LedgerSnapshot = { evidence: [], metrics: [], datasets: [], findings: [] };
  for (const input of inputs) {
    if (input.type === "evidence") ledger.evidence.push(input.evidence);
    if (input.type === "metric") ledger.metrics.push(input.metric);
    if (input.type === "dataset.ready" && input.inline) ledger.datasets.push(input.inline);
    if (input.type === "finding" && !ledger.findings.some((f) => f.id === input.finding.id)) ledger.findings.push(input.finding);
  }
  return ledger;
}

export const SPENT_USD = 0.12;
export const TOTAL_USD = 0.15;

export interface CompletedScript {
  /** Resolved by the test to let the agent emit its first event (after it subscribed to the bus). */
  beforeStart?: Promise<void>;
  /** Resolved by the test to let the agent go past CLERK. */
  afterClerk?: Promise<void>;
  /** Called with the options runAgent received. */
  onStart?: (o: AgentRunOptions) => void;
}

/**
 * A completed run: the synthetic test-run script as the agent's events (with this run's question
 * and model), a usage event with real-looking spend, and a result with the matching ledger.
 */
export function completedAgent(script: CompletedScript = {}): RunAgentFn {
  return async (o) => {
    script.onStart?.(o);
    if (script.beforeStart) await script.beforeStart;
    const fake = buildFakeScript({ runId: o.runId, startedAt: Date.now(), durationMs: 1000 });
    const inputs = fake.steps.map((s) => s.input);
    let intent: Intent | null = null;
    for (const input of inputs) {
      if (input.type === "run.created") {
        o.emit(runCreated(o));
        continue;
      }
      o.emit(input);
      if (input.type === "clerk") {
        intent = input.intent;
        if (script.afterClerk) await script.afterClerk;
      }
    }
    o.emit({
      type: "usage",
      llmUsd: SPENT_USD,
      tokens: { input: 1000, output: 200, cacheRead: 500, cacheCreation: 0 },
      qloo: { network: 5, cached: 3, reused: 1 },
      elapsedMs: 900,
    });
    return agentResult({
      status: "completed",
      report: fake.report,
      ledger: ledgerOf(inputs),
      intent,
      usage: { input: 1200, output: 300, cacheRead: 500, cacheCreation: 100 },
      usd: TOTAL_USD,
      qloo: { network: 5, cached: 3, reused: 1 },
      validation: { issues: [], numbersTraced: fake.report.receipt.numbersTraced },
      elapsedMs: 900,
    });
  };
}

/** A run the resolution gate stopped: CLERK's intent, then the picker, ending needs_input. */
export function needsInputAgent(intent: Intent, picker: Omit<EventInputOf<"needs_input">, "type">): RunAgentFn {
  return async (o) => {
    o.emit(runCreated(o));
    o.emit({ type: "clerk", intent, ms: 500 });
    o.emit({ type: "needs_input", ...picker });
    return agentResult({ status: "needs_input", intent, reason: "Pick the one you meant.", model: null });
  };
}

/** An agent that emits run.created and then waits for the signal, returning `status` when stopped. */
export function waitingAgent(status: AgentRunResult["status"] = "incomplete", started?: Deferred): RunAgentFn {
  return async (o) => {
    o.emit(runCreated(o));
    o.emit({ type: "note", text: "Waiting for a stop." });
    started?.resolve();
    await new Promise<void>((resolve) => {
      if (o.signal.aborted) return resolve();
      o.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    return agentResult({ status, reason: "The agent saw its signal abort.", model: null });
  };
}
