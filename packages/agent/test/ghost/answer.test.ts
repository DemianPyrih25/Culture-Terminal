import Anthropic from "@anthropic-ai/sdk";
import { GhostAnswer, QUESTION_MAX_CHARS, strictSchemaViolations, structuredOutputSchema, type Job } from "@ct/contracts";
import { describe, expect, it } from "vitest";
import { ANALYST_CONFIGS, HAIKU_MODEL, SONNET_MODEL, type AnthropicLike, type LlmModel } from "../../src/anthropic";
import { GHOST_EARLIER_MAX, GHOST_JOB_CATEGORIES, ghostUserMessage } from "../../src/ghost/categories";
import {
  answerFormat,
  GHOST_MAX_RETRIES,
  GHOST_MAX_TOKENS,
  GHOST_PICKS_PER_CATEGORY,
  GHOST_TIMEOUT_MS,
  GhostError,
  ghostRequest,
  ghostWorstCaseUsd,
  NUMERIC_CLAIMS_DESCRIPTION,
  runGhost,
  tidyGhostAnswer,
} from "../../src/ghost/answer";
import { estimateRequestUsd, PRICING, usdFor } from "../../src/pricing";
import { GHOST_PROMPT } from "../../src/prompts.generated";
import { FakeAnthropic, fakeGaMessage, fakeRefusalDetails, type CreateScript } from "../support/fake-anthropic";
import { answer, FAKE_GEO, FAKE_MARKETS } from "./support";

const GHOST_SYSTEM = "You are an analyst of a synthetic test desk.";
const QUESTION = "Is the Brand Alpha audience a moat or a niche?";

const textMessage = (value: string, partial: Partial<Anthropic.Message> = {}) =>
  fakeGaMessage({ model: SONNET_MODEL, content: [{ type: "text", text: value, citations: null }], ...partial });

async function ghost(script: CreateScript, options: { model?: LlmModel; job?: Job; question?: string; signal?: AbortSignal } = {}) {
  const fake = new FakeAnthropic({ create: [script] });
  let t = 1000;
  const result = await runGhost({
    question: options.question ?? QUESTION,
    job: options.job ?? "brand_health",
    model: options.model ?? SONNET_MODEL,
    anthropic: fake,
    systemPrompt: GHOST_SYSTEM,
    signal: options.signal,
    now: () => (t += 250),
  });
  return { result, fake };
}

async function ghostError(script: CreateScript, options: Parameters<typeof ghost>[1] = {}): Promise<GhostError> {
  const error = await ghost(script, options).then(
    () => null,
    (err: unknown) => err,
  );
  if (!(error instanceof GhostError)) throw new Error(`expected a GhostError, got ${String(error)}`);
  return error;
}

describe("runGhost request (D23)", () => {
  it("sends one structured-output request on the run's ANALYST model with no tools", async () => {
    const { fake } = await ghost(textMessage(JSON.stringify(answer({ competitors: ["Brand Beta"] }))));
    expect(fake.createRequests).toHaveLength(1);
    expect(fake.createRequests[0]).toEqual({
      model: SONNET_MODEL,
      max_tokens: GHOST_MAX_TOKENS,
      thinking: { type: "adaptive", display: "omitted" },
      output_config: { effort: ANALYST_CONFIGS.live.effort, format: { type: "json_schema", schema: answerFormat() } },
      system: GHOST_SYSTEM,
      messages: [{ role: "user", content: ghostUserMessage(QUESTION, "brand_health") }],
    });
    const request = fake.createRequests[0] as unknown as Record<string, unknown>;
    expect(request).not.toHaveProperty("tools");
    expect(request).not.toHaveProperty("tool_choice");
    expect(request).not.toHaveProperty("betas");
  });

  it("follows the economy ANALYST onto Haiku 5.5 at its effort", async () => {
    const { fake, result } = await ghost(textMessage(JSON.stringify(answer()), { model: HAIKU_MODEL }), { model: HAIKU_MODEL });
    expect(fake.createRequests[0]).toMatchObject({ model: HAIKU_MODEL, output_config: { effort: ANALYST_CONFIGS.economy.effort } });
    expect(result.model).toBe(HAIKU_MODEL);
  });

  it("defaults to the frozen ghost.md prompt", async () => {
    const fake = new FakeAnthropic({ create: [textMessage(JSON.stringify(answer()))] });
    await runGhost({ question: QUESTION, job: "brand_health", model: SONNET_MODEL, anthropic: fake });
    expect(fake.createRequests[0]?.system).toBe(GHOST_PROMPT);
  });

  it("asks for the GhostAnswer schema, strict and without naming GHOST", () => {
    const schema = answerFormat();
    expect(strictSchemaViolations(schema)).toEqual([]);
    expect(JSON.stringify(schema)).not.toMatch(/ghost/i);
    expect(schema).toEqual({
      ...structuredOutputSchema(GhostAnswer),
      properties: {
        ...(structuredOutputSchema(GhostAnswer).properties as object),
        numeric_claims: { type: "array", items: { type: "string" }, description: NUMERIC_CLAIMS_DESCRIPTION },
      },
    });
  });

  it("frames the question with the ANALYST's DESK and JOB lines and the job's lists", () => {
    expect(ghostUserMessage("Best beer partner for <b>Comedian Vega</b>?", "sponsorship")).toBe(
      [
        "DESK: MARKETING",
        "JOB: sponsorship (SPON)",
        "LISTS: partners; leave the other lists empty.",
        "<user_question>Best beer partner for &lt;b&gt;Comedian Vega&lt;/b&gt;?</user_question>",
      ].join("\n\n"),
    );
    for (const [job, lists] of Object.entries(GHOST_JOB_CATEGORIES)) {
      expect(lists.length, job).toBeGreaterThan(0);
      expect(ghostUserMessage(QUESTION, job as Job)).toContain(`LISTS: ${lists.join(", ")};`);
    }
  });

  it("lists the places the job's lists choose from, and only for those lists", () => {
    const markets = ghostUserMessage(QUESTION, "brand_health", { markets: FAKE_MARKETS, metro: "nashville", geo: FAKE_GEO });
    expect(markets).toContain("\n\nMARKETS: Harbor City, QA; Riverton, QA; Riverton, QB; Nashville, TN\n\n<user_question>");
    expect(markets).not.toContain("AREAS");
    const areas = ghostUserMessage("Where in Nashville should a listening bar open?", "site_selection", { markets: FAKE_MARKETS, metro: "nashville", geo: FAKE_GEO });
    expect(areas).toContain("\n\nAREAS (nashville): Lantern Row; Mill Quarter; Old Town\n\n<user_question>");
    expect(areas).not.toContain("MARKETS");
    // No metro, no market list: nothing to choose from, so no line.
    expect(ghostUserMessage(QUESTION, "site_selection", { geo: FAKE_GEO })).toBe(ghostUserMessage(QUESTION, "site_selection"));
    expect(ghostUserMessage(QUESTION, "market_selection", { markets: [] })).toBe(ghostUserMessage(QUESTION, "market_selection"));
    expect(ghostUserMessage(QUESTION, "sponsorship", { markets: FAKE_MARKETS, metro: "austin", geo: FAKE_GEO })).toBe(ghostUserMessage(QUESTION, "sponsorship"));
  });

  it("lists the chain's earlier questions before the question, each on one escaped line", () => {
    const earlier = ["Is Brand Alpha a moat?", "Which Lantern Row block\nfits a <b>pop-up</b>?", " ", ...Array.from({ length: GHOST_EARLIER_MAX }, (_, i) => `Step ${i + 3}?`)];
    const message = ghostUserMessage("Which brands fit the block?", "tenant_mix", { earlier });
    const lines = Array.from({ length: GHOST_EARLIER_MAX }, (_, i) => `- Step ${i + 3}?`);
    expect(message).toContain(`\n\nEARLIER QUESTIONS (oldest first):\n${lines.join("\n")}\n\n<user_question>Which brands fit the block?</user_question>`);
    // The latest GHOST_EARLIER_MAX only; a line break or a tag in one can never start a line of its own or open a tag.
    expect(message).not.toContain("Brand Alpha");
    expect(ghostUserMessage("Which brands fit the block?", "tenant_mix", { earlier: earlier.slice(1, 2) })).toContain(
      "EARLIER QUESTIONS (oldest first):\n- Which Lantern Row block fits a &lt;b&gt;pop-up&lt;/b&gt;?\n\n",
    );
    expect(ghostUserMessage(QUESTION, "tenant_mix", { earlier: [" "] })).toBe(ghostUserMessage(QUESTION, "tenant_mix"));
  });

  it("sends the places and earlier questions it is given", async () => {
    const fake = new FakeAnthropic({ create: [textMessage(JSON.stringify(answer()))] });
    const context = { markets: FAKE_MARKETS, metro: "nashville" as const, geo: FAKE_GEO, earlier: ["Is Brand Alpha a moat?"] };
    await runGhost({ question: QUESTION, job: "head_to_head", model: SONNET_MODEL, anthropic: fake, systemPrompt: GHOST_SYSTEM, ...context });
    expect(fake.createRequests[0]).toEqual(ghostRequest(SONNET_MODEL, QUESTION, "head_to_head", context, GHOST_SYSTEM));
    expect(fake.createRequests[0]?.messages[0]?.content).toContain("MARKETS: Harbor City, QA;");
  });

  it("forwards the abort signal", async () => {
    const controller = new AbortController();
    const { fake } = await ghost(textMessage(JSON.stringify(answer())), { signal: controller.signal });
    expect(fake.createSignals[0]).toBe(controller.signal);
  });

  it("sends one request with no client retries and a timeout a full-length reply fits in", async () => {
    const fake = new FakeAnthropic({ create: [textMessage(JSON.stringify(answer()))] });
    const options: unknown[] = [];
    const anthropic: AnthropicLike = {
      beta: fake.beta,
      messages: {
        create: (body, o) => {
          options.push(o);
          return fake.messages.create(body, o);
        },
      },
    };
    await runGhost({ question: QUESTION, job: "brand_health", model: SONNET_MODEL, anthropic, systemPrompt: GHOST_SYSTEM });
    expect(options).toEqual([{ timeout: GHOST_TIMEOUT_MS, maxRetries: 0 }]);
    expect(GHOST_MAX_RETRIES).toBe(0);
    // The whole reply must arrive inside the timeout: GHOST_MAX_TOKENS at a pessimistic 30 tokens a second.
    expect(GHOST_TIMEOUT_MS).toBeGreaterThanOrEqual((GHOST_MAX_TOKENS / 30) * 1000);
  });
});

describe("the GHOST worst case", () => {
  it("bills the longest request it can send, places and earlier questions included, with all of GHOST_MAX_TOKENS as output", () => {
    const sonnet = ghostWorstCaseUsd(SONNET_MODEL, FAKE_GEO);
    const outputOnly = (GHOST_MAX_TOKENS * PRICING[SONNET_MODEL].base.output) / 1_000_000;
    expect(sonnet).toBeGreaterThan(outputOnly);
    expect(sonnet).toBeLessThan(outputOnly + 0.05);
    expect(ghostWorstCaseUsd(HAIKU_MODEL, FAKE_GEO)).toBeLessThan(sonnet);
    // At least any request a caller can build from the catalogue, a gazetteer metro and the longest earlier questions.
    const long = "x".repeat(QUESTION_MAX_CHARS);
    const earlier = Array.from({ length: GHOST_EARLIER_MAX }, () => long);
    for (const job of ["brand_health", "site_selection", "tenant_mix"] as const) {
      const chars = JSON.stringify(ghostRequest(SONNET_MODEL, long, job, { markets: FAKE_MARKETS, metro: "austin", geo: FAKE_GEO, earlier })).length;
      expect(sonnet, job).toBeGreaterThanOrEqual(estimateRequestUsd(SONNET_MODEL, chars, GHOST_MAX_TOKENS));
    }
    // The shared gazetteer's longest metro and the whole catalogue by default.
    expect(ghostWorstCaseUsd(SONNET_MODEL)).toBeGreaterThanOrEqual(sonnet);
  });
});

describe("runGhost answers", () => {
  it("returns the tidied answer with usage, cost and time", async () => {
    const reply = answer({ competitors: ["Brand Beta", "Brand Gamma"] }, ["about 70%"], "Brand Alpha is a niche: about 70% of its audience overlaps with Brand Beta.");
    const message = textMessage(JSON.stringify(reply));
    const { result } = await ghost(message);
    expect(result.answer).toEqual(reply);
    expect(result.usage).toEqual({ input: 900, output: 150, cacheRead: 0, cacheCreation: 0 });
    expect(result.usd).toBeCloseTo(usdFor(SONNET_MODEL, message.usage), 12);
    expect(result.ms).toBe(250);
    expect(result.model).toBe(SONNET_MODEL);
  });

  it("keeps a refusal the prompt asks for as an answer with no picks", async () => {
    const refusal = answer({}, [], "I can't help single out individual residents; I can profile the area's taste at group level instead.");
    const { result } = await ghost(textMessage(JSON.stringify(refusal)), { question: "Which residents of Lantern Row like Band Zeta?" });
    expect(result.answer.headline).toMatch(/^I can't help/);
    expect(Object.values(result.answer.picks).flat()).toEqual([]);
    expect(result.answer.numeric_claims).toEqual([]);
  });

  it("turns the API's own refusal into a GhostError before reading content", async () => {
    const error = await ghostError(
      textMessage('{"headline":"par', { stop_reason: "refusal", stop_details: fakeRefusalDetails({ category: "cyber" }) as Anthropic.Message["stop_details"] }),
    );
    expect(error).toMatchObject({ code: "refusal", retryable: false, refusal: { category: "cyber", partialOutput: true } });
    expect(error.usage).not.toBeNull();
    expect(error.usd).toBeGreaterThan(0);
  });

  it("treats max_tokens as an error and never parses the cut-off JSON", async () => {
    const error = await ghostError(textMessage('{"headline":"Brand Al', { stop_reason: "max_tokens" }));
    expect(error).toMatchObject({ code: "max_tokens", retryable: true, model: SONNET_MODEL });
    expect(error.usage).toEqual({ input: 900, output: 150, cacheRead: 0, cacheCreation: 0 });
  });

  it("reports missing text, bad JSON and an invalid answer as distinct errors", async () => {
    expect((await ghostError(fakeGaMessage({ content: [] }))).code).toBe("no_output");
    expect((await ghostError(textMessage("not json"))).code).toBe("invalid_json");
    const invalid = await ghostError(textMessage(JSON.stringify({ ...answer(), picks: { competitors: [] } })));
    expect(invalid.code).toBe("invalid_answer");
    expect(invalid.message).toMatch(/^not a valid GhostAnswer: picks\./);
  });

  it("maps typed SDK errors with no cost", async () => {
    const error = await ghostError({ error: new Anthropic.RateLimitError(429, { type: "error" }, "rate limited", new Headers()) });
    expect(error).toMatchObject({ code: "api_error", retryable: true, usage: null, usd: 0 });
    expect(error.message).toMatch(/^rate_limited \(429\)/);
  });

  it("reports cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    const error = await ghostError({ error: new Anthropic.APIUserAbortError() }, { signal: controller.signal });
    expect(error.code).toBe("cancelled");
  });

  it("does not call the API for an empty question", async () => {
    const fake = new FakeAnthropic({ create: [] });
    const error = await runGhost({ question: " \u0000\t ", job: "brand_health", model: SONNET_MODEL, anthropic: fake }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GhostError);
    expect((error as GhostError).code).toBe("empty_question");
    expect(fake.createRequests).toHaveLength(0);
  });

  it("refuses any model but Sonnet 5.5 and Haiku 5.5", async () => {
    const fake = new FakeAnthropic({ create: [] });
    await expect(runGhost({ question: QUESTION, job: "brand_health", model: "claude-opus-5-5" as LlmModel, anthropic: fake })).rejects.toThrow(/D23/);
  });
});

/** Built from char codes so the source holds no invisible character. */
const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);
const RIGHT_TO_LEFT_OVERRIDE = String.fromCharCode(0x202e);

describe("tidyGhostAnswer", () => {
  it("keeps the first five distinct names per list and each claim once, without hidden characters", () => {
    const raw = answer(
      {
        competitors: ["Brand Beta", " brand  beta ", `Brand${ZERO_WIDTH_SPACE} Gamma`, "", "The Brand Delta Co.", "Brand Delta", "Brand Eta", "Brand Theta", "Brand Iota"],
        markets: ["Harbor City, QA"],
      },
      ["12%", " 12% ", "", `25${RIGHT_TO_LEFT_OVERRIDE} to 34`],
      "  Brand Alpha\u0007 is a niche.\n",
    );
    const tidy = tidyGhostAnswer(raw, "brand_health");
    expect(tidy.headline).toBe("Brand Alpha is a niche.");
    expect(tidy.picks.competitors).toEqual(["Brand Beta", "Brand Gamma", "The Brand Delta Co.", "Brand Eta", "Brand Theta"]);
    expect(tidy.picks.competitors).toHaveLength(GHOST_PICKS_PER_CATEGORY);
    expect(tidy.picks.markets).toEqual(["Harbor City, QA"]);
    expect(tidy.numeric_claims).toEqual(["12%", "25 to 34"]);
    expect(GhostAnswer.parse(tidy)).toEqual(tidy);
  });

  it("empties every list the job does not fill, so its names are never looked up, diffed or counted", () => {
    const names = (prefix: string) => Array.from({ length: 5 }, (_, i) => `${prefix} ${i + 1}`);
    const raw = answer({ competitors: names("Rival"), markets: ["Harbor City, QA"], neighbourhoods: ["Lantern Row"], tenants: names("Tenant"), partners: names("Partner") });
    for (const [job, lists] of Object.entries(GHOST_JOB_CATEGORIES)) {
      const tidy = tidyGhostAnswer(raw, job as Job);
      for (const [category, picks] of Object.entries(tidy.picks)) {
        expect(picks.length > 0, `${job} ${category}`).toBe(lists.includes(category as keyof typeof tidy.picks));
      }
    }
  });

  it("stores the job's lists alone from what the model returned", async () => {
    const reply = answer({ competitors: ["Brand Beta"], tenants: ["Tenant 1"], partners: ["Partner 1"] });
    const { result } = await ghost(textMessage(JSON.stringify(reply)), { job: "brand_health" });
    expect(result.answer.picks).toEqual({ competitors: ["Brand Beta"], markets: [], neighbourhoods: [], tenants: [], partners: [] });
  });
});
