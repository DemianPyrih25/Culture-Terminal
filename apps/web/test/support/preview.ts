// Stand-ins for the preview service: the agent tests' scripted fake Anthropic answers CLERK, and a
// Qloo client on the mock transport and a memory store answers the gate (no key, no network, no
// database). Every entity is invented (D29).
import type { Intent } from "@ct/contracts";
import { createMemoryQlooStore, createMockTransport, createQlooClient, type QlooClient } from "@ct/qloo";
import type { AlreadyHave, PreviewDeps } from "../../server/preview";
import { FakeAnthropic, fakeGaMessage, type CreateScript } from "../../../../packages/agent/test/support/fake-anthropic";

export { FakeAnthropic, fakeGaMessage };

/** A mock-transport Qloo client with no rate limit to wait on. */
export function fastMockQloo(): QlooClient {
  return createQlooClient({
    transport: createMockTransport(),
    env: "mock",
    baseUrl: "https://mock.invalid",
    tag: "preview-test",
    tagCap: null,
    rps: 1000,
    store: createMemoryQlooStore(),
  });
}

export function testIntent(partial: Partial<Intent> = {}): Intent {
  return {
    pillar: "investment",
    job: "brand_health",
    mentions: [{ text: "Juniper Cola", entity_type: "brand", role: "primary", public_figure: false }],
    geo: { metro: null, area: null, unsupported_place: null },
    constraints: { concepts: [], sponsor_categories: [], domains: [], ages: [], notes: [] },
    safety: { allowed: true, category: null, reframe: null },
    assumptions: ["US geography"],
    mnemonic: "JUNIPER COLA <BRAND> HLTH",
    ...partial,
  };
}

/** CLERK's messages.create answer for an intent. */
export const clerkReply = (intent: Intent) =>
  fakeGaMessage({ content: [{ type: "text", text: JSON.stringify(intent), citations: null }] });

/** A fake Anthropic whose CLERK answers these, in order; any further CLERK call throws. */
export const clerkAnswering = (...answers: CreateScript[]) => new FakeAnthropic({ create: answers });

/** Deps with no database: live mode, no spend so far, nothing in the answer cache. Pass vi.fn overrides to watch them. */
export function previewDeps(anthropic: FakeAnthropic | null, overrides: Partial<PreviewDeps> = {}): PreviewDeps {
  const qloo = fastMockQloo();
  return {
    qloo: () => qloo,
    anthropic: () => anthropic,
    mode: async () => "live",
    todayUsd: async () => 0,
    recordUsd: async () => undefined,
    findAnswer: async () => null,
    ...overrides,
  };
}

/** An answer-cache hit for a question. */
export function alreadyHave(partial: Partial<AlreadyHave> = {}): AlreadyHave {
  return {
    runId: "run-brief-0001",
    question: "Who really competes with Juniper Cola?",
    createdAt: "2026-10-22T08:00:00.000Z",
    signal: "mixed",
    confidence: { score: 82, band: "HIGH" },
    ...partial,
  };
}

