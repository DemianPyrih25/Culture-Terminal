import { readFileSync } from "node:fs";
import {
  AgeBucket,
  AI_CONTEXT_HEADING,
  approxTokens,
  ArgumentSection,
  Badge,
  compileMnemonic,
  Domain,
  EntityType,
  FindingKind,
  candidateKey,
  Intent,
  Job,
  JOB_MNEMONIC,
  JOB_PILLAR,
  MarketId,
  MAX_OBVIOUS,
  MentionRole,
  MetroId,
  Priority,
  SafetyCategory,
  Signal,
  SponsorCategory,
  ToolName,
  TOOL_MNEMONIC,
  WEB_CONTEXT_HEADING,
} from "@ct/contracts";
import { MIN_BUSY_AREA_VENUES, THIN_SUPPLY_LABEL } from "@ct/quant";
import { describe, expect, it } from "vitest";
import { CLERK_PROMPT, DIRECTOR_PROMPT, PROMPT_HASHES } from "../../src/prompts";
import { PHRASE_RULES } from "../../src/report/phrases";
import { isSkillAvailable } from "../../src/run/catalogue";
import { RUN_CONTEXT_LABELS } from "../../src/run/context";
import { SCAN_TABLE } from "../../src/run/scan";

/** Per CHECKER V4 rule id: a phrase director.md's banned list must carry. */
const V4_PROMPT_PHRASES: Readonly<Record<string, string>> = {
  trade_advice: "buy, sell or short",
  invest_call: '"invest now", "invest in"',
  price_target: "price targets",
  valuation: "undervalued, overvalued, underpriced, overpriced",
  certainty: "guarantee",
  population_share: 'a token or percentage "of" customers',
  causal: '"cause" in any form',
  collapse: "collapse, bankrupt",
  individual: '"this person"',
  poaching: "poaching",
};

/**
 * The plain-word alternations of a rule, e.g. customers|fans|… or drive|drives|…, so a word added
 * to the CHECKER must reach the prompt too. Suffix groups such as caus(?:e|es) and short function
 * words (you, we, in) are skipped.
 */
function ruleVocabulary(re: RegExp): string[] {
  const source = re.source.replace(/\\[a-z]/gi, " "); // escapes such as \b and \s are not letters of a word
  const groups = source.matchAll(/(?<![a-z])\(\?:([a-z]+(?:\|[a-z]+)+)\)/gi);
  return [...groups].flatMap((m) => (m[1] ?? "").split("|")).filter((word) => word.length >= 4);
}

const UUID_SHAPE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
/** The pnpm guard's decimal rule for prompts (D29). */
const LONG_DECIMAL = /(?<![A-Za-z0-9.])\d*\.\d{3,}(?!\.?\d)/;
const ISO_DATE = /\b\d{4}-\d{2}-\d{2}\b/;
const NON_LATIN_LETTER = /[Ѐ-ӿ֐-ۿ぀-ヿ一-鿿]/;

const PROMPTS = { director: DIRECTOR_PROMPT, clerk: CLERK_PROMPT } as const;

describe("frozen prompts", () => {
  it.each(Object.entries(PROMPTS))("%s holds no Qloo ids, long decimals, dates or non-English script", (_, text) => {
    expect(text.length).toBeGreaterThan(1000);
    expect(text).not.toMatch(UUID_SHAPE);
    expect(text).not.toMatch(LONG_DECIMAL);
    expect(text).not.toMatch(ISO_DATE); // dynamic context such as today's date lives in the first user message
    expect(text).not.toMatch(NON_LATIN_LETTER);
    expect(text).not.toMatch(/\bTODO\b|\bFIXME\b/);
  });

  it("exposes a hash per prompt", () => {
    expect(Object.keys(PROMPT_HASHES).sort()).toEqual(["clerk", "director", "ghost"]);
    for (const hash of Object.values(PROMPT_HASHES)) expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("director.md (ANALYST)", () => {
  // PLAN §4.5 planned about 11,000 tokens; the 13 job playbooks, the 19 tools, the public data physics
  // of Parts 9 and 11 and the Part 11 honesty rules (category-level reads, candidates, popular beside
  // hidden, about-level differences, the AI CONTEXT line) take it past that, so the cap is 15,000 (owner:
  // raise caps rather than trim). The prompt is the cached prefix, so the extra tokens cost a cache read
  // per response, not a fresh input.
  it("stays within about six to fifteen thousand tokens", () => {
    const tokens = approxTokens(DIRECTOR_PROMPT);
    expect(tokens).toBeGreaterThanOrEqual(6000);
    expect(tokens).toBeLessThanOrEqual(15000);
  });

  it("has the eleven planned sections in order", () => {
    const headings = [...DIRECTOR_PROMPT.matchAll(/^## (\d+)\. (.+)$/gm)].map((m) => [Number(m[1]), m[2]]);
    expect(headings).toEqual([
      [1, "Role"],
      [2, "Qloo physics"],
      [3, "Public data physics"],
      [4, "Grounding rules"],
      [5, "Skill catalogue"],
      [6, "Opening theory per job"],
      [7, "Hypothesis protocol"],
      [8, "Investigation policy"],
      [9, "Report contract"],
      [10, "Safety"],
      [11, "Untrusted data"],
    ]);
  });

  it("catalogues every tool with its terminal mnemonic", () => {
    for (const name of ToolName.options) {
      expect(DIRECTOR_PROMPT, name).toContain(`**${name}** (${TOOL_MNEMONIC[name]};`);
    }
  });

  it("gives opening theory for every job and a playbook entry for every finding", () => {
    for (const job of Job.options) expect(DIRECTOR_PROMPT, job).toContain(`**${job}** (${JOB_MNEMONIC[job]})`);
    const playbook = DIRECTOR_PROMPT.slice(DIRECTOR_PROMPT.indexOf("**Finding playbook**"));
    for (const kind of FindingKind.options) expect(playbook, kind).toMatch(new RegExp(`^- ${kind}[: ]`, "m"));
  });

  it("uses the contracts vocabulary for signals, sections, priorities and badges", () => {
    for (const v of [...Signal.options, ...ArgumentSection.options, ...Priority.options, ...Badge.options]) {
      expect(DIRECTOR_PROMPT, v).toContain(v);
    }
  });

  it("states the token rules, the untrusted-data wrappers and the run-control codes", () => {
    for (const s of [
      "{{M#}}",
      "[E#]",
      "{{WINDOW}}",
      "<user_question>",
      "<qloo_data>",
      "<public_data>",
      "{{PERIOD:M#}}",
      "trigger_finding_id",
      "not available in this build",
      "INVESTIGATION_BUDGET_EXHAUSTED",
      "UNTRIGGERED_FOLLOWUP",
      "ANALYST PIVOT",
      "CODE FALLBACK",
      "QLOO DATA",
      "OUR READ",
      "**CASE SUMMARY**", // the header buildCaseSummary writes
    ]) {
      expect(DIRECTOR_PROMPT, s).toContain(s);
    }
  });

  /** A job's opening-theory line; taste_twins is a tool too, whose catalogue line reads "(TWIN;" instead. */
  const jobLine = (job: Job): string => DIRECTOR_PROMPT.split("\n").find((l) => l.startsWith(`- **${job}** (${JOB_MNEMONIC[job]}).`)) ?? "";

  it("names every scan skill the build runs in its job's Scan part, and never asks wave 1 to repeat it", () => {
    for (const [job, entries] of Object.entries(SCAN_TABLE)) {
      const line = jobLine(Job.parse(job));
      const [scan = "", rest = ""] = line.split("Wave 1:");
      // Wave 1 ends where Turn 2 begins: a turn-2 pivot may call a scan tool again, on what the scan found.
      const wave1 = rest.split("Turn 2:")[0] ?? "";
      for (const entry of entries.filter((e) => (e.build ?? e.chain) !== undefined && isSkillAvailable(e.tool))) {
        expect(scan, `${job} scan`).toContain(entry.tool);
        expect(wave1, `${job} wave 1`).not.toContain(entry.tool);
      }
    }
  });

  it("gives every job its turn-2 move and names the pivots it usually makes", () => {
    for (const job of Job.options) {
      const line = jobLine(job);
      expect(line, job).toMatch(/Turn 2: /);
      const kinds = FindingKind.options.filter((k) => line.includes(k));
      expect(kinds.length, `${job} pivots`).toBeGreaterThan(0);
    }
  });

  it("asks for next moves that cross desks, name what the desk studies and stay answerable by this build", () => {
    const line = DIRECTOR_PROMPT.split("\n").find((l) => l.startsWith("- next_moves:")) ?? "";
    // The chip prints the desk itself, and a prefix would spend the 40-character label (V9).
    expect(line).toContain("no desk prefix");
    expect(line).not.toMatch(/\b(?:INVESTMENT|LOCATION|MARKETING|AUDIENCE) · /);
    // The words the brief reads a move's desk from (apps/web/lib/brief/next-moves.ts).
    for (const word of ["block", "neighbourhood", "storefront", "markets", "sponsors", "rivals", "peers", "audience", "fans"]) expect(line).toContain(word);
    expect(line).toContain("Ask only what this build answers");
    for (const step of ["brand to audience", "slate to market", "market to block", "block to tenants"]) expect(line).toContain(step);
  });

  it("states CHECKER V10: demographics only where the same part cites a metric that measures them", () => {
    expect(DIRECTOR_PROMPT).toContain(
      "Claim an audience's age, gender or generation only where the same part cites an audience_dna or an age or gender context metric (V10)",
    );
  });

  it("states CHECKER V10 for competitors with geo_lift's supply-label rule", () => {
    expect(DIRECTOR_PROMPT).toContain(`An area whose quadrant reads "${THIN_SUPPLY_LABEL}" has too few counted venues for any supply label`);
    expect(DIRECTOR_PROMPT).toContain(`"crowded" from a lift.supply count needs at least ${MIN_BUSY_AREA_VENUES} venues`);
    expect(DIRECTOR_PROMPT).toContain("A sentence that says the count is unknown, or only a sample, passes.");
  });

  it("keeps wave 1 to refs that exist in turn 1, since the scan runs alongside it", () => {
    expect(DIRECTOR_PROMPT).toContain("The opening scan runs alongside turn 1");
    expect(DIRECTOR_PROMPT).toContain("Wave 1 has only REGISTRY refs");
    expect(DIRECTOR_PROMPT).not.toMatch(/scan has already run/i);
  });

  it("states the loop's turn-2 rule: late planned steps untriggered, every other call cites a finding", () => {
    expect(DIRECTOR_PROMPT).toContain("runs in turn 2 with its step_id and no trigger, once");
    const line = (prefix: string) => DIRECTOR_PROMPT.split("\n").find((l) => l.startsWith(prefix)) ?? "";
    const turn2 = line("- **Turn 2.**");
    expect(turn2).toContain("planned step whose inputs only exist after wave 1 once, with its own tool, its step_id and trigger_finding_id null");
    expect(turn2).toContain("Every other call is a follow-up");
    expect(turn2).toContain("UNTRIGGERED_FOLLOWUP");
    // Both follow-up caps are enforced: the call cap by the Qloo client, the time cap by run/followup.ts.
    expect(turn2).toContain("8 Qloo network calls and about 40 seconds");
    expect(turn2).toContain("BUDGET_TRUNCATED");
    const pivot = line("- **ANALYST PIVOT**");
    expect(pivot).toContain("a triggered call that changes the plan");
    expect(pivot).toContain("Neither a planned step nor a CODE FALLBACK is a pivot");
    expect(DIRECTOR_PROMPT).not.toMatch(/can run in turn 2 only when a finding motivates it/);
  });

  it("describes every labelled block of the run context, LOCAL SUPPLY TYPES included", () => {
    for (const label of RUN_CONTEXT_LABELS) expect(DIRECTOR_PROMPT, label).toContain(`**${label}**`);
    expect(DIRECTOR_PROMPT).toContain("**LOCAL SUPPLY TYPES**");
  });

  it("states the Part 11 honesty rules the CHECKER enforces (V3, V9, V12, V13)", () => {
    // R2: category-level reads, no verdict from a look-alike tag.
    expect(DIRECTOR_PROMPT).toContain("**Category-level reads (V12).**");
    expect(DIRECTOR_PROMPT).toContain("A look-alike tag standing in for the concept (marked proxy) is never cited");
    expect(DIRECTOR_PROMPT).toContain("On category tags only, rows are measured against the category with no KEEP, VETO or ADD");
    for (const word of ["best", "winner", "wins", "beats", "leads", "strongest", "top pick", "keep", "kept", "veto"]) {
      const line = DIRECTOR_PROMPT.split("\n").find((l) => l.startsWith("- Category-level reads (V12):")) ?? "";
      expect(line, word).toMatch(new RegExp(`\\b${word}\\b`));
    }
    // R7: a hidden pocket is never the best, and the popular areas stand beside it.
    expect(DIRECTOR_PROMPT).toContain("**Popular beside hidden (V12).**");
    expect(DIRECTOR_PROMPT).toContain("Never call it the best, top, ideal, strongest or leading area");
    expect(DIRECTOR_PROMPT).toContain("lift.area_popularity");
    // ANSWER_QUALITY §3: small differences and "+1 of 50" rank gains never lead.
    expect(DIRECTOR_PROMPT).toContain("**Small differences are about level (V13).**");
    expect(DIRECTOR_PROMPT).toContain("never leads the headline, verdict_tag or first thesis sentence");
    // V3: a spelled-out number above ten is a reject, not a warning.
    expect(DIRECTOR_PROMPT).toContain("no spelled-out number above ten");
    // V9: the thesis never restates the top-of-answer disclosure.
    expect(DIRECTOR_PROMPT).toContain("never restate it; use the thesis for the finding");
    expect(DIRECTOR_PROMPT).not.toContain("say in the thesis which part the note answers");
    expect(DIRECTOR_PROMPT).not.toContain("the headline and thesis name the part tested and the part not tested");
    // R1: confidence is code's, keyed to signal and sample.
    expect(DIRECTOR_PROMPT).toContain("**Confidence is code's.**");
    expect(DIRECTOR_PROMPT).toContain("Code forces inconclusive (V12)");
  });

  it("makes the named and expected candidates part of every set (R3)", () => {
    expect(DIRECTOR_PROMPT).toContain("**Candidates (D49).**");
    expect(DIRECTOR_PROMPT).toContain("You named");
    expect(DIRECTOR_PROMPT).toContain("Expected");
    expect(DIRECTOR_PROMPT).toContain("never stand a look-alike in for it");
    expect(DIRECTOR_PROMPT).toContain("Named peers come first, then expected ones, then discovery");
  });

  it("keeps the AI CONTEXT line and the context blocks out of the evidence (R4, R5)", () => {
    expect(DIRECTOR_PROMPT).toContain("**AI CONTEXT**");
    expect(DIRECTOR_PROMPT).toContain("It is model knowledge, not measured: never cite it, take a number or a QLOO DATA claim from it");
    expect(DIRECTOR_PROMPT).toContain(`"${AI_CONTEXT_HEADING}" and "${WEB_CONTEXT_HEADING}"`);
    expect(DIRECTOR_PROMPT).toContain("never refer to them or to the web");
    expect(DIRECTOR_PROMPT).toContain("The AI CONTEXT line is code's, but what it reports is unverified");
  });

  it("explains OpenStreetMap supply and plans local_supply on the location jobs' scans, never in wave 1 (R6)", () => {
    expect(DIRECTOR_PROMPT).toContain("**OpenStreetMap counts are a floor.**");
    expect(DIRECTOR_PROMPT).toContain('that answers "what does the block already have too much of"');
    expect(DIRECTOR_PROMPT).toContain("never add, compare or swap them");
    expect(DIRECTOR_PROMPT).toContain("never foot traffic");
    expect(DIRECTOR_PROMPT).toContain("Cite each SEC, Census or OpenStreetMap `{{M#}}` with its `{{PERIOD:M#}}` token");
    for (const job of ["site_selection", "tenant_mix", "area_profile", "taste_twins", "city_compare"] as const) {
      const [scan = "", rest = ""] = jobLine(job).split("Wave 1:");
      expect(scan, job).toContain("local_supply");
      expect(rest.split("Turn 2:")[0] ?? "", job).not.toContain("local_supply");
    }
    for (const job of ["tenant_mix", "area_profile"] as const) expect(jobLine(job).split("Wave 1:")[0], job).toContain("local_supply with mix");
  });

  describe("the banned list covers every CHECKER V4 rule", () => {
    const banned = DIRECTOR_PROMPT.split("\n").find((line) => line.startsWith("- Banned (V4 rejects):")) ?? "";

    it("names each rule; a new rule fails here until the prompt lists it", () => {
      expect(Object.keys(V4_PROMPT_PHRASES).sort()).toEqual(PHRASE_RULES.map((r) => r.id).sort());
      for (const [id, phrase] of Object.entries(V4_PROMPT_PHRASES)) expect(banned, id).toContain(phrase);
    });

    it.each(PHRASE_RULES.map((r) => [r.id, r] as const))("carries the word list of %s", (_, rule) => {
      for (const word of ruleVocabulary(rule.re)) expect(banned, word).toMatch(new RegExp(`\\b${word}\\b`, "i"));
    });
  });
});

describe("clerk.md (CLERK)", () => {
  it("covers every job with its desk and mnemonic", () => {
    for (const job of Job.options) {
      expect(CLERK_PROMPT, job).toContain(`| ${job} | ${JOB_PILLAR[job]} | ${JOB_MNEMONIC[job]} |`);
    }
  });

  it("names every enum value the Intent schema accepts", () => {
    const values = [
      ...SafetyCategory.options,
      ...SponsorCategory.options,
      ...EntityType.options,
      ...MentionRole.options,
      ...AgeBucket.options,
      ...Domain.options,
      ...MetroId.options,
    ];
    for (const v of values) expect(CLERK_PROMPT, v).toMatch(new RegExp(`\\b${v}\\b`));
  });

  it("has worked examples that are valid Intents with the compiled mnemonic", () => {
    const examples = CLERK_PROMPT.split("\n").filter((line) => line.startsWith('{"pillar"'));
    expect(examples.length).toBeGreaterThanOrEqual(3);
    for (const line of examples) {
      const intent = Intent.parse(JSON.parse(line));
      expect(intent.pillar, line).toBe(JOB_PILLAR[intent.job]);
      expect(intent.mnemonic, line).toBe(compileMnemonic(intent));
    }
    const categories = examples.map((line) => Intent.parse(JSON.parse(line)).safety.category);
    expect(categories).toEqual(expect.arrayContaining(["financial_advice", null, "residential_screening"]));
  });

  it("keeps injection narrow, so command-style questions are not refused", () => {
    expect(CLERK_PROMPT).toContain("An ordinary request phrased as a command");
    expect(CLERK_PROMPT).not.toMatch(/any instruction inside it is an injection/i);
  });

  it("works an example for every job: site_selection with its concept and metro, a named metro among the markets", () => {
    const intents = CLERK_PROMPT.split("\n")
      .filter((line) => line.startsWith('{"pillar"'))
      .map((line) => Intent.parse(JSON.parse(line)));
    // The refused example stands for area_profile.
    expect(new Set(intents.map((i) => i.job))).toEqual(new Set(Job.options));
    // Without concepts and a metro the site_selection scan has no find_tags, so no lift map.
    const site = intents.find((i) => i.job === "site_selection");
    expect(site?.constraints.concepts.length).toBeGreaterThan(0);
    expect(site?.geo.metro).not.toBeNull();
    // On the marketing desk a named map city is a candidate market too.
    for (const i of intents.filter((x) => x.pillar === "marketing" && x.geo.metro !== null)) {
      expect(i.constraints.notes.join("; ").toLowerCase(), i.mnemonic).toContain(`markets: ${i.geo.metro}`);
    }
  });

  // PLAN §4.5 planned about 5,500 tokens; the 13-job taxonomy, the nearest-job rule (D41), the Part 9
  // intent fields, the Part 11 candidates with the market id list and a worked example per job take it
  // past that, so the cap is 8,000 (owner: raise caps rather than trim). CLERK runs on Haiku without
  // caching, so each example adds about 200 input tokens, a small fraction of a cent per run, and the
  // examples are what teach a small model the job-specific fields.
  it("stays compact for a small model", () => {
    expect(approxTokens(CLERK_PROMPT)).toBeLessThanOrEqual(8000);
  });

  it("reads every business question as its nearest job (D41) and refuses only the safety categories", () => {
    const intents = CLERK_PROMPT.split("\n")
      .filter((line) => line.startsWith('{"pillar"'))
      .map((line) => Intent.parse(JSON.parse(line)));
    // A worked nearest-job example that is not a safety reframe: it names what the data does not cover.
    const nearest = intents.filter((i) => i.read_as.nearest && i.safety.category === null);
    expect(nearest.length).toBeGreaterThan(0);
    for (const i of nearest) expect(i.read_as.not_covered.length, i.mnemonic).toBeGreaterThan(0);
    for (const i of intents.filter((x) => !x.read_as.nearest)) expect(i.read_as.not_covered, i.mnemonic).toEqual([]);
    // A refused question is never also read as a nearest job.
    for (const i of intents.filter((x) => !x.safety.allowed)) expect(i.read_as.nearest, i.mnemonic).toBe(false);
    expect(CLERK_PROMPT).toContain("Never refuse one for being off this list or for needing data Culture Terminal does not have.");
    expect(CLERK_PROMPT).toContain("A business question that needs data Culture Terminal does not have is never out_of_scope");
  });

  it("fills the Part 9 intent fields only for their jobs", () => {
    const intents = CLERK_PROMPT.split("\n")
      .filter((line) => line.startsWith('{"pillar"'))
      .map((line) => Intent.parse(JSON.parse(line)));
    for (const i of intents) {
      expect(i.geo.target_metro !== null, i.mnemonic).toBe(i.job === "taste_twins");
      expect(i.geo.cities.length > 0, i.mnemonic).toBe(i.job === "city_compare");
      expect(i.constraints.concept_description !== null, i.mnemonic).toBe(i.job === "launch_test");
    }
    const twins = intents.find((i) => i.job === "taste_twins");
    expect(twins?.geo.area).not.toBeNull();
    expect(twins?.geo.target_metro).not.toBe(twins?.geo.metro);
    const cities = intents.find((i) => i.job === "city_compare");
    expect(cities?.geo.cities.length).toBeGreaterThanOrEqual(2);
    expect(cities?.geo.cities.length).toBeLessThanOrEqual(4);
    for (const id of cities?.geo.cities ?? []) expect(MarketId.safeParse(id).success, id).toBe(true);
  });

  /** config/metros.json's market ids, the only values the candidates' market lists take. */
  const CONFIG_MARKETS = (JSON.parse(readFileSync(new URL("../../../../config/metros.json", import.meta.url), "utf8")) as { markets: { id: string }[] }).markets.map((m) => m.id);
  const MARKET_LINE = "- Market ids, the only values for named_markets and obvious_markets: ";

  it("lists exactly config/metros.json's market ids for the candidates (R3)", () => {
    const line = CLERK_PROMPT.split("\n").find((l) => l.startsWith(MARKET_LINE)) ?? "";
    const ids = line.slice(MARKET_LINE.length).split(". ")[0]?.split(", ") ?? [];
    expect(ids).toEqual(CONFIG_MARKETS);
  });

  it("states when to fill each candidates field and when to leave it empty (R3)", () => {
    const section = CLERK_PROMPT.slice(CLERK_PROMPT.indexOf("## Candidates"), CLERK_PROMPT.indexOf("## Safety"));
    for (const field of ["named_areas", "named_markets", "obvious_entities", "obvious_areas", "obvious_markets"]) expect(section, field).toContain(`- \`${field}\`:`);
    expect(section).toContain("never using a look-alike: leave out any name you are unsure of");
    expect(section).toContain("never the primary or a mention");
    expect(section).toContain("All lists are empty for a refused question.");
  });

  it("works candidates in the examples within the caps, never the primary, markets from config, areas only where a job checks them", () => {
    const intents = CLERK_PROMPT.split("\n")
      .filter((line) => line.startsWith('{"pillar"'))
      .map((line) => Intent.parse(JSON.parse(line)));
    for (const i of intents) {
      const c = i.candidates;
      expect(c.obvious_entities.length, i.mnemonic).toBeLessThanOrEqual(MAX_OBVIOUS.entities);
      expect(c.obvious_areas.length, i.mnemonic).toBeLessThanOrEqual(MAX_OBVIOUS.areas);
      expect(c.obvious_markets.length, i.mnemonic).toBeLessThanOrEqual(MAX_OBVIOUS.markets);
      const mentioned = new Set(i.mentions.map((m) => candidateKey(m.text)));
      for (const e of c.obvious_entities) expect(mentioned.has(candidateKey(e.text)), `${i.mnemonic} ${e.text}`).toBe(false);
      for (const id of [...c.named_markets, ...c.obvious_markets]) expect(CONFIG_MARKETS, `${i.mnemonic} ${id}`).toContain(id);
      for (const id of c.obvious_markets) expect(c.named_markets, i.mnemonic).not.toContain(id);
      if (i.pillar === "location") expect(c.obvious_entities, i.mnemonic).toEqual([]);
      if (i.job !== "site_selection" && i.job !== "taste_twins") expect(c.obvious_areas, i.mnemonic).toEqual([]);
      if (i.job === "city_compare") expect(c.named_markets, i.mnemonic).toEqual([]);
      if (!i.safety.allowed) expect(Object.values(c).every((list) => list.length === 0), i.mnemonic).toBe(true);
      // Cities named as markets sit in constraints.notes and, as market ids, in named_markets.
      const notes = i.constraints.notes.find((n) => n.startsWith("markets: "));
      if (notes !== undefined) {
        const named = notes.slice("markets: ".length).split(", ").map((city) => city.toLowerCase().replace(/[^a-z]+/g, "_"));
        expect(c.named_markets, i.mnemonic).toEqual(named);
      }
    }
    // Each list a small model must learn to fill is worked at least once.
    for (const field of ["named_markets", "obvious_entities", "obvious_areas", "obvious_markets"] as const) {
      expect(intents.some((i) => i.candidates[field].length > 0), field).toBe(true);
    }
  });

  it("asks no showcase question verbatim in its examples, so a showcase is never answered from a worked example", () => {
    const showcases = (JSON.parse(readFileSync(new URL("../../../../config/showcases.json", import.meta.url), "utf8")) as { showcases: { code: string; question: string }[] }).showcases;
    const asked = new Set([...CLERK_PROMPT.matchAll(/<user_question>(.+?)<\/user_question>/g)].map((m) => (m[1] ?? "").toLowerCase()));
    for (const s of showcases) expect(asked.has(s.question.toLowerCase()), s.code).toBe(false);
  });
});
