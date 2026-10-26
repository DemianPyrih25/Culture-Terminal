// /trust: every safe-use rule with where it comes from (the kit or us), every safety category with its
// example and the reframe offered, every audience family of the Qloo client's allowlist (imported from
// @ct/qloo, never copied), data handling, and the model and cost guards read from the code and the
// server's configuration, lane by lane as the breakers compute them. Invented names only.
import { DEFAULT_RUN_LIMITS, Lane, SafetyCategory } from "@ct/contracts";
import { AUDIENCE_ALLOWLIST, LANE_SHARE } from "@ct/qloo";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { decode } from "../figures/markup";

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ push: vi.fn() }),
}));

const { default: TrustPage, dynamic } = await import("../../app/trust/page");
const { dailyBudget, spendPolicy, trustFacts } = await import("../../app/trust/facts");
const { TrustView, audienceLabel, familyLabel } = await import("../../components/trust/trust-view");
const { REFUSAL_ORDER, REFUSALS, SAFE_USE, SAFE_USE_INTRO, SAFE_USE_SOURCE_LABEL, TRUST_SECTION_ORDER } = await import("../../content/trust");
const { laneBudget } = await import("../../server/breakers");
const { spendPolicyFromEnv } = await import("../../server/container");
const { PRE_RUN_ECONOMY_USD, PRE_RUN_USD } = await import("../../server/llm-spend");
const { SAFETY_LABEL } = await import("../../lib/brief/format");

const html = renderToStaticMarkup(<TrustPage />);
const text = decode(html);

/** One element's markup, from its opening tag with `attr` to the end of its row or item. */
function block(markup: string, attr: string, end: string): string {
  const start = markup.indexOf(attr);
  if (start < 0) throw new Error(`no ${attr}`);
  return markup.slice(start, markup.indexOf(end, start));
}

describe("the /trust page", () => {
  it("renders every section, rendered per request, and links back to /method", () => {
    expect(dynamic).toBe("force-dynamic");
    expect(html).toMatch(/<h1[^>]*>What we will not do<\/h1>/);
    for (const id of TRUST_SECTION_ORDER) expect(html).toContain(`<section id="${id}"`);
    expect(html).toContain('href="/method"');
    // Trust is not a top-bar section: nothing is marked current.
    expect(html).not.toContain('aria-current="page"');
  });

  it("maps every safe-use rule to its mechanism", () => {
    for (const rule of SAFE_USE) {
      expect(html).toContain(`data-safe-use="${rule.id}"`);
      expect(text).toContain(rule.rule);
      expect(text).toContain(rule.enforced);
    }
  });

  it("says where each rule comes from, and credits the kit only with what it is known to say", () => {
    // Until the kit's own SAFE_USE list is checked in, the page claims no completeness against it.
    expect(SAFE_USE_INTRO).toContain("the rules we add to it");
    expect(text).not.toContain("Each of its rules");
    for (const rule of SAFE_USE) {
      const row = decode(block(html, `data-safe-use="${rule.id}"`, "</li>"));
      expect(row).toContain(`data-source="${rule.source}"`);
      if (rule.source === "kit") {
        expect(rule.basis, rule.id).toBeTruthy();
        expect(row).toContain(`${SAFE_USE_SOURCE_LABEL.kit} · ${rule.basis}`);
      } else {
        expect(row).toContain(`>${SAFE_USE_SOURCE_LABEL.ours}<`);
      }
    }
    // Our own product rules are never presented as the kit's.
    for (const id of ["group-level", "sensitive", "politics", "eligibility", "screening", "advice"]) {
      expect(SAFE_USE.find((r) => r.id === id)?.source, id).toBe("ours");
    }
  });

  it("lists every safety category with an example question and the reframe offered", () => {
    expect([...REFUSAL_ORDER].sort()).toEqual([...SafetyCategory.options].sort());
    for (const category of SafetyCategory.options) {
      const item = decode(block(html, `data-refusal="${category}"`, "</li>"));
      expect(item).toContain(SAFETY_LABEL[category]);
      expect(item).toContain(REFUSALS[category].example);
      expect(item).toContain(REFUSALS[category].reframe ?? "No reframe");
      expect(item).toContain(category === "financial_advice" ? "Answered, reframed" : "Refused");
    }
    // In the clerk's precedence: injection first, financial advice last.
    expect(html.indexOf('data-refusal="injection"')).toBeLessThan(html.indexOf('data-refusal="political_targeting"'));
    expect(html.indexOf('data-refusal="out_of_scope"')).toBeLessThan(html.indexOf('data-refusal="financial_advice"'));
  });

  it("lists every audience family the Qloo client allows per desk, and every denied one", () => {
    for (const [desk, families] of Object.entries(AUDIENCE_ALLOWLIST.desks)) {
      const row = block(html, `data-desk="${desk}"`, "</tr>");
      for (const family of families) {
        expect(row).toContain(`data-family="${family}"`);
        expect(decode(row)).toContain(familyLabel(family));
      }
    }
    for (const family of AUDIENCE_ALLOWLIST.denied.families) {
      expect(html).toContain(`data-denied-family="${family}"`);
      expect(text).toContain(familyLabel(family));
    }
    for (const urn of AUDIENCE_ALLOWLIST.denied.audiences) {
      expect(html).toContain(`data-denied-audience="${urn}"`);
      expect(text).toContain(audienceLabel(urn));
    }
  });

  it("states the models and the guards the code and the server enforce", () => {
    expect(text).toContain("Haiku 5.5");
    expect(text).toContain("Sonnet 5.5");
    expect(text).toContain(`At most ${DEFAULT_RUN_LIMITS.qlooCalls} new requests`);
    expect(text).toContain(`a hard stop at $${DEFAULT_RUN_LIMITS.usdHard.toFixed(2)}`);
    const env = { LLM_DAILY_USD_CAP: "2", QLOO_DAILY_FRESH_CAP: "1200" } as unknown as NodeJS.ProcessEnv;
    const guards = decode(renderToStaticMarkup(<TrustView {...trustFacts(env)} />));
    expect(guards).toContain("$2.00 a day across all briefs");
    expect(guards).toContain("40% of it is held for the judge lane");
    expect(guards).toContain("At most 1,200 fresh Qloo requests a day: 720 for public briefs, 480 for the judge lane.");
  });

  it("prints each lane's thresholds as the breakers compute them, and both pre-run reserves", () => {
    const env = { LLM_DAILY_USD_CAP: "2", LLM_ECONOMY_USD: "1.2", LLM_JUDGE_SHARE: "0.25" } as unknown as NodeJS.ProcessEnv;
    // The same policy the server's mode service runs on.
    expect(spendPolicy(env)).toEqual(spendPolicyFromEnv(env));
    const daily = dailyBudget(env);
    const usd = (n: number) => `$${n.toFixed(2)}`;
    for (const lane of Lane.options) expect(daily.lanes[lane]).toEqual(laneBudget(lane, spendPolicy(env)));
    expect(daily.preRunUsd).toEqual({ live: PRE_RUN_USD, economy: PRE_RUN_ECONOMY_USD });
    expect(daily.qloo.lanes.public).toBe(Math.floor(daily.qloo.dailyFresh * LANE_SHARE.public));
    const guards = decode(renderToStaticMarkup(<TrustView {...trustFacts(env)} />));
    const { public: pub, judge } = daily.lanes;
    expect(guards).toContain(`Sonnet 5.5 until today's spend reaches ${usd(pub.economyAt)}, then Haiku 5.5 until ${usd(pub.replayAt)}`);
    expect(guards).toContain(`Sonnet 5.5 until today's spend reaches ${usd(judge.economyAt)}, then Haiku 5.5 until ${usd(judge.replayAt)}`);
    expect(guards).toContain(`A brief holds ${usd(PRE_RUN_USD)} of today's budget before it starts (${usd(PRE_RUN_ECONOMY_USD)} on Haiku 5.5)`);
    expect(guards).toContain(`its lane's cap: ${usd(pub.cap)} public, ${usd(judge.cap)} judge`);
    expect(guards).toContain("25% of it is held for the judge lane");
    // Public briefs step down first: economy before the judge lane, and a lower cap.
    expect(pub.economyAt).toBeLessThan(judge.economyAt);
    expect(pub.cap).toBeLessThan(judge.cap);
  });

  it("words audience keys for readers", () => {
    expect(familyLabel("hobbies_and_interests")).toBe("Hobbies and interests");
    expect(familyLabel("lifestyle_preferences_beliefs")).toBe("Lifestyle preferences and beliefs");
    expect(audienceLabel("urn:audience:leisure:night_owls")).toBe("Night owls (leisure)");
  });
});
