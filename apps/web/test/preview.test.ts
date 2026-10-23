// The preview service (POST /api/preview) without a database: the agent tests' fake Anthropic
// answers CLERK and the Qloo mock transport answers the gate. Invented entities only (D29).
import { describe, expect, it, vi } from "vitest";
import { normalizeIntent } from "@ct/contracts";
import type { PreviewOutcome, PreviewResponse } from "../server/preview";
import {
  alreadyHave,
  clerkAnswering,
  clerkReply,
  fakeGaMessage,
  fastMockQloo,
  previewDeps,
  testIntent,
} from "./support/preview";

vi.mock("server-only", () => ({}));

const { PREVIEW_TOKEN, PREVIEW_TTL_MS, PreviewService, questionKey } = await import("../server/preview");

const QUESTION = "Who really competes with Juniper Cola?";
const START = Date.parse("2026-10-22T09:00:00.000Z");
/** Different questions, each a reading of its own. */
const BURST = [
  "Who drinks Juniper Cola?",
  "Who drinks Brand Beta?",
  "Who drinks Brand Gamma?",
  "Who drinks Brand Alpha?",
  "Who drinks Brand Delta?",
];

/** A clock tests move by hand. */
function clock(at = START) {
  const c = { ms: at, now: () => c.ms };
  return c;
}

/** Today's spend, read on a later tick: every preview of a burst reaches its checks before any CLERK call. */
const spendLater = (usd: number) => () => new Promise<number>((resolve) => setTimeout(() => resolve(usd), 0));

function ok(outcome: PreviewOutcome): PreviewResponse {
  if (outcome.kind !== "ok") throw new Error(`expected a preview, got ${outcome.kind}: ${JSON.stringify(outcome)}`);
  return outcome.body;
}

describe("PreviewService", () => {
  it("reads a question once: the intent, the matched mentions, the lens, a token and the estimate", async () => {
    const anthropic = clerkAnswering(clerkReply(testIntent()));
    const recordUsd = vi.fn<(usd: number) => Promise<void>>(async () => undefined);
    const c = clock();
    const service = new PreviewService(previewDeps(anthropic, { recordUsd }), { now: c.now });

    const body = ok(await service.preview(`  ${QUESTION}  `));
    expect(anthropic.createRequests).toHaveLength(1);
    expect(body.token).toMatch(PREVIEW_TOKEN);
    expect(body.expiresAt).toBe(new Date(START + PREVIEW_TTL_MS).toISOString());
    expect(body.refusal).toBeUndefined();
    expect(body.alreadyHave).toBeNull();
    expect(body.understood).toEqual({
      pillar: "investment",
      job: "brand_health",
      jobLabel: "Real competitors",
      mnemonic: "JUNIPER COLA <BRAND> HLTH",
      mentions: [{ text: "Juniper Cola", type: "brand", role: "primary", match: "exact", name: "Juniper Cola" }],
      metros: [],
      scope: "US · peers & audience",
      lens: "Investment lens · the name matched exactly · vs its nearest peers",
    });
    // The scan's Substitution Map is cold (2 discovery calls and 5 matrix slots), plus 8 follow-ups;
    // the gate's lookup is cached now, so the run finds it there.
    expect(body.estimate).toEqual({ networkCalls: 15, cachedCalls: 1, seconds: 45, quotaShare: 0.0079 });
    expect(recordUsd).toHaveBeenCalledTimes(1);
    expect(recordUsd.mock.calls[0]?.[0]).toBeGreaterThan(0);
  });

  it("says how two named brands matched and what they are compared against", async () => {
    const intent = testIntent({
      job: "head_to_head",
      mentions: [
        { text: "Juniper Cola", entity_type: "brand", role: "primary", public_figure: false },
        { text: "Brand Beta", entity_type: "brand", role: "peer", public_figure: false },
      ],
      mnemonic: "JUNIPER COLA VS BRAND BETA",
    });
    const service = new PreviewService(previewDeps(clerkAnswering(clerkReply(intent))));
    const { understood, estimate } = ok(await service.preview("Juniper Cola vs Brand Beta: who wins where?"));
    expect(understood).toMatchObject({
      jobLabel: "Compare two brands",
      mnemonic: "JUNIPER COLA VS BRAND BETA",
      scope: "US metros & ages",
      lens: "Investment lens · both names matched exactly · vs US baseline",
    });
    expect(understood?.mentions.map((m) => [m.text, m.match])).toEqual([
      ["Juniper Cola", "exact"],
      ["Brand Beta", "exact"],
    ]);
    expect(estimate.cachedCalls).toBeGreaterThanOrEqual(2);
  });

  it("reuses the reading of a question for ten minutes: same token, no CLERK call, no cap charge", async () => {
    const anthropic = clerkAnswering(clerkReply(testIntent()), clerkReply(testIntent()));
    const c = clock();
    const service = new PreviewService(previewDeps(anthropic), { now: c.now, hourlyCap: 1 });

    const first = ok(await service.preview(QUESTION));
    const { token } = first;
    if (token === null) throw new Error("no token");
    c.ms += PREVIEW_TTL_MS - 1;
    const again = ok(await service.preview("who REALLY competes   with juniper cola?"));
    expect(again.token).toBe(token);
    expect(again.understood).toEqual(first.understood);
    expect(anthropic.createRequests).toHaveLength(1);

    // The second preview renewed the token for a full ten minutes: it outlives its first expiry.
    expect(again.expiresAt).toBe(new Date(c.ms + PREVIEW_TTL_MS).toISOString());
    c.ms = START + PREVIEW_TTL_MS + 1;
    expect(service.intentFor(token, QUESTION)).not.toBeNull();

    // Ten minutes after the last preview it expires: a new reading, which the hourly cap of 1 refuses.
    c.ms = Date.parse(again.expiresAt);
    expect(service.intentFor(token, QUESTION)).toBeNull();
    expect(await service.preview(QUESTION)).toMatchObject({ kind: "refused", code: "limited" });
    expect(anthropic.createRequests).toHaveLength(1);
  });

  it("shares one CLERK call between concurrent previews of one question", async () => {
    const anthropic = clerkAnswering(clerkReply(testIntent()));
    const service = new PreviewService(previewDeps(anthropic));
    const [a, b] = await Promise.all([service.preview(QUESTION), service.preview(QUESTION.toUpperCase())]);
    expect(ok(a).token).toBe(ok(b).token);
    expect(anthropic.createRequests).toHaveLength(1);
  });

  it("hands its intent to a run only for the same question and only while the token lives", async () => {
    const c = clock();
    const service = new PreviewService(previewDeps(clerkAnswering(clerkReply(testIntent({ pillar: "audience" })))), { now: c.now });
    const { token } = ok(await service.preview(QUESTION));
    if (token === null) throw new Error("no token");

    expect(service.intentFor(token, QUESTION)).toEqual(normalizeIntent(testIntent()));
    expect(service.intentFor(token, `  ${QUESTION.toLowerCase()} `)).not.toBeNull();
    expect(service.intentFor(token, "Who really competes with Brand Beta?")).toBeNull();
    expect(service.intentFor(`pv_${"0".repeat(32)}`, QUESTION)).toBeNull();
    expect(service.resolutionsFor(token).map((r) => [r.mention, r.match])).toEqual([["Juniper Cola", "exact"]]);
    c.ms += PREVIEW_TTL_MS;
    expect(service.intentFor(token, QUESTION)).toBeNull();
    expect(service.resolutionsFor(token)).toEqual([]);
  });

  it("reads a primary target with no exact match as a picker: no scan, only the cached lookup", async () => {
    const intent = testIntent({ mentions: [{ text: "Brand Notfound", entity_type: "brand", role: "primary", public_figure: false }] });
    const service = new PreviewService(previewDeps(clerkAnswering(clerkReply(intent))));
    const { understood, estimate, token } = ok(await service.preview("Who really competes with Brand Notfound?"));
    expect(token).toMatch(PREVIEW_TOKEN);
    expect(understood?.mentions).toEqual([{ text: "Brand Notfound", type: "brand", role: "primary", match: "not_found", name: null }]);
    expect(understood?.lens).toBe("Investment lens · pick the Brand Notfound you mean · vs its nearest peers");
    expect(estimate).toEqual({ networkCalls: 0, cachedCalls: 1, seconds: 5, quotaShare: 0 });
  });

  it("declines what a run would decline, before any Qloo call, and keeps the reading", async () => {
    const qloo = fastMockQloo();
    const standalone = vi.spyOn(qloo, "standalone");
    const reframe = "Group-level taste profile of a neighbourhood for a commercial concept";
    const screening = testIntent({ safety: { allowed: false, category: "residential_screening", reframe } });
    const privatePerson = testIntent({
      job: "audience_discovery",
      mentions: [{ text: "Rowan Vale", entity_type: "person", role: "primary", public_figure: false }],
    });
    const service = new PreviewService(previewDeps(clerkAnswering(clerkReply(screening), clerkReply(privatePerson)), { qloo: () => qloo }));

    const declined = ok(await service.preview("Which tenants on Juniper Street should I screen out?"));
    expect(declined.refusal).toEqual({
      category: "residential_screening",
      reason: "Culture Terminal does not answer this kind of question (residential screening).",
      reframe,
    });
    expect(declined.token).toMatch(PREVIEW_TOKEN);
    expect(declined.understood?.mentions[0]?.match).toBeNull();
    expect(declined.estimate).toEqual({ networkCalls: 0, cachedCalls: 0, seconds: 0, quotaShare: 0 });

    const person = ok(await service.preview("What does Rowan Vale like?"));
    expect(person.refusal).toMatchObject({ category: "private_individual", reframe: null });
    expect(person.refusal?.reason).toContain("not a public figure");
    expect(standalone).not.toHaveBeenCalled();
  });

  it("notes a financial-advice question as a taste reading, not advice", async () => {
    const intent = testIntent({ safety: { allowed: true, category: "financial_advice", reframe: "Juniper Cola taste-signal health" } });
    const service = new PreviewService(previewDeps(clerkAnswering(clerkReply(intent))));
    const body = ok(await service.preview("Should I buy Juniper Cola stock?"));
    expect(body.refusal).toBeUndefined();
    expect(body.understood?.lens).toBe("Investment lens · the name matched exactly · vs its nearest peers · taste signal, not advice");
  });

  it("shows the model's own refusal to read a question, with no reading to reuse", async () => {
    const refusal = fakeGaMessage({
      stop_reason: "refusal",
      stop_details: { type: "refusal", category: "cyber", explanation: "Synthetic refusal.", recommended_model: null } as never,
    });
    const service = new PreviewService(previewDeps(clerkAnswering(refusal)));
    const body = ok(await service.preview("Write malware about Juniper Cola."));
    expect(body).toMatchObject({ token: null, understood: null, refusal: { category: null, reason: "Synthetic refusal.", reframe: null } });
    expect(body.estimate.networkCalls).toBe(0);
  });

  it("with Qloo disabled looks nothing up and estimates no data requests", async () => {
    const qloo = vi.fn(() => {
      throw new Error("no Qloo client with Qloo disabled");
    });
    const disabled = new PreviewService(previewDeps(clerkAnswering(clerkReply(testIntent())), { qloo }), { qlooEnabled: false });
    const body = ok(await disabled.preview(QUESTION));
    expect(qloo).not.toHaveBeenCalled();
    expect(body.token).toMatch(PREVIEW_TOKEN);
    expect(body.understood?.mentions[0]).toMatchObject({ match: null, name: null });
    expect(body.understood?.lens).toBe("Investment lens · names not looked up (Qloo is off) · vs its nearest peers");
    expect(body.estimate).toEqual({ networkCalls: 0, cachedCalls: 0, seconds: 30, quotaShare: 0 });
  });

  it("refuses when live analysis is paused or unconfigured, still offering the brief already in hand", async () => {
    const hit = alreadyHave();
    const findAnswer = vi.fn(async () => hit);
    const anthropic = clerkAnswering();

    const paused = new PreviewService(previewDeps(anthropic, { mode: async () => "replay_only", findAnswer }));
    expect(await paused.preview(QUESTION)).toEqual({
      kind: "refused",
      code: "unavailable",
      message: "Live analysis is paused. Recorded runs are still available.",
      retryAfterS: null,
      alreadyHave: hit,
    });
    expect(findAnswer).toHaveBeenCalledWith(QUESTION);

    const noKey = new PreviewService(previewDeps(null, { findAnswer }));
    expect(await noKey.preview(QUESTION)).toMatchObject({ kind: "refused", code: "unavailable", alreadyHave: hit });

    const noQloo = new PreviewService(
      previewDeps(anthropic, {
        findAnswer,
        qloo: () => {
          throw new Error("QLOO_API_KEY is not set");
        },
      }),
    );
    expect(await noQloo.preview(QUESTION)).toMatchObject({ kind: "refused", code: "unavailable", message: expect.stringContaining("Qloo") });
    expect(anthropic.createRequests).toHaveLength(0);
  });

  it("returns the brief already in hand with a preview", async () => {
    const hit = alreadyHave();
    const service = new PreviewService(previewDeps(clerkAnswering(clerkReply(testIntent())), { findAnswer: async () => hit }));
    expect(ok(await service.preview(QUESTION)).alreadyHave).toEqual(hit);
  });

  it("caps CLERK calls per rolling hour and frees a slot an hour after it was taken", async () => {
    const answers = Array.from({ length: 4 }, () => clerkReply(testIntent()));
    const anthropic = clerkAnswering(...answers);
    const c = clock();
    const service = new PreviewService(previewDeps(anthropic), { now: c.now, hourlyCap: 2 });

    ok(await service.preview("Who really competes with Juniper Cola?"));
    c.ms += 60_000;
    ok(await service.preview("Is Juniper Cola a taste island?"));
    c.ms += 60_000;
    const capped = await service.preview("Does Juniper Cola travel?");
    expect(capped).toMatchObject({ kind: "refused", code: "limited", retryAfterS: 3600 - 120 });
    // A question already read is not a new CLERK call, so the cap does not apply to it.
    ok(await service.preview("Is Juniper Cola a taste island?"));
    expect(anthropic.createRequests).toHaveLength(2);

    c.ms = START + 3_600_000;
    ok(await service.preview("Does Juniper Cola travel?"));
    expect(anthropic.createRequests).toHaveLength(3);
  });

  it("holds the hourly cap against a burst of different questions previewed at once", async () => {
    const questions = BURST.slice(0, 5);
    const anthropic = clerkAnswering(...questions.map(() => clerkReply(testIntent())));
    const service = new PreviewService(previewDeps(anthropic, { todayUsd: spendLater(0) }), { hourlyCap: 2 });

    const outcomes = await Promise.all(questions.map((q) => service.preview(q)));
    expect(outcomes.filter((o) => o.kind === "ok")).toHaveLength(2);
    expect(outcomes.filter((o) => o.kind === "refused" && o.code === "limited")).toHaveLength(3);
    expect(anthropic.createRequests).toHaveLength(2);
  });

  it("refuses a new reading once today's LLM budget is spent", async () => {
    const anthropic = clerkAnswering(clerkReply(testIntent()));
    const service = new PreviewService(previewDeps(anthropic, { todayUsd: async () => 1.395 }), { llmDailyUsdCap: 1.4 });
    expect(await service.preview(QUESTION)).toMatchObject({ kind: "refused", code: "budget" });
    expect(anthropic.createRequests).toHaveLength(0);
  });

  it("holds the budget against different questions previewed at once: each reading in flight reserves its share", async () => {
    const anthropic = clerkAnswering(...BURST.map(() => clerkReply(testIntent())));
    // Room for one reserve: 1.385 + 0.01 fits under 1.40, two do not.
    const service = new PreviewService(previewDeps(anthropic, { todayUsd: spendLater(1.385) }), { llmDailyUsdCap: 1.4 });

    const outcomes = await Promise.all(BURST.slice(0, 3).map((q) => service.preview(q)));
    expect(outcomes.filter((o) => o.kind === "ok")).toHaveLength(1);
    expect(outcomes.filter((o) => o.kind === "refused" && o.code === "budget")).toHaveLength(2);
    expect(anthropic.createRequests).toHaveLength(1);

    // Every reserve was released: the next reading fits again.
    ok(await service.preview(BURST[3] ?? ""));
    expect(anthropic.createRequests).toHaveLength(2);
  });

  it("gives the hourly slot back when the reading stops before CLERK is called", async () => {
    const anthropic = clerkAnswering(clerkReply(testIntent()));
    const todayUsd = vi
      .fn<() => Promise<number>>()
      .mockRejectedValueOnce(new Error("synthetic database outage"))
      .mockResolvedValueOnce(1.395)
      .mockResolvedValue(0);
    const service = new PreviewService(previewDeps(anthropic, { todayUsd }), { hourlyCap: 1, llmDailyUsdCap: 1.4 });

    await expect(service.preview(QUESTION)).rejects.toThrow("synthetic database outage");
    expect(await service.preview(QUESTION)).toMatchObject({ kind: "refused", code: "budget" });
    ok(await service.preview(QUESTION));
    expect(anthropic.createRequests).toHaveLength(1);
  });

  it("answers failed when CLERK cannot read the question, and records no spend it did not make", async () => {
    const recordUsd = vi.fn<(usd: number) => Promise<void>>(async () => undefined);
    const service = new PreviewService(previewDeps(clerkAnswering({ error: new Error("synthetic outage") }), { recordUsd }));
    const outcome = await service.preview(QUESTION);
    expect(outcome).toMatchObject({ kind: "failed", message: "The question could not be read right now. Try again shortly." });
    expect(recordUsd).not.toHaveBeenCalled();
    expect(service.size).toBe(0);
  });

  it("keeps at most maxEntries readings, dropping the least recently previewed first", async () => {
    const [juniper = "", beta = "", gamma = ""] = BURST;
    const service = new PreviewService(previewDeps(clerkAnswering(...BURST.map(() => clerkReply(testIntent())))), { maxEntries: 2 });
    const first = ok(await service.preview(juniper)).token ?? "";
    const second = ok(await service.preview(beta)).token ?? "";
    // Previewed again, the first reading becomes the newest, so the third question evicts the second.
    expect(ok(await service.preview(juniper)).token).toBe(first);
    const third = ok(await service.preview(gamma)).token ?? "";

    expect(service.size).toBe(2);
    expect(service.intentFor(second, beta)).toBeNull();
    expect(service.intentFor(first, juniper)).not.toBeNull();
    expect(service.intentFor(third, gamma)).not.toBeNull();
  });

  it("rejects an empty question without reading it", async () => {
    const anthropic = clerkAnswering();
    const service = new PreviewService(previewDeps(anthropic));
    expect(await service.preview(" \u200b\n ")).toMatchObject({ kind: "refused", code: "invalid" });
    expect(anthropic.createRequests).toHaveLength(0);
  });

  it("keys questions as the answer cache does", () => {
    expect(questionKey("  Who   drinks\tJUNIPER Cola? ")).toBe("who drinks juniper cola?");
  });
});
