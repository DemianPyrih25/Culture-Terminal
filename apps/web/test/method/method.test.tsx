// /method, the analysts' reference generated from the code: an anchor per FORMULAS id (the target of
// every "How it's calculated" link), the seven steps with the opening scan and the analyst's turns, the
// checker rules V1–V10, the confidence penalties, the evaluation in each of its states, the rules moved
// from /trust, and the new shell. Eval numbers here are invented for the fixture.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CONFIDENCE_CAP, CONFIDENCE_PENALTY, ConfidenceRule, GHOST_HONESTY_LINE, Job, ValidationRule } from "@ct/contracts";
import { CONFIDENCE_RULE_LABEL, FORMULA_IDS, FORMULAS, MIN_BUSY_AREA_VENUES, MIN_SUPPLY_VENUES, THIN_SUPPLY_LABEL } from "@ct/quant";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decode } from "../figures/markup";
import { convictionRuleLabel } from "../../lib/brief/format";

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ push: vi.fn() }),
}));

const MethodPageModule = await import("../../app/method/page");
const MethodPage = MethodPageModule.default;
const { methodFacts, openingScan, qlooEndpoints, rulesFacts, trendWindowText } = await import("../../app/method/facts");
const { evalSummaryCandidates, loadEvalSummary } = await import("../../app/method/load-eval");
const { MethodView } = await import("../../components/method/method-view");
const { formatEvalValue, parseEvalSummary } = await import("../../components/method/eval-summary");
const { FORMULA_GROUPS, FORMULA_META, METHOD_SECTION_ORDER, SCAN_COPY, checkerRules, methodSteps } = await import("../../content/method");
const { methodHref } = await import("../../components/figures");
const { RULES_INDEX } = await import("../../components/method/rules-sections");

type EvalState = import("../../components/method/eval-summary").EvalState;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function view(evaluation: EvalState = { state: "missing" }): string {
  return renderToStaticMarkup(
    <MethodView
      facts={methodFacts()}
      scan={openingScan()}
      endpoints={qlooEndpoints()}
      trendWindow={trendWindowText()}
      evaluation={evaluation}
      rules={rulesFacts({} as NodeJS.ProcessEnv)}
    />,
  );
}

/** The markup of one section card, from its marker to its end. */
function section(html: string, id: string): string {
  const start = html.indexOf(`data-section="${id}"`);
  if (start < 0) throw new Error(`no section ${id}`);
  const end = html.indexOf("</section>", start);
  return html.slice(start, end);
}

const SUMMARY = {
  ranAt: "2026-10-30",
  model: "claude-sonnet-5-5",
  questions: { total: 16, adversarial: 4 },
  metrics: [
    { id: "refutation_rate", label: "Priors refuted or qualified", unit: "rate", grounded: 0.42, ghost: null },
    { id: "latency_p50", label: "Latency, p50", unit: "seconds", grounded: 61, ghost: 9.5 },
    { id: "usd_per_run", label: "Model cost per answer", unit: "usd", grounded: 0.21, ghost: 0.04 },
  ],
  realityCheck: { cases: 12, medianPercentile: 0.77, ghostHitRate: 0.25 },
};

describe("the /method page", () => {
  it("renders in the new shell with an index of every section, How it works marked current", async () => {
    expect(MethodPageModule.dynamic).toBe("force-dynamic");
    expect(MethodPageModule.metadata.title).toBe("Method · Culture Terminal");
    // Mock Qloo: the cost card states plan figures only and never reads the database.
    vi.stubEnv("QLOO_MOCK", "1");
    const html = renderToStaticMarkup(await MethodPage());
    vi.unstubAllEnvs();
    expect(html).toMatch(/<h1[^>]*>Every formula and rule<\/h1>/);
    const nav = html.match(/<a[^>]*data-nav="how"[^>]*>/)?.[0] ?? "";
    expect(nav).toContain('href="/how-it-works"');
    expect(nav).toContain('aria-current="page"');
    expect(html).not.toContain('href="/trust"');
    for (const id of [...METHOD_SECTION_ORDER, ...RULES_INDEX.map((r) => r.id), "coverage", "costs"]) {
      expect(html).toContain(`data-section="${id}"`);
      expect(html).toContain(`href="#${id}"`);
    }
    // The sources name the trending window; the evaluation is in one of its states.
    expect(decode(html)).toContain(`${trendWindowText()}; nothing after it`);
    expect(html).toMatch(/data-eval="(missing|invalid|ok)"/);
    // No Concept A remnants.
    expect(html).not.toMatch(/font-serif|text-dim|text-faint|rounded-brief|bg-paper/);
  });

  it("gives every formula an anchor equal to its id, where each figure's method link lands", () => {
    const html = view();
    for (const id of FORMULA_IDS) {
      expect(html.split(`id="${id}"`).length - 1, id).toBe(1);
      expect(methodHref(id)).toBe(`/method#${id}`);
      const entry = html.slice(html.indexOf(`<article id="${id}"`), html.indexOf("</article>", html.indexOf(`<article id="${id}"`)));
      expect(decode(entry)).toContain(FORMULAS[id].name);
      expect(entry).toContain(`href="#${id}"`);
      for (const caveat of FORMULAS[id].caveats) expect(decode(entry)).toContain(caveat);
      for (const input of FORMULA_META[id].inputs) expect(decode(entry)).toContain(input);
      expect(entry).toContain(`data-badge="${FORMULA_META[id].badge ?? "none"}"`);
      // The TeX is set, not printed as source.
      expect(entry).not.toContain("\\");
    }
  });

  it("groups every formula exactly once, by skill", () => {
    const grouped = FORMULA_GROUPS.flatMap((g) => g.formulas);
    expect([...grouped].sort()).toEqual([...FORMULA_IDS].sort());
    expect(new Set(grouped).size).toBe(grouped.length);
    expect(Object.keys(FORMULA_META).sort()).toEqual([...FORMULA_IDS].sort());
    const html = view();
    for (const g of FORMULA_GROUPS) expect(html).toContain(`data-formula-group="${g.id}"`);
    for (const g of FORMULA_GROUPS.filter((g) => g.skill)) expect(html).toContain(g.skill!);
  });

  it("says name matching runs at the gate on every answer, not only when the analyst calls it", () => {
    const html = view();
    const start = html.indexOf(`data-formula-group="resolve"`);
    const head = decode(html.slice(start, html.indexOf("<article", start)));
    expect(head).toContain("Run by the resolution gate on every answer");
    expect(head).not.toContain(SCAN_COPY.analystOnly);
  });

  it("explains how an answer is made from the code: steps, models, scans and turns", () => {
    const facts = methodFacts();
    expect(facts.clerkModel).toBe("Haiku 5.5");
    expect(facts.analystModel).toBe("Sonnet 5.5");
    const html = decode(section(view(), "steps"));
    for (const step of methodSteps(facts)) {
      expect(html).toContain(step.name);
      expect(html).toContain(step.who);
    }
    expect(html).toContain(`Up to ${facts.limits.qlooCalls} Qloo requests per answer`);
    for (const job of Job.options) expect(html).toContain(`data-job="${job}"`);
    expect(html).toContain("Substitution map · Audience DNA · Travel taste");
    for (const turn of ["Turn 1", "Turn 2", "Turn 3", "Guards"]) expect(html).toContain(turn);
    expect(html).toContain(`${facts.limits.followupCalls} requests`);
  });

  it("lists the checker rules V1–V10 and the confidence penalties with their labels", () => {
    const html = view();
    const checker = decode(section(html, "checker"));
    const rules = checkerRules(methodFacts());
    for (const rule of ValidationRule.options) {
      expect(checker).toContain(`data-rule="${rule}"`);
      expect(checker).toContain(rules[rule].title);
    }
    expect(checker).toContain(`fewer than ${methodFacts().minOkEvidence} evidence bundles`);
    // V3 rejects any bare number once and warns on the repair, as V10 does.
    expect(rules.V3.action).toBe("Rejects; warns on the repair");
    expect(checker).toContain(rules.V3.action);
    // V10 covers competitor claims by geo_lift's supply-label rule, read from the code.
    expect(rules.V10.text).toContain(`at least ${MIN_SUPPLY_VENUES} similar venues across the compared areas, and ${MIN_BUSY_AREA_VENUES} in an area`);
    expect(rules.V10.text).toContain(`An area with none in a capped sample is not "few"`);
    expect(rules.V10.text).toContain(THIN_SUPPLY_LABEL);
    const conviction = decode(section(html, "conviction"));
    for (const rule of ConfidenceRule.options) {
      const cap = CONFIDENCE_CAP[rule];
      // Quant's hover label, or the brief's own words while a rule has no quant label yet.
      expect(conviction).toContain(decode(CONFIDENCE_RULE_LABEL[rule] ?? convictionRuleLabel(rule, 1)));
      // R1: a cap rule that subtracts nothing is listed under Caps with its ceiling, not as a "−0" penalty.
      if (cap !== undefined) expect(conviction).toContain(`data-cap="${rule}"`);
      if (cap !== undefined) expect(conviction).toContain(`at most ${cap}`);
      if (CONFIDENCE_PENALTY[rule] > 0 || cap === undefined) {
        expect(conviction).toContain(`data-penalty="${rule}"`);
        expect(conviction).toContain(`−${CONFIDENCE_PENALTY[rule]}`);
      }
    }
    expect(conviction).toMatch(/High<\/span> <span[^>]*>75–100/);
    expect(conviction).toMatch(/Medium<\/span> <span[^>]*>50–74/);
    expect(conviction).toMatch(/Low<\/span> <span[^>]*>0–49/);
    expect(conviction).toContain("Confidence");
  });
});

describe("the evaluation section", () => {
  it("says the evaluation has not run yet, with no numbers, when there is no summary", () => {
    const evalHtml = decode(section(view({ state: "missing" }), "eval"));
    expect(evalHtml).toContain('data-eval="missing"');
    expect(evalHtml).toContain("The evaluation has not been run yet");
    expect(evalHtml).not.toMatch(/\d+%|\$\d/);
    expect(evalHtml).toContain(GHOST_HONESTY_LINE);
  });

  it("shows nothing but the fact when the summary cannot be read", () => {
    const evalHtml = decode(section(view({ state: "invalid", reason: "bad" }), "eval"));
    expect(evalHtml).toContain('data-eval="invalid"');
    expect(evalHtml).toContain("could not be read");
    expect(evalHtml).not.toMatch(/\d+%|\$\d/);
  });

  it("prints the aggregates of a valid summary", () => {
    const state = parseEvalSummary(JSON.stringify(SUMMARY));
    expect(state.state).toBe("ok");
    const evalHtml = decode(section(view(state), "eval"));
    expect(evalHtml).toContain('data-eval="ok"');
    expect(evalHtml).toContain("30 Oct 2026 · Sonnet 5.5 · 16 questions, 4 adversarial");
    expect(evalHtml).toMatch(/data-eval-metric="refutation_rate"[\s\S]*?42%[\s\S]*?–/);
    expect(evalHtml).toContain("61 s");
    expect(evalHtml).toContain("9.5 s");
    expect(evalHtml).toContain("$0.21");
    expect(evalHtml).toContain("77%");
    expect(evalHtml).toContain("12 public cases");
    expect(evalHtml).toContain(GHOST_HONESTY_LINE);
  });

  it("reads apps/web/content/eval-summary.json when it exists, and reports a bad one", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ct-eval-"));
    dirs.push(dir);
    expect(loadEvalSummary([path.join(dir, "absent.json")])).toEqual({ state: "missing" });
    const good = path.join(dir, "good.json");
    writeFileSync(good, JSON.stringify(SUMMARY));
    expect(loadEvalSummary([path.join(dir, "absent.json"), good]).state).toBe("ok");
    const bad = path.join(dir, "bad.json");
    writeFileSync(bad, JSON.stringify({ ...SUMMARY, metrics: [] }));
    expect(loadEvalSummary([bad]).state).toBe("invalid");
    writeFileSync(bad, "{ not json");
    expect(loadEvalSummary([bad]).state).toBe("invalid");
    // The app runs from apps/web; tools and tests from the repository root.
    expect(evalSummaryCandidates("/repo/apps/web")[0]).toBe(path.join("/repo/apps/web", "content", "eval-summary.json"));
    expect(evalSummaryCandidates("/repo")[1]).toBe(path.join("/repo", "apps", "web", "content", "eval-summary.json"));
  });

  it("parses the committed apps/web/content/eval-summary.json, when there is one", () => {
    // A summary the eval writes in another shape fails here, not quietly as "could not be read" on /method.
    const file = evalSummaryCandidates(process.cwd()).find((candidate) => existsSync(candidate));
    if (file) expect(loadEvalSummary([file])).toMatchObject({ state: "ok" });
  });

  it("formats each unit, and a missing value as a dash", () => {
    expect(formatEvalValue(0.5, "rate")).toBe("50%");
    expect(formatEvalValue(52, "seconds")).toBe("52 s");
    expect(formatEvalValue(1204, "count")).toBe("1,204");
    expect(formatEvalValue(3.5, "number")).toBe("3.5");
    expect(formatEvalValue(0.18, "usd")).toBe("$0.18");
    expect(formatEvalValue(null, "rate")).toBe("–");
  });
});

describe("Part 11 on /method", () => {
  const html = decode(view());

  it("adds the AI and web context and the OpenStreetMap sections, in order before the formulas", () => {
    expect(METHOD_SECTION_ORDER.indexOf("context")).toBeGreaterThan(METHOD_SECTION_ORDER.indexOf("conviction"));
    expect(METHOD_SECTION_ORDER.indexOf("supply")).toBeLessThan(METHOD_SECTION_ORDER.indexOf("formulas"));
    const context = section(html, "context");
    expect(context).toContain("What AI knows (not verified)");
    expect(context).toContain("It may state no number");
    expect(context).toContain("Page text is untrusted data");
    const supply = section(html, "supply");
    expect(supply).toContain("Each count is a floor, not a census");
    expect(supply).toContain("about the city's level");
    expect(supply).toContain("© OpenStreetMap contributors");
  });

  it("lists every confidence cap with its ceiling", () => {
    const conviction = section(html, "conviction");
    for (const [rule, cap] of Object.entries(CONFIDENCE_CAP)) {
      expect(conviction).toContain(`data-cap="${rule}"`);
      expect(conviction).toContain(`at most ${cap}`);
    }
    expect(conviction).toContain("Medium: the signal is mixed");
  });

  it("has copy for V12 and V13, and V3 counts spelled-out numbers", () => {
    const rules = checkerRules(methodFacts());
    expect(rules.V12.title).toBe("Concepts and areas read honestly");
    expect(rules.V13.text).toContain("about level");
    expect(rules.V3.text).toContain("spelled out");
    const checker = section(html, "checker");
    expect(checker).toContain(rules.V12.title);
    expect(checker).toContain(rules.V13.title);
  });

  it("groups the OpenStreetMap formulas once the registry has them", () => {
    const osm = FORMULA_GROUPS.find((g) => g.id === "osm");
    expect(osm?.skill).toBe("local_supply");
    for (const id of osm?.formulas ?? []) expect((FORMULA_IDS as readonly string[]).includes(id)).toBe(true);
  });
});

describe("Part 11 safe-use and data rows", () => {
  it("states that entity ids stay on the server, web text is untrusted, AI text has no numbers, and the OSM licence", async () => {
    const { DATA_HANDLING, SAFE_USE } = await import("../../content/trust");
    const ids = SAFE_USE.map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining(["ids-server-only", "web-untrusted", "ai-no-numbers"]));
    expect(DATA_HANDLING.find((d) => d.term === "OpenStreetMap")?.text).toContain("Open Database License (ODbL) 1.0");
  });
});
