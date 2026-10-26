import Anthropic from "@anthropic-ai/sdk";
import { GhostAnswer, GhostDiff, Report } from "@ct/contracts";
import { describe, expect, it } from "vitest";
import { SONNET_MODEL } from "../../src/anthropic";
import { ghostUserMessage } from "../../src/ghost/categories";
import { buildGhostDiff } from "../../src/ghost/diff";
import { ghostForRun } from "../../src/ghost/forRun";
import { GhostError } from "../../src/ghost/answer";
import { GHOST_MARKETS } from "../../src/ghost/places";
import { usdFor } from "../../src/pricing";
import { FakeAnthropic, fakeGaMessage } from "../support/fake-anthropic";
import { answer, entity, entityIdOf, FAKE_GEO, FAKE_MARKETS, FakeSearch, registryOf, report, subsMap } from "./support";

const QUESTION = "Who does Brand Alpha really compete with?";

function brief() {
  const { registry, ref } = registryOf([["Brand Alpha", 0.5], ["Brand Beta", 0.6], ["Brand Gamma", 0.3]]);
  const datasets = [subsMap("D1", [ref("Brand Alpha"), "Brand Alpha"], [[ref("Brand Beta"), "Brand Beta", 0.8], [ref("Brand Gamma"), "Brand Gamma", 0.5]])];
  return { registry, datasets, report: report("brand_health", datasets, QUESTION) };
}

const reply = (a: GhostAnswer) => fakeGaMessage({ model: SONNET_MODEL, content: [{ type: "text", text: JSON.stringify(a), citations: null }] });

describe("ghostForRun", () => {
  it("answers the report's question, resolves the picks and diffs them against the brief", async () => {
    const { registry, datasets, report: r } = brief();
    const ghost = answer({ competitors: ["Brand Beta", "Brand Omega"] }, ["30%"], "Brand Alpha competes with Brand Beta for 30% of its audience.");
    const message = reply(ghost);
    const anthropic = new FakeAnthropic({ create: [message] });
    const search = new FakeSearch({ "Brand Beta": [entity(entityIdOf("Brand Beta"), "Brand Beta")], "Brand Omega": [entity("ent-omega", "Brand Omega", "urn:entity:brand", { popularity: 0.9 })] });

    const out = await ghostForRun({ report: r, datasets, registry, model: SONNET_MODEL, anthropic, search: search.search, geo: FAKE_GEO });

    // The places the brief can rank: every catalogue market by default.
    expect(anthropic.createRequests[0]?.messages).toEqual([{ role: "user", content: ghostUserMessage(QUESTION, "brand_health", { markets: GHOST_MARKETS }) }]);
    expect(anthropic.createRequests[0]).not.toHaveProperty("tools");
    expect(search.queries()).toEqual(["Brand Beta", "Brand Omega"]);
    expect(out.answer).toEqual(ghost);
    expect(out.model).toBe(SONNET_MODEL);
    expect(out.usd).toBeCloseTo(usdFor(SONNET_MODEL, message.usage), 12);
    expect(out.resolved.map((p) => p.exact)).toEqual([true, true]);
    expect(out.diff).toEqual(buildGhostDiff({ answer: ghost, resolved: out.resolved, report: r, datasets, registry, geo: FAKE_GEO }));
    expect(out.diff.items.map((i) => [i.status, i.name])).toEqual([
      ["both", "Brand Beta"],
      ["qloo_only", "Brand Gamma"],
      ["llm_only", "Brand Omega"],
    ]);
    // What the `ghost` event and Report.ghost carry.
    expect(GhostAnswer.parse(out.answer)).toEqual(out.answer);
    expect(GhostDiff.parse(out.diff)).toEqual(out.diff);
    expect(Report.shape.ghost.parse({ answer: out.answer, diff: out.diff })).toEqual({ answer: out.answer, diff: out.diff });
  });

  it("lets the caller override the question and job", async () => {
    const { registry, datasets, report: r } = brief();
    const anthropic = new FakeAnthropic({ create: [reply(answer())] });
    await ghostForRun({ report: r, datasets, registry, question: "Brand Alpha vs Brand Beta?", job: "head_to_head", model: SONNET_MODEL, anthropic, search: new FakeSearch().search, geo: FAKE_GEO });
    expect(anthropic.createRequests[0]?.messages).toEqual([{ role: "user", content: ghostUserMessage("Brand Alpha vs Brand Beta?", "head_to_head", { markets: GHOST_MARKETS }) }]);
  });

  it("lists the metro's areas and the chain's earlier questions, and matches neighbourhoods in that metro alone", async () => {
    const { registry, datasets } = brief();
    const question = "Which Nashville neighbourhoods fit a listening bar?";
    const earlier = ["Is Brand Alpha a moat?"];
    const anthropic = new FakeAnthropic({ create: [reply(answer({ neighbourhoods: ["Mill Quarter", "Cedar Bend"] }))] });
    const search = new FakeSearch();
    const out = await ghostForRun({
      report: report("site_selection", datasets, question),
      datasets,
      registry,
      markets: FAKE_MARKETS,
      metro: "nashville",
      earlier,
      model: SONNET_MODEL,
      anthropic,
      search: search.search,
      geo: FAKE_GEO,
    });
    const content = ghostUserMessage(question, "site_selection", { markets: FAKE_MARKETS, metro: "nashville", geo: FAKE_GEO, earlier });
    expect(anthropic.createRequests[0]?.messages).toEqual([{ role: "user", content }]);
    expect(content).toContain("AREAS (nashville): Lantern Row; Mill Quarter; Old Town");
    expect(content).toContain("EARLIER QUESTIONS (oldest first):\n- Is Brand Alpha a moat?");
    // Cedar Bend is an Austin area: not the question's city, so it goes to the locality search.
    expect(out.resolved.map((p) => [p.name, p.lookup])).toEqual([
      ["Mill Quarter", "gazetteer"],
      ["Cedar Bend", "search"],
    ]);
    expect(search.queries()).toEqual(["Cedar Bend"]);
  });

  it("searches nothing when the model gives no answer", async () => {
    const { registry, datasets, report: r } = brief();
    const anthropic = new FakeAnthropic({ create: [{ error: new Anthropic.InternalServerError(529, { type: "error" }, "overloaded", new Headers()) }] });
    const search = new FakeSearch();
    const error = await ghostForRun({ report: r, datasets, registry, model: SONNET_MODEL, anthropic, search: search.search, geo: FAKE_GEO }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GhostError);
    expect((error as GhostError).code).toBe("api_error");
    expect(search.calls).toEqual([]);
  });
});
