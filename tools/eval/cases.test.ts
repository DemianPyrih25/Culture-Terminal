// The registered eval inputs as they stand in eval/, and the schema rules on invented fixtures (D29:
// the fixtures name no real entity, and nothing here touches Qloo or the network).
import { readFileSync } from "node:fs";
import { Job, JOB_PILLAR, Pillar } from "@ct/contracts";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { loadGeo } from "../dev/cli/geo";
import {
  ADVERSARIAL_CATEGORY,
  ADVERSARIAL_QUESTIONS,
  AdversarialKind,
  CORE_QUESTIONS,
  CORE_QUESTIONS_PER_JOB,
  loadQuestions,
  OFFLIST_QUESTIONS,
  loadRealityCases,
  QuestionsFile,
  REALITY_CASES,
  RealityCasesFile,
  RealityKind,
  referenceProblems,
  type CaseReferences,
} from "./cases";

// Only the fields this test compares; packages/agent's config test checks the rest of the file.
const Showcases = z.object({
  showcases: z.array(z.object({ code: z.string(), desk: Pillar, question: z.string(), expected: z.object({ job: Job }) })),
});

// The market tiers, which tools/dev/cli/markets.ts does not carry.
const Metros = z.object({ markets: z.array(z.object({ id: z.string(), tier: z.enum(["major", "secondary"]) })) });

const SHOWCASES_JSON = new URL("../../config/showcases.json", import.meta.url);
const METROS_JSON = new URL("../../config/metros.json", import.meta.url);

const showcases = () => Showcases.parse(JSON.parse(readFileSync(SHOWCASES_JSON, "utf8"))).showcases;

const pad = (n: number): string => String(n).padStart(2, "0");
/** The showcases registered with the eval (S1 to S7); S8 to S13 came in Part 11, after registration. */
const EVAL_SHOWCASES = 7;

// Twenty-seven core questions covering every job twice (brand_health three times), one adversarial
// question of each kind, then three off-list questions read as their nearest job.
function questionsFixture(): z.input<typeof QuestionsFile> {
  const jobs = [...Job.options, ...Job.options, "brand_health"] as const;
  return {
    registered: "2026-01-15",
    questions: [
      ...jobs.map((job, i) => ({
        id: `q${pad(i + 1)}`,
        set: "core" as const,
        showcase: i === 0 ? "S1" : null,
        desk: JOB_PILLAR[job],
        job,
        question: `Invented question ${i + 1} about Brand Alpha and Artist Nova?`,
      })),
      ...AdversarialKind.options.map((kind, i) => ({
        id: `a${pad(i + 1)}`,
        set: "adversarial" as const,
        kind,
        desk: "audience" as const,
        job: "audience_discovery" as const,
        question: `Invented adversarial question ${i + 1}?`,
        expected: { handling: "refuse" as const, category: ADVERSARIAL_CATEGORY[kind], note: "A group-level reframe." },
      })),
      ...(["area_profile", "audience_discovery", "market_selection"] as const).map((job, i) => ({
        id: `o${pad(i + 1)}`,
        set: "offlist" as const,
        desk: JOB_PILLAR[job],
        job,
        question: `Invented off-list question ${i + 1} about rents for Brand Alpha?`,
        expected: { handling: "nearest" as const, not_covered: ["rent"], note: "Read as the nearest job." },
      })),
    ],
  };
}

const source = (n: number) => ({ url: `https://example.com/news/${n}`, publisher: "Example News", published: "2025-06-01", accessed: "2026-01-10" });

function caseFixture(kind: RealityKind, n: number) {
  const base = {
    id: `rc${pad(n)}`,
    context: "invented context",
    showcase: null,
    claim: "An invented public fact.",
    public_date: "2025-06-01",
    sources: [source(n)],
    note: null,
  };
  switch (kind) {
    case "brand_collaboration":
      return { ...base, kind, seed: { name: `Brand Alpha ${n}`, entity_type: "brand" }, choice: { name: "Brand Beta", entity_type: "brand" } };
    case "tour_sponsor":
      return {
        ...base,
        kind,
        seed: { name: `Artist Nova ${n}`, entity_type: "artist" },
        choice: { name: "Brand Gamma", entity_type: "brand" },
        sponsor_category: "beer",
      };
    case "comedian_market":
      return {
        ...base,
        kind,
        seed: { name: `Comedian Vega ${n}`, entity_type: "person" },
        choice: { entity_type: "locality", tour: "Invented Tour", markets: ["riverton", "lakeside"] },
      };
    case "dtc_neighbourhood":
      return {
        ...base,
        kind,
        seed: { name: `Brand Delta ${n}`, entity_type: "brand" },
        choice: { name: "Old Mill", entity_type: "neighbourhood", metro: "austin", area_id: "old_mill", address: "100 Example Street" },
      };
  }
}

// Three cases of each kind.
function casesFixture() {
  return {
    registered: "2026-01-15",
    caveats: ["An invented caveat."],
    scoring: ["An invented rule."],
    cases: Array.from({ length: REALITY_CASES }, (_, i) => caseFixture(RealityKind.options[i % RealityKind.options.length]!, i + 1)),
  };
}

const issues = (result: { success: boolean; error?: z.ZodError }): string =>
  result.error?.issues.map((i) => i.message).join("\n") ?? "";

describe("eval/questions.json", () => {
  const { questions } = loadQuestions();
  const core = questions.filter((q) => q.set === "core");

  it("registers 27 core questions across all four desks and thirteen jobs, at least two per job, 4 adversarial and 3 off-list ones", () => {
    expect(core).toHaveLength(CORE_QUESTIONS);
    expect(questions.filter((q) => q.set === "adversarial")).toHaveLength(ADVERSARIAL_QUESTIONS);
    expect(questions.filter((q) => q.set === "offlist")).toHaveLength(OFFLIST_QUESTIONS);
    expect(new Set(core.map((q) => q.job))).toEqual(new Set(Job.options));
    for (const job of Job.options) expect(core.filter((q) => q.job === job).length, job).toBeGreaterThanOrEqual(CORE_QUESTIONS_PER_JOB);
    expect(new Set(core.map((q) => q.desk))).toEqual(new Set(Pillar.options));
  });

  it("keeps the first twelve core questions as registered before Part 9", () => {
    expect(core.slice(0, 12).map((q) => q.id)).toEqual(Array.from({ length: 12 }, (_, i) => `q${pad(i + 1)}`));
  });

  it("reads every off-list question as a nearest job, naming what is not covered", () => {
    const offList = questions.flatMap((q) => (q.set === "offlist" ? [q] : []));
    for (const q of offList) {
      expect(q.expected.handling).toBe("nearest");
      expect(q.expected.not_covered.length).toBeGreaterThan(0);
      expect(q.desk).toBe(JOB_PILLAR[q.job]);
    }
  });

  it("asks every registered showcase question (S1 to S7) of config/showcases.json verbatim, with its desk and job, first", () => {
    const all = showcases().slice(0, EVAL_SHOWCASES);
    expect(all.length).toBeGreaterThan(0);
    const asked = core.slice(0, all.length).map((q) => ({ code: q.showcase, desk: q.desk, job: q.job, question: q.question }));
    expect(asked).toEqual(all.map((s) => ({ code: s.code, desk: s.desk, job: s.expected.job, question: s.question })));
    expect(core.slice(all.length).every((q) => q.showcase === null)).toBe(true);
  });

  it("covers each adversarial kind once, refused with the category clerk.md gives it", () => {
    const adversarial = questions.flatMap((q) => (q.set === "adversarial" ? [q] : []));
    expect(adversarial.map((q) => q.kind).sort()).toEqual([...AdversarialKind.options].sort());
    for (const q of adversarial) expect(q.expected).toMatchObject({ handling: "refuse", category: ADVERSARIAL_CATEGORY[q.kind] });
  });
});

describe("eval/reality_cases.json", () => {
  const file = loadRealityCases();

  it("registers 12 cases, three of each kind, every one with an https source", () => {
    expect(file.cases).toHaveLength(REALITY_CASES);
    for (const kind of RealityKind.options) expect(file.cases.filter((c) => c.kind === kind)).toHaveLength(3);
    for (const c of file.cases) {
      expect(c.sources.length, c.id).toBeGreaterThan(0);
      for (const s of c.sources) expect(new URL(s.url).protocol, c.id).toBe("https:");
    }
    expect(new Set(file.cases.map((c) => c.id)).size).toBe(REALITY_CASES);
  });

  it("uses no seed twice within a kind", () => {
    for (const kind of RealityKind.options) {
      const seeds = file.cases.filter((c) => c.kind === kind).map((c) => c.seed.name);
      expect(new Set(seeds).size, kind).toBe(seeds.length);
    }
  });

  it("names secondary markets of config/metros.json and areas of the shipped gazetteers", async () => {
    const { geo, source: geoSource } = await loadGeo();
    expect(geoSource).toBe("@ct/geo");
    const { markets } = Metros.parse(JSON.parse(readFileSync(METROS_JSON, "utf8")));
    const refs: CaseReferences = {
      markets: new Set(markets.filter((m) => m.tier === "secondary").map((m) => m.id)),
      hasArea: (metro, id) => geo.neighbourhood(metro, id) !== null,
    };
    expect(referenceProblems(file.cases, refs)).toEqual([]);
  });

  it("marks exactly the cases whose seed a showcase question names", () => {
    const all = showcases();
    for (const c of file.cases) {
      const code = all.find((s) => s.question.includes(c.seed.name))?.code ?? null;
      expect(c.showcase, c.id).toBe(code);
    }
  });

  it("states the leakage caveat and the GHOST hit rule for every kind", () => {
    expect(file.caveats.some((c) => /leak/i.test(c))).toBe(true);
    for (const kind of ["Brand collaboration", "tour sponsor", "Neighbourhood", "Comedian"]) {
      expect(file.scoring.some((rule) => rule.includes(kind) && /GHOST/.test(rule)), kind).toBe(true);
    }
  });
});

describe("the question schema", () => {
  it("accepts the invented fixture", () => {
    const result = QuestionsFile.safeParse(questionsFixture());
    expect(issues(result)).toBe("");
  });

  it("rejects a repeated id, a desk that does not match the job and an unknown job", () => {
    const fixture = questionsFixture();
    fixture.questions[1]!.id = "q01";
    fixture.questions[2]!.desk = "audience";
    expect(issues(QuestionsFile.safeParse(fixture))).toMatch(/q01 is used more than once[\s\S]*q03: desk audience does not match job/);
    const unknown = questionsFixture();
    Object.assign(unknown.questions[0]!, { job: "brand_vibes" });
    expect(QuestionsFile.safeParse(unknown).success).toBe(false);
  });

  it("rejects a core set that misses a job or covers one once, and the wrong number of questions", () => {
    const fixture = questionsFixture();
    const missing = Job.options[7]!;
    for (const q of fixture.questions) if (q.set === "core" && q.job === missing) Object.assign(q, { job: "brand_health", desk: "investment" });
    expect(issues(QuestionsFile.safeParse(fixture))).toContain(`no core question for job ${missing}`);
    const once = questionsFixture();
    Object.assign(once.questions[7]!, { job: "brand_health", desk: "investment" });
    expect(issues(QuestionsFile.safeParse(once))).toContain(`job ${missing} has 1 core question(s), expected at least ${CORE_QUESTIONS_PER_JOB}`);
    const short = questionsFixture();
    short.questions.splice(26, 1);
    expect(issues(QuestionsFile.safeParse(short))).toContain(`26 core questions, expected ${CORE_QUESTIONS}`);
    const noOffList = questionsFixture();
    noOffList.questions.pop();
    expect(issues(QuestionsFile.safeParse(noOffList))).toContain(`2 off-list questions, expected ${OFFLIST_QUESTIONS}`);
  });

  it("rejects an adversarial set that misses a kind or expects the wrong category", () => {
    const missing = questionsFixture();
    const religion = missing.questions.find((q) => q.set === "adversarial" && q.kind === "religion_siting")!;
    Object.assign(religion, { kind: "injection", expected: { handling: "refuse", category: "injection", note: "x" } });
    expect(issues(QuestionsFile.safeParse(missing))).toMatch(/no adversarial question of kind religion_siting[\s\S]*injection is registered more than once/);
    const wrong = questionsFixture();
    const siting = wrong.questions.find((q) => q.set === "adversarial" && q.kind === "religion_siting")!;
    Object.assign(siting, { expected: { handling: "refuse", category: "private_individual", note: "x" } });
    expect(issues(QuestionsFile.safeParse(wrong))).toContain("refused as sensitive_inference, not private_individual");
  });

  it("rejects a question longer than the web accepts", () => {
    const fixture = questionsFixture();
    fixture.questions[0]!.question = "x".repeat(401);
    expect(QuestionsFile.safeParse(fixture).success).toBe(false);
  });
});

describe("the case schema", () => {
  it("accepts the invented fixture", () => {
    expect(issues(RealityCasesFile.safeParse(casesFixture()))).toBe("");
  });

  it("rejects a case with no source or a plain-http one", () => {
    const none = casesFixture();
    none.cases[0]!.sources = [];
    expect(RealityCasesFile.safeParse(none).success).toBe(false);
    const http = casesFixture();
    http.cases[0]!.sources = [{ ...source(1), url: "http://example.com/news/1" }];
    expect(RealityCasesFile.safeParse(http).success).toBe(false);
  });

  it("rejects a repeated id, a missing kind and a fact dated after registration", () => {
    const fixture = casesFixture();
    fixture.cases[1]!.id = "rc01";
    fixture.cases[2]!.public_date = "2026-02-01";
    fixture.cases[3] = caseFixture("brand_collaboration", 4);
    fixture.cases[7] = caseFixture("brand_collaboration", 8);
    fixture.cases[11] = caseFixture("brand_collaboration", 12);
    expect(issues(RealityCasesFile.safeParse(fixture))).toMatch(
      /rc01 is used more than once[\s\S]*no case of kind dtc_neighbourhood[\s\S]*rc03: public_date 2026-02-01 is after registration/,
    );
  });

  it("rejects a seed of the wrong type and a source opened after registration", () => {
    const seed = casesFixture();
    seed.cases[0]!.seed = { name: "Artist Nova", entity_type: "artist" };
    expect(RealityCasesFile.safeParse(seed).success).toBe(false);
    const late = casesFixture();
    late.cases[0]!.sources = [{ ...source(1), accessed: "2026-03-01" }];
    expect(issues(RealityCasesFile.safeParse(late))).toContain("was accessed after registration");
  });

  it("rejects a seed used twice in one kind, and a comedian case with no market or one listed twice", () => {
    const fixture = casesFixture();
    fixture.cases[4]!.seed = { name: "brand alpha 1 ", entity_type: "brand" };
    Object.assign(fixture.cases[2]!.choice, { markets: ["riverton", "riverton"] });
    expect(issues(RealityCasesFile.safeParse(fixture))).toMatch(
      /brand_collaboration seed "brand alpha 1" is used more than once[\s\S]*rc03: market riverton is listed twice/,
    );
    const empty = casesFixture();
    Object.assign(empty.cases[2]!.choice, { markets: [] });
    expect(RealityCasesFile.safeParse(empty).success).toBe(false);
  });

  it("accepts the same seed in two kinds", () => {
    const fixture = casesFixture();
    fixture.cases[3]!.seed = { name: "Brand Alpha 1", entity_type: "brand" };
    expect(issues(RealityCasesFile.safeParse(fixture))).toBe("");
  });

  it("flags a market or an area this build does not have", () => {
    const { cases } = RealityCasesFile.parse(casesFixture());
    const refs: CaseReferences = {
      markets: new Set(["riverton", "lakeside"]),
      hasArea: (metro, id) => metro === "austin" && id === "old_mill",
    };
    expect(referenceProblems(cases, refs)).toEqual([]);
    expect(referenceProblems(cases, { markets: new Set(["riverton"]), hasArea: () => false })).toEqual([
      "rc03: lakeside not among the secondary markets of config/metros.json",
      "rc04: area old_mill is not in the austin gazetteer",
      "rc07: lakeside not among the secondary markets of config/metros.json",
      "rc08: area old_mill is not in the austin gazetteer",
      "rc11: lakeside not among the secondary markets of config/metros.json",
      "rc12: area old_mill is not in the austin gazetteer",
    ]);
  });
});
