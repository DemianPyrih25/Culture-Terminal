import {
  AgeBucket,
  approxTokens,
  ArgumentSection,
  Badge,
  compileMnemonic,
  Domain,
  EntityType,
  FindingKind,
  Intent,
  Job,
  JOB_MNEMONIC,
  JOB_PILLAR,
  MentionRole,
  MetroId,
  Priority,
  SafetyCategory,
  Signal,
  SponsorCategory,
  ToolName,
  TOOL_MNEMONIC,
} from "@ct/contracts";
import { describe, expect, it } from "vitest";
import { CLERK_PROMPT, DIRECTOR_PROMPT, PROMPT_HASHES } from "../../src/prompts";
import { PHRASE_RULES } from "../../src/report/phrases";
import { isSkillAvailable } from "../../src/run/catalogue";
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
  // Planned at six to seven thousand tokens (PLAN §4.5); the eight full job playbooks and the
  // cross-desk next-move rule take it to at most 7,500. The prompt is the cached prefix, so the
  // extra tokens cost a cache read per response, not a fresh input.
  it("stays within about six to seven and a half thousand tokens", () => {
    const tokens = approxTokens(DIRECTOR_PROMPT);
    expect(tokens).toBeGreaterThanOrEqual(6000);
    expect(tokens).toBeLessThanOrEqual(7500);
  });

  it("has the ten planned sections in order", () => {
    const headings = [...DIRECTOR_PROMPT.matchAll(/^## (\d+)\. (.+)$/gm)].map((m) => [Number(m[1]), m[2]]);
    expect(headings).toEqual([
      [1, "Role"],
      [2, "Qloo physics"],
      [3, "Grounding rules"],
      [4, "Skill catalogue"],
      [5, "Opening theory per job"],
      [6, "Hypothesis protocol"],
      [7, "Investigation policy"],
      [8, "Report contract"],
      [9, "Safety"],
      [10, "Untrusted data"],
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

  it("names every scan skill the build runs in its job's Scan part, and never asks wave 1 to repeat it", () => {
    for (const [job, entries] of Object.entries(SCAN_TABLE)) {
      const line = DIRECTOR_PROMPT.split("\n").find((l) => l.startsWith(`- **${job}** (`)) ?? "";
      const [scan = "", wave1 = ""] = line.split("Wave 1:");
      for (const entry of entries.filter((e) => (e.build ?? e.chain) !== undefined && isSkillAvailable(e.tool))) {
        expect(scan, `${job} scan`).toContain(entry.tool);
        expect(wave1, `${job} wave 1`).not.toContain(entry.tool);
      }
    }
  });

  it("gives every job its turn-2 move and names the pivots it usually makes", () => {
    for (const job of Job.options) {
      const line = DIRECTOR_PROMPT.split("\n").find((l) => l.startsWith(`- **${job}** (`)) ?? "";
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
      "Claim an audience's age, gender or generation only where the same part cites an audience_dna or share_of_taste age metric (V10)",
    );
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
    // On the marketing desk a named Nashville or Austin is a candidate market too.
    for (const i of intents.filter((x) => x.pillar === "marketing" && x.geo.metro !== null)) {
      expect(i.constraints.notes.join("; ").toLowerCase(), i.mnemonic).toContain(`markets: ${i.geo.metro}`);
    }
  });

  // Planned at about 3,500 tokens; a worked example per job takes it to at most 3,800. CLERK runs
  // on Haiku without caching, so each example adds about 130 input tokens, a small fraction of a
  // cent per run, and the examples are what teach a small model the job-specific fields (concepts,
  // metro, markets in notes, domains).
  it("stays compact for a small model", () => {
    expect(approxTokens(CLERK_PROMPT)).toBeLessThanOrEqual(3800);
  });
});
